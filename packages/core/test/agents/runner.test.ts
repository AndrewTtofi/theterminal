import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { ApprovalBroker, AlreadyDecidedError } from "../../src/agents/approvals.js";
import { FakeAdapter, type FakeStep } from "../../src/agents/fake-adapter.js";
import { AdapterUnavailableError, AgentRunner } from "../../src/agents/runner.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService, NotFoundError } from "../../src/board/board-service.js";
import { openDatabase, type Db } from "../../src/db.js";
import { getRun, listActions, listPendingActions } from "../../src/events/projections.js";
import { Ledger, LedgerReadOnlyError } from "../../src/ledger/ledger.js";

const owner = { kind: "human", id: "owner" } as const;
const EXTRA_SECRET = "extra-secret-value-0001";
const FAKE_KEY = "sk-ant-TESTKEY0123456789abcdef";

let dataDir: string;
let db: Db;
let ledger: Ledger;
let worktrees: WorktreeManager;
let projectId: string;
const runners: AgentRunner[] = [];

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "runner-data-")));
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  worktrees = new WorktreeManager(dataDir);
  projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
});
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.shutdown()));
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRunner(adapters: Partial<Record<"claude" | "fake", AgentAdapter>>, broker = new ApprovalBroker(), shutdownTimeoutMs?: number) {
  const r = new AgentRunner({ db, ledger, worktrees, broker, adapters, extraSecrets: [EXTRA_SECRET], dataDir, shutdownTimeoutMs });
  runners.push(r);
  return r;
}
const fakeRunner = (script: FakeStep[]) => makeRunner({ fake: new FakeAdapter(script) });

const allStrings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(allStrings) : [];
const agentEvents = () => ledger.list().filter((e) => e.type.startsWith("agent."));
const untilFinished = (runId: string) =>
  vi.waitFor(() => expect(getRun(db, runId)!.status).not.toBe("running"), { timeout: 5000 });
const untilPending = (n = 1) =>
  vi.waitFor(() => expect(listPendingActions(db, projectId)).toHaveLength(n), { timeout: 5000 });

const read = { tool: "Read", kind: "file_read" as const, summary: "read README", input: { path: "README.md" }, paths: ["README.md"] };
const write = { tool: "Write", kind: "file_write" as const, summary: "write notes", input: { path: "notes.md" }, paths: ["notes.md"] };

describe("AgentRunner with the FakeAdapter", () => {
  it("runs the happy path in ledger order, with a policy read and a human-approved write", async () => {
    const runner = fakeRunner([
      { propose: read, result: { ok: true, output: "hello" } },
      { propose: write, result: { ok: true, output: "written" } },
    ]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "do the thing" });
    expect(run).toMatchObject({ status: "running", adapter: "fake", authMode: "none", cardId: null });
    expect(run.worktree).toBe(`projects/${projectId}/worktrees/${run.id}`);

    await untilPending();
    const [pending] = listPendingActions(db, projectId);
    const decided = runner.decide(owner, pending!.id, "allow", "fine");
    expect(decided).toMatchObject({ id: pending!.id, status: "allowed", decidedBy: "human", reason: "fine" });
    await untilFinished(run.id);

    const events = agentEvents();
    expect(events.map((e) => [e.type, e.actor.kind, (e.payload as { by?: string }).by])).toEqual([
      ["agent.started", "human", undefined],
      ["agent.action.requested", "agent", undefined],
      ["agent.action.decided", "system", "policy"],
      ["agent.action.completed", "agent", undefined],
      ["agent.action.requested", "agent", undefined],
      ["agent.action.decided", "human", "human"],
      ["agent.action.completed", "agent", undefined],
      ["agent.finished", "system", undefined],
    ]);
    expect(events[1]!.actor.id).toBe(run.id);
    expect(events.at(-1)!.actor.id).toBe("runner");
    const { run: done, actions } = runner.getRun(run.id);
    expect(done).toMatchObject({ status: "completed", costUsd: 0, error: null });
    expect(actions.map((a) => [a.kind, a.status, a.decidedBy, a.output])).toEqual([
      ["file_read", "completed", "policy", "hello"],
      ["file_write", "completed", "human", "written"],
    ]);
    expect(runner.listRuns(projectId).map((r) => r.id)).toEqual([run.id]);
  });

  it("a denied action never gets an action_result", async () => {
    const runner = fakeRunner([
      { propose: write, result: { ok: true, output: "written" } },
      { propose: { ...read, paths: ["../outside.txt"] }, result: { ok: true, output: "leaked" } },
    ]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    runner.decide(owner, listPendingActions(db, projectId)[0]!.id, "deny", "not now");
    await untilFinished(run.id);
    expect(agentEvents().filter((e) => e.type === "agent.action.completed")).toEqual([]);
    expect(listActions(db, run.id).map((a) => [a.status, a.decidedBy, a.reason])).toEqual([
      ["denied", "human", "not now"],
      ["denied", "policy", "outside worktree"],
    ]);
    expect(getRun(db, run.id)!.status).toBe("completed");
  });

  it("keeps secrets from scripted input, output, messages and errors out of the ledger", async () => {
    const runner = fakeRunner([
      {
        propose: {
          tool: "Bash", kind: "shell", summary: `curl with ${FAKE_KEY}`,
          input: { command: `curl -H 'Authorization: Bearer abcdef0123456789' x`, api_key: FAKE_KEY, note: EXTRA_SECRET },
          paths: [],
        },
        result: { ok: true, output: `token=${EXTRA_SECRET}` },
      },
      { message: `my key is ${FAKE_KEY}` },
      { throw: `boom ${EXTRA_SECRET}` },
    ]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: `use ${EXTRA_SECRET}` });
    await untilPending();
    runner.decide(owner, listPendingActions(db, projectId)[0]!.id, "allow");
    await untilFinished(run.id);
    const all = JSON.stringify(ledger.list());
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain(EXTRA_SECRET);
    expect(all).not.toContain("abcdef0123456789");
    expect(all).toContain("[REDACTED]");
    expect(getRun(db, run.id)).toMatchObject({ status: "failed", error: "boom [REDACTED]" });
  });

  it("a second decide throws AlreadyDecidedError and an unknown action NotFoundError", async () => {
    const runner = fakeRunner([{ propose: write }]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    const id = listPendingActions(db, projectId)[0]!.id;
    runner.decide(owner, id, "deny");
    expect(() => runner.decide(owner, id, "allow")).toThrow(AlreadyDecidedError);
    expect(() => runner.decide(owner, "missing", "allow")).toThrow(NotFoundError);
    await untilFinished(run.id);
    expect(agentEvents().filter((e) => e.type === "agent.action.decided")).toHaveLength(1);
  });

  it("stop denies pending actions with 'run stopped' and finishes the run as stopped", async () => {
    const runner = fakeRunner([{ propose: write }, { message: "never" }]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    runner.stop(owner, run.id);
    expect(getRun(db, run.id)).toMatchObject({ status: "stopped" });
    expect(listActions(db, run.id).map((a) => [a.status, a.decidedBy, a.reason])).toEqual([["denied", "policy", "run stopped"]]);
    await runner.shutdown();
    const types = agentEvents().map((e) => e.type);
    expect(types).toEqual(["agent.started", "agent.action.requested", "agent.action.decided", "agent.finished"]);
  });

  it("fails closed: an unrecordable action is recorded as a fallback request and denied", async () => {
    const runner = fakeRunner([{ propose: { ...write, input: { n: 10n } }, result: { ok: true, output: "x" } }]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilFinished(run.id);
    const gated = agentEvents().filter((e) => e.type.startsWith("agent.action."));
    expect(gated.map((e) => e.type)).toEqual(["agent.action.requested", "agent.action.decided"]);
    expect(gated[0]!.payload).toMatchObject({ kind: "other", tool: "unknown", summary: "(unrecordable action)", input: null });
    expect(gated[1]!.payload).toMatchObject({ decision: "deny", by: "policy", reason: "internal error" });
    expect(gated[1]!.actor).toEqual({ kind: "system", id: "policy" });
  });

  it("coerces an unknown kind to 'other' and a non-string tool or summary to strings", async () => {
    const runner = fakeRunner([{ propose: { ...write, kind: "bogus" as never, tool: 42 as never, summary: null as never } }]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    expect(listActions(db, run.id)[0]).toMatchObject({ kind: "other", tool: "42", summary: "(no summary)", status: "pending" });
  });

  it("normalises class instances and toJSON values before redacting them", async () => {
    class Holder {
      api_key = FAKE_KEY;
      label = "holder";
    }
    const withToJson = { toJSON: () => ({ password: "hunter2-probe", note: `key ${FAKE_KEY}` }) };
    const runner = fakeRunner([{ propose: { ...read, input: { a: new Holder(), b: withToJson } }, result: { ok: true, output: "ok" } }]);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilFinished(run.id);
    expect(JSON.stringify(ledger.list())).not.toContain(FAKE_KEY);
    expect(JSON.stringify(ledger.list())).not.toContain("hunter2-probe");
    expect(listActions(db, run.id)[0]).toMatchObject({
      status: "completed",
      input: { a: { api_key: "[REDACTED]", label: "holder" }, b: { password: "[REDACTED]", note: "key [REDACTED]" } },
    });
  });

  it("records the worktree, dataDir and home directory as '.', '<data>' and '~'", async () => {
    const pathy: AgentAdapter = {
      id: "fake",
      async start(o) {
        const g = await o.gate({
          tool: "Bash", kind: "shell", summary: `cat ${join(o.cwd, "a.txt")}`,
          input: { file: join(o.cwd, "a.txt"), data: join(dataDir, "other"), home: join(homedir(), "notes") },
          paths: [],
        });
        o.emit({ type: "action_result", actionId: g.actionId, ok: true, output: `wrote ${join(o.cwd, "b.txt")}` });
        o.emit({ type: "message", text: `home is ${homedir()}` });
        throw new Error(`failed in ${join(o.cwd, "c")}`);
      },
    };
    const runner = makeRunner({ fake: pathy });
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    runner.decide(owner, listPendingActions(db, projectId)[0]!.id, "allow", `ok ${dataDir}`);
    await untilFinished(run.id);
    const [action] = listActions(db, run.id);
    expect(action).toMatchObject({
      summary: `cat .${sep}a.txt`,
      input: { file: `.${sep}a.txt`, data: `<data>${sep}other`, home: `~${sep}notes` },
      output: `wrote .${sep}b.txt`,
      reason: "ok <data>",
    });
    expect(getRun(db, run.id)!.error).toBe(`failed in .${sep}c`);
    const strings = allStrings(ledger.list().map((e) => e.payload));
    expect(strings.filter((s) => s.includes(dataDir) || s.includes(homedir()))).toEqual([]);
    expect(strings).toContain("home is ~");
  });

  it("shutdown does not hang on an adapter that ignores abort, and forgets the session", async () => {
    const hanging: AgentAdapter = { id: "fake", start: () => new Promise(() => {}) };
    const runner = makeRunner({ fake: hanging }, new ApprovalBroker(), 50);
    const run = await runner.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await runner.shutdown();
    expect(getRun(db, run.id)!.status).toBe("stopped");
    expect((runner as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it("recoverOnStartup denies pending actions and fails running runs", async () => {
    const first = fakeRunner([{ propose: write }]);
    const run = await first.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    const actionId = listPendingActions(db, projectId)[0]!.id;

    makeRunner({}).recoverOnStartup();
    expect(listActions(db, run.id)[0]).toMatchObject({ id: actionId, status: "denied", decidedBy: "policy", reason: "workspace restarted" });
    expect(getRun(db, run.id)).toMatchObject({ status: "failed", error: "workspace restarted" });
    const recovery = agentEvents().slice(-2);
    expect(recovery.map((e) => [e.type, e.actor])).toEqual([
      ["agent.action.decided", { kind: "system", id: "policy" }],
      ["agent.finished", { kind: "system", id: "runner" }],
    ]);
  });

  it("recoverOnStartup does nothing when the ledger is read-only", async () => {
    const first = fakeRunner([{ propose: write }]);
    await first.start(owner, { projectId, adapter: "fake", prompt: "p" });
    await untilPending();
    const before = ledger.list().length;
    ledger.readOnly = true;
    makeRunner({}).recoverOnStartup();
    ledger.readOnly = false;
    expect(ledger.list()).toHaveLength(before);
  });

  it("starting a run in read-only mode throws LedgerReadOnlyError", async () => {
    ledger.readOnly = true;
    await expect(fakeRunner([]).start(owner, { projectId, adapter: "fake", prompt: "p" })).rejects.toThrow(LedgerReadOnlyError);
  });

  it("rejects an unknown project and an unregistered adapter", async () => {
    const runner = fakeRunner([]);
    await expect(runner.start(owner, { projectId: "nope", adapter: "fake", prompt: "p" })).rejects.toThrow(NotFoundError);
    await expect(runner.start(owner, { projectId, adapter: "claude", prompt: "p" })).rejects.toThrow(AdapterUnavailableError);
    expect(agentEvents()).toEqual([]);
  });
});
