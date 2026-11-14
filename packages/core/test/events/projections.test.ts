import { describe, it, expect, beforeEach } from "vitest";
import { CLAUDE_SUBSCRIPTION_ACK } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { commitEvent } from "../../src/events/commit.js";
import {
  getRun, getSetting, listActions, listPendingActions, listRuns, rebuildAllProjections,
} from "../../src/events/projections.js";

const human = { kind: "human", id: "owner" } as const;
const agent = { kind: "agent", id: "claude" } as const;
let db: Db;
let ledger: Ledger;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
});

const emit = (type: string, payload: Record<string, unknown>, actor: typeof human | typeof agent = agent, projectId: string | null = "p1") =>
  commitEvent(db, ledger, () => ({ event: { projectId, actor, type, payload }, result: (e) => e }));

function script() {
  emit("agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "do it", cardId: "c1", worktree: "wt/r1" });
  emit("agent.message", { runId: "r1", text: "hi" });
  emit("agent.action.requested", { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "ls", input: { b: 1, a: 2 } });
  emit("agent.action.requested", { runId: "r1", actionId: "a2", kind: "file_write", tool: "Write", summary: "w", input: "x" });
  emit("agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "ok" }, human);
  emit("agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: "out" });
  emit("agent.action.decided", { runId: "r1", actionId: "a2", decision: "deny", by: "policy", reason: "no" }, human);
  emit("agent.action.completed", { runId: "r1", actionId: "a2", ok: false, output: "denied" });
  emit("agent.finished", { runId: "r1", status: "completed", costUsd: 0.5, error: null });
}

describe("agent projections", () => {
  it("projects runs and actions", () => {
    script();
    const run = getRun(db, "r1")!;
    expect(run).toMatchObject({
      id: "r1", projectId: "p1", cardId: "c1", adapter: "fake", authMode: "none", prompt: "do it",
      status: "completed", worktree: "wt/r1", costUsd: 0.5, error: null,
    });
    expect(run.finishedAt).toBe(ledger.list().at(-1)!.ts);
    expect(run.startedAt).toBe(ledger.list()[0]!.ts);
    const actions = listActions(db, "r1");
    expect(actions.map((a) => [a.id, a.status, a.decidedBy, a.reason, a.output])).toEqual([
      ["a1", "completed", "human", "ok", "out"],
      ["a2", "failed", "policy", "no", "denied"],
    ]);
    expect(actions[0]!.input).toEqual({ a: 2, b: 1 });
    expect(actions[1]!.input).toBe("x");
    expect(actions[0]!.decidedAt).not.toBeNull();
    expect(listRuns(db, "p1")).toHaveLength(1);
    expect(getRun(db, "nope")).toBeNull();
  });

  it("tracks running state, allowed/denied and pending actions", () => {
    emit("agent.started", { runId: "r1", adapter: "claude", authMode: "api_key", prompt: "p", cardId: null, worktree: "wt/r1" });
    emit("agent.action.requested", { runId: "r1", actionId: "a1", kind: "web", tool: "Fetch", summary: "s", input: null });
    emit("agent.action.requested", { runId: "r1", actionId: "a2", kind: "web", tool: "Fetch", summary: "s", input: null });
    expect(getRun(db, "r1")).toMatchObject({ status: "running", finishedAt: null, cardId: null, costUsd: null });
    expect(listPendingActions(db, "p1").map((a) => a.id)).toEqual(["a1", "a2"]);
    emit("agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" }, human);
    expect(listActions(db, "r1")[0]).toMatchObject({ status: "allowed", decidedBy: "human", output: null });
    expect(listPendingActions(db, "p1").map((a) => a.id)).toEqual(["a2"]);
  });

  it("lists runs newest first", () => {
    for (const r of ["r1", "r2"])
      emit("agent.started", { runId: r, adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt" });
    expect(listRuns(db, "p1").map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("settings projection holds the last mode", () => {
    expect(getSetting(db, "claude_auth_mode")).toBeNull();
    emit("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }, human, null);
    emit("settings.claude_auth_changed", { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK }, human, null);
    expect(getSetting(db, "claude_auth_mode")).toBe("subscription");
    emit("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }, human, null);
    expect(getSetting(db, "claude_auth_mode")).toBe("api_key");
  });

  it("rebuild after mixed board + agent history equals the live projections", () => {
    const board = new BoardService(db, ledger);
    const p = board.createProject(human, { name: "A" });
    board.addCard(human, p.id, { title: "t", stage: "plan" });
    script();
    emit("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }, human, null);
    const dump = () =>
      ["projects", "cards", "agent_runs", "agent_actions", "settings"].map((t) =>
        db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all(),
      );
    const live = dump();
    expect(live[2]).toHaveLength(1);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });
});
