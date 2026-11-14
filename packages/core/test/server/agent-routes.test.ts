import Fastify from "fastify";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_ACK, type AgentAction, type AgentRun } from "@theterminal/shared";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { FakeAdapter, type FakeStep } from "../../src/agents/fake-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { ProviderSettings } from "../../src/agents/settings.js";
import { registerAgentRoutes } from "../../src/server/agent-routes.js";
import { registerRoutes } from "../../src/server/routes.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase } from "../../src/db.js";
import { listPendingActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT", "FAKE_SERVICE_TOKEN"] as const;
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

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tt-agents-"));
  dirs.push(d);
  return d;
};

/** Starts a server with the fake adapter enabled (when `script` is given) and one project. */
async function start(script?: FakeStep[] | null, opts: { shutdownTimeoutMs?: number } = {}) {
  if (script !== null) {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    if (script) process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
  }
  const dataDir = tmp();
  const s = await createServer({ dataDir, port: 0, ...opts });
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
const untilPending = (s: RunningServer, projectId: string, n = 1) =>
  vi.waitFor(async () => expect(await pending(s, projectId)).toHaveLength(n), { timeout: 5000, interval: 25 });
const untilFinished = (s: RunningServer, runId: string) =>
  vi.waitFor(async () => expect((await getRun(s, runId)).run.status).not.toBe("running"), { timeout: 5000, interval: 25 });

const read = { tool: "Read", kind: "file_read", summary: "read README", input: { path: "README.md" }, paths: ["README.md"] } as const;
const shell = { tool: "Bash", kind: "shell", summary: "run tests", input: { command: "npm test" }, paths: [] } as const;
const script: FakeStep[] = [
  { propose: { ...read, paths: [...read.paths] }, result: { ok: true, output: "hello" } },
  { propose: { ...shell, paths: [] }, result: { ok: true, output: "ok" } },
];

describe("agent API", { timeout: 15000 }, () => {
  it("GET /api/agents lists registered adapters, the auth mode and the acknowledgement", async () => {
    const { s } = await start(script);
    expect(await json(get(s, "/api/agents"))).toEqual({
      adapters: ["claude", "fake"],
      claudeAuthMode: "api_key",
      subscriptionAck: CLAUDE_SUBSCRIPTION_ACK,
    });
  });

  it("registers only claude when the fake env var is unset, and rejects a fake run with 400", async () => {
    delete process.env.THETERMINAL_FAKE_AGENT;
    const { s, projectId } = await start(null);
    expect((await json<{ adapters: string[] }>(get(s, "/api/agents"))).adapters).toEqual(["claude"]);
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

  it("switches Claude auth mode; subscription needs the exact acknowledgement", async () => {
    const { s } = await start(script);
    const bad = await post(s, "/api/settings/claude-auth", { mode: "subscription" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
    expect((await post(s, "/api/settings/claude-auth", { mode: "subscription", acknowledgement: "ok" })).status).toBe(400);
    expect((await post(s, "/api/settings/claude-auth", { mode: "other" })).status).toBe(400);

    const ok = await post(s, "/api/settings/claude-auth", { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ mode: "subscription" });
    expect((await json<{ claudeAuthMode: string }>(get(s, "/api/agents"))).claudeAuthMode).toBe("subscription");

    expect(await json(post(s, "/api/settings/claude-auth", { mode: "api_key" }))).toEqual({ mode: "api_key" });
  });

  it("a scripted throw fails the run, the action stays denied, and responses are bounded", async () => {
    const { s, projectId } = await start([{ propose: { ...shell, paths: [] } }, { throw: "boom" }]);
    let t = Date.now();
    const run = await json<AgentRun>(post(s, `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "go" }));
    expect(Date.now() - t).toBeLessThan(3000);
    await untilPending(s, projectId);
    const [action] = await pending(s, projectId);
    t = Date.now();
    expect((await post(s, `/api/actions/${action!.id}/decision`, { decision: "deny" })).status).toBe(200);
    expect(Date.now() - t).toBeLessThan(3000);

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
      adapters: { fake: new FakeAdapter(script) }, extraSecrets: [], dataDir,
    });
    const app = Fastify();
    try {
      registerRoutes(app, { board, ledger, getIntegrity: () => ({ ok: true, count: 0 }) });
      registerAgentRoutes(app, { db, runner, settings: new ProviderSettings(db, ledger), adapters: ["fake"] });
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
      adapters: { fake: new FakeAdapter(script) }, extraSecrets: [], dataDir,
    });
    const run = await crashed.start({ kind: "human", id: "owner" }, { projectId, adapter: "fake", prompt: "go" });
    await vi.waitFor(() => expect(listPendingActions(db, projectId)).toHaveLength(1), { timeout: 5000, interval: 25 });
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
