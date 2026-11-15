import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { SecretStoreUnavailableError, type SecretStore } from "../../src/secrets/store.js";
import { NotFoundError } from "../../src/board/board-service.js";
import { commitEvent } from "../../src/events/commit.js";
import {
  ConflictError,
  ConnectionDisabledError,
  ConnectionService,
  UnsupportedConnectionError,
  SecretInConfigError,
  UnknownFieldError,
  type ConnectionTester,
} from "../../src/connections/service.js";

const owner = { kind: "human", id: "owner" } as const;
const KEY = "sk-ant-TESTKEY-0000000000";
const KEY2 = "sk-ant-TESTKEY-1111111111";
/** CLI home folders must be absolute; built at run time so no machine path is written into the repo. */
const GEM_HOME = join(tmpdir(), "gemini-home");
const CODEX_HOME = join(tmpdir(), "codex-home");
const HOME2 = join(tmpdir(), "home2");

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

describe("CLI home folder", () => {
  it("refuses a cliHome that is not an absolute path, on add and on update, without writing anything", async () => {
    const svc = make();
    for (const cliHome of ["gemini-home", "./gemini-home", "~/gemini-home"]) {
      const err = await svc
        .add(owner, { kind: "llm", provider: "gemini", name: "Gemini", private: { cliHome } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues[0]!.path).toEqual(["private", "cliHome"]);
      expect(JSON.stringify((err as ZodError).issues)).not.toContain(cliHome);
    }
    expect(ledger.list()).toEqual([]);
    expect(store.size()).toBe(0);

    const c = await svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", private: { cliHome: GEM_HOME } });
    await expect(svc.update(owner, c.id, { private: { cliHome: "relative" } })).rejects.toBeInstanceOf(ZodError);
    expect(svc.get(c.id).private).toEqual({ cliHome: GEM_HOME });
  });
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
      private: { cliHome: GEM_HOME },
    });
    expect(c.private).toEqual({ cliHome: GEM_HOME });
    expect(c.config).toEqual({ googleCloudProject: "demo-project" });
    expect(JSON.stringify(ledger.list())).not.toContain(GEM_HOME);
    expect(ledger.list()[0]!.payload).toMatchObject({ privateFields: ["cliHome"], secretFields: [] });
    expect(await store.get("connection/conn1/cliHome")).toBe(GEM_HOME);
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
    await expect(svc.add(owner, { kind: "cloud", provider: "other", name: "Other", config: {} } as never)).rejects.toBeInstanceOf(UnknownFieldError);
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
      svc.add(owner, { kind: "llm", provider: "codex", name: "Codex", config: {}, secrets: { apiKey: KEY }, private: { cliHome: CODEX_HOME } }),
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
      name: "Work Gemini", config: { googleCloudProject: "p2" }, enabled: false, private: { cliHome: HOME2 },
    });
    expect(u).toMatchObject({ name: "Work Gemini", config: { googleCloudProject: "p2" }, enabled: false, private: { cliHome: HOME2 } });
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
      secrets: { apiKey: "AIzaTESTKEY" }, private: { cliHome: GEM_HOME },
    });
    expect(svc.credentialsFor("gemini")).toEqual({
      connectionId: c.id, name: "Gemini", apiKey: "AIzaTESTKEY", googleCloudProject: "demo-project", cliHome: GEM_HOME,
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

  it("reports the keychain unavailable after a failed write, keeps cached credentials, and ok again after a good write", async () => {
    await addClaude(make());
    let failSet = false;
    const flaky: SecretStore = {
      get: (a) => store.get(a),
      set: async (a, v) => {
        if (failSet) throw new SecretStoreUnavailableError();
        return store.set(a, v);
      },
      delete: (a) => store.delete(a),
    };
    const svc = make({ secrets: flaky });
    await svc.load();
    expect(svc.keychainState()).toBe("ok");
    failSet = true;
    await expect(
      svc.add(owner, { kind: "llm", provider: "codex", name: "Codex", config: {}, secrets: { apiKey: KEY2 } }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(svc.keychainState()).toBe("unavailable");
    expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY); // the cache is still good
    failSet = false;
    await svc.add(owner, { kind: "llm", provider: "codex", name: "Codex", config: {}, secrets: { apiKey: KEY2 } });
    expect(svc.keychainState()).toBe("ok");
  });

  it("reports the keychain unavailable after a failed write on an empty workspace", async () => {
    const svc = make({ secrets: new MemorySecretStore({ failOn: new Set(["get", "set", "delete"]) }) });
    await svc.load();
    expect(svc.keychainState()).toBe("ok"); // nothing was read yet
    await expect(addClaude(svc)).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(svc.keychainState()).toBe("unavailable");
    expect(ledger.list()).toEqual([]);
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
      svc.update(owner, c.id, { private: { cliHome: GEM_HOME } }),
    ]);
    expect(svc.credentialsFor("gemini")).toMatchObject({ apiKey: "AIzaTESTKEY", cliHome: GEM_HOME });
    expect(svc.get(c.id)).toMatchObject({ secretFields: ["apiKey"], private: { cliHome: GEM_HOME } });
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

describe("re-review fixes", () => {
  // Matches no token pattern, so only the loaded secret values can catch it.
  const PLAIN = "plain-TESTVALUE-0000";

  it("loads a cold cache before checking a name, so a stored secret is refused", async () => {
    const c = await addClaude(make(), PLAIN);
    const cold = make(); // no load()
    await expect(cold.update(owner, c.id, { name: PLAIN })).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(
      cold.add(owner, { kind: "llm", provider: "gemini", name: `x ${PLAIN}`, config: {} }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    expect(types()).toEqual(["connection.added"]);
  });

  it("refuses a name equal to a stored secret once the keychain comes back", async () => {
    const c = await addClaude(make(), PLAIN);
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
    // Still down: a name-only update proceeds on pattern redaction alone.
    await svc.update(owner, c.id, { name: "Renamed" });
    down = false;
    await expect(svc.update(owner, c.id, { name: PLAIN })).rejects.toBeInstanceOf(SecretInConfigError);
    expect(svc.keychainState()).toBe("ok");
  });

  it("gives up on a tester that ignores the signal and releases the connection", async () => {
    const svc = new ConnectionService({
      db, ledger, secrets: store, newId, testTimeoutMs: 5,
      testers: { claude: () => new Promise(() => undefined) },
    });
    const c = await addClaude(svc);
    expect(await svc.test(owner, c.id)).toEqual({ ok: false, message: "Could not reach the provider" });
    expect(ledger.list()[1]).toMatchObject({ type: "connection.tested", payload: { ok: false, message: "Could not reach the provider" } });
    await svc.update(owner, c.id, { name: "Still usable" });
    expect(svc.get(c.id).name).toBe("Still usable");
  });

  /** A store whose next `get` reads the value now but answers only when released. */
  function gatedStore() {
    let armed = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: SecretStore = {
      get: async (a) => {
        const value = await store.get(a);
        if (armed) await gate;
        return value;
      },
      set: (a, v) => store.set(a, v),
      delete: (a) => store.delete(a),
    };
    return { gated, arm: () => (armed = true), release: () => release() };
  }

  it("a concurrent load does not drop a value set while it ran", async () => {
    const { gated, arm, release } = gatedStore();
    const svc = make({ secrets: gated });
    const c = await addClaude(svc);
    await svc.load();
    arm();
    const loading = svc.load();
    await svc.update(owner, c.id, { secrets: { apiKey: KEY2 } });
    release();
    await loading;
    expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY2);
  });

  it("a concurrent load does not bring back a removed connection", async () => {
    const { gated, arm, release } = gatedStore();
    const svc = make({ secrets: gated });
    const c = await addClaude(svc);
    await svc.load();
    arm();
    const loading = svc.load();
    await svc.remove(owner, c.id);
    release();
    await loading;
    expect((svc as unknown as { cache: Map<string, unknown> }).cache.has(c.id)).toBe(false);
    // A new connection reusing nothing from the removed one starts with no cached key.
    const again = await svc.add(owner, { kind: "llm", provider: "claude", name: "Claude", config: {} });
    expect(svc.credentialsFor("claude")).toEqual({ connectionId: again.id, name: "Claude" });
  });
});

describe("final fix wave", () => {
  // Matches no token pattern: only the value given in the same request can catch it.
  const OPAQUE = "zq0RS6kd83JWnB2yT5pe7MaV4cUx9hLf1Gt";

  it("refuses a name or config value that holds a secret or private value from the same request, on add", async () => {
    const svc = make();
    await expect(
      svc.add(owner, { kind: "llm", provider: "claude", name: OPAQUE, config: {}, secrets: { apiKey: OPAQUE } }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(
      svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: `p-${OPAQUE}` }, secrets: { apiKey: OPAQUE } }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(
      svc.add(owner, { kind: "llm", provider: "gemini", name: `home ${GEM_HOME}`, config: {}, private: { cliHome: GEM_HOME } }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    expect(ledger.list()).toHaveLength(0);
    expect(store.size()).toBe(0);
    expect(svc.list()).toEqual([]);
  });

  it("refuses a name or config value that holds a secret or private value from the same request, on update", async () => {
    const svc = make();
    const g = await svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini", config: {}, secrets: { apiKey: "AIzaTESTKEY" } });
    await expect(svc.update(owner, g.id, { name: OPAQUE, secrets: { apiKey: OPAQUE } })).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(
      svc.update(owner, g.id, { config: { googleCloudProject: GEM_HOME }, private: { cliHome: GEM_HOME } }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    expect(types()).toEqual(["connection.added"]);
    expect(store.size()).toBe(1);
    expect(await store.get("connection/conn1/apiKey")).toBe("AIzaTESTKEY");
    expect(svc.get(g.id)).toMatchObject({ name: "Gemini", config: {}, private: {} });
  });

  it("requires a secret of at least 8 characters, without echoing it, on add and on update", async () => {
    const svc = make();
    for (const value of ["short-7", "1234567"]) {
      const err = await addClaude(svc, value).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZodError);
      const issues = (err as ZodError).issues;
      expect(issues).toEqual([{ code: "custom", path: ["secrets", "apiKey"], message: "must be at least 8 characters" }]);
      expect(JSON.stringify(issues)).not.toMatch(/short-7|1234567/);
    }
    const c = await addClaude(svc, "12345678");
    await expect(svc.update(owner, c.id, { secrets: { apiKey: "abcdefg" } })).rejects.toBeInstanceOf(ZodError);
    expect(await store.get("connection/conn1/apiKey")).toBe("12345678");
    expect(types()).toEqual(["connection.added"]);
  });

  /** A store that is down until `up()` is called. */
  function flakyStore() {
    let down = true;
    const flaky: SecretStore = {
      get: async (a) => {
        if (down) throw new SecretStoreUnavailableError();
        return store.get(a);
      },
      set: async (a, v) => {
        if (down) throw new SecretStoreUnavailableError();
        return store.set(a, v);
      },
      delete: (a) => store.delete(a),
    };
    return { flaky, up: () => (down = false), downAgain: () => (down = true) };
  }

  it("test() retries the load while the keychain is unavailable, at most once per 30 s, so the state recovers without a write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const c = await addClaude(make(), KEY);
      const { flaky, up, downAgain } = flakyStore();
      const seen: string[] = [];
      const svc = make({ secrets: flaky, testers: { claude: async (i) => (seen.push(i.secrets.apiKey ?? "(none)"), { ok: true, message: "Connected" }) } });
      await svc.load();
      expect(svc.keychainState()).toBe("unavailable");
      up();
      await svc.test(owner, c.id);
      expect(svc.keychainState()).toBe("ok");
      expect(seen).toEqual([KEY]);

      // A failed write marks it unavailable again; the next retry waits 30 s from the last one.
      downAgain();
      await expect(svc.update(owner, c.id, { secrets: { apiKey: KEY2 } })).rejects.toBeInstanceOf(SecretStoreUnavailableError);
      expect(svc.keychainState()).toBe("unavailable");
      up();
      vi.advanceTimersByTime(29_000);
      await svc.test(owner, c.id);
      expect(svc.keychainState()).toBe("unavailable");
      vi.advanceTimersByTime(1_000);
      await svc.test(owner, c.id);
      expect(svc.keychainState()).toBe("ok");
      expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("residuals", () => {
  /** A store whose reads and writes fail while `down` is set. */
  function switchable() {
    const s = { down: false, gets: 0 };
    const secrets: SecretStore = {
      get: async (a) => {
        s.gets++;
        if (s.down) throw new SecretStoreUnavailableError();
        return store.get(a);
      },
      set: async (a, v) => {
        if (s.down) throw new SecretStoreUnavailableError();
        return store.set(a, v);
      },
      delete: (a) => store.delete(a),
    };
    return { s, secrets };
  }

  it("a failed write with the keychain still down keeps the cache: a status read 30 s later still yields the key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const c = await addClaude(make(), KEY);
      const { s, secrets } = switchable();
      const svc = make({ secrets });
      await svc.load();
      s.down = true;
      await expect(svc.update(owner, c.id, { secrets: { apiKey: KEY2 } })).rejects.toBeInstanceOf(SecretStoreUnavailableError);
      expect(svc.keychainState()).toBe("unavailable");
      vi.advanceTimersByTime(30_000);
      await svc.retryIfUnavailable(); // what a status read does
      expect(svc.keychainState()).toBe("unavailable");
      expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY);
      expect(svc.secretValues()).toContain(KEY);

      // Back up: the next probe clears the mark, still without replacing the cache.
      s.down = false;
      await store.set(`connection/${c.id}/apiKey`, "changed-behind-our-back");
      vi.advanceTimersByTime(30_000);
      await svc.retryIfUnavailable();
      expect(svc.keychainState()).toBe("ok");
      expect(svc.credentialsFor("claude")!.apiKey).toBe(KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed load after a good one keeps the values already loaded", async () => {
    const c = await addClaude(make(), KEY);
    const { s, secrets } = switchable();
    const seen: string[] = [];
    const svc = make({ secrets, testers: { claude: async (i) => (seen.push(i.secrets.apiKey ?? "(none)"), { ok: true, message: "Connected" }) } });
    await svc.load();
    s.down = true;
    await svc.load();
    expect(svc.keychainState()).toBe("unavailable");
    await svc.test(owner, c.id); // its retry fails too
    expect(seen).toEqual([KEY]);
    expect(svc.secretValues()).toContain(KEY);
  });

  it("does not use request values shorter than 8 characters to check the name and config", async () => {
    const svc = make();
    const x = join("/", "x");
    const c = await svc.add(owner, { kind: "llm", provider: "gemini", name: `Gemini${x}`, config: {}, private: { cliHome: x } });
    expect(c.name).toBe(`Gemini${x}`);
    const u = await svc.update(owner, c.id, { name: `Work${x}`, private: { cliHome: x } });
    expect(u.name).toBe(`Work${x}`);
  });
});

describe("cloud, MCP and hardware connections", () => {
  const ACCESS_KEY = "AKIATESTKEY000000000";
  const SECRET_KEY = "TESTKEY-aws-secret-0000000000";
  const HEADER = "Bearer TESTKEY-hdr-0000000000";
  /** MCP server names need 8 letters or digits from the id. */
  const uuidId = () => `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const makeU = (secrets: SecretStore = store) => new ConnectionService({ db, ledger, secrets, testers: {}, newId: uuidId });
  const addAws = (svc: ConnectionService, config: Record<string, string> = { region: "us-east-1" }) =>
    svc.add(owner, {
      kind: "cloud", provider: "aws", name: "AWS", config, secrets: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
  const addMcpHttp = (svc: ConnectionService, headers = `Authorization=${HEADER}`) =>
    svc.add(owner, { kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "https://mcp.example.com/mcp" }, secrets: { headers } });
  const pathOf = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    return (err as ZodError).issues[0]!.path;
  };

  it("adds an AWS account: two keychain entries, the region in config", async () => {
    const svc = makeU();
    const c = await addAws(svc);
    expect(store.size()).toBe(2);
    expect(svc.list()[0]!.secretFields).toEqual(["accessKeyId", "secretAccessKey"]);
    expect(c.config).toEqual({ region: "us-east-1" });
    expect(JSON.stringify(ledger.list())).not.toContain("TESTKEY");
  });

  it("allows a second AWS account", async () => {
    const svc = makeU();
    await addAws(svc);
    await addAws(svc, { region: "eu-west-2" });
    expect(svc.list().filter((c) => c.provider === "aws")).toHaveLength(2);
  });

  it("checks catalog patterns, numbers and URLs at the field's path, without echoing the value", async () => {
    const svc = makeU();
    expect(await pathOf(addAws(svc, { region: "nowhere" }))).toEqual(["config", "region"]);
    const err = await addAws(svc, { region: "nowhere" }).catch((e: unknown) => e);
    expect(JSON.stringify((err as ZodError).issues)).not.toContain("nowhere");

    const claude = (config: Record<string, string>) =>
      svc.add(owner, { kind: "llm", provider: "claude", name: "Claude", config, secrets: { apiKey: KEY } });
    expect(await pathOf(claude({ monthlyBudgetUsd: "12.345" }))).toEqual(["config", "monthlyBudgetUsd"]);
    expect(await pathOf(claude({ monthlyBudgetUsd: "-5" }))).toEqual(["config", "monthlyBudgetUsd"]);
    const c = await claude({ monthlyBudgetUsd: "50", plan: "Max 5x" });
    expect(c.config).toEqual({ monthlyBudgetUsd: "50", plan: "Max 5x" });
    expect(await pathOf(svc.update(owner, c.id, { config: { monthlyBudgetUsd: "lots" } }))).toEqual(["config", "monthlyBudgetUsd"]);

    const mcp = (url: string) => svc.add(owner, { kind: "mcp", provider: "mcp_http", name: "M", config: { url } });
    expect(await pathOf(mcp("not a url"))).toEqual(["config", "url"]);
    expect(await pathOf(mcp("http://mcp.example.com/mcp"))).toEqual(["config", "url"]);
    expect(await pathOf(mcp("ftp://localhost/x"))).toEqual(["config", "url"]);
    for (const url of [
      "https://user:TESTKEY-pass-0000000000@mcp.example.com/mcp",
      "https://TESTKEY-user-0000000000@mcp.example.com/mcp",
      "https://:TESTKEY-pass-0000000000@mcp.example.com/mcp",
      "https://mcp.example.com/mcp?token=TESTKEY-query-0000000000",
      "https://mcp.example.com/mcp?",
      "https://mcp.example.com/mcp#token=TESTKEY-frag-0000000000",
      "https://mcp.example.com/mcp#",
    ]) {
      const err = await mcp(url).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZodError);
      const issue = (err as ZodError).issues[0]!;
      expect(issue.path).toEqual(["config", "url"]);
      expect(issue.message).toBe("Put credentials in Headers, not in the URL.");
      expect(JSON.stringify((err as ZodError).issues)).not.toContain("TESTKEY");
    }
    expect(JSON.stringify(ledger.list())).not.toContain("TESTKEY");
    await mcp("http://localhost:3000/mcp");
    await mcp("http://127.0.0.1:3000/mcp");

    const azure = (tenantId: string) =>
      svc.add(owner, {
        kind: "cloud", provider: "azure", name: "Azure",
        config: { tenantId, clientId: "00000000-0000-4000-8000-000000000001", subscriptionId: "00000000-0000-4000-8000-000000000002" },
        secrets: { clientSecret: "TESTKEY-azure-secret-0000000000" },
      });
    expect(await pathOf(azure("tenant"))).toEqual(["config", "tenantId"]);
    await azure("00000000-0000-4000-8000-0000000000AB");
    expect(await pathOf(svc.add(owner, { kind: "github", provider: "github", name: "G", config: { repo: "nope" }, secrets: { token: "ghp_TESTKEY0000000000" } })))
      .toEqual(["config", "repo"]);
  });

  it("requires a required config field on add", async () => {
    const svc = makeU();
    const err = svc.add(owner, { kind: "cloud", provider: "aws", name: "AWS", secrets: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY } });
    expect(await pathOf(err)).toEqual(["config", "region"]);
    expect(store.size()).toBe(0);
    // A new config replaces the old one, so it must keep the required fields.
    const c = await addAws(svc);
    expect(await pathOf(svc.update(owner, c.id, { config: {} }))).toEqual(["config", "region"]);
    expect(svc.get(c.id).config).toEqual({ region: "us-east-1" });
  });

  it("refuses a bad pairs line before any keychain write", async () => {
    const svc = makeU();
    expect(await pathOf(addMcpHttp(svc, "Bad Name=TESTKEY-hdr-0000000000"))).toEqual(["headers", 1]);
    expect(store.size()).toBe(0);
    expect(ledger.list()).toEqual([]);
    const c = await addMcpHttp(svc);
    expect(await pathOf(svc.update(owner, c.id, { secrets: { headers: "no equals sign here" } }))).toEqual(["headers", 1]);
    expect(await store.get(`connection/${c.id}/headers`)).toBe(`Authorization=${HEADER}`);
  });

  it("redacts each header value on its own, also after a load in a fresh service", async () => {
    const svc = makeU();
    await addMcpHttp(svc, `Authorization=${HEADER}\nX-Short=abc`);
    expect(svc.secretValues()).toContain(HEADER);
    expect(svc.secretValues()).not.toContain("abc");
    const fresh = makeU();
    await fresh.load();
    expect(fresh.secretValues()).toContain(HEADER);
  });

  it("also redacts the credential after a Bearer, Basic or token scheme word, when it is 8 or more characters", async () => {
    const svc = makeU();
    await addMcpHttp(svc, "Authorization=Bearer TESTKEY-hdr-0000000000\nX-Basic=basic TESTKEY-basic-000\nX-Gh=TOKEN TESTKEY-gh-0000\nX-Short=Bearer abc1234");
    for (const v of ["TESTKEY-hdr-0000000000", "TESTKEY-basic-000", "TESTKEY-gh-0000"]) expect(svc.secretValues()).toContain(v);
    expect(svc.secretValues()).toContain("Bearer abc1234");
    expect(svc.secretValues()).not.toContain("abc1234");
  });

  it("selectForRun returns cloud sources and MCP specs in order, duplicates collapsed", async () => {
    const svc = makeU();
    const aws = await addAws(svc);
    const mcp = await addMcpHttp(svc);
    const sel = svc.selectForRun([aws.id, mcp.id, aws.id]);
    expect(sel.cloud).toEqual([{
      connectionId: aws.id, name: "AWS", provider: "aws", config: { region: "us-east-1" },
      secrets: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    }]);
    expect(sel.mcp).toEqual([{
      serverName: "tt-00000002", connectionId: mcp.id, name: "Docs", transport: "http",
      url: "https://mcp.example.com/mcp", headers: { Authorization: HEADER },
    }]);
    expect(svc.selectForRun([])).toEqual({ cloud: [], mcp: [] });
  });

  it("selectForRun includes a local MCP server with its private command and args", async () => {
    const svc = makeU();
    const c = await svc.add(owner, {
      kind: "mcp", provider: "mcp_stdio", name: "Files",
      private: { command: "npx", args: "-y\nexample-server" }, secrets: { env: "ROOT_TOKEN=TESTKEY-env-0000000000" },
    });
    expect(svc.selectForRun([c.id]).mcp).toEqual([{
      serverName: "tt-00000001", connectionId: c.id, name: "Files", transport: "stdio",
      command: "npx", args: ["-y", "example-server"], env: { ROOT_TOKEN: "TESTKEY-env-0000000000" },
    }]);
  });

  it("refuses ${ in an MCP command, argument, URL, env value or header, at the field's path, without echoing the value", async () => {
    const svc = makeU();
    const MARK = "TESTKEY-ref-0000000000";
    const issue = async (p: Promise<unknown>) => {
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZodError);
      const issues = (err as ZodError).issues;
      expect(JSON.stringify(issues)).not.toContain(MARK);
      return { path: issues[0]!.path, message: issues[0]!.message };
    };
    const stdio = (priv: Record<string, string>, secrets?: Record<string, string>) =>
      svc.add(owner, { kind: "mcp", provider: "mcp_stdio", name: "Files", private: { command: "npx", ...priv }, ...(secrets && { secrets }) });
    const message = 'must not contain "${": the agent program would read it as a reference to one of its variables';
    expect(await issue(stdio({ command: `npx-\${${MARK}}` }))).toEqual({ path: ["private", "command"], message });
    expect(await issue(stdio({ args: `-y\n\${${MARK}}` }))).toEqual({ path: ["private", "args"], message });
    expect(await issue(stdio({}, { env: `TOKEN=\${${MARK}}` }))).toEqual({ path: ["secrets", "env"], message });
    expect(await issue(addMcpHttp(svc, `Authorization=Bearer \${${MARK}}`))).toEqual({ path: ["secrets", "headers"], message });
    const http = (url: string) => svc.add(owner, { kind: "mcp", provider: "mcp_http", name: "M", config: { url } });
    expect((await issue(http(`https://mcp.example.com/\${${MARK}}`))).path).toEqual(["config", "url"]);
    const ok = await stdio({ args: "--price\n$5" }, { env: "PS1=$HOME" });
    await svc.update(owner, ok.id, { private: { args: `\${${MARK}}` } }).then(
      () => expect.unreachable(),
      (e: unknown) => expect((e as ZodError).issues[0]!.path).toEqual(["private", "args"]),
    );
    expect(store.size()).toBeGreaterThan(0);
    expect(JSON.stringify(ledger.list())).not.toContain(MARK);
  });

  it("selectForRun refuses wrong-kind, disabled, unknown ids and an unavailable keychain", async () => {
    const svc = makeU();
    const claude = await addClaude(svc);
    const github = await svc.add(owner, { kind: "github", provider: "github", name: "GitHub", secrets: { token: "ghp_TESTKEY0000000000" } });
    const aws = await addAws(svc);
    expect(() => svc.selectForRun([claude.id])).toThrow(UnsupportedConnectionError);
    expect(() => svc.selectForRun([github.id])).toThrow(UnsupportedConnectionError);
    expect(() => svc.selectForRun([claude.id])).toThrow("this connection cannot be given to a run");
    expect(() => svc.selectForRun(["missing"])).toThrow(NotFoundError);
    await svc.update(owner, aws.id, { enabled: false });
    expect(() => svc.selectForRun([aws.id])).toThrow(ConnectionDisabledError);
    expect(() => svc.selectForRun([aws.id])).toThrow("connection is disabled");
    await svc.update(owner, aws.id, { enabled: true });

    // A stored field missing from the keychain would give the run an incomplete source.
    await store.delete(`connection/${aws.id}/secretAccessKey`);
    const partial = makeU();
    await partial.load();
    expect(partial.keychainState()).toBe("ok");
    expect(() => partial.selectForRun([aws.id])).toThrow(SecretStoreUnavailableError);
    const stdio = await svc.add(owner, { kind: "mcp", provider: "mcp_stdio", name: "Files", private: { command: "npx" } });
    await store.delete(`connection/${stdio.id}/command`);
    const partial2 = makeU();
    await partial2.load();
    expect(() => partial2.selectForRun([stdio.id])).toThrow(SecretStoreUnavailableError);
    await store.set(`connection/${aws.id}/secretAccessKey`, SECRET_KEY);
    await store.set(`connection/${stdio.id}/command`, "npx");

    const down = makeU(new MemorySecretStore({ failOn: new Set(["get"]) }));
    await down.load();
    expect(() => down.selectForRun([aws.id])).toThrow(SecretStoreUnavailableError);
  });

  it("githubSource needs an enabled GitHub connection with a token and a repo", async () => {
    const svc = makeU();
    expect(svc.githubSource()).toBeNull();
    const g = await svc.add(owner, { kind: "github", provider: "github", name: "GitHub", secrets: { token: "ghp_TESTKEY0000000000" } });
    expect(svc.githubSource()).toBeNull();
    await svc.update(owner, g.id, { config: { repo: "octo/example" } });
    expect(svc.githubSource()).toEqual({ connectionId: g.id, token: "ghp_TESTKEY0000000000", repo: "octo/example" });
    await svc.update(owner, g.id, { enabled: false });
    expect(svc.githubSource()).toBeNull();
  });

  it("budgets lists one entry per enabled model connection, the budget as a number", async () => {
    const svc = makeU();
    const c = await svc.add(owner, {
      kind: "llm", provider: "claude", name: "Claude", config: { plan: "Max 5x", monthlyBudgetUsd: "50" }, secrets: { apiKey: KEY },
    });
    const g = await svc.add(owner, { kind: "llm", provider: "gemini", name: "Gemini" });
    await addAws(svc);
    expect(svc.budgets()).toEqual([
      { connectionId: c.id, provider: "claude", name: "Claude", plan: "Max 5x", monthlyBudgetUsd: 50 },
      { connectionId: g.id, provider: "gemini", name: "Gemini", plan: null, monthlyBudgetUsd: null },
    ]);
    await svc.update(owner, g.id, { enabled: false });
    expect(svc.budgets().map((b) => b.provider)).toEqual(["claude"]);
  });

  it("refuses to add or update This computer through the service; detection manages it", async () => {
    const svc = makeU();
    const err = await svc.add(owner, { kind: "hardware", provider: "local_hardware", name: "This computer", config: { cores: "8" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedConnectionError);
    expect((err as Error).message).toBe("this connection is managed by detection");
    expect(ledger.list()).toEqual([]);

    // As the detector will record it; the Owner may still remove it.
    commitEvent(db, ledger, () => ({
      event: {
        projectId: null, actor: { kind: "system", id: "hardware" }, type: "connection.added",
        payload: { connectionId: "hw-00000001", kind: "hardware", provider: "local_hardware", name: "This computer", config: { cores: "8" }, secretFields: [], privateFields: [] },
      },
      result: () => undefined,
    }));
    await expect(svc.update(owner, "hw-00000001", { name: "Mine" })).rejects.toBeInstanceOf(UnsupportedConnectionError);
    expect(() => svc.selectForRun(["hw-00000001"])).toThrow(UnsupportedConnectionError);
    await svc.remove(owner, "hw-00000001");
    expect(svc.list()).toEqual([]);
  });
});

describe("Google Cloud key redaction", () => {
  const LINE1 = "TESTKEYTESTKEYTESTKEYTESTKEYTESTKEYTESTKEYTESTKEYTESTKEYTESTKEY0";
  const LINE2 = "TESTKEYTESTKEYTESTKEYTESTKEYTESTKEY00000";
  const SHORT = "TESTKEY000000000";
  const PEM = `-----BEGIN PRIVATE KEY-----\n${LINE1}\n${LINE2}\n${SHORT}\n-----END PRIVATE KEY-----\n`;
  const KEY_ID = "0000000000000000000000000000000000testkey";
  const SA_JSON = JSON.stringify({
    type: "service_account", project_id: "tt-test-project", private_key_id: KEY_ID, private_key: PEM,
    client_email: "tester@tt-test-project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token",
  });
  const addGcp = (svc: ConnectionService) =>
    svc.add(owner, { kind: "cloud", provider: "gcp", name: "GCP", config: { project: "tt-test-project" }, secrets: { serviceAccountJson: SA_JSON } });

  it("redacts the parsed private key, its JSON-escaped form, each long body line and the key id", async () => {
    const expected = [SA_JSON, PEM, JSON.stringify(PEM).slice(1, -1), LINE1, LINE2, KEY_ID];
    const svc = make();
    await addGcp(svc);
    expect(svc.secretValues()).toEqual(expect.arrayContaining(expected));
    expect(svc.secretValues()).not.toContain(SHORT);
    expect(svc.secretValues()).not.toContain("-----BEGIN PRIVATE KEY-----");
    const reloaded = make();
    await reloaded.load();
    expect(reloaded.secretValues()).toEqual(expect.arrayContaining(expected));
  });
});
