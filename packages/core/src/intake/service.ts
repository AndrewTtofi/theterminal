import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { z } from "zod";
import {
  DECISION_IDS, INTAKE_DECISIONS, INTAKE_QUESTIONS, INTAKE_VERSION, QUESTION_IDS, applicableDecisions, intakeStep,
  planSummary, proposedCards, recommendedOption, renderAnswer, validateAnswer,
  type Actor, type Answers, type DecisionId, type Decisions, type IntakeView, type NewLedgerEntry, type QuestionId,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvents } from "../events/commit.js";
import { getIntake, listOpenIntakes, type IntakeState } from "../events/projections.js";
import { NotFoundError } from "../board/board-service.js";
import { ConflictError } from "../connections/service.js";
import { redact, truncate } from "../agents/redact.js";
import { pathScrubber, usernameScrubber, type Scrub } from "../agents/scrub-paths.js";

export class HumanRequiredError extends Error {
  constructor() {
    super("a named human must decide");
    this.name = "HumanRequiredError";
  }
}

/** Never carries the text: the message is fixed. */
export class SecretInTextError extends Error {
  constructor() {
    super("text contains a secret");
    this.name = "SecretInTextError";
  }
}

export class IntakeCompletedError extends Error {
  constructor() {
    super("the intake is completed");
    this.name = "IntakeCompletedError";
  }
}

export class IntakeIncompleteError extends Error {
  constructor(public readonly missing: { questions: QuestionId[]; decisions: DecisionId[] }) {
    super("the intake is not ready to complete");
    this.name = "IntakeIncompleteError";
  }
}

export class DecisionNotApplicableError extends Error {
  constructor() {
    super("the decision does not apply to the current answers");
    this.name = "DecisionNotApplicableError";
  }
}

/** The project exists but has no intake, so there is nothing to answer, decide, complete or reopen. */
export class NoIntakeError extends Error {
  constructor() {
    super("the project has no intake");
    this.name = "NoIntakeError";
  }
}

export type IntakeServiceDeps = {
  db: Db;
  ledger: Ledger;
  newId?: () => string;
  /** Scrubbed to `<data>` in recorded text when given. */
  dataDir?: string;
  /** The OS username scrubbed to `<user>`; defaults to the current user's. */
  username?: string;
  /** Extra values refused as secrets (the session token, stored connection secrets), read on every check. */
  secrets?: () => string[];
};

export type IntakeProjectDecisions = { projectId: string; name: string; decisions: number };

const IDEA_MAX = 4000;
const SUMMARY_MAX = 4000;
const RATIONALE_MAX = 1000;
const REASON_MAX = 500;

function osUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return ""; // no passwd entry: nothing to scrub
  }
}

const answersOf = (s: IntakeState): Answers =>
  Object.fromEntries(Object.entries(s.answers).map(([k, v]) => [k, v!.answer])) as Answers;
const decisionsOf = (s: IntakeState): Decisions =>
  Object.fromEntries(Object.entries(s.decisions).map(([k, v]) => [k, v!.chosen])) as Decisions;

/**
 * The guided intake as ledger events. Every command is a human's; every free text is trimmed, scrubbed of local
 * paths and the username, and refused when it holds a secret, before anything is recorded.
 */
export class IntakeService {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly newId: () => string;
  private readonly scrub: Scrub;
  private readonly secrets: () => string[];

  constructor(deps: IntakeServiceDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.newId = deps.newId ?? (() => randomUUID());
    const dirs: [string, string][] = [[homedir(), "~"]];
    if (deps.dataDir !== undefined) dirs.unshift([deps.dataDir, "<data>"]);
    const paths = pathScrubber(dirs);
    const user = usernameScrubber(deps.username ?? osUsername());
    // Paths first, so a home directory becomes `~` rather than a path ending in `<user>`.
    this.scrub = (s) => user(paths(s));
    this.secrets = deps.secrets ?? (() => []);
  }

  get(projectId: string): IntakeView | null {
    const name = this.projectName(projectId);
    const state = getIntake(this.db, projectId);
    return state ? this.view(name, state) : null;
  }

  start(actor: Actor, projectId: string, idea: string): IntakeView {
    requireHuman(actor);
    const clean = this.text("idea", idea, { min: 1, max: IDEA_MAX });
    const intakeId = this.newId();
    return this.commit(() => {
      this.projectName(projectId);
      if (getIntake(this.db, projectId)) throw new ConflictError("the project already has an intake");
      return [{ projectId, actor, type: "intake.started", payload: { intakeId, idea: clean, version: INTAKE_VERSION } }];
    }, projectId);
  }

  answer(actor: Actor, projectId: string, questionId: QuestionId, answer: unknown): IntakeView {
    requireHuman(actor);
    const qid = z.object({ questionId: z.enum(QUESTION_IDS) }).parse({ questionId }).questionId;
    const q = INTAKE_QUESTIONS.find((x) => x.id === qid)!;
    let value = validateAnswer(q, answer);
    if (typeof value === "string" && q.kind === "text") value = validateAnswer(q, this.clean(value));
    return this.commit(() => {
      const state = this.requireOpen(projectId);
      return [{ projectId, actor, type: "intake.answered", payload: { intakeId: state.intake.id, questionId: qid, answer: value } }];
    }, projectId);
  }

  decide(actor: Actor, projectId: string, decisionId: DecisionId, chosen: string, rationale?: string): IntakeView {
    requireHuman(actor);
    const did = z.object({ decisionId: z.enum(DECISION_IDS) }).parse({ decisionId }).decisionId;
    const d = INTAKE_DECISIONS.find((x) => x.id === did)!;
    const option = z
      .object({ chosen: z.enum(d.options.map((o) => o.id) as [string, ...string[]]) })
      .parse({ chosen }).chosen;
    const why = rationale === undefined ? "" : this.text("rationale", rationale, { min: 0, max: RATIONALE_MAX });
    const owner = this.clean(actor.id);
    return this.commit(() => {
      const state = this.requireOpen(projectId);
      if (!applicableDecisions(answersOf(state)).some((x) => x.id === did)) throw new DecisionNotApplicableError();
      return [{
        projectId, actor, type: "intake.decided",
        payload: { intakeId: state.intake.id, decisionId: did, chosen: option, rationale: why, owner },
      }];
    }, projectId);
  }

  complete(actor: Actor, projectId: string): IntakeView {
    requireHuman(actor);
    return this.commit(() => {
      const name = this.projectName(projectId);
      const state = this.requireOpen(projectId);
      const answers = answersOf(state);
      const decisions = decisionsOf(state);
      if (intakeStep(state.intake.status, answers, decisions) !== "approve") {
        throw new IntakeIncompleteError({
          questions: INTAKE_QUESTIONS.filter((q) => q.required && !answered(answers, q.id)).map((q) => q.id),
          decisions: applicableDecisions(answers).filter((x) => decisions[x.id] === undefined).map((x) => x.id),
        });
      }
      // Exact title → card id; reversed so that the oldest card with a duplicated title wins.
      const existing = new Map(
        (this.db.prepare("SELECT id, title FROM cards WHERE project_id = ? ORDER BY created_at, rowid").all(projectId) as {
          id: string; title: string;
        }[]).map((r) => [r.title, r.id] as const).reverse(),
      );
      const created: NewLedgerEntry[] = [];
      const cards = proposedCards(answers, decisions).map((c) => {
        const found = existing.get(c.title);
        if (found !== undefined) return { cardId: found, title: c.title, stage: c.stage, outcome: "existing" as const };
        const cardId = this.newId();
        created.push({ projectId, actor, type: "card.created", payload: { cardId, title: c.title, stage: c.stage } });
        return { cardId, title: c.title, stage: c.stage, outcome: "created" as const };
      });
      // Built from the answers as recorded (already cleaned); the project name passes the same check.
      const summary = truncate(this.clean(planSummary(name, answers, decisions)), SUMMARY_MAX);
      return [
        { projectId, actor, type: "intake.completed", payload: { intakeId: state.intake.id, summary, cards } },
        ...created,
      ];
    }, projectId);
  }

  reopen(actor: Actor, projectId: string, reason: string): IntakeView {
    requireHuman(actor);
    const why = this.text("reason", reason, { min: 1, max: REASON_MAX });
    return this.commit(() => {
      const state = this.requireIntake(projectId);
      if (state.intake.status === "open") throw new ConflictError("the intake is already open");
      return [{ projectId, actor, type: "intake.reopened", payload: { intakeId: state.intake.id, reason: why } }];
    }, projectId);
  }

  /** Open intakes with at least one applicable decision not yet decided, oldest first. */
  openDecisionsByProject(): IntakeProjectDecisions[] {
    const out: IntakeProjectDecisions[] = [];
    for (const open of listOpenIntakes(this.db)) {
      const state = getIntake(this.db, open.projectId);
      if (!state) continue;
      const decisions = decisionsOf(state);
      const n = applicableDecisions(answersOf(state)).filter((d) => decisions[d.id] === undefined).length;
      if (n > 0) out.push({ projectId: open.projectId, name: this.projectName(open.projectId), decisions: n });
    }
    return out;
  }

  /** Over every open intake: applicable decisions not yet decided. */
  openDecisionCount(): number {
    return this.openDecisionsByProject().reduce((a, p) => a + p.decisions, 0);
  }

  private commit(build: () => NewLedgerEntry[], projectId: string): IntakeView {
    return commitEvents(this.db, this.ledger, () => ({
      events: build(),
      result: () => this.get(projectId)!,
    }));
  }

  /** Scrubbed, then refused when redaction would change it. The error never carries the text. */
  private clean(text: string): string {
    const scrubbed = this.scrub(text);
    if (redact(scrubbed, this.secrets()) !== scrubbed) throw new SecretInTextError();
    return scrubbed;
  }

  /** A free text trimmed, length-checked as given, then cleaned and checked again (a placeholder may lengthen it). */
  private text(field: string, value: string, limits: { min: number; max: number }): string {
    const schema = z.object({ [field]: z.string().trim().min(limits.min).max(limits.max) });
    const trimmed = schema.parse({ [field]: value })[field] as string;
    return schema.parse({ [field]: this.clean(trimmed) })[field] as string;
  }

  private projectName(projectId: string): string {
    const row = this.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
    if (!row) throw new NotFoundError("project", projectId);
    return row.name;
  }

  private requireIntake(projectId: string): IntakeState {
    this.projectName(projectId);
    const state = getIntake(this.db, projectId);
    if (!state) throw new NoIntakeError();
    return state;
  }

  private requireOpen(projectId: string): IntakeState {
    const state = this.requireIntake(projectId);
    if (state.intake.status === "completed") throw new IntakeCompletedError();
    return state;
  }

  private view(projectName: string, state: IntakeState): IntakeView {
    const answers = answersOf(state);
    const decisions = decisionsOf(state);
    const step = intakeStep(state.intake.status, answers, decisions);
    const questions = INTAKE_QUESTIONS.map((q) => ({
      ...q,
      answer: state.answers[q.id]?.answer ?? null,
      answeredAt: state.answers[q.id]?.answeredAt ?? null,
    }));
    const decisionViews = applicableDecisions(answers).map(({ appliesWhen: _a, recommend: _r, ...d }) => {
      const full = INTAKE_DECISIONS.find((x) => x.id === d.id)!;
      const made = state.decisions[d.id];
      return {
        ...d,
        recommended: recommendedOption(full, answers),
        because: d.dependsOn.flatMap((qid) => {
          const a = answers[qid];
          const q = INTAKE_QUESTIONS.find((x) => x.id === qid)!;
          return a === undefined || !answered(answers, qid) ? [] : [{ label: q.label, answer: renderAnswer(q, a) }];
        }),
        chosen: made?.chosen ?? null,
        rationale: made?.rationale ?? null,
        owner: made?.owner ?? null,
        decidedAt: made?.decidedAt ?? null,
      };
    });
    let plan: IntakeView["plan"] = null;
    if (step === "approve") {
      // As complete() will record it.
      const summary = truncate(this.scrub(planSummary(projectName, answers, decisions)), SUMMARY_MAX);
      plan = { summary, cards: proposedCards(answers, decisions) };
    } else if (step === "completed") {
      plan = { summary: state.intake.summary ?? "", cards: proposedCards(answers, decisions) };
    }
    return { intake: state.intake, step, questions, decisions: decisionViews, plan };
  }
}

function requireHuman(actor: Actor): void {
  if (actor.kind !== "human") throw new HumanRequiredError();
}

function answered(answers: Answers, id: QuestionId): boolean {
  const a = answers[id];
  if (a === undefined || a === null) return false;
  if (typeof a === "string") return a.trim().length > 0;
  if (Array.isArray(a)) return a.length > 0;
  return true;
}
