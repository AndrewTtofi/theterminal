import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { SecretStoreUnavailableError, type SecretStore } from "../../src/secrets/store.js";
import { NotFoundError } from "../../src/board/board-service.js";
import {
  ConflictError,
  ConnectionService,
  SecretInConfigError,
  UnknownFieldError,
  type ConnectionTester,
} from "../../src/connections/service.js";

const owner = { kind: "human", id: "owner" } as const;
const KEY = "sk-ant-TESTKEY-0000000000";
const KEY2 = "sk-ant-TESTKEY-1111111111";

let db: Db;
let ledger: Ledger;
let store: MemorySecretStore;
let ids: number;

const newId = () => `conn${++ids}`;
const make = (opts: { secrets?: SecretStore; testers?: Record<string, ConnectionTester>; fetch?: typeof fetch } = {}) =>
  new ConnectionService({ db, ledger, secrets: opts.secrets ?? store, testers: opts.testers ?? {}, fetch: opts.fetch, newId });
const types = () => ledger.list().map((e) => e.type);
const addClaude = (svc: ConnectionService, apiKey = KEY) =>
  svc.add(owner, { kind: "llm", provider: "claude", name: "Claude", config: {}, secrets: { apiKey } });

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  store = new MemorySecretStore();
  ids = 0;
});

describe("add", () => {
  it("stores the key in the keychain and records only field names", async () => {
    const svc = make();
    const c = await addClaude(svc);
    expect(c).toMatchObject({
      id: "conn1", kind: "llm", provider: "claude", name: "Claude", enabled: true, config: {}, private: {},
      secretFields: ["apiKey"], status: { state: "untested", message: "", testedAt: null },
    });
    expect(types()).toEqual(["connection.added"]);
    expect(ledger.list()[0]!.payload).toEqual({
      connectionId: "conn1", kind: "llm", provider: "claude", name: "Claude", config: {}, secretFields: ["apiKey"], privateFields: [],
    });
    expect(await store.get("connection/conn1/apiKey")).toBe(KEY);
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]!.secretFields).toEqual(["apiKey"]);
    expect(JSON.stringify(svc.list())).not.toContain("TESTKEY");
    expect(JSON.stringify(ledger.list())).not.toContain("TESTKEY");
    expect(JSON.stringify(db.prepare("SELECT * FROM connections").all())).not.toContain("TESTKEY");
    expect(svc.secretValues()).toEqual([KEY]);
  });

  it("keeps private values out of the ledger but returns them", async () => {
    const svc = make();
    const c = await svc.add(owner, {
      kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: "demo-project" },
      private: { cliHome: "gemini-home" },
    });
    expect(c.private).toEqual({ cliHome: "gemini-home" });
    expect(c.config).toEqual({ googleCloudProject: "demo-project" });
    expect(JSON.stringify(ledger.list())).not.toContain("gemini-home");
    expect(ledger.list()[0]!.payload).toMatchObject({ privateFields: ["cliHome"], secretFields: [] });
    expect(await store.get("connection/conn1/cliHome")).toBe("gemini-home");
    expect(svc.secretValues()).toEqual([]);
  });

  it("rejects a config value that looks like a secret, writing nothing (Review Focus 1)", async () => {
    const svc = make();
    await expect(
      svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: KEY }, secrets: { apiKey: KEY2 } }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    expect(ledger.list()).toHaveLength(0);
    expect(store.size()).toBe(0);
    expect(svc.list()).toEqual([]);
  });

  it("rejects a second connection for a single provider, enabled or not", async () => {
    const svc = make();
    const c = await addClaude(svc);
    await svc.update(owner, c.id, { enabled: false });
    await expect(addClaude(svc, KEY2)).rejects.toBeInstanceOf(ConflictError);
    expect(store.size()).toBe(1);
    expect(types()).toEqual(["connection.added", "connection.updated"]);
  });

  it("rejects fields outside the catalog or under the wrong storage", async () => {
    const svc = make();
    const attempt = (input: Record<string, unknown>) =>
      svc.add(owner, { kind: "llm", provider: "claude", name: "Claude", config: {}, ...input } as never);
    await expect(attempt({ secrets: { token: KEY } })).rejects.toBeInstanceOf(UnknownFieldError);
    await expect(attempt({ config: { region: "x" } })).rejects.toBeInstanceOf(UnknownFieldError);
    await expect(attempt({ private: { apiKey: KEY } })).rejects.toBeInstanceOf(UnknownFieldError);
    await expect(
      svc.add(owner, { kind: "llm", provider: "gemini", name: "G", config: {}, secrets: { googleCloudProject: "p" } }),
    ).rejects.toBeInstanceOf(UnknownFieldError);
    await expect(svc.add(owner, { kind: "cloud", provider: "aws", name: "AWS", config: {} })).rejects.toBeInstanceOf(UnknownFieldError);
    expect(ledger.list()).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  it("validates secret values and required fields before writing", async () => {
    const svc = make();
    await expect(addClaude(svc, "")).rejects.toThrow();
    await expect(addClaude(svc, "line1\nline2")).rejects.toThrow();
    await expect(addClaude(svc, "x".repeat(16 * 1024 + 1))).rejects.toThrow();
    await expect(svc.add(owner, { kind: "github", provider: "github", name: "GitHub", config: {} })).rejects.toThrow();
    await expect(svc.add(owner, { kind: "llm", provider: "github", name: "GitHub", config: {} })).rejects.toThrow();
    expect(ledger.list()).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  it("fails closed when the keychain cannot be written (Review Focus 4)", async () => {
    const failing = new MemorySecretStore({ failOn: new Set(["set"]) });
    const svc = make({ secrets: failing });
    await expect(addClaude(svc)).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(ledger.list()).toHaveLength(0);
    expect(failing.size()).toBe(0);
    expect(svc.list()).toEqual([]);
  });

  it("deletes the entries it wrote when a later keychain write fails", async () => {
    let writes = 0;
    const flaky: SecretStore = {
      get: (a) => store.get(a),
      delete: (a) => store.delete(a),
      set: async (a, v) => {
        if (++writes > 1) throw new SecretStoreUnavailableError();
        await store.set(a, v);
      },
    };
    const svc = make({ secrets: flaky });
    await expect(
      svc.add(owner, { kind: "llm", provider: "codex", name: "Codex", config: {}, secrets: { apiKey: KEY }, private: { cliHome: "codex-home" } }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(store.size()).toBe(0);
    expect(ledger.list()).toHaveLength(0);
  });

  it("deletes the written entries when the commit fails", async () => {
    const svc = make();
    const spy = vi.spyOn(ledger, "appendInTransaction").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(addClaude(svc)).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(store.size()).toBe(0);
    expect(ledger.list()).toHaveLength(0);
  });
});

describe("update", () => {
  it("replaces the key, recording only the field name", async () => {
    const svc = make();
    const c = await addClaude(svc);
    const u = await svc.update(owner, c.id, { secrets: { apiKey: KEY2 } });
    expect(u.secretFields).toEqual(["apiKey"]);
    const entry = ledger.list()[1]!;
    expect(entry.type).toBe("connection.updated");
    expect(entry.payload).toEqual({ connectionId: c.id, name: "Claude", changes: { secretsSet: ["apiKey"] } });
    expect(JSON.stringify(entry)).not.toContain("TESTKEY");
    expect(await store.get(`connection/${c.id}/apiKey`)).toBe(KEY2);
    expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY2);
    expect(svc.secretValues().sort()).toEqual([KEY, KEY2].sort());
  });

  it("removes a key with null", async () => {
    const svc = make();
    const c = await addClaude(svc);
    const u = await svc.update(owner, c.id, { secrets: { apiKey: null } });
    expect(u.secretFields).toEqual([]);
    expect(ledger.list()[1]!.payload).toEqual({ connectionId: c.id, name: "Claude", changes: { secretsRemoved: ["apiKey"] } });
    expect(store.size()).toBe(0);
    expect(svc.credentialsFor("claude")).toEqual({ connectionId: c.id, name: "Claude" });
    expect(svc.secretValues()).toContain(KEY);
  });

  it("records name, config, enabled and private changes", async () => {
    const svc = make();
    const c = await svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", config: {} });
    const u = await svc.update(owner, c.id, {
      name: "Work Gemini", config: { googleCloudProject: "p2" }, enabled: false, private: { cliHome: "home2" },
    });
    expect(u).toMatchObject({ name: "Work Gemini", config: { googleCloudProject: "p2" }, enabled: false, private: { cliHome: "home2" } });
    expect(ledger.list()[1]!.payload).toEqual({
      connectionId: c.id, name: "Work Gemini",
      changes: { name: "Work Gemini", config: { googleCloudProject: "p2" }, enabled: false, privateSet: ["cliHome"] },
    });
    const v = await svc.update(owner, c.id, { private: { cliHome: null } });
    expect(v.private).toEqual({});
    expect(ledger.list()[2]!.payload).toMatchObject({ changes: { privateRemoved: ["cliHome"] } });
  });

  it("rejects secret-looking config, unknown ids, empty patches and removing a required field", async () => {
    const svc = make();
    const g = await svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", config: {} });
    await expect(svc.update(owner, g.id, { config: { googleCloudProject: KEY } })).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(svc.update(owner, "nope", { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.update(owner, g.id, {})).rejects.toThrow();
    const gh = await svc.add(owner, { kind: "github", provider: "github", name: "GitHub", config: {}, secrets: { token: "ghp_TESTKEY0000000000000000" } });
    await expect(svc.update(owner, gh.id, { secrets: { token: null } })).rejects.toThrow();
    expect(types()).toEqual(["connection.added", "connection.added"]);
  });

  it("puts the previous key back when the keychain write fails", async () => {
    const svc = make();
    const c = await addClaude(svc);
    const failing = make({ secrets: { get: (a) => store.get(a), delete: (a) => store.delete(a), set: async () => { throw new SecretStoreUnavailableError(); } } });
    await failing.load();
    await expect(failing.update(owner, c.id, { secrets: { apiKey: KEY2 } })).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(ledger.list()).toHaveLength(1);
    expect(await store.get(`connection/${c.id}/apiKey`)).toBe(KEY);
  });
});

describe("remove", () => {
  it("deletes the keychain entry but keeps the value redactable (Review Focus 2)", async () => {
    const svc = make();
    const c = await addClaude(svc);
    await svc.remove(owner, c.id);
    expect(types()).toEqual(["connection.added", "connection.removed"]);
    expect(ledger.list()[1]!.payload).toEqual({ connectionId: c.id, name: "Claude" });
    expect(store.size()).toBe(0);
    expect(svc.list()).toEqual([]);
    expect(() => svc.get(c.id)).toThrow(NotFoundError);
    expect(svc.secretValues()).toContain(KEY);
    expect(svc.credentialsFor("claude")).toBeNull();
    await expect(svc.remove(owner, c.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("load and credentials", () => {
  it("restores credentials after a restart", async () => {
    const c = await addClaude(make());
    const svc = make();
    await svc.load();
    expect(svc.keychainState()).toBe("ok");
    expect(svc.credentialsFor("claude")).toEqual({ connectionId: c.id, name: "Claude", apiKey: KEY });
    expect(svc.secretValues()).toEqual([KEY]);
  });

  it("reports an unavailable keychain and yields no credentials", async () => {
    await addClaude(make());
    const svc = make({ secrets: new MemorySecretStore({ failOn: new Set(["get"]) }) });
    await svc.load();
    expect(svc.keychainState()).toBe("unavailable");
    expect(svc.credentialsFor("claude")).toBeNull();
    expect(svc.list()).toHaveLength(1);
  });

  it("carries the Gemini project and CLI home; a disabled connection yields null", async () => {
    const svc = make();
    const c = await svc.add(owner, {
      kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: "demo-project" },
      secrets: { apiKey: "AIzaTESTKEY" }, private: { cliHome: "gemini-home" },
    });
    expect(svc.credentialsFor("gemini")).toEqual({
      connectionId: c.id, name: "Gemini", apiKey: "AIzaTESTKEY", googleCloudProject: "demo-project", cliHome: "gemini-home",
    });
    expect(svc.credentialsFor("codex")).toBeNull();
    await svc.update(owner, c.id, { enabled: false });
    expect(svc.credentialsFor("gemini")).toBeNull();
  });
});

describe("test", () => {
  it("records the result and updates the status", async () => {
    const tester: ConnectionTester = vi.fn(async (input, deps) => {
      expect(input.secrets).toEqual({ apiKey: KEY });
      expect(deps.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, message: "Connected" };
    });
    const svc = make({ testers: { claude: tester } });
    const c = await addClaude(svc);
    expect(await svc.test(owner, c.id)).toEqual({ ok: true, message: "Connected" });
    expect(ledger.list()[1]).toMatchObject({ type: "connection.tested", payload: { connectionId: c.id, name: "Claude", ok: true, message: "Connected" } });
    const status = svc.get(c.id).status;
    expect(status).toMatchObject({ state: "ok", message: "Connected" });
    expect(status.testedAt).toBe(ledger.list()[1]!.ts);
  });

  it("redacts a tester message that echoes the key", async () => {
    const svc = make({ testers: { claude: async (input) => ({ ok: false, message: input.secrets.apiKey! }) } });
    const c = await addClaude(svc);
    expect(await svc.test(owner, c.id)).toEqual({ ok: false, message: "[REDACTED]" });
    expect(ledger.list()[1]!.payload).toMatchObject({ ok: false, message: "[REDACTED]" });
    expect(svc.get(c.id).status).toMatchObject({ state: "failed", message: "[REDACTED]" });
  });

  it("truncates long messages to 500", async () => {
    const svc = make({ testers: { claude: async () => ({ ok: false, message: "x".repeat(900) }) } });
    const c = await addClaude(svc);
    expect((await svc.test(owner, c.id)).message).toHaveLength(500);
  });

  it("records an untestable provider", async () => {
    const svc = make();
    const c = await addClaude(svc);
    const r = await svc.test(owner, c.id);
    expect(r).toEqual({ ok: false, message: "Testing is not available for this connection yet" });
    expect(ledger.list()[1]).toMatchObject({ type: "connection.tested", payload: { ok: false } });
  });

  it("passes the injected fetch and a timeout signal", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch;
    let seen: { fetch: typeof fetch; signal: AbortSignal } | null = null;
    const svc = new ConnectionService({
      db, ledger, secrets: store, newId, fetch: fakeFetch, testTimeoutMs: 5,
      testers: { claude: async (_i, deps) => { seen = deps; return { ok: true, message: "Connected" }; } },
    });
    const c = await addClaude(svc);
    await svc.test(owner, c.id);
    expect(seen!.fetch).toBe(fakeFetch);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen!.signal.aborted).toBe(true);
  });
});

describe("review fixes", () => {
  const failCommit = () =>
    vi.spyOn(ledger, "appendInTransaction").mockImplementation(() => {
      throw new Error("disk full");
    });

  it("keeps the old key when an update on a cold service fails to commit", async () => {
    const c = await addClaude(make());
    const cold = make(); // no load()
    const spy = failCommit();
    await expect(cold.update(owner, c.id, { secrets: { apiKey: KEY2 } })).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(await store.get(`connection/${c.id}/apiKey`)).toBe(KEY);
    const svc = make();
    await svc.load();
    expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY);
  });

  it("reads a value missing from the cache before overwriting it, and puts it back on failure", async () => {
    const svc = make();
    const c = await svc.add(owner, { kind: "llm", provider: "claude", name: "Claude", config: {} });
    await store.set(`connection/${c.id}/apiKey`, KEY); // an entry the projection does not list
    const spy = failCommit();
    await expect(svc.update(owner, c.id, { secrets: { apiKey: KEY2 } })).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(await store.get(`connection/${c.id}/apiKey`)).toBe(KEY);
  });

  it("refuses keychain writes while the keychain stays unavailable, writing nothing", async () => {
    await addClaude(make());
    const failing = new MemorySecretStore({ failOn: new Set(["get"]) });
    const svc = make({ secrets: failing });
    await expect(
      svc.add(owner, { kind: "llm", provider: "codex", name: "Codex", config: {}, secrets: { apiKey: KEY2 } }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(ledger.list()).toHaveLength(1);
    expect(failing.size()).toBe(0);
    expect(svc.keychainState()).toBe("unavailable");
    await expect(svc.remove(owner, "conn1")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(ledger.list()).toHaveLength(1);
  });

  it("reloads once the keychain is back: state ok and loaded values redactable", async () => {
    const c = await addClaude(make());
    let down = true;
    const recovering: SecretStore = {
      get: async (a) => {
        if (down) throw new SecretStoreUnavailableError();
        return store.get(a);
      },
      set: (a, v) => store.set(a, v),
      delete: (a) => store.delete(a),
    };
    const svc = make({ secrets: recovering });
    await svc.load();
    expect(svc.keychainState()).toBe("unavailable");
    expect(svc.secretValues()).toEqual([]);
    down = false;
    await svc.update(owner, c.id, { secrets: { apiKey: KEY2 } });
    expect(svc.keychainState()).toBe("ok");
    expect(svc.secretValues().sort()).toEqual([KEY, KEY2].sort());
    expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY2);
  });

  it("serialises concurrent updates of one connection", async () => {
    const svc = make();
    const c = await svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", config: {} });
    await Promise.all([
      svc.update(owner, c.id, { secrets: { apiKey: "AIzaTESTKEY" } }),
      svc.update(owner, c.id, { private: { cliHome: "gemini-home" } }),
    ]);
    expect(svc.credentialsFor("gemini")).toMatchObject({ apiKey: "AIzaTESTKEY", cliHome: "gemini-home" });
    expect(svc.get(c.id)).toMatchObject({ secretFields: ["apiKey"], private: { cliHome: "gemini-home" } });
  });

  it("rejects a name that looks like a secret on add and update", async () => {
    const svc = make();
    await expect(svc.add(owner, { kind: "llm", provider: "claude", name: KEY, config: {} })).rejects.toBeInstanceOf(SecretInConfigError);
    const c = await addClaude(svc);
    await expect(svc.update(owner, c.id, { name: `my ${KEY}` })).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(svc.update(owner, c.id, { name: "copy of AIzaTESTKEY" })).resolves.toBeDefined();
    await expect(svc.update(owner, c.id, { name: `again ${KEY}` })).rejects.toBeInstanceOf(SecretInConfigError);
    expect(types()).toEqual(["connection.added", "connection.updated"]);
  });

  it("names an unknown field only when it is a plain identifier", async () => {
    const svc = make();
    const attempt = (secrets: Record<string, string>) =>
      svc.add(owner, { kind: "llm", provider: "claude", name: "Claude", config: {}, secrets });
    await expect(attempt({ token: "x" })).rejects.toThrow("unknown secret field: token");
    const err = await attempt({ [KEY]: "x" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UnknownFieldError);
    expect((err as Error).message).toBe("unknown field");
  });

  it("records a tester that throws as unreachable", async () => {
    const svc = make({
      testers: {
        claude: async () => {
          throw new Error(`boom ${KEY}`);
        },
      },
    });
    const c = await addClaude(svc);
    expect(await svc.test(owner, c.id)).toEqual({ ok: false, message: "Could not reach the provider" });
    expect(ledger.list()[1]).toMatchObject({ type: "connection.tested", payload: { ok: false, message: "Could not reach the provider" } });
    expect(svc.get(c.id).status.state).toBe("failed");
  });
});
