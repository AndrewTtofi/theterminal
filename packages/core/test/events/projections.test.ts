import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  CLAUDE_SUBSCRIPTION_ACK, DEFAULT_GATE_REQUIREMENT, DEFAULT_REMOTE, GATES, INTAKE_VERSION, LINKING_ACK, OWNER_ID, type GateId, type LedgerEntry,
} from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { commitEvent, commitEvents } from "../../src/events/commit.js";
import { ConnectionService } from "../../src/connections/service.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import {
  countActiveShareLinks, countPendingActions, countRunningRuns, getIntake, getLinkRun, getMachine, getRun, getSetting,
  getShareSnapshot, listActions, listAllPendingActions, listGateDecisions, listLinkRuns, listMachines, listOpenIntakes,
  listPendingActions, listProjectGateDecisions, listRuns, listShareLinks, listShareSnapshots, mirroredIds, projectSpendUsd,
  rebuildAllProjections, workspaceCounts, getPerson, listPeople, getRemoteState, getGateRequirement, getInviteByHash, listInvites,
} from "../../src/events/projections.js";
import { canonicalJson } from "../../src/ledger/canonical.js";
import { MirroredEntryRefusedError } from "../../src/events/projections.js";
import { pairAndRequest, remoteRun, requestRun, type RemoteRun } from "../link/remote-fixtures.js";

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
const link = { kind: "system", id: "link" } as const;
let db: Db;
let ledger: Ledger;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
});

const emit = (type: string, payload: Record<string, unknown>, actor: { kind: "human" | "agent" | "system"; id: string } = agent, projectId: string | null = "p1") =>
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

  it("projects the fork commit `base` from agent.started, NULL for entries without it, and rebuilds the same rows", () => {
    const base = "b".repeat(40);
    emit("agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt/r1", base });
    emit("agent.started", { runId: "r2", adapter: "fake", authMode: "none", prompt: "p", cardId: null, worktree: "wt/r2" }); // before the fork was kept
    expect(getRun(db, "r1")!.base).toBe(base);
    expect(getRun(db, "r2")!.base).toBeNull();
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

describe("linked-machine projections", () => {
  const mA = "a".repeat(32);
  const mB = "b".repeat(32);
  const own = { machineId: "c".repeat(32), publicKey: `${"A".repeat(59)}=`, fingerprint: "c".repeat(64) };
  const peer = (id: string, name: string) => ({
    machineId: id, name, publicKey: `${"B".repeat(59)}=`, fingerprint: id.repeat(2), address: "studio.local:4418",
    role: "entered_code",
  });
  const runRequested = (runId: string, machineId: string) => ({
    runId, machineId, adapter: "fake", prompt: "do it", cardId: null, connectionIds: [],
  });

  it("migrates past user_version 10 with the machines and link_runs tables and agent_runs.machine_id", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(10);
    const columns = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("machines")).toEqual(["id", "name", "public_key", "fingerprint", "address", "role", "paired_at", "updated_at"]);
    expect(columns("link_runs")).toEqual(["run_id", "machine_id", "direction", "project_id", "state", "last_seq", "error", "updated_at"]);
    expect(columns("agent_runs")).toContain("machine_id");
  });

  it("projects this machine's identity, name and linking switch into settings", () => {
    emit("machine.identity_created", own, link, null);
    expect(getSetting(db, "link.machineId")).toBe(own.machineId);
    expect(getSetting(db, "link.publicKey")).toBe(own.publicKey);
    expect(getSetting(db, "link.fingerprint")).toBe(own.fingerprint);
    emit("machine.named", { name: "Studio" }, human, null);
    expect(getSetting(db, "link.name")).toBe("Studio");
    emit("machine.named", { name: "Studio Mac" }, human, null);
    expect(getSetting(db, "link.name")).toBe("Studio Mac");
    expect(getSetting(db, "link.enabled")).toBeNull();
    emit("machine.linking_enabled", { port: 4419, acknowledgement: LINKING_ACK }, human, null);
    expect(getSetting(db, "link.enabled")).toBe("1");
    expect(getSetting(db, "link.port")).toBe("4419");
    emit("machine.linking_disabled", {}, human, null);
    expect(getSetting(db, "link.enabled")).toBe("0");
    expect(getSetting(db, "link.port")).toBe("4419");
  });

  it("projects paired machines, re-pairing replaces the row, and unpairing deletes it", () => {
    expect(listMachines(db)).toEqual([]);
    const paired = emit("machine.paired", peer(mA, "Laptop"), human, null);
    emit("machine.paired", { ...peer(mB, "Desktop"), role: "showed_code" }, human, null);
    expect(getMachine(db, mA)).toEqual({
      id: mA, name: "Laptop", publicKey: `${"B".repeat(59)}=`, fingerprint: mA.repeat(2), address: "studio.local:4418",
      role: "entered_code", pairedAt: paired.ts, updatedAt: paired.ts,
    });
    expect(listMachines(db).map((m) => [m.name, m.role])).toEqual([["Desktop", "showed_code"], ["Laptop", "entered_code"]]);
    const again = emit("machine.paired", { ...peer(mA, "Laptop 2"), address: "10.0.0.5:4420" }, human, null);
    expect(getMachine(db, mA)).toMatchObject({ name: "Laptop 2", address: "10.0.0.5:4420", updatedAt: again.ts });
    expect(listMachines(db)).toHaveLength(2);
    emit("machine.unpaired", { machineId: mA, name: "Laptop 2" }, human, null);
    expect(getMachine(db, mA)).toBeNull();
    expect(listMachines(db).map((m) => m.id)).toEqual([mB]);
  });

  it("projects link runs on both sides through their states", () => {
    const requested = emit("link.run_requested", runRequested("r1", mA), human, "p1");
    expect(getLinkRun(db, "r1")).toEqual({
      runId: "r1", machineId: mA, direction: "requested", projectId: "p1", state: "requested", lastSeq: 0, error: null,
      updatedAt: requested.ts,
    });
    const accepted = emit("link.run_accepted", { runId: "r2", machineId: mB, projectId: "p2" }, link, "p2");
    expect(getLinkRun(db, "r2")).toEqual({
      runId: "r2", machineId: mB, direction: "accepted", projectId: "p2", state: "running", lastSeq: 0, error: null,
      updatedAt: accepted.ts,
    });
    emit("link.run_requested", runRequested("r3", mA), human, "p1");
    const failed = emit("link.run_failed", { runId: "r3", machineId: mA, error: "unreachable" }, link, "p1");
    expect(getLinkRun(db, "r3")).toMatchObject({ state: "failed", error: "unreachable", updatedAt: failed.ts });
    const imported = emit(
      "link.changes_imported", { runId: "r1", machineId: mA, commit: "f".repeat(40) }, link, "p1",
    );
    expect(getLinkRun(db, "r1")).toMatchObject({ state: "imported", updatedAt: imported.ts });
    expect(getLinkRun(db, "nope")).toBeNull();
    expect(listLinkRuns(db).map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
    expect(listLinkRuns(db, "running").map((r) => r.runId)).toEqual(["r2"]);
    expect(listLinkRuns(db, "failed").map((r) => r.runId)).toEqual(["r3"]);
    expect(listLinkRuns(db, "finished")).toEqual([]);
  });

  it("maps agent_runs.machine_id to machineId in getRun and listRuns", () => {
    script();
    expect(getRun(db, "r1")!.machineId).toBeNull();
    db.prepare("UPDATE agent_runs SET machine_id = ? WHERE id = 'r1'").run(mA);
    expect(getRun(db, "r1")!.machineId).toBe(mA);
    expect(listRuns(db, "p1").map((r) => r.machineId)).toEqual([mA]);
  });

  it("rebuild after identity, naming, linking, pairing and link runs equals the live tables", () => {
    emit("machine.identity_created", own, link, null);
    emit("machine.named", { name: "Studio" }, human, null);
    emit("machine.linking_enabled", { port: 4418, acknowledgement: LINKING_ACK }, human, null);
    emit("machine.paired", peer(mA, "Laptop"), human, null);
    emit("machine.paired", peer(mB, "Desktop"), human, null);
    emit("machine.unpaired", { machineId: mB, name: "Desktop" }, human, null);
    emit("link.run_requested", runRequested("r1", mA), human, "p1");
    emit("link.run_requested", runRequested("r2", mA), human, "p1");
    emit("link.run_failed", { runId: "r2", machineId: mA, error: "repo_too_large" }, link, "p1");
    emit("link.run_accepted", { runId: "r3", machineId: mA, projectId: "p3" }, link, "p3");
    emit("link.changes_imported", { runId: "r1", machineId: mA, commit: "e".repeat(40) }, link, "p1");
    emit("machine.linking_disabled", {}, human, null);
    const tables = ["settings", "machines", "link_runs"];
    const dump = () => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
    const live = dump();
    expect(live.map((rows) => rows.length)).toEqual([6, 1, 3]);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
    // A rebuild clears the link tables first: rows not backed by the ledger disappear.
    db.prepare("INSERT INTO machines VALUES ('x', 'n', 'k', 'f', 'a:1', 'showed_code', 't', 't')").run();
    db.prepare("INSERT INTO link_runs (run_id, machine_id, direction, project_id, state, updated_at) VALUES ('x', 'm', 'requested', 'p', 'requested', 't')").run();
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });
});

describe("share projections", () => {
  const HASH = "a".repeat(64);
  const DIGEST = "b".repeat(64);
  const OPTIONS = { includePrompts: false, includeHardware: true, digestDays: 14 };
  const confirm = (shareId: string, projectId = "p1") =>
    emit("share.confirmed", {
      shareId, contentHash: HASH, bytes: 1234, sections: ["overview", "audit"], options: OPTIONS, headSeq: 7,
    }, human, projectId)!;
  const link = (linkId: string, shareId: string, projectId = "p1") =>
    emit("share.link_created", {
      linkId, shareId, tokenDigest: DIGEST, expiresAt: "2026-11-15T13:00:00.000Z", port: 4100, scope: "local_network",
    }, human, projectId)!;

  it("share.confirmed inserts a snapshot record with sections and options as canonical JSON", () => {
    const e = confirm("s1");
    expect(db.prepare("SELECT * FROM share_snapshots").all()).toEqual([{
      id: "s1", project_id: "p1", content_hash: HASH, bytes: 1234, sections: '["overview","audit"]',
      options: '{"digestDays":14,"includeHardware":true,"includePrompts":false}', head_seq: 7, confirmed_at: e.ts,
    }]);
    expect(getShareSnapshot(db, "s1")).toEqual({
      id: "s1", projectId: "p1", contentHash: HASH, bytes: 1234, sections: ["overview", "audit"], options: OPTIONS, headSeq: 7,
      confirmedAt: e.ts,
    });
    expect(getShareSnapshot(db, "nope")).toBeNull();
  });

  it("listShareSnapshots lists one project's snapshots, newest first", () => {
    confirm("s1");
    confirm("s2");
    confirm("other", "p2");
    expect(listShareSnapshots(db, "p1").map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(listShareSnapshots(db, "p3")).toEqual([]);
  });

  it("share.link_created inserts an active link of the entry's project; revoked, expired and stopped end it", () => {
    confirm("s1");
    const created = link("l1", "s1");
    expect(listShareLinks(db)).toEqual([{
      id: "l1", shareId: "s1", projectId: "p1", scope: "local_network", port: 4100, state: "active",
      createdAt: created.ts, expiresAt: "2026-11-15T13:00:00.000Z", endedAt: null,
    }]);
    link("l2", "s1");
    link("l3", "s1");
    const revoked = emit("share.revoked", { linkId: "l1", reason: "owner" }, human)!;
    const expired = emit("share.expired", { linkId: "l2" })!;
    const stopped = emit("share.stopped", { linkId: "l3", reason: "shutdown" })!;
    const byId = Object.fromEntries(listShareLinks(db).map((l) => [l.id, [l.state, l.endedAt]]));
    expect(byId).toEqual({ l1: ["revoked", revoked.ts], l2: ["expired", expired.ts], l3: ["stopped", stopped.ts] });
  });

  it("listShareLinks filters by state and project, newest first", () => {
    confirm("s1");
    confirm("s2", "p2");
    link("l1", "s1");
    link("l2", "s2", "p2");
    link("l3", "s1");
    emit("share.revoked", { linkId: "l3", reason: "too_many_failures" });
    expect(listShareLinks(db).map((l) => l.id)).toEqual(["l3", "l2", "l1"]);
    expect(listShareLinks(db, { state: "active" }).map((l) => l.id)).toEqual(["l2", "l1"]);
    expect(listShareLinks(db, { projectId: "p1" }).map((l) => l.id)).toEqual(["l3", "l1"]);
    expect(listShareLinks(db, { state: "active", projectId: "p1" }).map((l) => l.id)).toEqual(["l1"]);
  });

  it("countActiveShareLinks goes from 1 to 0 after share.expired", () => {
    confirm("s1");
    link("l1", "s1");
    expect(countActiveShareLinks(db)).toBe(1);
    emit("share.expired", { linkId: "l1" });
    expect(countActiveShareLinks(db)).toBe(0);
  });

  it("rebuild after confirm, link and revoke equals the live share tables", () => {
    confirm("s1");
    link("l1", "s1");
    link("l2", "s1");
    emit("share.revoked", { linkId: "l1", reason: "owner" }, human);
    const dump = () => ["share_snapshots", "share_links"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    const live = dump();
    expect(live.map((rows) => rows.length)).toEqual([1, 2]);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });
});

describe("mirrored remote runs (applyMirrored)", () => {
  const PROJECT = "p1";
  let remote: RemoteRun;

  beforeEach(async () => {
    emit("project.created", { projectId: PROJECT, name: "Demo", pitch: "" }, human, PROJECT);
    remote = await remoteRun("run-remote-1", PROJECT);
    pairAndRequest(db, ledger, remote);
  });

  /** Commits the worker entry as the requester does: link.mirrored, by the link, in the origin's project. */
  const mirror = (entry: LedgerEntry, machineId = remote.machineId, via = remote) => {
    const frame = JSON.parse(via.line(entry)) as { origin: LedgerEntry; signature: string };
    return emit("link.mirrored", { machineId, origin: frame.origin, signature: frame.signature }, link, frame.origin.projectId);
  };
  const tables = ["agent_runs", "agent_actions", "link_runs", "rate_limits"];
  const dump = () => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());

  it("an inner agent.started creates the run with the machine it runs on, and the link run is running at its seq", async () => {
    const carded = await remoteRun("run-remote-2", PROJECT, remote.identity);
    requestRun(db, ledger, carded, "c1");
    const started = carded.started("c1");
    const e = mirror(started, carded.machineId, carded);
    expect(getRun(db, carded.runId)).toMatchObject({
      id: carded.runId, projectId: PROJECT, cardId: "c1", adapter: "fake", status: "running", machineId: carded.machineId,
      worktree: `projects/${PROJECT}/worktrees/${carded.runId}`, startedAt: started.ts,
    });
    expect(getLinkRun(db, carded.runId)).toMatchObject({ state: "running", lastSeq: started.seq, updatedAt: e.ts, error: null });
  });

  it("refuses an inner agent.started whose working copy or card is not the one this computer requested, and rolls the commit back", () => {
    const payload = remote.started().payload as Record<string, unknown>;
    const attempt = (over: Record<string, unknown>) => {
      const origin = { ...(JSON.parse(remote.line(remote.started())) as { origin: Record<string, unknown> }).origin, payload: { ...payload, ...over } };
      const signature = remote.identity.sign(Buffer.from(canonicalJson(origin)));
      return () => emit("link.mirrored", { machineId: remote.machineId, origin, signature }, link, PROJECT);
    };
    const head = ledger.headSeq();
    for (const worktree of [".", "projects/another-project/repo", "link/incoming", `projects/${PROJECT}/worktrees/other-run`]) {
      expect(attempt({ worktree })).toThrow(MirroredEntryRefusedError);
    }
    expect(attempt({ cardId: "c-foreign" })).toThrow(MirroredEntryRefusedError);
    expect(ledger.headSeq()).toBe(head);
    expect(getRun(db, remote.runId)).toBeNull();
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "requested", lastSeq: 0 });
    // The honest entry still lands.
    mirror(remote.started());
    expect(getRun(db, remote.runId)).toMatchObject({ status: "running", cardId: null, worktree: `projects/${PROJECT}/worktrees/${remote.runId}` });
  });

  it("an inner agent.action.requested is a pending action Needs-you lists, with the project's name", () => {
    mirror(remote.started());
    mirror(remote.message("Looking"));
    const req = remote.requested("act-1", "nvidia-smi");
    mirror(req);
    expect(listAllPendingActions(db)).toEqual([
      expect.objectContaining({ id: "act-1", runId: remote.runId, status: "pending", projectId: PROJECT, projectName: "Demo", summary: "Run: nvidia-smi" }),
    ]);
    expect(getLinkRun(db, remote.runId)!.lastSeq).toBe(req.seq);
  });

  it("decided, completed and finished entries settle the action, end the run, and finish the link run", () => {
    mirror(remote.started());
    mirror(remote.connectionUsed());
    mirror(remote.requested("act-1"));
    mirror(remote.decided("act-1"));
    mirror(remote.completed("act-1", "all green"));
    expect(getLinkRun(db, remote.runId)!.state).toBe("running");
    const fin = remote.finished();
    mirror(fin);
    expect(listActions(db, remote.runId)).toEqual([expect.objectContaining({ id: "act-1", status: "completed", decidedBy: "human", output: "all green" })]);
    expect(getRun(db, remote.runId)).toMatchObject({ status: "completed", machineId: remote.machineId });
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "finished", lastSeq: fin.seq });
    emit("link.changes_imported", { runId: remote.runId, machineId: remote.machineId, commit: "f".repeat(40) }, link, PROJECT);
    expect(getLinkRun(db, remote.runId)!.state).toBe("imported");
  });

  it("mirroredIds lists the origin ids already mirrored for a run, and only that run's", () => {
    expect(mirroredIds(db, remote.runId)).toEqual(new Set());
    const a = remote.started();
    const b = remote.message("hi");
    mirror(a);
    mirror(b);
    expect(mirroredIds(db, remote.runId)).toEqual(new Set([a.id, b.id]));
    expect(mirroredIds(db, "another-run")).toEqual(new Set());
  });

  it("link.run_failed fails the mirrored run while it is running, and leaves a finished one and this machine's runs alone", () => {
    mirror(remote.started());
    mirror(remote.requested("act-1"));
    script(); // a local run r1
    const failed = emit("link.run_failed", { runId: remote.runId, machineId: remote.machineId, error: "bad_signature" }, link, PROJECT);
    expect(getRun(db, remote.runId)).toMatchObject({ status: "failed", error: "bad_signature", finishedAt: failed.ts });
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "failed", error: "bad_signature" });
    emit("link.run_failed", { runId: "r1", machineId: remote.machineId, error: "unreachable" }, link, PROJECT);
    expect(getRun(db, "r1")).toMatchObject({ status: "completed", error: null });
    const live = dump();
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });

  it("a pending action of a mirrored run that link.run_failed ended is closed: denied by nobody, with the run's end as the reason", () => {
    mirror(remote.started());
    mirror(remote.requested("act-1"));
    mirror(remote.requested("act-2"));
    mirror(remote.decided("act-2", "allow"));
    // A running local run with a pending action of its own.
    emit("agent.started", { runId: "r2", adapter: "fake", authMode: "none", prompt: "do it", cardId: null, worktree: "wt/r2" });
    emit("agent.action.requested", { runId: "r2", actionId: "a-local", kind: "shell", tool: "Bash", summary: "ls", input: {} });
    expect(listAllPendingActions(db).map((a) => a.id)).toEqual(["act-1", "a-local"]);
    expect(countPendingActions(db, PROJECT)).toBe(2);
    const failed = emit("link.run_failed", { runId: remote.runId, machineId: remote.machineId, error: "machine_unpaired" }, link, PROJECT);
    // Nothing from that machine can be checked any more, so nothing can settle it: no one is asked to decide it, and
    // the record says so, so the run's page never lists it as waiting.
    expect(listAllPendingActions(db).map((a) => a.id)).toEqual(["a-local"]);
    expect(listPendingActions(db, PROJECT).map((a) => a.id)).toEqual(["a-local"]);
    expect(countPendingActions(db, PROJECT)).toBe(1);
    expect(workspaceCounts(db).pendingDecisions).toBe(1);
    expect(listActions(db, remote.runId)).toEqual([
      expect.objectContaining({ id: "act-1", status: "denied", decidedBy: null, reason: "The run ended before a decision was made.", decidedAt: failed.ts }),
      expect.objectContaining({ id: "act-2", status: "allowed", decidedBy: "human" }),
    ]);
    // This machine's own run is never touched by a link entry.
    expect(listActions(db, "r2")).toEqual([expect.objectContaining({ id: "a-local", status: "pending" })]);
    const live = dump();
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });

  it("rebuild with mirrored entries equals the live tables", () => {
    mirror(remote.started());
    mirror(remote.connectionUsed());
    mirror(remote.requested("act-1"));
    mirror(remote.decided("act-1", "deny"));
    mirror(remote.completed("act-1", "denied"));
    mirror(remote.record("agent.rate_limited", { runId: remote.runId, retryAfterS: 30 }));
    mirror(remote.requested("act-2"));
    const live = dump();
    expect(live.map((rows) => rows.length)).toEqual([1, 2, 1, 1]);
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
  });

  /** The commit throws and nothing of it stays: no ledger entry, no projection change. */
  const refused = (fn: () => unknown) => {
    const before = ledger.headSeq();
    const tablesBefore = dump();
    expect(fn).toThrow();
    expect(ledger.headSeq()).toBe(before);
    expect(dump()).toEqual(tablesBefore);
  };

  it("refuses a mirrored entry for a run that was never requested of that machine", async () => {
    const stranger = await remoteRun("run-not-requested", PROJECT);
    refused(() => mirror(stranger.started(), stranger.machineId, stranger));
    const elsewhere = await remoteRun(remote.runId, PROJECT);
    refused(() => mirror(elsewhere.started(), elsewhere.machineId, elsewhere));
  });

  it("refuses a mirrored entry in another project than the run's", async () => {
    const other = await remoteRun(remote.runId, "p2");
    // Signed by another key, but the projection does not check signatures: it checks the run and project.
    refused(() => mirror(other.started(), remote.machineId, other));
  });

  it("refuses a mirrored decision or completion of an action that belongs to another run", () => {
    script(); // a local run r1 with actions a1 and a2
    mirror(remote.started());
    refused(() => mirror(remote.decided("a1")));
    refused(() => mirror(remote.completed("a2")));
    refused(() => mirror(remote.requested("a1")));
    expect(listActions(db, "r1").map((a) => a.status)).toEqual(["completed", "failed"]);
  });

  it("refuses a mirrored agent.started whose run id already exists here", () => {
    mirror(remote.started());
    refused(() => mirror(remote.started()));
  });

  it("refuses a duplicate run id for link.run_requested and link.run_accepted, and rolls the commit back", () => {
    const again = { runId: remote.runId, machineId: remote.machineId, adapter: "fake", prompt: "p", cardId: null, connectionIds: [] };
    refused(() => emit("link.run_requested", again, human, PROJECT));
    refused(() => emit("link.run_accepted", { runId: remote.runId, machineId: remote.machineId, projectId: PROJECT }, link, PROJECT));
    emit("link.run_accepted", { runId: "acc-1", machineId: remote.machineId, projectId: PROJECT }, link, PROJECT);
    refused(() => emit("link.run_accepted", { runId: "acc-1", machineId: remote.machineId, projectId: PROJECT }, link, PROJECT));
    refused(() => emit("link.run_requested", { ...again, runId: "acc-1" }, human, PROJECT));
    expect(listLinkRuns(db).map((r) => [r.runId, r.direction])).toEqual([[remote.runId, "requested"], ["acc-1", "accepted"]]);
  });

  it("refuses link.run_requested without a project: its project comes from the entry", () => {
    const req = { runId: "no-project", machineId: remote.machineId, adapter: "fake", prompt: "p", cardId: null, connectionIds: [] };
    refused(() => emit("link.run_requested", req, human, null));
    expect(getLinkRun(db, "no-project")).toBeNull();
  });
});

describe("listProjectGateDecisions", () => {
  it("lists one project's gate decisions across its cards, in ledger order", () => {
    const decide = (projectId: string, cardId: string, gateId: GateId) =>
      emit("gate.waived", {
        gateId, cardId, from: "build", to: "ship", unmet: ["no_pending_actions"], reason: "Known and accepted for the demo",
        acknowledgement: ack(gateId), waivedBy: "owner",
      }, human, projectId);
    decide("p1", "c1", "ready_to_ship");
    decide("p2", "c9", "ready_to_ship");
    decide("p1", "c2", "go_live");
    expect(listProjectGateDecisions(db, "p1").map((d) => [d.cardId, d.gateId])).toEqual([["c1", "ready_to_ship"], ["c2", "go_live"]]);
    expect(listProjectGateDecisions(db, "p3")).toEqual([]);
  });
});

describe("people, invites, remote access and gate requirements", () => {
  const owner = { kind: "human", id: OWNER_ID } as const;
  const cli = { kind: "system", id: "cli" } as const;
  const fp = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16).toUpperCase().padStart(2, "0")).join(":");
  const fp2 = fp.replace(/^00/, "FF");
  const passkey = { kind: "passkey", credentialId: "cred-1", publicKey: "TESTKEY1", transports: ["usb", "nfc"], label: "Laptop" };
  const key = { kind: "key", credentialId: "key-2", publicKey: "TESTKEY2", label: "CLI" };
  const tables = ["people", "credentials", "invites", "remote_state", "gate_requirements"];
  const dump = () => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());

  it("migrates to user_version 11 with the people tables, sessions and credential_state", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    const columns = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("people")).toEqual(["id", "name", "role", "joined_at", "last_seen_at", "removed_at"]);
    expect(columns("sessions")).toEqual([
      "id_hash", "person_id", "listener", "method", "created_at", "last_seen_at", "expires_at", "revoked_at",
    ]);
    expect(columns("credential_state")).toEqual(["credential_id", "counter"]);
  });

  it("the Owner is virtual without a row", () => {
    expect(getPerson(db, OWNER_ID)).toEqual({
      id: OWNER_ID, name: "Owner", role: "owner", joinedAt: null, lastSeenAt: null, removedAt: null, credentials: 0,
    });
    expect(listPeople(db)).toEqual([getPerson(db, OWNER_ID)]);
    expect(getPerson(db, "nobody")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 0 });
  });

  it("remote state is DEFAULT_REMOTE before any entry and follows enabled, certificate_changed and disabled", () => {
    expect(getRemoteState(db)).toEqual(DEFAULT_REMOTE);
    emit("remote.enabled", { port: 4400, bind: "127.0.0.1", domain: null, tls: "self_signed", fingerprint: fp }, cli, null);
    expect(getRemoteState(db)).toEqual({
      enabled: true, port: 4400, bind: "127.0.0.1", domain: null, tls: "self_signed", fingerprint: fp, expiresAt: null,
    });
    emit("remote.certificate_changed", { tls: "acme", fingerprint: fp2, domain: "tt.example.org", expiresAt: "2027-02-01T00:00:00.000Z" }, cli, null);
    expect(getRemoteState(db)).toMatchObject({ enabled: true, port: 4400, tls: "acme", fingerprint: fp2, domain: "tt.example.org", expiresAt: "2027-02-01T00:00:00.000Z" });
    emit("remote.disabled", {}, owner, null);
    expect(getRemoteState(db).enabled).toBe(false);
    // Enabling again with the same certificate keeps its expiry; a new one drops it.
    emit("remote.enabled", { port: 4400, bind: "127.0.0.1", domain: "tt.example.org", tls: "acme", fingerprint: fp2 }, cli, null);
    expect(getRemoteState(db).expiresAt).toBe("2027-02-01T00:00:00.000Z");
    emit("remote.enabled", { port: 4400, bind: "127.0.0.1", domain: null, tls: "self_signed", fingerprint: fp }, cli, null);
    expect(getRemoteState(db).expiresAt).toBeNull();
    // An entry that carries the expiry (every new one does) sets it whatever came before.
    emit("remote.enabled", { port: 4400, bind: "127.0.0.1", domain: null, tls: "self_signed", fingerprint: fp, expiresAt: "2036-11-15T00:00:00.000Z" }, cli, null);
    expect(getRemoteState(db).expiresAt).toBe("2036-11-15T00:00:00.000Z");
  });

  it("a gate requirement is the default until set, and null restores it", () => {
    expect(getGateRequirement(db, "p1", "go_live")).toEqual(DEFAULT_GATE_REQUIREMENT.go_live);
    emit("gate.requirement_set", { gateId: "go_live", requirement: { personId: "p9" } }, owner, "p1");
    expect(getGateRequirement(db, "p1", "go_live")).toEqual({ personId: "p9" });
    expect(getGateRequirement(db, "p2", "go_live")).toEqual(DEFAULT_GATE_REQUIREMENT.go_live);
    emit("gate.requirement_set", { gateId: "go_live", requirement: { role: "maintainer" } }, owner, "p1");
    expect(getGateRequirement(db, "p1", "go_live")).toEqual({ role: "maintainer" });
    emit("gate.requirement_set", { gateId: "go_live", requirement: null }, owner, "p1");
    expect(getGateRequirement(db, "p1", "go_live")).toEqual(DEFAULT_GATE_REQUIREMENT.go_live);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gate_requirements").get()).toEqual({ n: 0 });
  });

  it("an expired invite reads as expired at read time, with no entry", () => {
    emit("person.invited", { inviteId: "i1", role: "viewer", codeHash: "a".repeat(64), expiresAt: "2026-11-16T00:00:00.000Z" }, owner, null);
    expect(getInviteByHash(db, "a".repeat(64), new Date("2026-11-15T23:59:59.999Z"))!.status).toBe("pending");
    expect(getInviteByHash(db, "a".repeat(64), new Date("2026-11-16T00:00:00.000Z"))!.status).toBe("expired");
    expect(listInvites(db, new Date("2026-11-16T00:00:00.000Z")).map((i) => i.status)).toEqual(["expired"]);
    expect(getInviteByHash(db, "b".repeat(64))).toBeNull();
  });

  it("rebuild after the whole people sequence equals the live five tables row for row", () => {
    const p1 = { kind: "human", id: "p1" } as const;
    emit("person.invited", { inviteId: "i1", role: "reviewer", codeHash: "a".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" }, owner, null);
    emit("person.invited", { inviteId: "i2", role: "viewer", codeHash: "b".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" }, owner, null);
    emit("person.invited", { inviteId: "i3", role: "owner", codeHash: "c".repeat(64), expiresAt: "2026-12-01T00:00:00.000Z" }, owner, null);
    emit("person.invite_revoked", { inviteId: "i2" }, owner, null);
    emit("person.joined", { personId: "p1", inviteId: "i1", name: "Reviewer One", role: "reviewer", credential: passkey }, p1, null);
    emit("person.credential_added", { personId: "p1", credential: key }, owner, null);
    emit("person.credential_removed", { personId: "p1", credentialId: "cred-1" }, owner, null);
    emit("person.credential_added", { personId: OWNER_ID, credential: { ...key, credentialId: "key-3", publicKey: "TESTKEY3" } }, owner, null);
    emit("person.renamed", { personId: OWNER_ID, name: "Ana" }, owner, null);
    emit("person.renamed", { personId: "p1", name: "Reviewer Uno" }, owner, null);
    emit("person.role_changed", { personId: "p1", from: "reviewer", to: "maintainer" }, owner, null);
    emit("person.signed_in", { personId: "p1", listener: "remote", method: "key" }, p1, null);
    emit("person.locked", { personId: "p1", until: "2026-11-15T10:15:00.000Z", failures: 5 }, { kind: "system", id: "auth" }, null);
    emit("person.removed", { personId: "p1" }, owner, null);
    emit("remote.enabled", { port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: fp }, cli, null);
    emit("remote.certificate_changed", { tls: "self_signed", fingerprint: fp2, domain: null, expiresAt: "2027-11-15T00:00:00.000Z" }, cli, null);
    emit("gate.requirement_set", { gateId: "go_live", requirement: { personId: "p1" } }, owner, "p1");
    emit("gate.requirement_set", { gateId: "payments", requirement: { role: "reviewer" } }, owner, "p1");
    emit("gate.requirement_set", { gateId: "payments", requirement: null }, owner, "p1");

    const live = dump();
    expect(live.map((rows) => rows.length)).toEqual([2, 3, 3, 1, 1]);
    expect(db.prepare("SELECT transports FROM credentials WHERE credential_id = 'key-2'").get()).toEqual({ transports: "[]" });
    rebuildAllProjections(db, ledger);
    expect(dump()).toEqual(live);
    expect(listPeople(db, { includeRemoved: true }).map((p) => [p.id, p.name, p.role])).toEqual([
      [OWNER_ID, "Ana", "owner"], ["p1", "Reviewer Uno", "maintainer"],
    ]);
  });

  it("rebuild leaves sessions and credential_state alone", () => {
    db.prepare("INSERT INTO credential_state (credential_id, counter) VALUES ('cred-1', 7)").run();
    db.prepare(
      `INSERT INTO sessions (id_hash, person_id, listener, method, created_at, last_seen_at, expires_at)
       VALUES ('h', 'p1', 'local', 'passkey', 'x', 'x', 'x')`,
    ).run();
    rebuildAllProjections(db, ledger);
    expect(db.prepare("SELECT COUNT(*) AS n FROM credential_state").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  });
});
