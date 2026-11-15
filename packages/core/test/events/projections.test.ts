import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { CLAUDE_SUBSCRIPTION_ACK, GATES, INTAKE_VERSION, type GateId } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { commitEvent, commitEvents } from "../../src/events/commit.js";
import { ConnectionService } from "../../src/connections/service.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import {
  countPendingActions, countRunningRuns, getIntake, getRun, getSetting, listActions, listAllPendingActions, listGateDecisions,
  listOpenIntakes, listPendingActions, listRuns, projectSpendUsd, rebuildAllProjections, workspaceCounts,
} from "../../src/events/projections.js";

describe("workspaceCounts", () => {
  it("sums cost only over runs started on the local calendar day", () => {
    const d = openDatabase(":memory:");
    const now = new Date(2026, 10, 14, 12, 0, 0);
    const insert = d.prepare(
      `INSERT INTO agent_runs (id, project_id, adapter, auth_mode, prompt, status, worktree, cost_usd, started_at)
       VALUES (?, 'p1', 'fake', 'none', 'p', ?, 'wt', ?, ?)`,
    );
    insert.run("before", "completed", 1, new Date(2026, 10, 13, 23, 59, 59, 999).toISOString());
    insert.run("start", "completed", 0.5, new Date(2026, 10, 14, 0, 0, 0).toISOString());
    insert.run("late", "completed", 0.25, new Date(2026, 10, 14, 23, 59, 59, 999).toISOString());
    insert.run("after", "completed", 2, new Date(2026, 10, 15, 0, 0, 0).toISOString());
    insert.run("live", "running", null, new Date(2026, 10, 14, 9, 0, 0).toISOString());
    expect(workspaceCounts(d, now)).toEqual({
      runningAgents: 1, pendingDecisions: 0, todayCostUsd: 0.75, monthCostUsd: 3.75, connections: { enabled: 0, failed: 0 },
    });
    d.close();
  });

  it("sums monthCostUsd only over runs started in the local calendar month", () => {
    const d = openDatabase(":memory:");
    const now = new Date(2026, 10, 14, 12, 0, 0);
    const insert = d.prepare(
      `INSERT INTO agent_runs (id, project_id, adapter, auth_mode, prompt, status, worktree, cost_usd, started_at)
       VALUES (?, 'p1', 'fake', 'none', 'p', 'completed', 'wt', ?, ?)`,
    );
    insert.run("last-month", 4, new Date(2026, 9, 31, 23, 59, 59, 999).toISOString());
    insert.run("first", 1.5, new Date(2026, 10, 1, 0, 0, 0).toISOString());
    insert.run("end", 0.5, new Date(2026, 10, 30, 23, 59, 59, 999).toISOString());
    insert.run("next-month", 8, new Date(2026, 11, 1, 0, 0, 0).toISOString());
    insert.run("unreported", null, new Date(2026, 10, 10).toISOString());
    expect(workspaceCounts(d, now).monthCostUsd).toBe(2);
    d.close();
  });
});

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
      status: "completed", worktree: "wt/r1", costUsd: 0.5, inputTokens: null, outputTokens: null, error: null,
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

  it("lists pending actions across all projects, oldest first, with their project", () => {
    const board = new BoardService(db, ledger);
    const alpha = board.createProject(human, { name: "Alpha" }).id;
    const beta = board.createProject(human, { name: "Beta" }).id;
    emit("agent.started", { runId: "ra", adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt/ra" }, human, alpha);
    emit("agent.started", { runId: "rb", adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt/rb" }, human, beta);
    emit("agent.action.requested", { runId: "ra", actionId: "a1", kind: "shell", tool: "Bash", summary: "s", input: null }, agent, alpha);
    emit("agent.action.requested", { runId: "rb", actionId: "b1", kind: "shell", tool: "Bash", summary: "s", input: null }, agent, beta);
    emit("agent.action.requested", { runId: "ra", actionId: "a2", kind: "shell", tool: "Bash", summary: "s", input: null }, agent, alpha);
    emit("agent.action.decided", { runId: "ra", actionId: "a1", decision: "deny", by: "human", reason: "" }, human, alpha);
    expect(listAllPendingActions(db).map((a) => [a.id, a.projectId, a.projectName])).toEqual([
      ["b1", beta, "Beta"],
      ["a2", alpha, "Alpha"],
    ]);
    expect(listAllPendingActions(db)[0]).toMatchObject({ runId: "rb", status: "pending", kind: "shell" });
  });

  it("lists runs newest first", () => {
    for (const r of ["r1", "r2"])
      emit("agent.started", { runId: r, adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt" });
    expect(listRuns(db, "p1").map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("settings projection holds the last mode", () => {
    expect(getSetting(db, "auth_mode:claude")).toBeNull();
    emit("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }, human, null);
    emit("settings.claude_auth_changed", { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK }, human, null);
    expect(getSetting(db, "auth_mode:claude")).toBe("subscription");
    emit("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }, human, null);
    expect(getSetting(db, "auth_mode:claude")).toBe("api_key");
  });

  it("projects token totals from agent.finished, NULL for entries without them, and rebuilds the same rows", () => {
    for (const r of ["r1", "r2"]) {
      emit("agent.started", { runId: r, adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: `wt/${r}` });
    }
    emit("agent.finished", { runId: "r1", status: "completed", costUsd: 0.1, inputTokens: 10, outputTokens: 5, error: null });
    emit("agent.finished", { runId: "r2", status: "completed", costUsd: null, error: null }); // written before token totals existed
    expect(getRun(db, "r1")).toMatchObject({ costUsd: 0.1, inputTokens: 10, outputTokens: 5 });
    expect(getRun(db, "r2")).toMatchObject({ costUsd: null, inputTokens: null, outputTokens: null });
    const live = listRuns(db, "p1");
    rebuildAllProjections(db, ledger);
    expect(listRuns(db, "p1")).toEqual(live);
  });

  it("projects agent.rate_limited into rate_limits with the run's adapter, and rebuilds the same rows", () => {
    emit("agent.started", { runId: "r1", adapter: "codex", authMode: "api_key", prompt: "p", cardId: null, worktree: "wt/r1" });
    emit("agent.rate_limited", { runId: "r1", retryAfterS: 12 });
    emit("agent.rate_limited", { runId: "r1", retryAfterS: null });
    const dump = () => db.prepare("SELECT run_id, adapter, at, retry_after_s FROM rate_limits ORDER BY rowid").all();
    const live = dump();
    expect(live).toEqual([
      { run_id: "r1", adapter: "codex", at: expect.any(String), retry_after_s: 12 },
      { run_id: "r1", adapter: "codex", at: expect.any(String), retry_after_s: null },
    ]);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
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

  it("rebuild after connection add/update/test/remove equals the live connections table", async () => {
    let n = 0;
    const svc = new ConnectionService({
      db, ledger, secrets: new MemorySecretStore(), newId: () => `c${++n}`,
      testers: { claude: async () => ({ ok: true, message: "Connected" }) },
    });
    const claude = await svc.add(human, { kind: "llm", provider: "claude", name: "Claude", config: {}, secrets: { apiKey: "sk-ant-TESTKEY-0000000000" } });
    const gemini = await svc.add(human, {
      kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: "p" }, private: { cliHome: join(tmpdir(), "home") },
    });
    const github = await svc.add(human, { kind: "github", provider: "github", name: "GitHub", config: {}, secrets: { token: "ghp_TESTKEY0000000000000000" } });
    await svc.update(human, gemini.id, { name: "G2", enabled: false, secrets: { apiKey: "AIzaTESTKEY" }, private: { cliHome: null } });
    await svc.test(human, claude.id);
    await svc.test(human, gemini.id);
    await svc.remove(human, github.id);
    const dump = () => db.prepare("SELECT * FROM connections ORDER BY id").all();
    const live = dump();
    expect(live).toHaveLength(2);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });
});

const ack = (gateId: GateId) => GATES.find((g) => g.id === gateId)!.acknowledgement;
const IDEA = "A reading list for a book club";

function startIntake(projectId = "p1", intakeId = "i1") {
  return emit("intake.started", { intakeId, idea: IDEA, version: INTAKE_VERSION }, human, projectId)!;
}

describe("intake projections", () => {
  it("intake.started inserts an open session with no summary", () => {
    const e = startIntake();
    expect(db.prepare("SELECT * FROM intakes").all()).toEqual([
      { id: "i1", project_id: "p1", idea: IDEA, status: "open", summary: null, created_at: e.ts, updated_at: e.ts, completed_at: null },
    ]);
    expect(getIntake(db, "p1")).toEqual({
      intake: { id: "i1", projectId: "p1", idea: IDEA, status: "open", summary: null, createdAt: e.ts, updatedAt: e.ts, completedAt: null },
      answers: {},
      decisions: {},
    });
    expect(getIntake(db, "other")).toBeNull();
  });

  it("intake.answered stores the answer as canonical JSON, replaces a re-answer and bumps updated_at", () => {
    startIntake();
    emit("intake.answered", { intakeId: "i1", questionId: "audience", answer: "Members of a book club" }, human);
    emit("intake.answered", { intakeId: "i1", questionId: "platform", answer: ["web", "mobile"] }, human);
    emit("intake.answered", { intakeId: "i1", questionId: "budget_usd", answer: 25 }, human);
    const last = emit("intake.answered", { intakeId: "i1", questionId: "platform", answer: ["web"] }, human)!;
    expect(db.prepare("SELECT question_id, answer FROM intake_answers ORDER BY question_id").all()).toEqual([
      { question_id: "audience", answer: '"Members of a book club"' },
      { question_id: "budget_usd", answer: "25" },
      { question_id: "platform", answer: '["web"]' },
    ]);
    const got = getIntake(db, "p1")!;
    expect(got.intake.updatedAt).toBe(last.ts);
    expect(got.answers).toEqual({
      audience: { answer: "Members of a book club", answeredAt: expect.any(String) },
      budget_usd: { answer: 25, answeredAt: expect.any(String) },
      platform: { answer: ["web"], answeredAt: last.ts },
    });
  });

  it("intake.decided inserts or replaces the decision", () => {
    startIntake();
    emit("intake.decided", { intakeId: "i1", decisionId: "first_version", chosen: "full", rationale: "We want it all", owner: "owner" }, human);
    const e = emit("intake.decided", { intakeId: "i1", decisionId: "first_version", chosen: "smallest", rationale: "Start small", owner: "owner" }, human)!;
    expect(db.prepare("SELECT * FROM intake_decisions").all()).toEqual([
      { intake_id: "i1", decision_id: "first_version", chosen: "smallest", rationale: "Start small", owner: "owner", decided_at: e.ts },
    ]);
    expect(getIntake(db, "p1")!.decisions).toEqual({
      first_version: { chosen: "smallest", rationale: "Start small", owner: "owner", decidedAt: e.ts },
    });
  });

  it("intake.completed sets the summary and completion, the cards in the same batch are created, and reopen keeps the summary", () => {
    startIntake();
    const entries = commitEvents(db, ledger, () => ({
      events: [
        { projectId: "p1", actor: human, type: "intake.completed", payload: {
          intakeId: "i1", summary: "A small web app", cards: [{ cardId: "c1", title: "Sign in", stage: "plan", outcome: "created" }],
        } },
        { projectId: "p1", actor: human, type: "card.created", payload: { cardId: "c1", title: "Sign in", stage: "plan" } },
      ],
      result: (es) => es,
    }));
    const done = entries[0]!;
    expect(db.prepare("SELECT status, summary, completed_at, updated_at FROM intakes").get()).toEqual({
      status: "completed", summary: "A small web app", completed_at: done.ts, updated_at: done.ts,
    });
    expect(db.prepare("SELECT id, title FROM cards").all()).toEqual([{ id: "c1", title: "Sign in" }]);
    expect(listOpenIntakes(db)).toEqual([]);

    const re = emit("intake.reopened", { intakeId: "i1", reason: "The scope changed" }, human)!;
    expect(db.prepare("SELECT status, summary, completed_at, updated_at FROM intakes").get()).toEqual({
      status: "open", summary: "A small web app", completed_at: null, updated_at: re.ts,
    });
    expect(listOpenIntakes(db).map((i) => i.id)).toEqual(["i1"]);
  });

  it("listOpenIntakes lists only open sessions", () => {
    startIntake("p1", "i1");
    startIntake("p2", "i2");
    emit("intake.completed", { intakeId: "i2", summary: "Done", cards: [] }, human, "p2");
    expect(listOpenIntakes(db).map((i) => [i.id, i.projectId, i.status])).toEqual([["i1", "p1", "open"]]);
  });
});

describe("gate projections", () => {
  it("gate.signed_off and gate.waived insert decisions with the entry id; gate.blocked projects nothing", () => {
    const blocked = emit("gate.blocked", { cardId: "c1", from: "plan", to: "design", gates: [{ gateId: "plan_approved", outcome: "needs_sign_off", unmet: [] }] }, human)!;
    expect(blocked).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM gate_decisions").get()).toEqual({ n: 0 });
    const signed = emit("gate.signed_off", {
      gateId: "plan_approved", cardId: "c1", from: "plan", to: "design", conditions: [], acknowledgement: ack("plan_approved"), signedBy: "owner",
    }, human)!;
    const waived = emit("gate.waived", {
      gateId: "ready_to_ship", cardId: "c1", from: "build", to: "ship", unmet: ["no_pending_actions"],
      reason: "Known and accepted for the demo", acknowledgement: ack("ready_to_ship"), waivedBy: "owner",
    }, human)!;
    emit("gate.signed_off", {
      gateId: "plan_approved", cardId: "c2", from: "plan", to: "design", conditions: [], acknowledgement: ack("plan_approved"), signedBy: "owner",
    }, human);
    expect(listGateDecisions(db, "c1")).toEqual([
      { entryId: signed.id, gateId: "plan_approved", projectId: "p1", cardId: "c1", kind: "signed_off", from: "plan", to: "design", reason: null, decidedBy: "owner", at: signed.ts },
      { entryId: waived.id, gateId: "ready_to_ship", projectId: "p1", cardId: "c1", kind: "waived", from: "build", to: "ship", reason: "Known and accepted for the demo", decidedBy: "owner", at: waived.ts },
    ]);
    expect(listGateDecisions(db, "none")).toEqual([]);
  });
});

describe("gate projection without a project", () => {
  it("rejects a gate.signed_off with a null projectId and leaves the ledger empty", () => {
    expect(() =>
      emit("gate.signed_off", {
        gateId: "plan_approved", cardId: "c1", from: "plan", to: "design", conditions: [], acknowledgement: ack("plan_approved"), signedBy: "owner",
      }, human, null),
    ).toThrow("gate event without a project");
    expect(ledger.list()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gate_decisions").get()).toEqual({ n: 0 });
  });
});

describe("intake and gate rebuild", () => {
  it("rebuild after start, three answers, a decision, a completion, a reopen and a waiver equals the live tables", () => {
    startIntake();
    emit("intake.answered", { intakeId: "i1", questionId: "audience", answer: "Members of a book club" }, human);
    emit("intake.answered", { intakeId: "i1", questionId: "platform", answer: ["web"] }, human);
    emit("intake.answered", { intakeId: "i1", questionId: "budget_usd", answer: 40.5 }, human);
    emit("intake.decided", { intakeId: "i1", decisionId: "first_version", chosen: "smallest", rationale: "Start small", owner: "owner" }, human);
    commitEvents(db, ledger, () => ({
      events: [
        { projectId: "p1", actor: human, type: "intake.completed", payload: {
          intakeId: "i1", summary: "A small web app", cards: [{ cardId: "c1", title: "Sign in", stage: "build", outcome: "created" }],
        } },
        { projectId: "p1", actor: human, type: "card.created", payload: { cardId: "c1", title: "Sign in", stage: "build" } },
      ],
      result: () => null,
    }));
    emit("intake.reopened", { intakeId: "i1", reason: "The scope changed" }, human);
    commitEvents(db, ledger, () => ({
      events: [
        { projectId: "p1", actor: human, type: "gate.waived", payload: {
          gateId: "ready_to_ship", cardId: "c1", from: "build", to: "ship", unmet: ["no_pending_actions"],
          reason: "Known and accepted for the demo", acknowledgement: ack("ready_to_ship"), waivedBy: "owner",
        } },
        { projectId: "p1", actor: human, type: "card.moved", payload: { cardId: "c1", from: "build", to: "ship" } },
      ],
      result: () => null,
    }));
    const tables = ["intakes", "intake_answers", "intake_decisions", "gate_decisions", "cards"];
    const dump = () => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
    const live = dump();
    expect(live.map((rows) => rows.length)).toEqual([1, 3, 1, 1, 1]);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });
});

describe("gate fact queries", () => {
  const insertRun = (id: string, projectId: string, cardId: string | null, status: string, cost: number | null) =>
    db.prepare(
      `INSERT INTO agent_runs (id, project_id, card_id, adapter, auth_mode, prompt, status, worktree, cost_usd, started_at)
       VALUES (?, ?, ?, 'fake', 'none', 'p', ?, 'wt', ?, '2026-11-15T00:00:00.000Z')`,
    ).run(id, projectId, cardId, status, cost);

  it("projectSpendUsd sums only that project's runs and is 0 when there are none", () => {
    insertRun("r1", "p1", null, "completed", 1.25);
    insertRun("r2", "p1", "c1", "failed", 0.5);
    insertRun("r3", "p1", "c1", "running", null);
    insertRun("r4", "p2", null, "completed", 9);
    expect(projectSpendUsd(db, "p1")).toBe(1.75);
    expect(projectSpendUsd(db, "p3")).toBe(0);
  });

  it("countRunningRuns counts only running runs on that card", () => {
    insertRun("r1", "p1", "c1", "running", null);
    insertRun("r2", "p1", "c1", "running", null);
    insertRun("r3", "p1", "c1", "completed", 0);
    insertRun("r4", "p1", "c2", "running", null);
    insertRun("r5", "p1", null, "running", null);
    expect(countRunningRuns(db, "c1")).toBe(2);
    expect(countRunningRuns(db, "c3")).toBe(0);
  });

  it("countPendingActions counts pending actions on the project's runs", () => {
    emit("agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt/r1" });
    emit("agent.started", { runId: "r2", adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt/r2" }, agent, "p2");
    emit("agent.action.requested", { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "s", input: null });
    emit("agent.action.requested", { runId: "r1", actionId: "a2", kind: "shell", tool: "Bash", summary: "s", input: null });
    emit("agent.action.requested", { runId: "r2", actionId: "b1", kind: "shell", tool: "Bash", summary: "s", input: null }, agent, "p2");
    emit("agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" }, human);
    expect(countPendingActions(db, "p1")).toBe(1);
    expect(countPendingActions(db, "p2")).toBe(1);
    expect(countPendingActions(db, "p3")).toBe(0);
  });
});
