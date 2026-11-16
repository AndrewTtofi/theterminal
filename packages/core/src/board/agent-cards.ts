import { randomUUID } from "node:crypto";
import {
  COMMENT_LIMITS, ROLE_LABELS, stageSchema, visibleControls,
  type Actor, type CardComment, type NewLedgerEntry, type Role, type Stage,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent, commitEvents } from "../events/commit.js";
import { getRun, listCardComments } from "../events/projections.js";
import type { GateService } from "../gates/service.js";
import { HumanRequiredError, SecretInTextError, type RecordedText } from "../intake/service.js";
import { truncate } from "../agents/redact.js";
import { NotFoundError, requireCard, type BoardService } from "./board-service.js";

/** The longest card title an agent may give (Ruling 1). */
const TITLE_MAX = 200;
/** The longest author name recorded on a note (the `card.comment` schema). */
const AUTHOR_MAX = 120;

export type AgentCardsDeps = {
  db: Db;
  ledger: Ledger;
  gates: Pick<GateService, "evaluate" | "move">;
  board: Pick<BoardService, "setCardStatus">;
  recorded: RecordedText;
  newId?: () => string;
  now?: () => Date;
};

/** `s` cut to at most `max` UTF-16 units, never leaving half of a surrogate pair at the end. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = /[\ud800-\udbff]/.test(s.charAt(max - 1)) ? max - 1 : max;
  return s.slice(0, end);
}

/**
 * The Board as the agents run it. A run's card markers become the existing card events with the run as actor: a card
 * created and linked, a move (only when every gate passes; otherwise a request a person settles through the gate),
 * and done. People leave notes on cards; the next run on the card is given the waiting ones and says when it read them.
 * A gate is never decided here: an agent's move either passes every gate or waits for a person.
 */
export class AgentCards {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly gates: AgentCardsDeps["gates"];
  private readonly board: AgentCardsDeps["board"];
  private readonly recorded: RecordedText;
  private readonly newId: () => string;

  constructor(deps: AgentCardsDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.gates = deps.gates;
    this.board = deps.board;
    this.recorded = deps.recorded;
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /**
   * `[[card: …]]`: a card in Plan in the run's project, linked to the run, committed together. Ignored for an unknown
   * run, a run on a linked machine, a run that already has a card (the first card wins) and a title that cleans to
   * nothing. The title is redacted, scrubbed of local paths, its hidden controls escaped, and clipped to 200.
   */
  onCard(runId: string, title: string): void {
    const clean = truncate(visibleControls(this.recorded.scrub(this.recorded.redacted(title.trim()))), TITLE_MAX).trim();
    if (clean.length === 0) return;
    const cardId = this.newId();
    const actor = agentActor(runId);
    commitEvents(this.db, this.ledger, () => {
      const run = getRun(this.db, runId);
      if (!run || run.machineId !== null || run.cardId !== null) return { events: [], result: () => undefined };
      const base = { projectId: run.projectId, actor };
      const events: NewLedgerEntry[] = [
        { ...base, type: "card.created", payload: { cardId, title: clean, stage: "plan" } },
        { ...base, type: "card.run_linked", payload: { cardId, runId } },
      ];
      return { events, result: () => undefined };
    });
  }

  /**
   * `[[card-stage: …]]`: nothing without a card or when it is already there. When every gate the move raises passes,
   * the gate service moves it with the run as actor. Otherwise (or when a gate appears in between) the move becomes
   * `card.move_requested`, unless that same request is already pending.
   */
  onStage(runId: string, stage: Stage): void {
    const to = stageSchema.parse(stage);
    const card = this.cardOfRun(runId);
    if (!card || card.stage === to) return;
    if (this.gates.evaluate(card.id, to).every((g) => g.outcome === "pass")) {
      try {
        this.gates.move(agentActor(runId), card.id, to);
        return;
      } catch (e) {
        if (!(e instanceof HumanRequiredError)) throw e;
      }
    }
    this.request(runId, card.id, to);
  }

  /** `[[card-done]]`: the card's status set to done (its stage unchanged), unless it is done already. */
  onDone(runId: string): void {
    const card = this.cardOfRun(runId);
    if (!card || card.status === "done") return;
    this.board.setCardStatus(agentActor(runId), card.id, "done");
  }

  /** `[[noted]]`: every note given to this run and not yet read becomes read, in one entry. */
  onNoted(runId: string): void {
    commitEvent(this.db, this.ledger, () => {
      const rows = this.db
        .prepare("SELECT id, card_id, project_id FROM card_comments WHERE run_id = ? AND state = 'given' ORDER BY at, rowid")
        .all(runId) as { id: string; card_id: string; project_id: string }[];
      if (rows.length === 0) return { result: () => undefined };
      const first = rows[0]!;
      const commentIds = rows.filter((r) => r.card_id === first.card_id).map((r) => r.id).slice(0, COMMENT_LIMITS.perRun);
      return {
        event: {
          projectId: first.project_id, actor: agentActor(runId), type: "card.comments_read",
          payload: { cardId: first.card_id, runId, commentIds },
        },
        result: () => undefined,
      };
    });
  }

  /**
   * A person's note on a card, for the next run on it. Only a human writes one (`HumanRequiredError`); the card must
   * exist (`NotFoundError`). The text is clipped to 2,000 characters, its hidden controls escaped and local paths
   * scrubbed; a secret anywhere in what was sent is refused (`SecretInTextError`) and nothing is recorded. The author's
   * name and role at this moment are recorded with it.
   */
  addComment(actor: Actor, person: { name: string; role: Role }, cardId: string, text: string): CardComment {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new RangeError("a note needs some text");
    // The whole text is checked, so a secret cut in half by the clip is still refused.
    if (!this.recorded.passes(trimmed)) throw new SecretInTextError();
    const recorded = cut(this.recorded.clean(visibleControls(cut(trimmed, COMMENT_LIMITS.textChars))), COMMENT_LIMITS.textChars);
    const authorName = cut(person.name, AUTHOR_MAX);
    const commentId = this.newId();
    return commitEvent(this.db, this.ledger, () => {
      const card = requireCard(this.db, cardId);
      return {
        event: {
          projectId: card.projectId, actor, type: "card.comment",
          payload: { commentId, cardId, text: recorded, authorName, role: person.role },
        },
        result: () => listCardComments(this.db, cardId).find((c) => c.id === commentId)!,
      };
    });
  }

  /** The card's 20 oldest waiting notes, as lines for the next run's prompt; null when none waits. */
  notesFor(cardId: string): { ids: string[]; lines: string[] } | null {
    const rows = this.db
      .prepare(
        `SELECT id, author_name, role, text FROM card_comments WHERE card_id = ? AND state = 'waiting'
         ORDER BY at, rowid LIMIT ?`,
      )
      .all(cardId, COMMENT_LIMITS.perRun) as { id: string; author_name: string; role: Role; text: string }[];
    if (rows.length === 0) return null;
    return {
      ids: rows.map((r) => r.id),
      lines: rows.map((r) => `Note from ${r.author_name} (${ROLE_LABELS[r.role]}): ${r.text}`),
    };
  }

  /** "Not yet" to the card's pending move: a person's decision (`HumanRequiredError` otherwise); `NotFoundError` without one. */
  declineMove(actor: Actor, cardId: string): void {
    if (actor.kind !== "human") throw new HumanRequiredError();
    commitEvent(this.db, this.ledger, () => {
      const req = this.db.prepare("SELECT project_id, to_stage FROM card_move_requests WHERE card_id = ?").get(cardId) as
        | { project_id: string; to_stage: Stage }
        | undefined;
      if (!req) throw new NotFoundError("move request", cardId);
      return {
        event: { projectId: req.project_id, actor, type: "card.move_declined", payload: { cardId, to: req.to_stage } },
        result: () => undefined,
      };
    });
  }

  /** `card.move_requested` from the card's stage, unless the same request is already pending. */
  private request(runId: string, cardId: string, to: Stage): void {
    commitEvent(this.db, this.ledger, () => {
      const card = requireCard(this.db, cardId);
      if (card.stage === to) return { result: () => undefined };
      const same = this.db
        .prepare("SELECT 1 FROM card_move_requests WHERE card_id = ? AND run_id = ? AND from_stage = ? AND to_stage = ?")
        .get(cardId, runId, card.stage, to);
      if (same) return { result: () => undefined };
      return {
        event: {
          projectId: card.projectId, actor: agentActor(runId), type: "card.move_requested",
          payload: { cardId, runId, from: card.stage, to },
        },
        result: () => undefined,
      };
    });
  }

  /** The card of a run on this computer, or null. */
  private cardOfRun(runId: string) {
    const run = getRun(this.db, runId);
    if (!run || run.machineId !== null || run.cardId === null) return null;
    try {
      return requireCard(this.db, run.cardId);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }
}

const agentActor = (runId: string): Actor => ({ kind: "agent", id: runId });
