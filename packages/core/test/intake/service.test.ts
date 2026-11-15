import { homedir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Answers, LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService, NotFoundError } from "../../src/board/board-service.js";
import { ConflictError } from "../../src/connections/service.js";
import { applyEvent, rebuildAllProjections } from "../../src/events/projections.js";
import {
  DecisionNotApplicableError, HumanRequiredError, IntakeCompletedError, IntakeIncompleteError, IntakeService,
  NoIntakeError, SecretInTextError,
} from "../../src/intake/service.js";

const human = { kind: "human", id: "owner" } as const;
const system = { kind: "system", id: "runner" } as const;
const IDEA = "A reading list for a book club";
const SECRET = "sk-ant-TESTKEY-0000000000";

/** A private, no-payments, no-data idea used on the web only. */
const ANSWERS: Answers = {
  audience: "Members of a book club",
  outcome: "Keep a shared reading list",
  success: "The club picks its next book from the list",
  platform: ["web"],
  payments: "no",
  personal_data: "none",
  exposure: "private",
  budget_usd: 20,
  existing: "Nothing yet",
};
const FIVE = [
  'Define what "done" means',
  "Sketch the main screens and flows",
  "Build the smallest version that proves the idea",
  "Run it on this computer",
  "Monitoring and health checks",
];

let db: Db;
let ledger: Ledger;
let board: BoardService;
let intake: IntakeService;
let projectId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  board = new BoardService(db, ledger);
  intake = new IntakeService({ db, ledger, username: "clubuser" });
  projectId = board.createProject(human, { name: "Book Club" }).id;
});

const entriesAfter = (seq: number): LedgerEntry[] => ledger.list({ afterSeq: seq });

function answerAll(answers: Answers = ANSWERS) {
  for (const [q, a] of Object.entries(answers)) intake.answer(human, projectId, q as never, a);
}
function decideBoth() {
  intake.decide(human, projectId, "first_version", "smallest", "Start small");
  intake.decide(human, projectId, "hosting", "local");
}

describe("IntakeService", () => {
  it("start commits one intake.started with version 1; the view asks for answers", () => {
    const before = ledger.headSeq();
    const view = intake.start(human, projectId, `  ${IDEA}  `);
    const added = entriesAfter(before);
    expect(added.map((e) => e.type)).toEqual(["intake.started"]);
    expect(added[0]!.projectId).toBe(projectId);
    expect(added[0]!.payload).toMatchObject({ idea: IDEA, version: 1, intakeId: view.intake.id });
    expect(view.step).toBe("answer");
    expect(intake.get(projectId)!.step).toBe("answer");
    expect(view.questions).toHaveLength(9);
    expect(view.plan).toBeNull();
  });

  it("get is null without an intake and NotFoundError for an unknown project", () => {
    expect(intake.get(projectId)).toBeNull();
    expect(() => intake.get("nope")).toThrow(NotFoundError);
    expect(() => intake.start(human, "nope", IDEA)).toThrow(NotFoundError);
  });

  it("refuses commands on a project without an intake, so no orphan rows are written", () => {
    const before = ledger.headSeq();
    expect(() => intake.answer(human, projectId, "audience", "x")).toThrow(NoIntakeError);
    expect(() => intake.decide(human, projectId, "hosting", "local")).toThrow(NoIntakeError);
    expect(() => intake.complete(human, projectId)).toThrow(NoIntakeError);
    expect(() => intake.reopen(human, projectId, "The scope changed")).toThrow(NoIntakeError);
    expect(ledger.headSeq()).toBe(before);
  });

  it("walks answer → decide → approve → completed, creating the plan's cards in one batch", () => {
    intake.start(human, projectId, IDEA);
    answerAll();
    let view = intake.get(projectId)!;
    expect(view.step).toBe("decide");
    expect(view.decisions.map((d) => d.id)).toEqual(["first_version", "hosting"]);
    const hosting = view.decisions.find((d) => d.id === "hosting")!;
    expect(hosting.recommended).toBe("local");
    expect(hosting.because).toEqual([{ label: "Who can reach it?", answer: "Only me, on my computer" }]);
    expect(intake.openDecisionCount()).toBe(2);
    expect(intake.openDecisionsByProject()).toEqual([{ projectId, name: "Book Club", decisions: 2 }]);

    decideBoth();
    view = intake.get(projectId)!;
    expect(view.step).toBe("approve");
    expect(view.plan!.cards.map((c) => c.title)).toEqual(FIVE);
    expect(view.decisions.find((d) => d.id === "first_version")).toMatchObject({
      chosen: "smallest", rationale: "Start small", owner: "owner",
    });
    expect(view.decisions.find((d) => d.id === "hosting")!.rationale).toBe("");
    expect(intake.openDecisionCount()).toBe(0);
    expect(intake.openDecisionsByProject()).toEqual([]);

    const before = ledger.headSeq();
    view = intake.complete(human, projectId);
    const added = entriesAfter(before);
    expect(added.map((e) => e.type)).toEqual(["intake.completed", ...FIVE.map(() => "card.created")]);
    expect(added.map((e) => e.seq)).toEqual(added.map((_, i) => before + 1 + i));
    expect(added.every((e) => e.projectId === projectId)).toBe(true);
    expect(added.slice(1).every((e) => e.actor.kind === "human" && e.actor.id === "owner")).toBe(true);
    const completed = added[0]!.payload as { summary: string; cards: { cardId: string; title: string; outcome: string }[] };
    expect(completed.cards.map((c) => [c.title, c.outcome])).toEqual(FIVE.map((t) => [t, "created"]));
    expect(added.slice(1).map((e) => (e.payload as { cardId: string }).cardId)).toEqual(completed.cards.map((c) => c.cardId));
    expect(view.step).toBe("completed");
    expect(intake.get(projectId)!.plan!.summary).toBe(completed.summary);
    expect(completed.summary).toContain("Book Club is for Members of a book club");
    const titles = Object.values(board.getBoard(projectId).columns).flat().map((c) => c.title);
    expect(titles.sort()).toEqual([...FIVE].sort());

    expect(() => intake.answer(human, projectId, "audience", "Readers")).toThrow(IntakeCompletedError);
    expect(() => intake.decide(human, projectId, "hosting", "own_cloud")).toThrow(IntakeCompletedError);
    expect(() => intake.complete(human, projectId)).toThrow(IntakeCompletedError);
  });

  it("after a reopen, a new applicable decision blocks completion, then adds only the new card", () => {
    intake.start(human, projectId, IDEA);
    answerAll();
    decideBoth();
    intake.complete(human, projectId);
    expect(() => intake.reopen(human, projectId, "We will sell copies")).not.toThrow();
    expect(() => intake.reopen(human, projectId, "Again")).toThrow(ConflictError);
    intake.answer(human, projectId, "payments", "yes");
    const view = intake.get(projectId)!;
    expect(view.step).toBe("decide");
    expect(view.decisions.map((d) => d.id)).toContain("payments_scope");

    try {
      intake.complete(human, projectId);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntakeIncompleteError);
      expect((e as IntakeIncompleteError).missing).toEqual({ questions: [], decisions: ["payments_scope"] });
    }

    intake.decide(human, projectId, "payments_scope", "provider");
    const before = ledger.headSeq();
    intake.complete(human, projectId);
    const added = entriesAfter(before);
    expect(added.map((e) => e.type)).toEqual(["intake.completed", "card.created"]);
    expect(added[1]!.payload).toMatchObject({ title: "Payments readiness review", stage: "ship" });
    const cards = (added[0]!.payload as { cards: { title: string; outcome: string; cardId: string }[] }).cards;
    expect(cards.filter((c) => c.outcome === "created").map((c) => c.title)).toEqual(["Payments readiness review"]);
    const existing = cards.filter((c) => c.outcome === "existing");
    expect(existing.map((c) => c.title)).toEqual(FIVE);
    const ids = new Map(Object.values(board.getBoard(projectId).columns).flat().map((c) => [c.title, c.id]));
    expect(existing.every((c) => ids.get(c.title) === c.cardId)).toBe(true);
  });

  it("lists the missing questions when answers are incomplete", () => {
    intake.start(human, projectId, IDEA);
    intake.answer(human, projectId, "audience", "Members of a book club");
    try {
      intake.complete(human, projectId);
      expect.unreachable();
    } catch (e) {
      expect((e as IntakeIncompleteError).missing.questions).toEqual([
        "outcome", "success", "platform", "payments", "personal_data", "exposure", "budget_usd",
      ]);
    }
  });

  it("start twice is a ConflictError", () => {
    intake.start(human, projectId, IDEA);
    expect(() => intake.start(human, projectId, IDEA)).toThrow(ConflictError);
  });

  it("refuses a decision that is not applicable, or whose questions are unanswered", () => {
    intake.start(human, projectId, IDEA);
    expect(() => intake.decide(human, projectId, "hosting", "local")).toThrow(DecisionNotApplicableError);
    answerAll();
    expect(() => intake.decide(human, projectId, "payments_scope", "provider")).toThrow(DecisionNotApplicableError);
  });

  it("validates answers and choices against the catalog without writing", () => {
    intake.start(human, projectId, IDEA);
    const before = ledger.headSeq();
    expect(() => intake.answer(human, projectId, "payments", "maybe")).toThrow(ZodError);
    expect(() => intake.answer(human, projectId, "nope" as never, "x")).toThrow(ZodError);
    expect(() => intake.answer(human, projectId, "audience", "   ")).toThrow(ZodError);
    answerAll();
    const after = ledger.headSeq();
    expect(() => intake.decide(human, projectId, "hosting", "moon")).toThrow(ZodError);
    expect(ledger.headSeq()).toBe(after);
    expect(after - before).toBe(9);
  });

  it("refuses a secret in any text with SecretInTextError, writing nothing", () => {
    const before = ledger.headSeq();
    expect(() => intake.start(human, projectId, `Use ${SECRET} to log in`)).toThrow(SecretInTextError);
    expect(ledger.headSeq()).toBe(before);
    try {
      intake.start(human, projectId, `Use ${SECRET}`);
    } catch (e) {
      expect((e as Error).message).not.toContain("TESTKEY");
    }
    intake.start(human, projectId, IDEA);
    const mid = ledger.headSeq();
    expect(() => intake.answer(human, projectId, "existing", `token ${SECRET}`)).toThrow(SecretInTextError);
    answerAll();
    const answered = ledger.headSeq();
    expect(() => intake.decide(human, projectId, "hosting", "local", `key ${SECRET}`)).toThrow(SecretInTextError);
    decideBoth();
    intake.complete(human, projectId);
    const done = ledger.headSeq();
    expect(() => intake.reopen(human, projectId, `rotate ${SECRET}`)).toThrow(SecretInTextError);
    expect(ledger.headSeq()).toBe(done);
    expect(answered - mid).toBe(9);
  });

  it("refuses an extra secret supplied by the server", () => {
    const svc = new IntakeService({ db, ledger, secrets: () => ["club-session-token-123456"] });
    expect(() => svc.start(human, projectId, "see club-session-token-123456")).toThrow(SecretInTextError);
  });

  it("refuses a secret that the scrubber would rewrite (it contains the username or a home path)", () => {
    const bearing = "clubuser!Hunter2Pass";
    const pathy = `${homedir()}/Hunter2Pass`;
    const svc = new IntakeService({ db, ledger, username: "clubuser", secrets: () => [bearing, pathy] });
    const before = ledger.headSeq();
    expect(() => svc.start(human, projectId, `the club password is ${bearing}`)).toThrow(SecretInTextError);
    expect(() => svc.start(human, projectId, `keep ${pathy} safe`)).toThrow(SecretInTextError);
    expect(ledger.headSeq()).toBe(before);
    svc.start(human, projectId, IDEA);
    const started = ledger.headSeq();
    expect(() => svc.answer(human, projectId, "existing", `login ${bearing}`)).toThrow(SecretInTextError);
    expect(ledger.headSeq()).toBe(started);
    expect(JSON.stringify(ledger.list())).not.toContain("Hunter2Pass");
  });

  it("trims a text answer before it is validated and recorded", () => {
    intake.start(human, projectId, IDEA);
    intake.answer(human, projectId, "audience", "   Members of a book club \n");
    expect(intake.get(projectId)!.questions[0]!.answer).toBe("Members of a book club");
    // The length limit applies to the trimmed text.
    const full = "x".repeat(2000);
    intake.answer(human, projectId, "outcome", `  ${full}  `);
    expect(intake.get(projectId)!.questions[1]!.answer).toBe(full);
  });

  it("explains in the approve view, and on completion, when the project name looks like a secret", () => {
    const named = board.createProject(human, { name: "Club sk-ant-TESTKEY-0000000000" }).id;
    intake.start(human, named, IDEA);
    for (const [q, a] of Object.entries(ANSWERS)) intake.answer(human, named, q as never, a);
    intake.decide(human, named, "first_version", "smallest");
    intake.decide(human, named, "hosting", "local");
    const view = intake.get(named)!;
    const message = "The project name looks like it contains a secret. Rename the project to continue.";
    expect(view.step).toBe("approve");
    expect(view.plan!.problem).toBe(message);
    expect(view.plan!.summary).not.toContain("TESTKEY");
    const before = ledger.headSeq();
    try {
      intake.complete(human, named);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SecretInTextError);
      expect((e as SecretInTextError).explanation).toBe(message);
      expect((e as Error).message).not.toContain("TESTKEY");
    }
    expect(ledger.headSeq()).toBe(before);
  });

  it("names the answer when a recorded answer later matches a secret", () => {
    let secrets: string[] = [];
    const svc = new IntakeService({ db, ledger, secrets: () => secrets });
    svc.start(human, projectId, IDEA);
    for (const [q, a] of Object.entries(ANSWERS)) svc.answer(human, projectId, q as never, a);
    svc.decide(human, projectId, "first_version", "smallest");
    svc.decide(human, projectId, "hosting", "local");
    expect(svc.get(projectId)!.plan!.problem).toBeNull();
    secrets = ["Keep a shared reading list"];
    const message = 'The answer to "What should it do for them?" looks like it contains a secret. Change the answer to continue.';
    expect(svc.get(projectId)!.plan!.problem).toBe(message);
    expect(() => svc.complete(human, projectId)).toThrow(message);
  });

  it("scrubs the home directory and the username from every text before it is recorded", () => {
    intake.start(human, projectId, `Notes in ${homedir()}/club/notes.md by clubuser`);
    expect(intake.get(projectId)!.intake.idea).toBe("Notes in ~/club/notes.md by <user>");
    answerAll({ ...ANSWERS, audience: `clubuser and friends`, existing: `${homedir()}/club` });
    const view = intake.get(projectId)!;
    expect(view.questions.find((q) => q.id === "existing")!.answer).toBe("~/club");
    intake.decide(human, projectId, "first_version", "smallest", `see ${homedir()}/plan.txt`);
    intake.decide(human, projectId, "hosting", "local");
    expect(intake.get(projectId)!.decisions[0]!.rationale).toBe("see ~/plan.txt");
    const done = intake.complete(human, projectId);
    expect(done.plan!.summary).toContain("is for <user> and friends");
    intake.reopen(human, projectId, `moved to ${homedir()}/elsewhere`);
    const reason = ledger.list({ afterSeq: ledger.headSeq() - 1 })[0]!.payload as { reason: string };
    expect(reason.reason).toBe("moved to ~/elsewhere");
    expect(JSON.stringify(ledger.list())).not.toContain(homedir());
  });

  it("refuses a non-human actor for every command", () => {
    expect(() => intake.start(system, projectId, IDEA)).toThrow(HumanRequiredError);
    intake.start(human, projectId, IDEA);
    expect(() => intake.answer(system, projectId, "audience", "x")).toThrow(HumanRequiredError);
    expect(() => intake.decide(system, projectId, "hosting", "local")).toThrow(HumanRequiredError);
    expect(() => intake.complete(system, projectId)).toThrow(HumanRequiredError);
    expect(() => intake.reopen(system, projectId, "The scope changed")).toThrow(HumanRequiredError);
    expect(() => intake.start({ kind: "agent", id: "a1" }, projectId, IDEA)).toThrow(HumanRequiredError);
  });

  it("the reducer refuses an intake event for an unknown intake or another project's intake", () => {
    intake.start(human, projectId, IDEA);
    const id = intake.get(projectId)!.intake.id;
    const other = board.createProject(human, { name: "Other" }).id;
    const before = ledger.headSeq();
    const append = (intakeId: string, pid: string) =>
      db.transaction(() => {
        const e = ledger.appendInTransaction({
          projectId: pid, actor: human, type: "intake.answered", payload: { intakeId, questionId: "audience", answer: "x" },
        });
        applyEvent(db, e);
      })();
    expect(() => append("missing", projectId)).toThrow(/unknown intake/);
    expect(() => append(id, other)).toThrow(/unknown intake/);
    expect(ledger.headSeq()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM intake_answers").get()).toEqual({ n: 0 });
  });

  it("rebuilding after the whole sequence reproduces the live tables", () => {
    intake.start(human, projectId, IDEA);
    answerAll();
    decideBoth();
    intake.complete(human, projectId);
    intake.reopen(human, projectId, "We will sell copies");
    intake.answer(human, projectId, "payments", "yes");
    intake.decide(human, projectId, "payments_scope", "provider");
    intake.complete(human, projectId);
    const tables = ["intakes", "intake_answers", "intake_decisions", "cards", "projects"];
    const snap = () => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    const live = snap();
    rebuildAllProjections(db, ledger);
    expect(snap()).toEqual(live);
  });
});
