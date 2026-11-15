import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHARE_OPTIONS, GATES, HIDDEN_BY_DEFAULT, HIDDEN_HARDWARE_LINE, HIDDEN_PROMPTS_LINE, type CapacityHardware, type CiStatus, type GateId, type ShareOptions,
  type ShareSnapshot,
} from "@theterminal/shared";
import { NotFoundError } from "../../src/board/board-service.js";
import { canonicalJson } from "../../src/ledger/canonical.js";
import { SHARE_TEXT_MAX, shareCleaner } from "../../src/share/clean.js";
import { SHARE_LIMITS, buildSnapshot, evidenceOf, type SnapshotDeps } from "../../src/share/snapshot.js";
import { NOON, completeIntake, emit, human, startRun, world, type World } from "./setup.js";

const SECRET = "zq-TESTKEY-e2e-opaque-0000000000";
const PROMPT = "Build the login page";
const OTHER_CARD = "Plant the tomatoes";
const ack = (id: GateId) => GATES.find((g) => g.id === id)!.acknowledgement;
const clean = shareCleaner({
  dataDir: join(tmpdir(), "theterminal-share-snapshot-data"), secrets: () => [SECRET], username: "alice", home: "/Users/alice",
});

let w: World;
let projectId: string;
let otherId: string;

function deps(over: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    db: w.db, ledger: w.ledger, integrity: () => w.ledger.verify(), gates: w.gates, connections: () => w.connections.list(),
    ci: async () => null, hardware: () => null, clean, now: () => NOON, ...over,
  };
}
const build = (options: Partial<ShareOptions> = {}, over: Partial<SnapshotDeps> = {}, id = projectId): Promise<ShareSnapshot> =>
  buildSnapshot(deps(over), id, { ...DEFAULT_SHARE_OPTIONS, ...options });

const cardId = (title: string) =>
  (w.db.prepare("SELECT id FROM cards WHERE title = ?").get(title) as { id: string }).id;

/**
 * Book Club: a completed intake (private, no payments, budget $25) that added five cards, one of them done; card
 * Login; a fake run on Login that asked to run a command (allowed by the Owner), returned a secret, said `I am done`
 * and finished at $0.10; a second run waiting on a decision; Login moved to Ship under a waiver. Garden Log is a
 * second project with its own card and decision.
 */
function bookClub(): void {
  projectId = w.board.createProject(human, { name: "Book Club", pitch: "Reading lists for a club" }).id;
  completeIntake(w, projectId);
  w.board.setCardStatus(human, cardId('Define what "done" means'), "done");
  const login = w.board.addCard(human, projectId, { title: "Login", stage: "build" }).id;

  startRun(w, projectId, "r1", "fake", login, PROMPT);
  emit(w, projectId, "agent.action.requested", { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "ls", input: { command: "ls" } });
  emit(w, projectId, "agent.action.decided", { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" }, human);
  emit(w, projectId, "agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: SECRET });
  emit(w, projectId, "agent.message", { runId: "r1", text: "I am done" });
  emit(w, projectId, "agent.finished", { runId: "r1", status: "completed", costUsd: 0.1, error: null });

  startRun(w, projectId, "r2", "fake", null, "Check the GPU");
  emit(w, projectId, "agent.action.requested", {
    runId: "r2", actionId: "a2", kind: "shell", tool: "Bash", summary: "nvidia-smi", input: { command: "nvidia-smi" },
  });

  w.gates.move(human, login, "ship", [
    { gateId: "ready_to_ship", decision: "waive", reason: "We are only testing this", acknowledgement: ack("ready_to_ship") },
  ]);

  otherId = w.board.createProject(human, { name: "Garden Log" }).id;
  const other = w.board.addCard(human, otherId, { title: OTHER_CARD, stage: "build" }).id;
  startRun(w, otherId, "g1", "fake", other, "Water the garden");
  emit(w, otherId, "agent.action.requested", { runId: "g1", actionId: "ga1", kind: "shell", tool: "Bash", summary: "water", input: null });
  emit(w, otherId, "agent.action.decided", { runId: "g1", actionId: "ga1", decision: "deny", by: "human", reason: "Garden secret" }, human);
}

beforeEach(() => {
  w = world();
});

describe("buildSnapshot", () => {
  beforeEach(bookClub);

  it("counts progress and the headline numbers", async () => {
    const s = await build();
    expect(s.version).toBe(1);
    expect(s.generatedAt).toBe(NOON.toISOString());
    expect(s.project).toMatchObject({ name: "Book Club", pitch: "Reading lists for a club" });
    expect(s.owner).toBe("Owner");
    expect(s.progress.plan).toEqual({ total: 1, done: 1 });
    expect(s.progress.ship.total).toBe(2);
    expect(s.currentStage).toBe("design");
    expect(s.numbers).toMatchObject({
      cardsDone: 1, cardsTotal: 6, runsCompleted: 1, runsTotal: 2, spendUsd: { value: 0.1, basis: "estimate" }, budgetUsd: 25,
      decisionsMade: 4, decisionsWaiting: 1, overrides: 0, ci: null,
    });
    expect(s.numbers.costPerDayUsd).toEqual({ value: 0.1, basis: "estimate" });
    expect(s.summary).toContain("Book Club is for Members of a book club");
    expect(s.idea).toBe("Reading lists for a club");
  });

  it("lists what is waiting, newest decisions first, and the readiness gates", async () => {
    const s = await build();
    expect(s.waiting).toHaveLength(1);
    expect(s.waiting[0]!.headline).toContain("wants to run the command");
    expect(s.waiting[0]).toMatchObject({ kind: "action", assignee: "a reviewer or above", cardTitle: null });
    expect(s.waiting[0]!.since).toMatch(/^2026-11-15T/);

    expect(s.decisions.map((d) => d.kind)).toEqual(["gate_waiver", "action", "intake", "intake"]);
    expect(s.decisions[0]!.reason).toBe("We are only testing this");
    expect(s.decisions[1]!.reason).toBeNull();
    expect(s.decisions.map((d) => d.evidence.seq)).toEqual([...s.decisions.map((d) => d.evidence.seq)].sort((a, b) => b - a));
    expect(s.decisionsOmitted).toBe(0);

    const readiness = Object.fromEntries(s.readiness.map((r) => [r.gateId, r]));
    expect(s.readiness.map((r) => r.gateId)).toEqual(GATES.map((g) => g.id));
    expect(readiness.plan_approved!.state).toBe("not_reached");
    expect(readiness.ready_to_ship).toMatchObject({ state: "waived", detail: "We are only testing this", cardTitle: "Login" });
    expect(readiness.ready_to_ship!.evidence).toEqual(s.decisions[0]!.evidence);
    expect(readiness.go_live!.state).toBe("open");
    expect(readiness.go_live!.detail).toContain("No agent is waiting for a decision in this project");
    expect(readiness.over_budget!.state).toBe("not_reached");
  });

  it("narrates the day without what agents said or returned", async () => {
    const s = await build();
    expect(s.digests).toHaveLength(1);
    expect(s.digests[0]!.day).toBe("2026-11-15");
    const headlines = s.digests[0]!.items.map((i) => i.headline);
    expect(headlines.some((h) => h.includes("wants to run the command"))).toBe(true);
    expect(headlines.join("\n")).not.toContain("I am done");
    expect(headlines.join("\n")).not.toContain("zq-TESTKEY");
    expect(s.history).toEqual([]);
  });

  it("carries none of the output, the messages, the prompts or the other project", async () => {
    const json = JSON.stringify(await build());
    for (const hidden of [SECRET, "zq-TESTKEY", "I am done", PROMPT, OTHER_CARD, "Garden", "Water the garden", "Check the GPU"]) {
      expect(json).not.toContain(hidden);
    }
    const s = await build();
    expect(s.asks).toEqual([]);
    expect(s.hidden).toEqual([...HIDDEN_BY_DEFAULT]);
    expect(s.hardware).toBeNull();
  });

  it("shows the prompts only when asked, and drops their line from what is hidden", async () => {
    const s = await build({ includePrompts: true });
    expect(s.asks[0]).toMatchObject({ day: "2026-11-15", adapterLabel: "Fake", cardTitle: "Login", prompt: PROMPT });
    expect(s.asks[0]!.time).toMatch(/^\d\d:\d\d$/);
    expect(s.asks).toHaveLength(2);
    expect(s.hidden).toHaveLength(HIDDEN_BY_DEFAULT.length - 1);
    expect(s.hidden).not.toContain(HIDDEN_PROMPTS_LINE);
    expect(s.hidden).toContain(HIDDEN_HARDWARE_LINE);
    expect(JSON.stringify(s)).not.toContain("Water the garden");
  });

  it("shows this computer only when asked, without the connection's enabled flag", async () => {
    const hw: CapacityHardware = {
      cpu: "Test CPU", cores: 8, memoryGb: 16, gpu: null, gpuMemoryGb: null, platform: "linux", wsl: false,
      detectedAt: "2026-11-15T08:00:00.000Z", enabled: true,
    };
    expect((await build({}, { hardware: () => hw })).hardware).toBeNull();
    const s = await build({ includeHardware: true }, { hardware: () => hw });
    const { enabled: _enabled, ...info } = hw;
    expect(s.hardware).toEqual(info);
    expect(s.hidden).not.toContain(HIDDEN_HARDWARE_LINE);
    expect(s.hidden).toContain(HIDDEN_PROMPTS_LINE);
    expect((await build({ includeHardware: true }, { hardware: () => ({ ...hw, enabled: false }) })).hardware).toBeNull();
  });

  it("names the connection.added entry of each connection row, though connections belong to no project", async () => {
    await w.connections.add(human, {
      kind: "cloud", provider: "aws", name: "My prod account", config: { region: "us-east-1" },
      secrets: { accessKeyId: "AKIATESTKEY00000000", secretAccessKey: "aws-TESTKEY-secret-0000000000" },
    });
    const added = w.ledger.list({ limit: 500 }).find((e) => e.type === "connection.added")!;
    expect(added.projectId).toBeNull();
    const s = await build();
    const cloud = s.stack.find((r) => r.layer === "Cloud")!;
    expect(cloud.evidence).toEqual({ seq: added.seq, hash12: added.hash.slice(0, 12), at: added.ts });
    expect(cloud.evidence!.hash12).toMatch(/^[0-9a-f]{12}$/);
    const json = JSON.stringify(s);
    expect(json).not.toContain("My prod account");
    expect(json).not.toContain("us-east-1");
  });

  it("takes the CI state from the client", async () => {
    const ci: CiStatus = { state: "passing", url: null, branch: "main", updatedAt: null };
    expect((await build({}, { ci: async () => ci })).numbers.ci).toBe("passing");
  });

  it("reports the audit status from the integrity check and the ledger head", async () => {
    const s = await build();
    const head = w.ledger.list({ afterSeq: w.ledger.headSeq() - 1 })[0]!;
    expect(s.audit).toEqual({
      ok: true, entries: w.ledger.headSeq(), brokenAtSeq: null, headSeq: w.ledger.headSeq(), headHash12: head.hash.slice(0, 12),
    });
  });

  it("is refused for an unknown project", async () => {
    await expect(build({}, {}, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("buildSnapshot cleaning", () => {
  it("scrubs the username, the home path and email addresses from the pitch", async () => {
    projectId = w.board.createProject(human, { name: "Club", pitch: "by alice at /Users/alice, someone@example.test" }).id;
    expect((await build()).project.pitch).toBe("by <user> at ~, [email]");
  });

  /** Appends a row with a valid hash chain but a payload no schema would accept, as a rewritten ledger could hold. */
  function appendRaw(type: string, payload: unknown, pid: string | null): void {
    const last = w.db.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string };
    const base = {
      seq: last.seq + 1, id: randomUUID(), ts: "2026-11-15T11:00:00.000Z", projectId: pid, actor: human, type, payload,
      prevHash: last.hash,
    };
    const hash = createHash("sha256").update(canonicalJson(base)).digest("hex");
    w.db.prepare(
      `INSERT INTO ledger (seq, id, ts, project_id, actor_kind, actor_id, type, payload, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(base.seq, base.id, base.ts, pid, "human", "owner", type, canonicalJson(payload), base.prevHash, hash);
  }

  // The hostile entry carries about 100 MB of text to hash, verify and clean, which takes CI runners 2.5 to 4 s while
  // the other packages' suites load the same machine; the default 5 s has cut it off. The cap is what is tested.
  it("cleans and caps narration of a hostile share.confirmed entry", { timeout: 30_000 }, async () => {
    projectId = w.board.createProject(human, { name: "Club" }).id;
    const huge = "x".repeat(20_000);
    appendRaw("share.confirmed", {
      shareId: "s1", contentHash: "0".repeat(64), bytes: `${huge}${SECRET}`, sections: Array.from({ length: 5000 }, () => huge),
      options: { evil: `${huge} ${SECRET} someone@example.test /Users/alice/x by alice` }, headSeq: 1,
    }, projectId);
    expect(w.ledger.verify().ok).toBe(true);
    const s = await build();
    expect(s.digests[0]!.items.some((i) => i.headline.includes("confirmed a share page"))).toBe(true);
    const strings: string[] = [];
    JSON.stringify(s, (_k, v: unknown) => {
      if (typeof v === "string") strings.push(v);
      return v;
    });
    for (const str of strings) expect(str.length).toBeLessThanOrEqual(SHARE_TEXT_MAX);
    const json = JSON.stringify(s);
    for (const bad of [SECRET, "someone@example.test", "/Users/alice", "x".repeat(100), '"evil"']) expect(json).not.toContain(bad);
  });

  it("shows no entry from the break on when the chain is broken", async () => {
    projectId = w.board.createProject(human, { name: "Club" }).id;
    w.board.addCard(human, projectId, { title: "Before", stage: "plan" });
    const head = w.ledger.headSeq();
    w.db.prepare(
      `INSERT INTO ledger (seq, id, ts, project_id, actor_kind, actor_id, type, payload, prev_hash, hash)
       VALUES (?, ?, ?, ?, 'human', 'owner', 'card.created', ?, 'bad', 'bad')`,
    ).run(head + 1, randomUUID(), "2026-11-15T11:00:00.000Z", projectId, canonicalJson({ cardId: "x", title: "Tampered", stage: "plan" }));
    const s = await build();
    expect(s.audit).toMatchObject({ ok: false, brokenAtSeq: head + 1, entries: head, headSeq: head + 1, headHash12: "bad" });
    expect(JSON.stringify(s.digests)).not.toContain("Tampered");
    expect(JSON.stringify(s.digests)).toContain("Before");
  });
});

describe("buildSnapshot history and limits", () => {
  it("keeps days before the digest window as one history line each, oldest first", async () => {
    w.at("2026-10-01T10:00:00.000Z");
    projectId = w.board.createProject(human, { name: "Club" }).id;
    w.at("2026-10-02T10:00:00.000Z");
    const c = w.board.addCard(human, projectId, { title: "Old", stage: "plan" }).id;
    w.board.moveCard(human, c, "design");
    w.at("2026-11-15T10:00:00.000Z");
    w.board.addCard(human, projectId, { title: "New", stage: "plan" });
    const s = await build();
    expect(s.digests.map((d) => d.day)).toEqual(["2026-11-15"]);
    expect(s.history).toEqual([
      { day: "2026-10-01", entries: 1, actions: 0, decisions: 0, cardsMoved: 0 },
      { day: "2026-10-02", entries: 2, actions: 0, decisions: 0, cardsMoved: 1 },
    ]);
    expect((await build({ digestDays: 30 })).history).toHaveLength(2);
    w.at("2026-11-09T10:00:00.000Z");
    w.board.addCard(human, projectId, { title: "Week", stage: "plan" });
    // Seven UTC days end at noon on the 15th: the 9th through the 15th.
    expect((await build()).digests.map((d) => d.day)).toEqual(["2026-11-15", "2026-11-09"]);
  });

  it("evidenceOf names the entry by seq, the first twelve characters of its hash and its time", () => {
    projectId = w.board.createProject(human, { name: "Club" }).id;
    const e = w.ledger.list()[0]!;
    expect(evidenceOf(e)).toEqual({ seq: e.seq, hash12: e.hash.slice(0, 12), at: e.ts });
    expect(SHARE_LIMITS).toEqual({ decisions: 200, waiting: 50, readinessCards: 20, historyDays: 2000, asksPerDay: 50 });
  });

  it("keeps the newest 200 decisions and counts the rest", async () => {
    projectId = w.board.createProject(human, { name: "Club" }).id;
    startRun(w, projectId, "r1", "fake", null);
    for (let i = 0; i < 205; i++) {
      emit(w, projectId, "agent.action.requested", { runId: "r1", actionId: `a${i}`, kind: "shell", tool: "Bash", summary: "ls", input: null });
      emit(w, projectId, "agent.action.decided", { runId: "r1", actionId: `a${i}`, decision: "allow", by: "human", reason: "" }, human);
    }
    const s = await build();
    expect(s.decisions).toHaveLength(200);
    expect(s.decisionsOmitted).toBe(5);
    expect(s.numbers.decisionsMade).toBe(205);
  });
});

describe("buildSnapshot attributions", () => {
  const p1 = { kind: "human", id: "p1" } as const;

  function joinReviewer(): void {
    emit(w, null, "person.invited", { inviteId: "i1", role: "reviewer", codeHash: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" }, human);
    emit(w, null, "person.joined", {
      personId: "p1", inviteId: "i1", name: "Reviewer One", role: "reviewer",
      credential: { kind: "key", credentialId: "key-p1", publicKey: "TESTKEYp1", label: "CLI" },
    }, p1);
  }

  beforeEach(() => {
    projectId = w.board.createProject(human, { name: "Book Club", pitch: "Reading lists for a club" }).id;
    w.intake.start(human, projectId, "Reading lists for a club");
    joinReviewer();
    const login = w.board.addCard(human, projectId, { title: "Login", stage: "build" }).id;
    emit(w, projectId, "agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "go", cardId: login, worktree: "wt/r1" }, p1);
    emit(w, projectId, "agent.finished", { runId: "r1", status: "completed", costUsd: null, error: null });
    w.gates.move(p1, login, "ship", [
      { gateId: "ready_to_ship", decision: "waive", reason: "Only a demo for the club", acknowledgement: ack("ready_to_ship") },
    ]);
  });

  it("names the reviewer who waived, the Owner, and who may answer what waits", async () => {
    const s = await build();
    expect(s.owner).toBe("Owner");
    expect(s.decisions[0]).toMatchObject({ kind: "gate_waiver", by: "Reviewer One" });
    expect(s.decisions[0]!.headline).toContain("Reviewer One waived");
    expect(s.waiting).toEqual([]);
    startRun(w, projectId, "r2", "fake", null);
    emit(w, projectId, "agent.action.requested", { runId: "r2", actionId: "a2", kind: "shell", tool: "Bash", summary: "ls", input: null });
    expect((await build()).waiting[0]).toMatchObject({ kind: "action", assignee: "a reviewer or above" });
    const started = s.digests[0]!.items.find((i) => i.headline.includes("started a Fake agent"));
    expect(started!.headline).toMatch(/^Reviewer One started a Fake agent/);
    expect(JSON.stringify(s)).not.toContain('"by":"Owner"');
  });

  it("uses the Owner's chosen name once renamed, and a fixed phrase for someone not on record", async () => {
    emit(w, null, "person.renamed", { personId: "owner", name: "Dana" }, human);
    // A decision whose signer has no record (an id nobody holds): the page does not invent a name.
    const login = (w.db.prepare("SELECT id FROM cards WHERE title = 'Login'").get() as { id: string }).id;
    emit(w, projectId, "gate.signed_off", {
      gateId: "go_live", cardId: login, from: "ship", to: "operate", conditions: [], acknowledgement: ack("go_live"), signedBy: "ghost",
    }, { kind: "human", id: "ghost" });
    const s = await build();
    expect(s.owner).toBe("Dana");
    expect(s.decisions[0]).toMatchObject({ kind: "gate_sign_off", by: "a former collaborator" });
    expect(s.decisions[1]).toMatchObject({ kind: "gate_waiver", by: "Reviewer One" });
  });
});
