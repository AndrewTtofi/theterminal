import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_CATALOG, type AgentAction, type AgentRun, type Connection } from "@theterminal/shared";
import type { FakeStep as FakeStepLike } from "../../src/agents/fake-adapter.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { SecretStoreUnavailableError } from "../../src/secrets/store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { COLLABORATORS, seedPeople } from "../fixtures/people.js";
import { localFetch } from "../fixtures/local-fetch.js";

const ENV_KEYS = [
  "THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT", "THETERMINAL_FAKE_HTTP", "THETERMINAL_SECRET_STORE",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
] as const;
const KEY = "sk-ant-TESTKEY-0000000000";
const NEW_KEY = "sk-ant-TESTKEY-1111111111";
const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
  const dataDir = mkdtempSync(join(tmpdir(), "tt-conn-"));
  dirs.push(dataDir);
  const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), discovery: fakeDiscovery(), ...opts });
  running.push(s);
  return s;
}

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const auth = (s: RunningServer) => ({ authorization: `Bearer ${s.token}` });
const send = (s: RunningServer, method: string, path: string, body?: unknown) =>
  fetch(base(s) + path, {
    method,
    headers: { ...auth(s), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const get = (s: RunningServer, path: string) => send(s, "GET", path);
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const addClaude = (s: RunningServer, extra: Record<string, unknown> = {}) =>
  send(s, "POST", "/api/connections", { kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: KEY }, ...extra });

describe("connections API", { timeout: 15000 }, () => {
  it("GET /api/connections/catalog returns the catalog", async () => {
    const s = await start();
    expect(await json(get(s, "/api/connections/catalog"))).toEqual(CONNECTION_CATALOG);
  });

  it("adds, lists, updates and removes a connection without ever returning a secret value", async () => {
    const s = await start();
    expect(await json(get(s, "/api/connections"))).toEqual([]);

    const res = await addClaude(s);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const added = JSON.parse(text) as Connection;
    expect(added).toMatchObject({ kind: "llm", provider: "claude", name: "Claude", enabled: true, secretFields: ["apiKey"] });

    const listText = await (await get(s, "/api/connections")).text();
    expect(listText).not.toContain(KEY);
    expect(JSON.parse(listText)).toEqual([added]);

    const patched = await send(s, "PATCH", `/api/connections/${added.id}`, { name: "Work", enabled: false, secrets: { apiKey: NEW_KEY } });
    expect(patched.status).toBe(200);
    const patchText = await patched.text();
    expect(patchText).not.toContain(NEW_KEY);
    expect(JSON.parse(patchText)).toMatchObject({ id: added.id, name: "Work", enabled: false, secretFields: ["apiKey"] });

    const ledgerText = await (await get(s, "/api/ledger")).text();
    expect(ledgerText).toContain("connection.added");
    expect(ledgerText).toContain("connection.updated");
    expect(ledgerText).not.toContain(KEY);
    expect(ledgerText).not.toContain(NEW_KEY);

    const del = await send(s, "DELETE", `/api/connections/${added.id}`);
    expect(del.status).toBe(204);
    expect((await send(s, "DELETE", `/api/connections/${added.id}`)).status).toBe(404);
    expect(await json(get(s, "/api/connections"))).toEqual([]);
  });

  it("refuses a second Claude connection with 409 conflict", async () => {
    const s = await start();
    expect((await addClaude(s)).status).toBe(201);
    const res = await addClaude(s, { name: "Second" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });

  it("answers 404 not_found for an unknown id on PATCH, DELETE and test", async () => {
    const s = await start();
    for (const [method, path, body] of [
      ["PATCH", "/api/connections/nope", { name: "x" }],
      ["DELETE", "/api/connections/nope", undefined],
      ["POST", "/api/connections/nope/test", undefined],
    ] as const) {
      const res = await send(s, method, path, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("refuses a config value that looks like a secret with 400 secret_in_config, without echoing it", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", {
      kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: KEY },
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "secret_in_config" });
    expect(text).not.toContain(KEY);
    expect(await (await get(s, "/api/ledger")).text()).not.toContain(KEY);
  });

  it("refuses to add This computer through the API with 400 connection_unsupported", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: "hardware", provider: "local_hardware", name: "This computer", config: { cores: "8" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "connection_unsupported" });
  });

  it("refuses an unknown field with 400 invalid_input", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: "llm", provider: "claude", name: "C", secrets: { token: KEY } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_input" });
    expect(text).not.toContain(KEY);
  });

  it("reports zod failures as { path, code, message } only, never the received value", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: "llm", provider: "claude", name: "C", secrets: { apiKey: 42 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Record<string, unknown>[] };
    expect(body.error).toBe("invalid_input");
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    expect(body.issues[0]!.path).toEqual(["secrets", "apiKey"]);
  });

  it("never echoes an input value in an issue, even for an enum or an unknown key", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: KEY, provider: "claude", name: "C", [KEY]: "x" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect((JSON.parse(text) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it("rebuilds enum and unknown-key messages from the schema, never from zod's input-quoting defaults", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: "nope", provider: "claude", name: "C", extraField: "x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_input",
      issues: [
        { path: ["kind"], code: "invalid_value", message: "Invalid option: expected one of 'llm' | 'cloud' | 'github' | 'mcp' | 'hardware'" },
        { path: [], code: "unrecognized_keys", message: "Unrecognized key(s) in object" },
      ],
    });
  });

  it("masks a config key that is not a plain field name and keeps the refinement's fixed message", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: "llm", provider: "gemini", name: "G", config: { [KEY]: "x" } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({
      error: "invalid_input",
      issues: [{ path: ["*"], code: "invalid_key", message: "looks like a credential name; store it as a secret" }],
    });
  });

  it("answers a malformed JSON body with 400 and never echoes its text", async () => {
    const s = await start();
    const res = await fetch(`${base(s)}/api/connections`, {
      method: "POST",
      headers: { ...auth(s), "content-type": "application/json" },
      body: `{"secrets":{"apiKey":"${KEY}"`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(KEY);
  });

  it("refuses a CLI home folder that is not absolute with 400 invalid_input", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/connections", { kind: "llm", provider: "codex", name: "Codex", private: { cliHome: "codex-home" } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as { error: string }).error).toBe("invalid_input");
    expect(text).not.toContain("codex-home");
    expect(await json(get(s, "/api/connections"))).toEqual([]);
  });

  it("answers 401 without a token for the connection and status routes", async () => {
    const s = await start();
    for (const path of ["/api/connections", "/api/connections/catalog", "/api/status"]) {
      expect((await fetch(base(s) + path)).status).toBe(401);
    }
  });

  it("tests a connection with a bare POST (no body, no content-type) through the fake HTTP stub", async () => {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_HTTP = "1";
    const s = await start();
    const added = await json<Connection>(addClaude(s));
    const res = await fetch(`${base(s)}/api/connections/${added.id}/test`, { method: "POST", headers: auth(s) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Connected" });
    const [listed] = await json<Connection[]>(get(s, "/api/connections"));
    expect(listed!.status).toMatchObject({ state: "ok", message: "Connected" });
  });

  it("uses an injected fetch for tests and reports a rejected key", async () => {
    const stub = vi.fn(async () => new Response("{}", { status: 401 }));
    const s = await start({ fetch: stub as unknown as typeof fetch });
    const added = await json<Connection>(addClaude(s));
    expect(await json(send(s, "POST", `/api/connections/${added.id}/test`))).toEqual({
      ok: false, message: "Rejected by the provider (HTTP 401)",
    });
    expect(stub).toHaveBeenCalledOnce();
    const st = await json<{ connections: unknown }>(get(s, "/api/status"));
    expect(st.connections).toEqual({ enabled: 1, failed: 1, keychain: "ok", secretStore: "memory" });
  });

  it("starts with an unavailable keychain, refuses writes with 503 and reports it in /api/status", async () => {
    const failing = new MemorySecretStore({ failOn: new Set(["get", "set", "delete"]) });
    const s = await start({ secrets: failing });
    expect((await get(s, "/api/connections")).status).toBe(200);
    const res = await addClaude(s);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "keychain_unavailable" });
    expect(await json(get(s, "/api/connections"))).toEqual([]);
    expect(await (await get(s, "/api/ledger")).text()).not.toContain("connection.added");
    const st = await json<{ connections: unknown }>(get(s, "/api/status"));
    expect(st.connections).toEqual({ enabled: 0, failed: 0, keychain: "unavailable", secretStore: "memory" });
  });

  it("GET /api/agents reports where each provider's API key comes from", async () => {
    const s = await start();
    const sources = async () =>
      Object.fromEntries(
        Object.entries((await json<{ providers: Record<string, { apiKey: string }> }>(get(s, "/api/agents"))).providers).map(
          ([p, v]) => [p, v.apiKey],
        ),
      );
    expect(await sources()).toEqual({ claude: "none", codex: "none", gemini: "none" });
    process.env.OPENAI_API_KEY = "sk-TESTKEY-openai-0000000000000000";
    expect((await addClaude(s)).status).toBe(201);
    expect(await sources()).toEqual({ claude: "connection", codex: "environment", gemini: "none" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-TESTKEY-environment-000000";
    expect((await sources()).claude).toBe("connection"); // a connection wins over the environment
  });
});

describe("GET /api/status", { timeout: 15000 }, () => {
  const shell = { tool: "Bash", kind: "shell", summary: "run tests", input: { command: "npm test" }, paths: [] };
  const script: FakeStepLike[] = [{ usage: { costUsd: 0.25 } }, { propose: shell, result: { ok: true, output: "ok" } }];

  it("counts running agents, pending decisions and today's cost", async () => {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
    const s = await start();
    const empty = { runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, monthCostUsd: 0, monthlyBudgetUsd: null, connections: { enabled: 0, failed: 0, keychain: "ok", secretStore: "memory" }, ci: null, intakeDecisions: 0, intakeProjects: [], machines: { linked: 0, online: 0, keyChanged: 0 }, network: { state: "unknown", basis: "inferred", since: null, lastError: null }, shareLinks: 0, remote: { enabled: false, listening: false, label: "off" } };
    expect(await json(get(s, "/api/status"))).toEqual(empty);

    const project = await json<{ id: string }>(send(s, "POST", "/api/projects", { name: "P", pitch: "x" }));
    const run = await json<AgentRun>(send(s, "POST", `/api/projects/${project.id}/runs`, { adapter: "fake", prompt: "go" }));
    let pending: AgentAction[] = [];
    await vi.waitFor(async () => {
      pending = await json<AgentAction[]>(get(s, "/api/pending-actions"));
      expect(pending).toHaveLength(1);
    }, { timeout: 5000, interval: 25 });
    expect(await json(get(s, "/api/status"))).toMatchObject({ runningAgents: 1, pendingDecisions: 1, todayCostUsd: 0 });

    await send(s, "POST", `/api/actions/${pending[0]!.id}/decision`, { decision: "allow" });
    await vi.waitFor(async () => {
      expect((await json<{ run: AgentRun }>(get(s, `/api/runs/${run.id}`))).run.status).toBe("completed");
    }, { timeout: 5000, interval: 25 });
    expect(await json(get(s, "/api/status"))).toEqual({ ...empty, todayCostUsd: 0.25, monthCostUsd: 0.25 });

    await addClaude(s);
    expect((await json<{ connections: unknown }>(get(s, "/api/status"))).connections).toEqual({ enabled: 1, failed: 0, keychain: "ok", secretStore: "memory" });
  });
});

describe("final fix wave", () => {
  it("refuses a secret shorter than 8 characters with 400 and a message that never echoes it", async () => {
    const s = await start();
    const res = await addClaude(s, { secrets: { apiKey: "shrt-7" } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "invalid_input", issues: [{ path: ["secrets", "apiKey"], code: "custom", message: "must be at least 8 characters" }],
    });
    expect(text).not.toContain("shrt-7");
    expect(await json(get(s, "/api/connections"))).toEqual([]);
  });

  it("answers 401 without a token for the sign-in routes", async () => {
    const s = await start();
    const requests: [string, string][] = [
      ["GET", "/api/connections/signin-status"], ["POST", "/api/connections/signin/codex"],
      ["GET", "/api/connections/signin/some-id"], ["DELETE", "/api/connections/signin/some-id"],
    ];
    for (const [method, path] of requests) {
      const res = await fetch(base(s) + path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("GET /api/status retries the keychain load while it is unavailable, so the state recovers without a write", async () => {
    const memory = new MemorySecretStore();
    let down = true;
    const flaky = {
      get: async (a: string) => {
        if (down) throw new SecretStoreUnavailableError();
        return memory.get(a);
      },
      set: (a: string, v: string) => memory.set(a, v),
      delete: (a: string) => memory.delete(a),
    };
    // A connection stored while the keychain was up; the server then restarts with it down.
    const first = await start({ secrets: memory });
    const dataDir = dirs.at(-1)!;
    const added = await json<Connection>(addClaude(first));
    await running.pop()!.close();
    const s = await start({ dataDir, secrets: flaky });
    // The startup load failed: a write is refused and nothing is written.
    expect((await send(s, "PATCH", `/api/connections/${added.id}`, { secrets: { apiKey: NEW_KEY } })).status).toBe(503);
    expect(await memory.get(`connection/${added.id}/apiKey`)).toBe(KEY);
    down = false;
    // The retry runs in the background: a later status read sees its outcome.
    await vi.waitFor(async () => {
      const st = await json<{ connections: { keychain: string } }>(get(s, "/api/status"));
      expect(st.connections.keychain).toBe("ok");
    });
  });
});

describe("residuals", () => {
  it("GET /api/status answers with the current state without waiting for a keychain retry that hangs", async () => {
    const memory = new MemorySecretStore();
    let mode: "up" | "down" | "hung" = "up";
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const store = {
      get: async (a: string) => {
        if (mode === "down") throw new SecretStoreUnavailableError();
        if (mode === "hung") await released;
        return memory.get(a);
      },
      set: (a: string, v: string) => memory.set(a, v),
      delete: (a: string) => memory.delete(a),
    };
    const first = await start({ secrets: memory });
    const dataDir = dirs.at(-1)!;
    await json<Connection>(addClaude(first));
    await running.pop()!.close();
    mode = "down";
    const s = await start({ dataDir, secrets: store });
    mode = "hung";
    try {
      const res = await Promise.race([
        get(s, "/api/status"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("status waited for the keychain")), 2000)),
      ]);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { connections: { keychain: string } }).connections.keychain).toBe("unavailable");
    } finally {
      release();
    }
  });
});

describe("GET /api/status network (inferred from the Owner's own calls)", { timeout: 15000 }, () => {
  type Network = { state: string; basis: string; since: string | null; lastError: string | null };
  const network = async (s: RunningServer) => (await json<{ network: Network }>(get(s, "/api/status"))).network;
  // As undici rejects when name resolution fails: a TypeError whose cause carries the system code.
  const dnsFailure = () =>
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });

  it("a connection test that cannot resolve the provider makes the state offline; a later answer makes it online", async () => {
    let offline = true;
    const stub = vi.fn(async () => {
      if (offline) throw dnsFailure();
      return new Response("{}", { status: 200 });
    });
    const s = await start({ fetch: stub as unknown as typeof fetch });
    expect(await network(s)).toEqual({ state: "unknown", basis: "inferred", since: null, lastError: null });
    const added = await json<Connection>(addClaude(s));
    expect(await json(send(s, "POST", `/api/connections/${added.id}/test`))).toEqual({ ok: false, message: "Could not reach the provider" });
    const down = await network(s);
    expect(down).toMatchObject({ state: "offline", basis: "inferred", lastError: "ENOTFOUND" });
    expect(Object.keys(down).sort()).toEqual(["basis", "lastError", "since", "state"]);
    expect(Number.isNaN(Date.parse(down.since!))).toBe(false);
    // Only the plan's fields: no URL, host or error text leaves the server.
    const text = await (await get(s, "/api/status")).text();
    expect(text).not.toMatch(/anthropic|https?:|getaddrinfo|fetch failed/i);

    offline = false;
    expect(await json(send(s, "POST", `/api/connections/${added.id}/test`))).toMatchObject({ ok: true });
    expect(await network(s)).toMatchObject({ state: "online", lastError: null });
  });

  it("a refused connection says nothing about the internet and leaves the state", async () => {
    const stub = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const s = await start({ fetch: stub as unknown as typeof fetch });
    const added = await json<Connection>(addClaude(s));
    await send(s, "POST", `/api/connections/${added.id}/test`);
    expect(stub).toHaveBeenCalledOnce();
    expect((await network(s)).state).toBe("unknown");
  });

  it("a local model test never counts, even when its call fails like the internet would", async () => {
    const stub = vi.fn(async () => {
      throw dnsFailure();
    });
    const s = await start({ fetch: stub as unknown as typeof fetch });
    const added = await json<Connection>(send(s, "POST", "/api/connections", {
      kind: "llm", provider: "local_model", name: "Fake coder", config: { baseUrl: "http://127.0.0.1:11434/v1", model: "fake-coder:7b" },
    }));
    expect(await json(send(s, "POST", `/api/connections/${added.id}/test`))).toMatchObject({ ok: false });
    expect(stub).toHaveBeenCalled();
    expect((await network(s)).state).toBe("unknown");
  });

  it("a GitHub call that cannot resolve makes the state offline, and /api/status still answers 200", async () => {
    const stub = vi.fn(async () => {
      throw dnsFailure();
    });
    const s = await start({ fetch: stub as unknown as typeof fetch });
    const gh = await send(s, "POST", "/api/connections", {
      kind: "github", provider: "github", name: "GitHub", config: { repo: "octo-org/example" }, secrets: { token: "ghp_TESTKEY0000000000" },
    });
    expect(gh.status).toBe(201);
    const overview = await get(s, "/api/github/overview");
    expect(overview.status).toBe(503);
    expect(await overview.json()).toEqual({ error: "github_unavailable" });
    expect(stub).toHaveBeenCalled();
    const status = await get(s, "/api/status");
    expect(status.status).toBe(200);
    expect(((await status.json()) as { network: Network }).network).toMatchObject({ state: "offline", lastError: "ENOTFOUND" });
  });
});

describe("what a collaborator sees of connections", { timeout: 15000 }, () => {
  async function startSeeded() {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
    const dataDir = mkdtempSync(join(tmpdir(), "tt-conn-roles-"));
    dirs.push(dataDir);
    const cookies = seedPeople(dataDir);
    const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), discovery: fakeDiscovery() });
    running.push(s);
    const asRole = (role: "viewer" | "reviewer" | "maintainer") => ({ cookie: cookies[COLLABORATORS.find((p) => p.role === role)!.id]! });
    const theirs = (role: "viewer" | "reviewer" | "maintainer", method: string, path: string, body?: unknown) =>
      localFetch(base(s) + path, {
        method, headers: { ...asRole(role), ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    return { s, theirs };
  }

  it("GET /api/connections is a summary for a maintainer: id, kind, provider, name, enabled and the test state; the Owner gets everything but values", async () => {
    const { s, theirs } = await startSeeded();
    const added = (await (await addClaude(s, { config: { plan: "Max 5x" } })).json()) as Connection;
    const res = await theirs("maintainer", "GET", "/api/connections");
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const field of ["config", "private", "secretFields", KEY, "Max 5x"]) expect(text).not.toContain(field);
    const list = JSON.parse(text) as Record<string, unknown>[];
    expect(list).toEqual([{ id: added.id, kind: "llm", provider: "claude", name: "Claude", enabled: true, status: { state: "untested", message: "", testedAt: null } }]);
    const owners = (await json<Connection[]>(get(s, "/api/connections")))[0]!;
    expect(owners).toMatchObject({ id: added.id, config: { plan: "Max 5x" }, secretFields: ["apiKey"], private: {} });
    expect(JSON.stringify(owners)).not.toContain(KEY);
  });

  it("a maintainer may not read one connection, change it or test it", async () => {
    const { s, theirs } = await startSeeded();
    const added = (await (await addClaude(s)).json()) as Connection;
    for (const [method, path, body] of [
      ["GET", `/api/connections/${added.id}`, undefined],
      ["PATCH", `/api/connections/${added.id}`, { enabled: false }],
      ["POST", `/api/connections/${added.id}/test`, undefined],
      ["DELETE", `/api/connections/${added.id}`, undefined],
      ["POST", "/api/connections", { kind: "llm", provider: "codex", name: "Codex" }],
      ["GET", "/api/connections/catalog", undefined],
      ["GET", "/api/connections/signin-status", undefined],
    ] as const) {
      const res = await theirs("maintainer", method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden", required: "owner" });
    }
    expect((await json<Connection[]>(get(s, "/api/connections")))[0]).toMatchObject({ enabled: true });
  });

  it("GET /api/status for a collaborator is trimmed: counts only, no budget, no keychain state and nothing about remote access", async () => {
    const { s, theirs } = await startSeeded();
    await send(s, "POST", "/api/connections", { kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: KEY }, config: { monthlyBudgetUsd: "40" } });
    const owners = await json<Record<string, unknown>>(get(s, "/api/status"));
    expect(owners.connections).toEqual({ enabled: 1, failed: 0, keychain: "ok", secretStore: "memory" });
    expect(owners.remote).toEqual({ enabled: false, listening: false, label: "off" });
    expect(owners.monthlyBudgetUsd).toBe(40);
    for (const role of ["viewer", "reviewer", "maintainer"] as const) {
      const res = await theirs(role, "GET", "/api/status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.connections).toEqual({ enabled: 1, failed: 0 });
      expect(body).not.toHaveProperty("remote");
      // What the Owner pays for is theirs alone: the summed budget goes the way of each source's budget in capacity.
      expect(body).not.toHaveProperty("monthlyBudgetUsd");
      expect(JSON.stringify(body)).not.toContain("keychain");
      expect(JSON.stringify(body)).not.toContain("40");
      expect(Object.keys(body).sort()).toEqual(
        ["ci", "connections", "intakeDecisions", "intakeProjects", "machines", "monthCostUsd", "network", "pendingDecisions", "runningAgents", "shareLinks", "todayCostUsd"],
      );
    }
  });
});
