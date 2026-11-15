import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINKING_ACK, type AgentRun, type Connection, type Role } from "@theterminal/shared";
import type { FakeStep } from "../../src/agents/fake-adapter.js";
import { APP_HOST, ROUTE_ROLES } from "../../src/server/auth.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { COLLABORATORS, seedPeople } from "../fixtures/people.js";
import { localFetch } from "../fixtures/local-fetch.js";

const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;
const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const SECRET = "zq-TESTKEY-e2e-opaque-0000000000";
const NEW_SECRET = "zq-TESTKEY-e2e-replaced-000000000";
/** What the connection tester reports when the stubbed provider answers 401: a message only the Owner reads. */
const TEST_MESSAGE = "Rejected by the provider (HTTP 401)";
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const running: RunningServer[] = [];
const dirs: string[] = [];
const WIN32 = process.platform === "win32";
vi.setConfig({ testTimeout: WIN32 ? 90_000 : 45_000, hookTimeout: 30_000 });

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The fake agent reads a file and reports the secret in its output; the recorded output must be redacted. */
const script: FakeStep[] = [
  {
    propose: { tool: "Read", kind: "file_read", summary: "read notes", input: { path: "notes.txt" }, paths: ["notes.txt"] },
    result: { ok: true, output: `the value is ${SECRET}` },
  },
];

const send = (s: RunningServer, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  localFetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

/** A server over a fresh data folder, with the three collaborators signed in; the provider stub answers every test 401. */
async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-nosecrets-"));
  dirs.push(dataDir);
  const cookies = seedPeople(dataDir);
  const s = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), discovery: fakeDiscovery(),
    linkBind: "127.0.0.1", linkPort: 0, fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
  });
  running.push(s);
  return { s, dataDir, cookies };
}

/**
 * A workspace with a secret in a connection (set, then replaced), a private value removed from another, a failed
 * connection test, a run's working copy and an action's output, a paired machine, and three collaborators.
 */
async function world() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
  const { s, dataDir, cookies } = await startServer();
  const owner = { authorization: `Bearer ${s.token}` };
  const as = (role: Role): Record<string, string> =>
    role === "owner" ? owner : { cookie: cookies[COLLABORATORS.find((p) => p.role === role)!.id]! };
  const json = async <T>(r: Promise<Response>): Promise<T> => (await r).json() as Promise<T>;

  const conn = await json<Connection>(send(s, "POST", "/api/connections", owner, { kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: SECRET } }));
  expect((await send(s, "PATCH", `/api/connections/${conn.id}`, owner, { secrets: { apiKey: NEW_SECRET } })).status).toBe(200);
  const codex = await json<Connection>(send(s, "POST", "/api/connections", owner, {
    kind: "llm", provider: "codex", name: "Codex", secrets: { apiKey: SECRET }, private: { cliHome: join(dataDir, "owners-codex-home") },
  }));
  expect((await send(s, "PATCH", `/api/connections/${codex.id}`, owner, { private: { cliHome: null } })).status).toBe(200);
  expect(await json(send(s, "POST", `/api/connections/${conn.id}/test`, owner))).toEqual({ ok: false, message: TEST_MESSAGE });
  // A second server stands in for another computer of the Owner's; pairing records its address in the ledger.
  const worker = (await startServer()).s;
  for (const t of [s, worker]) expect((await send(t, "POST", "/api/link/enable", { authorization: `Bearer ${t.token}` }, { acknowledgement: LINKING_ACK })).status).toBe(200);
  const { self } = await json<{ self: { linking: { port: number } } }>(send(worker, "GET", "/api/link", { authorization: `Bearer ${worker.token}` }));
  const { code } = await json<{ code: string }>(send(worker, "POST", "/api/link/code", { authorization: `Bearer ${worker.token}` }));
  expect((await send(s, "POST", "/api/link/pair", owner, { address: `127.0.0.1:${self.linking.port}`, code })).status).toBe(201);
  const project = await json<{ id: string }>(send(s, "POST", "/api/projects", owner, { name: "Club", pitch: "p" }));
  const card = await json<{ id: string }>(send(s, "POST", `/api/projects/${project.id}/cards`, owner, { title: "T", stage: "plan" }));
  const run = await json<AgentRun>(send(s, "POST", `/api/projects/${project.id}/runs`, owner, { adapter: "fake", prompt: "go", cardId: card.id }));
  await vi.waitFor(async () => {
    const { run: r } = await json<{ run: AgentRun }>(send(s, "GET", `/api/runs/${run.id}`, owner));
    expect(r.status).not.toBe("running");
  }, { timeout: 20_000, interval: 50 });
  writeFileSync(join(dataDir, run.worktree, "notes.txt"), `password: ${SECRET}\n`);
  const action = (await json<{ actions: { id: string }[] }>(send(s, "GET", `/api/runs/${run.id}`, owner))).actions[0]!;
  const preview = await json<{ previewId: string; contentHash: string }>(send(s, "POST", `/api/projects/${project.id}/share/preview`, owner, {}));
  const snapshot = await json<{ id: string }>(send(s, "POST", `/api/projects/${project.id}/share/confirm`, owner, preview));

  /** A GET key as a real request: the ids of this workspace, and the query each route needs. */
  const pathFor = (key: string): string => {
    const pattern = key.slice("GET ".length);
    let path = pattern
      .replace("/api/projects/:id", `/api/projects/${project.id}`)
      .replace("/api/cards/:id", `/api/cards/${card.id}`)
      .replace("/api/runs/:id", `/api/runs/${run.id}`)
      .replace("/api/connections/:id", `/api/connections/${conn.id}`)
      .replace("/api/share/snapshots/:id", `/api/share/snapshots/${snapshot.id}`)
      .replace("/api/actions/:id", `/api/actions/${action.id}`)
      .replace(/:[A-Za-z]+/g, "x");
    if (pattern.endsWith("/gates")) path += "?to=ship";
    if (pattern.endsWith("/file") || pattern.endsWith("/diff")) path += "?path=notes.txt";
    if (pattern.endsWith("/files")) path += "?path=";
    return path;
  };
  return { s, as, pathFor, run, conn };
}

const GETS = Object.keys(ROUTE_ROLES).filter((k) => k.startsWith("GET ") && k !== "GET /api/events");
/**
 * Keys a collaborator's view never holds: a connection's config, its secret and private field names, which of them
 * changed, a key source, a tester's message, a paired machine's address, the remote listener's bind.
 */
const OWNER_FIELDS = [
  '"secretFields":', '"private":', '"privateFields":', '"config":', '"apiKey"', '"secretsSet":', '"secretsRemoved":', '"privateSet":',
  '"privateRemoved":', '"cliHome"', '"address":', '"bind":', TEST_MESSAGE, "owners-codex-home",
];

/** Everything the ledger stream sends `headers` up to its first presence frame (which follows the backlog). */
function streamBacklog(s: RunningServer, headers: Record<string, string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/events?afterSeq=0`, { headers: { host: `${APP_HOST}:${s.port}`, ...headers } });
    const got: string[] = [];
    ws.on("message", (d) => {
      const text = String(d);
      if (JSON.parse(text).type === "presence") {
        ws.close();
        resolve(got);
        return;
      }
      got.push(text);
    });
    ws.on("error", reject);
    ws.on("close", (code) => (code === 1000 ? undefined : reject(new Error(`closed ${code}`))));
  });
}

describe("no secret reaches a collaborator", () => {
  it("across every GET route and the ledger stream, for a viewer, a reviewer and a maintainer: no secret value, no secret or private names, no config, no key source, no test message, no address", async () => {
    const { s, as, pathFor } = await world();
    const leaks: string[] = [];
    const check = (role: string, key: string, text: string) => {
      for (const secret of [SECRET, NEW_SECRET]) if (text.includes(secret)) leaks.push(`${role} ${key}: the secret value`);
      for (const field of OWNER_FIELDS) if (text.includes(field)) leaks.push(`${role} ${key}: ${field}`);
    };
    for (const role of ["viewer", "reviewer", "maintainer"] as const) {
      for (const key of GETS) {
        const res = await send(s, "GET", pathFor(key), as(role));
        const text = await res.text();
        if (res.status !== 200) continue;
        check(role, key, text);
      }
      const streamed = await streamBacklog(s, as(role));
      expect(streamed.length).toBeGreaterThan(5);
      for (const text of streamed) check(role, "WS /api/events", text);
    }
    expect(leaks).toEqual([]);
    // The record itself is whole for the Owner: the ledger and its stream name the secret fields (never a value), which
    // of them were replaced, the tester's message and the paired machine's address.
    const owners = await (await send(s, "GET", "/api/ledger", as("owner"))).text();
    const streamed = (await streamBacklog(s, as("owner"))).join("\n");
    for (const text of [owners, streamed]) {
      expect(text).toContain('"secretFields":["apiKey"]');
      expect(text).toContain('"secretsSet":["apiKey"]');
      expect(text).toContain('"privateFields":["cliHome"]');
      expect(text).toContain('"privateRemoved":["cliHome"]');
      expect(text).toContain(TEST_MESSAGE);
      expect(text).toMatch(/"address":"127\.0\.0\.1:\d+"/);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(NEW_SECRET);
      expect(text).not.toContain("owners-codex-home");
    }
  });

  it("the Owner's own views carry no secret value either", async () => {
    const { s, as, pathFor } = await world();
    for (const key of GETS) {
      const text = await (await send(s, "GET", pathFor(key), as("owner"))).text();
      expect(text, key).not.toContain(SECRET);
      expect(text, key).not.toContain(NEW_SECRET);
    }
  });

  it("a reviewer reads a run's working copy, redacted; a viewer may not", async () => {
    const { s, as, pathFor } = await world();
    for (const key of ["GET /api/runs/:id/file", "GET /api/runs/:id/files", "GET /api/runs/:id/changes", "GET /api/runs/:id/diff", "GET /api/ledger/export"]) {
      const viewer = await send(s, "GET", pathFor(key), as("viewer"));
      expect(viewer.status, key).toBe(403);
      const reviewer = await send(s, "GET", pathFor(key), as("reviewer"));
      expect(reviewer.status, key).toBe(200);
    }
    const file = await (await send(s, "GET", pathFor("GET /api/runs/:id/file"), as("reviewer"))).json() as { text: string };
    expect(file.text).toContain("[REDACTED]");
    expect(file.text).not.toContain(SECRET);
  });

  it("a maintainer's connection list holds summaries only; the Owner's holds the names of the secret fields and no value", async () => {
    const { s, as, conn } = await world();
    const mine = await (await send(s, "GET", "/api/connections", as("maintainer"))).json() as Record<string, unknown>[];
    expect(mine).toHaveLength(2);
    for (const c of mine) expect(Object.keys(c).sort()).toEqual(["enabled", "id", "kind", "name", "provider", "status"]);
    expect(mine[0]).toMatchObject({ id: conn.id, kind: "llm", provider: "claude", name: "Claude", enabled: true, status: { state: "failed", message: "" } });
    const owners = await (await send(s, "GET", "/api/connections", as("owner"))).text();
    expect(owners).toContain('"secretFields":["apiKey"]');
    expect(owners).toContain(TEST_MESSAGE);
    expect(owners).not.toContain(SECRET);
    expect(owners).not.toContain(NEW_SECRET);
  });
});
