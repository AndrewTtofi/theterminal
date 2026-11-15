import { z } from "zod";
import {
  DEFAULT_GATE_REQUIREMENT, OWNER_ID, STAGES, applicableGates, satisfies, gateDecisionInputSchema, outcomeOf, stageSchema,
  type Actor, type Card, type ConditionId, type GateDecisionInput, type GateEvaluation, type GateId, type NewLedgerEntry,
  type Stage,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvents } from "../events/commit.js";
import { requireCard } from "../board/board-service.js";
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

export type GateServiceDeps = RecordedTextDeps & { db: Db; ledger: Ledger; recorded?: RecordedText };

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

  constructor(deps: GateServiceDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.recorded = deps.recorded ?? new RecordedText(deps);
  }

  /** The gates a move of the card to `to` raises, in catalog order. Records nothing. */
  evaluate(cardId: string, to: Stage): GateEvaluation[] {
    const stage = stageSchema.parse(to);
    const card = requireCard(this.db, cardId);
    return card.stage === stage ? [] : this.evaluations(card, stage);
  }

  /**
   * Moves the card when every gate the move raises passes or has a decision: `[...gate decisions, card.moved]`. When
   * a gate is left without one, records a single `gate.blocked` and throws `GateBlockedError` after the commit.
   */
  move(actor: Actor, cardId: string, to: Stage, decisions: GateDecisionInput[] = []): Card {
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
      const evaluations = this.evaluations(card, stage);
      if (actor.kind !== "human" && evaluations.some((g) => g.outcome !== "pass")) throw new HumanRequiredError();

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

  private evaluations(card: Card, to: Stage): GateEvaluation[] {
    const { answers, decisions, facts } = gateFacts(this.db, card.projectId);
    return applicableGates({ from: card.stage, to }, answers, facts).map((def) => {
      const conditions = evaluateConditions(this.db, def.conditions, {
        projectId: card.projectId, cardId: card.id, facts, decisions,
      });
      // The default requirement, judged for the Owner, until recorded requirements and a signer arrive (Plan 8 Task 5).
      const requirement = DEFAULT_GATE_REQUIREMENT[def.id];
      return {
        id: def.id, title: def.title, explanation: def.explanation, risks: def.risks, learn: def.learn,
        acknowledgement: def.acknowledgement, signOff: def.signOff,
        conditions, met: conditions.every((c) => c.met), outcome: outcomeOf(def, conditions),
        requirement, signable: satisfies(requirement, { personId: OWNER_ID, role: "owner" }),
      };
    });
  }
}
