import Fastify from "fastify";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_ACK, PROVIDER_ACKS, type AgentAction, type AgentRun } from "@theterminal/shared";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { FakeAdapter, type FakeStep } from "../../src/agents/fake-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { ProviderSettings } from "../../src/agents/settings.js";
import { registerAgentRoutes } from "../../src/server/agent-routes.js";
import { registerRoutes } from "../../src/server/routes.js";
import { GateService } from "../../src/gates/service.js";
import { EMPTY_GITCONFIG, WorktreeManager, ensureEmptyGitconfig } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase } from "../../src/db.js";
import { listPendingActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { createServer, repairSharedGitconfig, type RunningServer } from "../../src/server/server.js";
import { AwsRejectedError, fakeSts, type StsCaller } from "../../src/connections/cloud/aws.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";

const ENV_KEYS = [
  "THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT", "FAKE_SERVICE_TOKEN", "THETERMINAL_CODEX_BIN", "OPENAI_API_KEY",
  "THETERMINAL_FAKE_CODEX_SCRIPT", "THETERMINAL_GEMINI_BIN", "GEMINI_API_KEY", "THETERMINAL_FAKE_GEMINI_SCRIPT",
  "ANTHROPIC_API_KEY",
] as const;
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const FAKE_GEMINI = fileURLToPath(new URL("../fixtures/fake-gemini.mjs", import.meta.url));
const FAKE_OPENAI_KEY = "sk-TESTKEY-openai-0000000000000000";
const FAKE_GEMINI_KEY = "AIza-TESTKEY-gemini-000000000000000";
/** A PATH lookup that finds nothing, so tests never depend on which CLIs this machine has. */
const noCli = () => null;
/** No bundled programs either, so a run that is not a fake can never start a real CLI. */
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
  // Windows: a git or agent process going away may still hold a file in the directory for a moment.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tt-agents-"));
  dirs.push(d);
  return d;
};

/** Starts a server with the fake adapter enabled (when `script` is given) and one project. */
async function start(
  script?: FakeStep[] | null,
  opts: {
    shutdownTimeoutMs?: number; which?: (cmd: string) => string | null; bundled?: Parameters<typeof createServer>[0]["bundled"];
    secrets?: MemorySecretStore; sts?: StsCaller;
  } = {},
) {
  if (script !== null) {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    if (script) process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
  }
  const dataDir = tmp();
  const s = await createServer({ dataDir, port: 0, which: noCli, bundled: NO_BUNDLED, ...opts });
  running.push(s);
  const project = (await (await post(s, "/api/projects", { name: "P", pitch: "x" })).json()) as { id: string };
  return { s, projectId: project.id, dataDir };
}

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const headers = (s: RunningServer) => ({ authorization: `Bearer ${s.token}`, "content-type": "application/json" });
const post = (s: RunningServer, path: string, body: unknown = {}) =>
  fetch(base(s) + path, { method: "POST", headers: headers(s), body: JSON.stringify(body) });
const get = (s: RunningServer, path: string) => fetch(base(s) + path, { headers: headers(s) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;

const getRun = (s: RunningServer, runId: string) => json<{ run: AgentRun; actions: AgentAction[] }>(get(s, `/api/runs/${runId}`));
const pending = (s: RunningServer, projectId: string) => json<AgentAction[]>(get(s, `/api/projects/${projectId}/pending-actions`));
// A run start creates the project repository and the worktree through runGit, whose hardening checks make five or six
// git processes of every call: about fifty per start, then the fake agent's process. Seconds on Windows CI, where a
// process start is slow and the suite shares two cores (a start measured 3.6 s there); the default 5 s is too close.
const WIN32 = process.platform === "win32";
const GIT_TEST_TIMEOUT_MS = WIN32 ? 40_000 : 15_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });
/** How long a route that starts a run or records a decision may take to answer: never the agent's own run time. */
const BOUNDED_MS = WIN32 ? 10_000 : 3000;
const WAIT_MS = WIN32 ? 20_000 : 5000;

const untilPending = (s: RunningServer, projectId: string, n = 1) =>
  vi.waitFor(async () => expect(await pending(s, projectId)).toHaveLength(n), { timeout: WAIT_MS, interval: 25 });
const untilFinished = (s: RunningServer, runId: string) =>
  vi.waitFor(async () => expect((await getRun(s, runId)).run.status).not.toBe("running"), { timeout: WAIT_MS, interval: 25 });

const read = { tool: "Read", kind: "file_read", summary: "read README", input: { path: "README.md" }, paths: ["README.md"] } as const;
const shell = { tool: "Bash", kind: "shell", summary: "run tests", input: { command: "npm test" }, paths: [] } as const;
const script: FakeStep[] = [
  { propose: { ...read, paths: [...read.paths] }, result: { ok: true, output: "hello" } },
  { propose: { ...shell, paths: [] }, result: { ok: true, output: "ok" } },
];

describe("agent API", { timeout: 15000 }, () => {
  it("GET /api/agents lists registered adapters, each provider's mode, availability and key source, and the acknowledgements", async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const) delete process.env[k];
    process.env.GEMINI_API_KEY = FAKE_GEMINI_KEY;
    const { s } = await start(script, { which: (cmd) => (cmd === "codex" ? "/fake/bin/codex" : null) });
    expect(await json(get(s, "/api/agents"))).toEqual({
      adapters: ["claude", "codex", "gemini", "fake"],
      providers: {
        claude: { mode: "api_key", available: false, apiKey: "none" },
        codex: { mode: "api_key", available: true, apiKey: "none" },
        gemini: { mode: "api_key", available: false, apiKey: "environment" },
      },
      acks: PROVIDER_ACKS,
    });
  });

  const availability = async (s: RunningServer) =>
    Object.fromEntries(
      Object.entries((await json<{ providers: Record<string, { available: boolean }> }>(get(s, "/api/agents"))).providers)
        .map(([p, v]) => [p, v.available]),
    );

  it("reports every provider available from its bundled program alone, with nothing on PATH", async () => {
    delete process.env.THETERMINAL_FAKE_AGENT;
    const s = await createServer({ dataDir: tmp(), port: 0, which: noCli });
    running.push(s);
    expect(await availability(s)).toEqual({ claude: true, codex: true, gemini: true });
  });

  it("consults PATH for a provider only when its bundled program is missing", async () => {
    const which = vi.fn((cmd: string) => (cmd === "gemini" ? "/fake/bin/gemini" : null));
    const { s } = await start(null, { which, bundled: { ...NO_BUNDLED, claude: () => "/bundled/claude" } });
    expect(await availability(s)).toEqual({ claude: true, codex: false, gemini: true });
    expect([...new Set(which.mock.calls.map(([cmd]) => cmd))].sort()).toEqual(["codex", "gemini"]);
  });

  it("locates the bundled programs once at startup, not on every listing or run start", async () => {
    const lookups = { claude: vi.fn(() => null), codex: vi.fn(() => null), gemini: vi.fn(() => null) };
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.GEMINI_API_KEY = FAKE_GEMINI_KEY;
    const { s, projectId } = await start(null, { bundled: lookups });
    await availability(s);
    await availability(s);
    for (const adapter of ["codex", "gemini"]) {
      const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter, prompt: "go" }));
      await untilFinished(s, run.id);
    }
    for (const fn of Object.values(lookups)) expect(fn).toHaveBeenCalledOnce();
  });

  it("a provider with a test binary override reports available only under the fake env", async () => {
    process.env.THETERMINAL_CODEX_BIN = FAKE_CODEX;
    process.env.THETERMINAL_GEMINI_BIN = FAKE_GEMINI;
    const { s: withFake } = await start(script);
    expect(await availability(withFake)).toEqual({ claude: false, codex: true, gemini: true });

    // Decided when the server starts, like the adapters' commands: later changes to the env do not apply.
    delete process.env.THETERMINAL_FAKE_AGENT;
    expect(await availability(withFake)).toEqual({ claude: false, codex: true, gemini: true });
    const { s: real } = await start(null);
    expect(await availability(real)).toEqual({ claude: false, codex: false, gemini: false });
  });

  it("provider-auth rejects unknown body fields", async () => {
    const { s } = await start(script);
    const res = await post(s, "/api/settings/provider-auth", { provider: "codex", mode: "api_key", extra: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
  });

  it("provider-auth sets a provider's mode; a mode the provider lacks or a missing acknowledgement is 400", async () => {
    const { s } = await start(script);
    const wrongMode = await post(s, "/api/settings/provider-auth", { provider: "claude", mode: "chatgpt", acknowledgement: PROVIDER_ACKS.claude });
    expect(wrongMode.status).toBe(400);
    expect(await wrongMode.json()).toMatchObject({ error: "invalid_input" });
    expect((await post(s, "/api/settings/provider-auth", { provider: "codex", mode: "chatgpt" })).status).toBe(400);
    expect((await post(s, "/api/settings/provider-auth", { provider: "codex", mode: "chatgpt", acknowledgement: PROVIDER_ACKS.claude })).status).toBe(400);
    expect((await post(s, "/api/settings/provider-auth", { provider: "gpt", mode: "api_key" })).status).toBe(400);
    expect((await post(s, "/api/settings/provider-auth", { provider: "codex", mode: "none" })).status).toBe(400);
    const before = await json<unknown[]>(get(s, "/api/ledger"));

    const ok = await post(s, "/api/settings/provider-auth", { provider: "codex", mode: "chatgpt", acknowledgement: PROVIDER_ACKS.codex });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ provider: "codex", mode: "chatgpt" });
    const after = await json<{ type: string; payload: unknown }[]>(get(s, "/api/ledger"));
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ type: "settings.provider_auth_changed", payload: { provider: "codex", mode: "chatgpt" } });
    const listing = await json<{ providers: Record<string, { mode: string }> }>(get(s, "/api/agents"));
    expect(listing.providers.codex!.mode).toBe("chatgpt");
    expect(listing.providers.claude!.mode).toBe("api_key");

    expect(await json(post(s, "/api/settings/provider-auth", { provider: "codex", mode: "api_key" }))).toEqual({ provider: "codex", mode: "api_key" });
  });

  it("with the fake env and THETERMINAL_CODEX_BIN, a Codex run goes start, ask, allow, completed", async () => {
    process.env.THETERMINAL_CODEX_BIN = FAKE_CODEX;
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.THETERMINAL_FAKE_CODEX_SCRIPT = JSON.stringify([
      { approve: "command", command: "npm test", itemId: "i1", output: "ok" },
      { message: "All done." },
    ]);
    const { s, projectId } = await start(script);
    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "codex", prompt: "run the tests" });
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect(run).toMatchObject({ adapter: "codex", authMode: "api_key", status: "running" });

    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    expect(action).toMatchObject({ runId: run.id, kind: "shell", tool: "codex.command", summary: "Run: npm test" });
    expect((await post(s, `/api/actions/${action!.id}/decision`, { decision: "allow" })).status).toBe(200);

    await untilFinished(s, run.id);
    const detail = await getRun(s, run.id);
    expect(detail.run).toMatchObject({ status: "completed", error: null });
    expect(detail.actions.map((a) => [a.kind, a.status, a.decidedBy])).toEqual([["shell", "completed", "human"]]);
    const ledger = JSON.stringify(await json(get(s, `/api/ledger?projectId=${projectId}`)));
    expect(ledger).not.toContain(FAKE_OPENAI_KEY);
  });

  it("ignores THETERMINAL_CODEX_BIN without the fake env: the run fails because there is no bundled Codex and none on PATH", async () => {
    delete process.env.THETERMINAL_FAKE_AGENT;
    process.env.THETERMINAL_CODEX_BIN = FAKE_CODEX;
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    const { s, projectId } = await start(null);
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "codex", prompt: "go" }));
    await untilFinished(s, run.id);
    expect((await getRun(s, run.id)).run).toMatchObject({ status: "failed", error: "Codex CLI is unavailable: its bundled program is missing and none is on PATH" });
  });

  it("with the fake env and THETERMINAL_GEMINI_BIN, a Gemini run goes start, ask, allow, completed", async () => {
    process.env.THETERMINAL_GEMINI_BIN = FAKE_GEMINI;
    process.env.GEMINI_API_KEY = FAKE_GEMINI_KEY;
    process.env.THETERMINAL_FAKE_GEMINI_SCRIPT = JSON.stringify([
      { type: "write", path: "notes.txt", content: "hello", permission: true },
      { type: "message", text: "All done." },
    ]);
    const { s, projectId } = await start(script);
    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "gemini", prompt: "write the notes" });
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect(run).toMatchObject({ adapter: "gemini", authMode: "api_key", status: "running" });

    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    expect(action).toMatchObject({ runId: run.id, kind: "file_edit" });
    expect((await post(s, `/api/actions/${action!.id}/decision`, { decision: "allow" })).status).toBe(200);

    await untilFinished(s, run.id);
    const detail = await getRun(s, run.id);
    expect(detail.run).toMatchObject({ status: "completed", error: null });
    expect(detail.actions.map((a) => [a.kind, a.status, a.decidedBy])).toEqual([["file_edit", "completed", "human"]]);
    const ledger = JSON.stringify(await json(get(s, `/api/ledger?projectId=${projectId}`)));
    expect(ledger).not.toContain(FAKE_GEMINI_KEY);
  });

  it("ignores THETERMINAL_GEMINI_BIN without the fake env: the run fails because there is no bundled Gemini CLI and none on PATH", async () => {
    delete process.env.THETERMINAL_FAKE_AGENT;
    process.env.THETERMINAL_GEMINI_BIN = FAKE_GEMINI;
    process.env.GEMINI_API_KEY = FAKE_GEMINI_KEY;
    const { s, projectId } = await start(null);
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "gemini", prompt: "go" }));
    await untilFinished(s, run.id);
    expect((await getRun(s, run.id)).run).toMatchObject({ status: "failed", error: "Gemini CLI is unavailable: its bundled program is missing and none is on PATH" });
  });

  it("registers claude, codex and gemini when the fake env var is unset, and rejects a fake run with 400", async () => {
    delete process.env.THETERMINAL_FAKE_AGENT;
    const { s, projectId } = await start(null);
    expect((await json<{ adapters: string[] }>(get(s, "/api/agents"))).adapters).toEqual(["claude", "codex", "gemini"]);
    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input" });
  });

  it("an unknown adapter is 400 invalid_input; an unknown project is 404", async () => {
    const { s, projectId } = await start(script);
    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "gpt", prompt: "go" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect((await post(s, "/api/projects/nope/runs", { adapter: "fake", prompt: "go" })).status).toBe(404);
    expect((await get(s, "/api/projects/nope/pending-actions")).status).toBe(404);
    expect((await get(s, "/api/runs/nope")).status).toBe(404);
    expect((await post(s, "/api/actions/nope/decision", { decision: "allow" })).status).toBe(404);
  });

  it("an empty or oversized prompt is 400 invalid_input, before any project work", async () => {
    const { s, projectId } = await start(script);
    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect((await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "x".repeat(20001) })).status).toBe(400);
    expect((await post(s, "/api/projects/nope/runs", { adapter: "fake", prompt: "" })).status).toBe(400);
  });

  it("a run's card must exist in the same project", async () => {
    const { s, projectId, dataDir } = await start(script);
    const other = await json<{ id: string }>(post(s, "/api/projects", { name: "Other", pitch: "y" }));
    const foreign = await json<{ id: string }>(post(s, `/api/projects/${other.id}/cards`, { title: "F", stage: "plan" }));
    const card = await json<{ id: string }>(post(s, `/api/projects/${projectId}/cards`, { title: "C", stage: "plan" }));
    const before = await json<unknown[]>(get(s, "/api/ledger"));

    const missing = await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go", cardId: "nope" });
    expect(missing.status).toBe(404);
    const cross = await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go", cardId: foreign.id });
    expect(cross.status).toBe(404);
    expect(await json<unknown[]>(get(s, "/api/ledger"))).toHaveLength(before.length);
    expect(await json(get(s, `/api/projects/${projectId}/runs`))).toEqual([]);
    expect(existsSync(join(dataDir, "projects", projectId))).toBe(false);

    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go", cardId: card.id });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ cardId: card.id });
  });

  it("starts, lists, inspects and approves a scripted run end to end", async () => {
    const { s, projectId } = await start(script);
    const res = await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "do it" });
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect(run).toMatchObject({ projectId, adapter: "fake", authMode: "none", status: "running", cardId: null });

    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    expect(action).toMatchObject({ runId: run.id, kind: "shell", status: "pending" });

    const decided = await post(s, `/api/actions/${action!.id}/decision`, { decision: "allow", reason: "fine" });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ id: action!.id, status: "allowed", decidedBy: "human", reason: "fine" });

    await untilFinished(s, run.id);
    const detail = await getRun(s, run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.actions.map((a) => [a.kind, a.status, a.decidedBy])).toEqual([
      ["file_read", "completed", "policy"],
      ["shell", "completed", "human"],
    ]);

    const second = (await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "again" })));
    const list = await json<AgentRun[]>(get(s, `/api/projects/${projectId}/runs`));
    expect(list.map((r) => r.id)).toEqual([second.id, run.id]);
  });

  it("a second decision is 409 already_decided, and so is a decision on an auto-decided action", async () => {
    const { s, projectId } = await start(script);
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" }));
    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    expect((await post(s, `/api/actions/${action!.id}/decision`, { decision: "deny" })).status).toBe(200);
    const again = await post(s, `/api/actions/${action!.id}/decision`, { decision: "allow" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_decided" });

    const auto = (await getRun(s, run.id)).actions.find((a) => a.decidedBy === "policy")!;
    const res = await post(s, `/api/actions/${auto.id}/decision`, { decision: "deny" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_decided" });

    expect((await post(s, `/api/actions/${action!.id}/decision`, { decision: "maybe" })).status).toBe(400);
  });

  it("stops a run with a pending action, and stopping a finished run returns it unchanged", async () => {
    const { s, projectId } = await start(script);
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" }));
    await untilPending(s, projectId);
    const res = await post(s, `/api/runs/${run.id}/stop`);
    expect(res.status).toBe(200);
    const stopped = (await res.json()) as AgentRun;
    expect(stopped).toMatchObject({ id: run.id, status: "stopped" });
    expect(await pending(s, projectId)).toEqual([]);

    const again = await post(s, `/api/runs/${run.id}/stop`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(stopped);
    expect((await post(s, "/api/runs/nope/stop")).status).toBe(404);
  });

  it("the claude-auth alias switches Claude auth mode; subscription needs the exact acknowledgement", async () => {
    const { s } = await start(script);
    const bad = await post(s, "/api/settings/claude-auth", { mode: "subscription" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
    expect((await post(s, "/api/settings/claude-auth", { mode: "subscription", acknowledgement: "ok" })).status).toBe(400);
    expect((await post(s, "/api/settings/claude-auth", { mode: "other" })).status).toBe(400);

    const ok = await post(s, "/api/settings/claude-auth", { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ mode: "subscription" });
    const listing = await json<{ providers: Record<string, { mode: string }> }>(get(s, "/api/agents"));
    expect(listing.providers.claude!.mode).toBe("subscription");

    expect(await json(post(s, "/api/settings/claude-auth", { mode: "api_key" }))).toEqual({ mode: "api_key" });
  });

  it("a scripted throw fails the run, the action stays denied, and responses are bounded", async () => {
    const { s, projectId } = await start([{ propose: { ...shell, paths: [] } }, { throw: "boom" }]);
    let t = Date.now();
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" }));
    expect(Date.now() - t).toBeLessThan(BOUNDED_MS);
    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    t = Date.now();
    expect((await post(s, `/api/actions/${action!.id}/decision`, { decision: "deny" })).status).toBe(200);
    expect(Date.now() - t).toBeLessThan(BOUNDED_MS);

    await untilFinished(s, run.id);
    const detail = await getRun(s, run.id);
    expect(detail.run).toMatchObject({ status: "failed", error: "boom" });
    expect(detail.actions).toMatchObject([{ id: action!.id, status: "denied" }]);
  });

  it("uses a default script when THETERMINAL_FAKE_SCRIPT is unset", async () => {
    delete process.env.THETERMINAL_FAKE_SCRIPT;
    const { s, projectId } = await start();
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" }));
    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    expect(action).toMatchObject({ kind: "shell" });
    await post(s, `/api/actions/${action!.id}/decision`, { decision: "allow" });
    await untilFinished(s, run.id);
    const detail = await getRun(s, run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.actions.map((a) => a.kind)).toEqual(["file_read", "shell"]);
  });

  it("refuses to start when THETERMINAL_FAKE_SCRIPT is not valid JSON", async () => {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_SCRIPT = "{not json";
    await expect(createServer({ dataDir: tmp(), port: 0 })).rejects.toThrow(/THETERMINAL_FAKE_SCRIPT/);
  });

  it("repairs a modified shared git config at startup: emptied and read-only", async () => {
    const dataDir = tmp();
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    writeFileSync(cfg, "[user]\n\temail = someone@example.com\n");
    const s = await createServer({ dataDir, port: 0, which: noCli });
    running.push(s);
    expect(readFileSync(cfg, "utf8")).toBe("");
    if (process.platform !== "win32") expect(statSync(cfg).mode & 0o777).toBe(0o444);
  });

  describe("a shared git config that cannot be repaired at startup", () => {
    /** Starts with console.warn captured; returns what was warned. */
    async function startWarned(dataDir: string): Promise<string[]> {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        running.push(await createServer({ dataDir, port: 0, which: noCli }));
        return warn.mock.calls.map((c) => c.map(String).join(" "));
      } finally {
        warn.mockRestore();
      }
    }

    it.skipIf(process.platform === "win32")("a symlink: starts and warns with a fixed message holding no path", async () => {
      const dataDir = tmp();
      const target = join(tmp(), "target");
      writeFileSync(target, "x");
      symlinkSync(target, join(dataDir, EMPTY_GITCONFIG));
      const warned = await startWarned(dataDir);
      expect(warned).toEqual(["The Terminal: the shared git config is not a regular file; agent runs will fail until it is removed"]);
      expect(readFileSync(target, "utf8")).toBe("x");
    });

    it("a hard link: starts, leaves the linked file alone and warns with a fixed message holding no path", async () => {
      const dataDir = tmp();
      const other = join(tmp(), "other-config");
      writeFileSync(other, "[user]\n\tname = x\n");
      linkSync(other, join(dataDir, EMPTY_GITCONFIG));
      const warned = await startWarned(dataDir);
      expect(warned).toEqual(["The Terminal: the shared git config has another hard link; agent runs will fail until it is removed"]);
      expect(readFileSync(other, "utf8")).toBe("[user]\n\tname = x\n");
    });

    it("any other repair error: never thrown, warned with a fixed message holding no path or error text", () => {
      const dataDir = tmp();
      const warned: string[] = [];
      const failing = () => {
        throw Object.assign(new Error(`EPERM: operation not permitted, open '${join(dataDir, EMPTY_GITCONFIG)}'`), { code: "EPERM" });
      };
      expect(() => repairSharedGitconfig(dataDir, failing, (m) => warned.push(m))).not.toThrow();
      expect(warned).toEqual(["The Terminal: the shared git config could not be repaired; agent runs will fail until this is fixed"]);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a config that cannot be checked: warned as such, not as a non-file", () => {
      const dataDir = tmp();
      ensureEmptyGitconfig(dataDir);
      const warned: string[] = [];
      chmodSync(dataDir, 0o600); // no search permission: lstat fails with EACCES
      try {
        repairSharedGitconfig(dataDir, ensureEmptyGitconfig, (m) => warned.push(m));
      } finally {
        chmodSync(dataDir, 0o700);
      }
      expect(warned).toEqual(["The Terminal: the shared git config could not be checked; agent runs will fail until this is fixed"]);
    });
  });

  it("close() with a pending action does not hang, and records the run as stopped", async () => {
    const dataDir = tmp();
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
    const s = await createServer({ dataDir, port: 0, shutdownTimeoutMs: 500 });
    const project = await json<{ id: string }>(post(s, "/api/projects", { name: "P", pitch: "x" }));
    const run = await json<AgentRun>(post(s, `/api/projects/${project.id}/runs`, { adapter: "fake", prompt: "go" }));
    await untilPending(s, project.id);

    const t = Date.now();
    await s.close();
    expect(Date.now() - t).toBeLessThan(3000);

    const b = await createServer({ dataDir, port: 0 });
    running.push(b);
    const detail = await getRun(b, run.id);
    expect(detail.run.status).toBe("stopped");
    expect(detail.actions.map((a) => a.status)).toEqual(["completed", "denied"]);
  });

  it("lists pending actions from every project at /api/pending-actions", async () => {
    const { s, projectId } = await start([{ propose: { ...shell, paths: [] } }]);
    const other = await json<{ id: string }>(post(s, "/api/projects", { name: "Other" }));
    expect(await json(get(s, "/api/pending-actions"))).toEqual([]);
    await post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" });
    await untilPending(s, projectId);
    await post(s, `/api/projects/${other.id}/runs`, { adapter: "fake", prompt: "go" });
    await untilPending(s, other.id);
    const all = await json<(AgentAction & { projectId: string; projectName: string })[]>(get(s, "/api/pending-actions"));
    expect(all.map((a) => [a.projectId, a.projectName, a.summary])).toEqual([
      [projectId, "P", "run tests"],
      [other.id, "Other", "run tests"],
    ]);
    expect(await pending(s, projectId)).toHaveLength(1);
  });

  it("starting a run while the workspace shuts down is 503 shutting_down", async () => {
    const dataDir = tmp();
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const board = new BoardService(db, ledger);
    const projectId = board.createProject({ kind: "human", id: "owner" }, { name: "P" }).id;
    const runner = new AgentRunner({
      db, ledger, worktrees: new WorktreeManager(dataDir), broker: new ApprovalBroker(),
      adapters: { fake: new FakeAdapter(script) }, extraSecrets: () => [], dataDir,
    });
    const app = Fastify();
    try {
      registerRoutes(app, { board, gates: new GateService({ db, ledger }), ledger, getIntegrity: () => ({ ok: true, count: 0 }) });
      registerAgentRoutes(app, { db, runner, settings: new ProviderSettings(db, ledger), adapters: ["fake"], available: () => false, apiKey: () => "none" });
      await runner.shutdown();
      const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/runs`, payload: { adapter: "fake", prompt: "go" } });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "shutting_down" });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("redacts the values of secret-named environment variables from everything recorded", async () => {
    process.env.FAKE_SERVICE_TOKEN = "fake-service-value-0003";
    const { s, projectId } = await start([{ message: "the value is fake-service-value-0003" }]);
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" }));
    await untilFinished(s, run.id);
    const entries = await json<{ type: string; payload: { text?: string } }[]>(get(s, `/api/ledger?projectId=${projectId}`));
    const text = entries.find((e) => e.type === "agent.message")!.payload.text;
    expect(text).toBe("the value is [REDACTED]");
  });

  it("at startup, denies actions left pending and fails runs left running by a crash", async () => {
    const dataDir = tmp();
    // Simulate a crash: a runner on the server's database is abandoned with an action pending.
    const db = openDatabase(join(dataDir, "ledger.db"));
    const ledger = new Ledger(db);
    const projectId = new BoardService(db, ledger).createProject({ kind: "human", id: "owner" }, { name: "P" }).id;
    const crashed = new AgentRunner({
      db, ledger, worktrees: new WorktreeManager(dataDir), broker: new ApprovalBroker(),
      adapters: { fake: new FakeAdapter(script) }, extraSecrets: () => [], dataDir,
    });
    const run = await crashed.start({ kind: "human", id: "owner" }, { projectId, adapter: "fake", prompt: "go" });
    await vi.waitFor(() => expect(listPendingActions(db, projectId)).toHaveLength(1), { timeout: WAIT_MS, interval: 25 });
    db.close();

    const s = await createServer({ dataDir, port: 0 });
    running.push(s);
    const detail = await getRun(s, run.id);
    expect(detail.run).toMatchObject({ status: "failed", error: "workspace restarted" });
    expect(detail.actions.map((a) => [a.status, a.reason])).toEqual([
      ["completed", "read-only inside worktree"],
      ["denied", "workspace restarted"],
    ]);
  });
});

describe("POST /api/projects/:id/runs with connectionIds", { timeout: 15000 }, () => {
  const AWS = {
    kind: "cloud", provider: "aws", name: "AWS dev", config: { region: "eu-west-1" },
    secrets: { accessKeyId: "AKIATESTKEY000000000", secretAccessKey: "TESTKEY-static-secret-0000000000" },
  };
  const AZURE = {
    kind: "cloud", provider: "azure", name: "Azure dev",
    config: {
      tenantId: "00000000-0000-0000-0000-00000000aaaa", clientId: "00000000-0000-0000-0000-00000000bbbb",
      subscriptionId: "00000000-0000-0000-0000-00000000cccc",
    },
    secrets: { clientSecret: "TESTKEY-azure-secret-0000000000" },
  };
  const add = async (s: RunningServer, body: unknown) => (await json<{ id: string }>(post(s, "/api/connections", body))).id;
  const startRun = (s: RunningServer, projectId: string, connectionIds: unknown, adapter = "fake") =>
    post(s, `/api/projects/${projectId}/runs`, { adapter, prompt: "go", connectionIds });
  const used = async (s: RunningServer) =>
    (await json<{ type: string; payload: Record<string, unknown> }[]>(get(s, "/api/ledger"))).filter((e) => e.type === "connection.used");

  it("gives the run the selected cloud credentials and records connection.used without any value", async () => {
    const { s, projectId } = await start(script, { secrets: new MemorySecretStore(), sts: fakeSts });
    const id = await add(s, AZURE);
    const res = await startRun(s, projectId, [id]);
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect((await used(s)).map((e) => e.payload)).toEqual([
      { connectionId: id, name: "Azure dev", runId: run.id, purpose: "cloud_credentials", credential: "azure_client_secret", expiresAt: null },
    ]);
    expect(await (await get(s, "/api/ledger")).text()).not.toContain("TESTKEY-azure-secret");
  });

  it("a disabled connection is 400 connection_disabled and nothing is recorded", async () => {
    const { s, projectId } = await start(script, { secrets: new MemorySecretStore(), sts: fakeSts });
    const id = await add(s, AWS);
    const patched = await fetch(`${base(s)}/api/connections/${id}`, { method: "PATCH", headers: headers(s), body: JSON.stringify({ enabled: false }) });
    expect(patched.status).toBe(200);
    const res = await startRun(s, projectId, [id]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "connection_disabled" });
    expect(await used(s)).toEqual([]);
    expect(await json(get(s, `/api/projects/${projectId}/runs`))).toEqual([]);
  });

  it("a model connection is 400 connection_unsupported; an unknown id is 404", async () => {
    const { s, projectId } = await start(script, { secrets: new MemorySecretStore(), sts: fakeSts });
    const llm = await add(s, { kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: "sk-ant-TESTKEY-0000000000" } });
    const res = await startRun(s, projectId, [llm]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "connection_unsupported" });
    const unknown = await startRun(s, projectId, ["no-such-connection"]);
    expect(unknown.status).toBe(404);
    expect(await used(s)).toEqual([]);
  });

  it("a cloud provider that refuses is 502 cloud_credentials_failed with the connection name, and no run exists", async () => {
    const rejecting: StsCaller = {
      ...fakeSts,
      sessionToken: async () => {
        throw new AwsRejectedError("InvalidClientTokenId");
      },
    };
    const { s, projectId, dataDir } = await start(script, { secrets: new MemorySecretStore(), sts: rejecting });
    const id = await add(s, AWS);
    const res = await startRun(s, projectId, [id]);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "cloud_credentials_failed", name: "AWS dev" });
    expect(await json(get(s, `/api/projects/${projectId}/runs`))).toEqual([]);
    expect(await used(s)).toEqual([]);
    expect(existsSync(join(dataDir, "projects", projectId, "worktrees")) ? readdirSync(join(dataDir, "projects", projectId, "worktrees")) : []).toEqual([]);
  });

  it("two cloud connections of one provider are 400 duplicate_cloud_provider, before anything is minted", async () => {
    const sessionToken = vi.fn(fakeSts.sessionToken);
    const { s, projectId } = await start(script, { secrets: new MemorySecretStore(), sts: { ...fakeSts, sessionToken } });
    const a = await add(s, AWS);
    const b = await add(s, { ...AWS, name: "AWS prod" });
    const res = await startRun(s, projectId, [a, b]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "duplicate_cloud_provider" });
    expect(sessionToken).not.toHaveBeenCalled();
    expect(await used(s)).toEqual([]);
  });

  it("a Codex run with an MCP server is 400 mcp_unsupported", async () => {
    const { s, projectId } = await start(null, { secrets: new MemorySecretStore(), sts: fakeSts });
    const id = await add(s, { kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "https://mcp.example.com/mcp" } });
    const res = await startRun(s, projectId, [id], "codex");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "mcp_unsupported", adapter: "codex" });
    expect(await used(s)).toEqual([]);
  });

  it("a Gemini run with an MCP server is 400 mcp_unsupported, and records no connection.used", async () => {
    const { s, projectId } = await start(null, { secrets: new MemorySecretStore(), sts: fakeSts });
    const id = await add(s, { kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "https://mcp.example.com/mcp" } });
    const res = await startRun(s, projectId, [id], "gemini");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "mcp_unsupported", adapter: "gemini" });
    expect(await used(s)).toEqual([]);
  });

  it("a Claude run accepts an MCP server: 201, and connection.used records it without the header value", async () => {
    const { s, projectId } = await start(null, { secrets: new MemorySecretStore(), sts: fakeSts });
    const id = await add(s, {
      kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "https://mcp.example.com/mcp" },
      secrets: { headers: "Authorization=Bearer TESTKEY-mcp-route-0000000000" },
    });
    const res = await startRun(s, projectId, [id], "claude");
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect((await used(s)).map((e) => e.payload)).toEqual([{ connectionId: id, name: "Docs", runId: run.id, purpose: "mcp_server" }]);
    // No Claude program here (NO_BUNDLED, no PATH): the run fails at launch, after the grant was recorded.
    await untilFinished(s, run.id);
    expect(await (await get(s, "/api/ledger")).text()).not.toContain("TESTKEY-mcp-route");
  });

  it("more than 10 ids is 400 invalid_input; without the token it is 401", async () => {
    const { s, projectId } = await start(script, { secrets: new MemorySecretStore(), sts: fakeSts });
    const res = await startRun(s, projectId, Array.from({ length: 11 }, (_, i) => `id-${i}`));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_input");
    const anonymous = await fetch(`${base(s)}/api/projects/${projectId}/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapter: "fake", prompt: "go", connectionIds: [] }),
    });
    expect(anonymous.status).toBe(401);
  });
});
