import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_ID, type AgentRun, type HomeRuns, type NewLedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { commitEvent } from "../../src/events/commit.js";
import { homeRuns } from "../../src/server/home-routes.js";
import type { FakeStep } from "../../src/agents/fake-adapter.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { localFetch } from "../fixtures/local-fetch.js";

const owner = { kind: "human", id: OWNER_ID } as const;
const same = (s: string) => s;

describe("homeRuns", () => {
  let db: Db;
  let ledger: Ledger;
  let board: BoardService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    ledger = new Ledger(db);
    board = new BoardService(db, ledger);
  });
  afterEach(() => db.close());

  const record = (projectId: string, type: NewLedgerEntry["type"], payload: unknown) =>
    commitEvent(db, ledger, () => ({ event: { projectId, actor: owner, type, payload }, result: () => undefined }));
  const start = (projectId: string, runId: string, prompt = "Fix the login\nand more") =>
    record(projectId, "agent.started", { runId, adapter: "fake", authMode: "none", prompt, cardId: null, worktree: `w/${runId}` });

  it("lists running runs with title, percent, now, waiting and the current step as reason", () => {
    const p = board.createProject(owner, { name: "Club" });
    start(p.id, "run-1");
    record(p.id, "agent.progress", { runId: "run-1", steps: ["Read", "Fix", "Test"], done: [1], current: 2 });
    record(p.id, "agent.action.requested", {
      runId: "run-1", actionId: "a-1", kind: "shell", tool: "Bash", summary: "run the tests", input: { command: "npm test" },
    });
    start(p.id, "run-2");
    const home = homeRuns(db, { projectId: p.id, clean: same });
    expect(home.finishedToday).toEqual([]);
    expect(home.working.map((h) => h.run.id)).toEqual(["run-2", "run-1"]);
    const [plain, planned] = home.working;
    expect(planned).toMatchObject({
      projectName: "Club", title: "Read", percent: 33, waiting: true, reason: "Fix", summary: null,
    });
    expect(planned!.now).toMatch(/^[A-Z]/);
    expect(plain).toMatchObject({ title: "Fix the login", percent: null, now: null, waiting: false, reason: null });
  });

  it("finished today, newest first, with the last message as the summary or the finished headline; another day's runs are left out", () => {
    const p = board.createProject(owner, { name: "Club" });
    start(p.id, "run-1");
    record(p.id, "agent.message", { runId: "run-1", text: "All done: the login works." });
    record(p.id, "agent.finished", { runId: "run-1", status: "completed", costUsd: null, error: null });
    start(p.id, "run-2");
    record(p.id, "agent.finished", { runId: "run-2", status: "failed", costUsd: null, error: "it broke" });
    const home = homeRuns(db, { projectId: p.id, clean: same });
    expect(home.working).toEqual([]);
    expect(home.finishedToday.map((h) => h.run.id)).toEqual(["run-2", "run-1"]);
    expect(home.finishedToday[1]!.summary).toBe("All done: the login works.");
    expect(home.finishedToday[0]!.summary).toContain("failed");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(homeRuns(db, { projectId: p.id, now: tomorrow, clean: same }).finishedToday).toEqual([]);
  });

  it("without a project, every project's runs; with one, only its own", () => {
    const a = board.createProject(owner, { name: "A" });
    const b = board.createProject(owner, { name: "B" });
    start(a.id, "run-a");
    start(b.id, "run-b");
    expect(homeRuns(db, { clean: same }).working.map((h) => [h.run.id, h.projectName]).sort()).toEqual([["run-a", "A"], ["run-b", "B"]]);
    expect(homeRuns(db, { projectId: a.id, clean: same }).working.map((h) => h.run.id)).toEqual(["run-a"]);
  });
});

describe("GET /api/home and /api/status", () => {
  const KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server: RunningServer | null = null;
  let dataDir = "";

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    server = null;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a fake run reporting 1 of 3 and waiting on a decision shows 33%, waiting, the step as reason; both projects without a filter; doneToday once stopped", { timeout: 60_000 }, async () => {
    const script: FakeStep[] = [
      { message: "[[plan: Read | Fix | Test]]" },
      { message: "[[step 1/3 started]]" },
      { message: "[[step 1/3 done]]" },
      { message: "[[step 2/3 started]]" },
      { propose: { tool: "Bash", kind: "shell", summary: "run the tests", input: { command: "npm test" }, paths: [] }, result: { ok: true, output: "ok" } },
    ];
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
    dataDir = mkdtempSync(join(tmpdir(), "tt-home-"));
    server = await createServer({
      dataDir, port: 0, which: () => null, bundled: { claude: () => null, codex: () => null, gemini: () => null },
      secrets: new MemorySecretStore(), discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0,
    });
    const s = server;
    const auth = { authorization: `Bearer ${s.token}` };
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await localFetch(`http://127.0.0.1:${s.port}${path}`, {
        method, headers: { ...auth, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return (await res.json()) as T;
    };
    const a = await call<{ id: string }>("POST", "/api/projects", { name: "Alpha" });
    const b = await call<{ id: string }>("POST", "/api/projects", { name: "Beta" });
    const runA = await call<AgentRun>("POST", `/api/projects/${a.id}/runs`, { adapter: "fake", prompt: "go" });
    const runB = await call<AgentRun>("POST", `/api/projects/${b.id}/runs`, { adapter: "fake", prompt: "go" });
    await vi.waitFor(async () => {
      const home = await call<HomeRuns>("GET", `/api/home?projectId=${a.id}`);
      expect(home.working).toHaveLength(1);
      expect(home.working[0]).toMatchObject({ percent: 33, waiting: true, reason: "Fix", projectName: "Alpha", title: "Read" });
    }, { timeout: 20_000, interval: 100 });
    await vi.waitFor(async () => {
      const all = await call<HomeRuns>("GET", "/api/home");
      expect(all.working.map((h) => h.run.id).sort()).toEqual([runA.id, runB.id].sort());
    }, { timeout: 20_000, interval: 100 });
    for (const r of [runA, runB]) await call("POST", `/api/runs/${r.id}/stop`, {});
    await vi.waitFor(async () => {
      const status = await call<{ doneToday: number }>("GET", "/api/status");
      expect(status.doneToday).toBe(2);
    }, { timeout: 20_000, interval: 100 });
    const finished = await call<HomeRuns>("GET", "/api/home");
    expect(finished.working).toEqual([]);
    expect(finished.finishedToday.map((h) => h.run.id).sort()).toEqual([runA.id, runB.id].sort());
  });
});
