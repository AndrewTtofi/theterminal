import { z } from "zod";
import {
  OWNER_ID, STAGES, applicableGates, satisfies, gateDecisionInputSchema, gatePayloadSchemas, outcomeOf, stageSchema,
  type Actor, type Card, type ConditionId, type GateDecisionInput, type GateEvaluation, type GateId, type GateRequirement,
  type NewLedgerEntry, type Person, type Role, type Stage,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent, commitEvents } from "../events/commit.js";
import { getGateRequirement, getPerson } from "../events/projections.js";
import { canonicalJson } from "../ledger/canonical.js";
import { NotFoundError, requireCard } from "../board/board-service.js";
import { HumanRequiredError, RecordedText, type RecordedTextDeps } from "../intake/service.js";
import { evaluateConditions, gateFacts } from "./conditions.js";

/** The move was stopped by gates left without a decision; a `gate.blocked` entry was recorded. Carries every evaluation. */
export class GateBlockedError extends Error {
  constructor(public readonly gates: GateEvaluation[]) {
    super("the move is blocked by a gate");
    this.name = "GateBlockedError";
  }
}

/** A sign-off for a gate whose conditions do not hold (any more). Nothing was recorded. */
export class GateNotMetError extends Error {
  constructor(public readonly gateId: GateId, public readonly unmet: ConditionId[]) {
    super("the gate's conditions are not met");
    this.name = "GateNotMetError";
  }
}

/**
 * A sign-off or waiver by someone the gate's requirement does not allow (the wrong role, or not the named person).
 * Nothing was recorded. Carries only the gate and its requirement, never a name.
 */
export class GateRequirementError extends Error {
  constructor(public readonly gateId: GateId, public readonly requirement: GateRequirement) {
    super("this gate needs someone else's sign-off");
    this.name = "GateRequirementError";
  }
}

/** The person a gate decision is judged for. */
export type Signer = { personId: string; role: Role };

const OWNER_SIGNER: Signer = { personId: OWNER_ID, role: "owner" };

export type GateServiceDeps = RecordedTextDeps & {
  db: Db;
  ledger: Ledger;
  recorded?: RecordedText;
  /** A person, removed or not (the projections' getPerson by default): the signer when a move names none. */
  person?: (id: string) => Person | null;
};

const requirementInput = gatePayloadSchemas["gate.requirement_set"];

const REASON_MAX = 500;

/** One decision per gate, at most ten. */
const decisionsSchema = z
  .array(gateDecisionInputSchema)
  .max(10)
  .superRefine((ds, ctx) => {
    const seen = new Set<GateId>();
    ds.forEach((d, i) => {
      if (seen.has(d.gateId)) ctx.addIssue({ code: "custom", message: "one decision per gate", path: [i, "gateId"] });
      seen.add(d.gateId);
    });
  });

const NO_FACTS = { intakeCompleted: false, budgetUsd: null, spendUsd: 0 };

/**
 * True when a gate stands in front of the stage whatever stage the card comes from (Ship, Operate), so a card must
 * not be created there directly: it would skip the readiness checks a move runs.
 */
export function stageHasEntryGates(stage: Stage): boolean {
  return STAGES.some((from) => from !== "plan" && from !== stage && applicableGates({ from, to: stage }, {}, NO_FACTS).length > 0);
}

type MoveResult = { card: Card } | { blocked: GateEvaluation[] };

const unmetOf = (g: GateEvaluation): ConditionId[] => g.conditions.filter((c) => !c.met).map((c) => c.id);

/**
 * Readiness gates on lifecycle moves. Every fact is read from projections of the ledger, inside the move's own
 * transaction, so a decision is recorded only together with the move it unlocks and only while its conditions hold.
 */
export class GateService {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly recorded: RecordedText;
  private readonly person: (id: string) => Person | null;

  constructor(deps: GateServiceDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.recorded = deps.recorded ?? new RecordedText(deps);
    this.person = deps.person ?? ((id) => getPerson(deps.db, id));
  }

  /**
   * The gates a move of the card to `to` raises, in catalog order, each with who may sign it and whether `signer`
   * may (the Owner when none is named). Records nothing.
   */
  evaluate(cardId: string, to: Stage, signer?: Signer): GateEvaluation[] {
    const stage = stageSchema.parse(to);
    const card = requireCard(this.db, cardId);
    return card.stage === stage ? [] : this.evaluations(card, stage, signer ?? OWNER_SIGNER);
  }

  /**
   * Who may sign a project's gate: `{ role }` (that role or above) or `{ personId }` (that current person only);
   * null restores the gate's default. Records `gate.requirement_set`, or nothing when the stored value is unchanged.
   * The route allows the Owner only. Returns the requirement now in force.
   */
  setRequirement(actor: Actor, projectId: string, gateId: GateId, requirement: GateRequirement | null): GateRequirement {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const payload = requirementInput.parse({ gateId, requirement }) as { gateId: GateId; requirement: GateRequirement | null };
    return commitEvent(this.db, this.ledger, () => {
      if (!this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new NotFoundError("project", projectId);
      const named = payload.requirement !== null && "personId" in payload.requirement ? payload.requirement.personId : null;
      if (named !== null) {
        const person = this.person(named);
        if (!person || person.removedAt !== null) throw new NotFoundError("person", named);
      }
      const stored = this.db
        .prepare("SELECT requirement FROM gate_requirements WHERE project_id = ? AND gate_id = ?")
        .get(projectId, payload.gateId) as { requirement: string } | undefined;
      const next = payload.requirement === null ? undefined : canonicalJson(payload.requirement);
      const inForce = () => getGateRequirement(this.db, projectId, payload.gateId);
      if (stored?.requirement === next) return { result: inForce };
      return { event: { projectId, actor, type: "gate.requirement_set", payload }, result: inForce };
    });
  }

  /** The signer a move names none for: the actor, with the role recorded for them; null for a removed or unknown person. */
  private signerOf(actor: Actor): Signer | null {
    if (actor.id === OWNER_ID) return OWNER_SIGNER;
    const person = this.person(actor.id);
    return person && person.removedAt === null ? { personId: person.id, role: person.role } : null;
  }

  /**
   * Moves the card when every gate the move raises passes or has a decision: `[...gate decisions, card.moved]`. When
   * a gate is left without one, records a single `gate.blocked` and throws `GateBlockedError` after the commit. A
   * decision on a gate whose requirement `signer` (by default the actor as recorded) does not satisfy is
   * `GateRequirementError`, and nothing is recorded. The decision is recorded as the actor's.
   */
  move(actor: Actor, cardId: string, to: Stage, decisions: GateDecisionInput[] = [], signer?: Signer): Card {
    const stage = stageSchema.parse(to);
    // A gate decision is a human's: refused for anyone else before the decisions or their text are even looked at.
    if (actor.kind !== "human" && decisions.length > 0) throw new HumanRequiredError();
    const byGate = new Map(decisionsSchema.parse(decisions).map((d) => [d.gateId, d] as const));
    // Checked before the transaction: the error never carries the text, and a refusal records nothing.
    const reasons = new Map<GateId, string>();
    for (const d of byGate.values()) {
      if (d.decision === "waive") reasons.set(d.gateId, this.recorded.text("reason", d.reason!, { min: 10, max: REASON_MAX }));
    }
    const decidedBy = byGate.size > 0 ? this.recorded.clean(actor.id) : actor.id;

    const outcome = commitEvents<MoveResult>(this.db, this.ledger, () => {
      const card = requireCard(this.db, cardId);
      if (card.stage === stage) return { events: [], result: () => ({ card }) };
      const who = signer ?? this.signerOf(actor);
      // The evaluations a refusal sends back are judged for the signer; someone unknown or removed may sign nothing.
      const evaluations = this.evaluations(card, stage, who);
      if (actor.kind !== "human" && evaluations.some((g) => g.outcome !== "pass")) throw new HumanRequiredError();
      // Who decides is checked before what is decided: a decision on a raised gate by someone it does not allow.
      for (const g of evaluations) {
        if (g.outcome === "pass" || !byGate.has(g.id)) continue;
        if (who === null || !satisfies(g.requirement, who)) throw new GateRequirementError(g.id, g.requirement);
      }

      const base = { projectId: card.projectId, actor };
      const move = { cardId, from: card.stage, to: stage };
      const decided: NewLedgerEntry[] = [];
      const unresolved: GateEvaluation[] = [];
      for (const g of evaluations) {
        if (g.outcome === "pass") continue;
        const d = byGate.get(g.id);
        if (d?.decision === "sign_off" && g.outcome === "blocked") throw new GateNotMetError(g.id, unmetOf(g));
        if (d?.decision === "sign_off") {
          decided.push({
            ...base, type: "gate.signed_off",
            payload: {
              gateId: g.id, ...move, conditions: g.conditions.map((c) => c.id), acknowledgement: d.acknowledgement,
              signedBy: decidedBy,
            },
          });
        } else if (d?.decision === "waive" && g.outcome === "blocked") {
          decided.push({
            ...base, type: "gate.waived",
            payload: {
              gateId: g.id, ...move, unmet: unmetOf(g), reason: reasons.get(g.id)!, acknowledgement: d.acknowledgement,
              waivedBy: decidedBy,
            },
          });
        } else {
          // No decision, or a waiver for a gate whose conditions hold: it still needs its sign-off.
          unresolved.push(g);
        }
      }
      if (unresolved.length > 0) {
        return {
          events: [{
            ...base, type: "gate.blocked",
            payload: { ...move, gates: unresolved.map((g) => ({ gateId: g.id, outcome: g.outcome, unmet: unmetOf(g) })) },
          }],
          result: () => ({ blocked: evaluations }),
        };
      }
      return {
        events: [...decided, { ...base, type: "card.moved", payload: move }],
        result: () => ({ card: requireCard(this.db, cardId) }),
      };
    });
    if ("blocked" in outcome) throw new GateBlockedError(outcome.blocked);
    return outcome.card;
  }

  /** Each raised gate, with its requirement and whether `signer` satisfies it (never, for null). */
  private evaluations(card: Card, to: Stage, signer: Signer | null): GateEvaluation[] {
    const { answers, decisions, facts } = gateFacts(this.db, card.projectId);
    return applicableGates({ from: card.stage, to }, answers, facts).map((def) => {
      const conditions = evaluateConditions(this.db, def.conditions, {
        projectId: card.projectId, cardId: card.id, facts, decisions,
      });
      const requirement = getGateRequirement(this.db, card.projectId, def.id);
      return {
        id: def.id, title: def.title, explanation: def.explanation, risks: def.risks, learn: def.learn,
        acknowledgement: def.acknowledgement, signOff: def.signOff,
        conditions, met: conditions.every((c) => c.met), outcome: outcomeOf(def, conditions),
        requirement, signable: signer !== null && satisfies(requirement, signer),
      };
    });
  }
}
