import { randomUUID } from "node:crypto";
import {
  STAGES,
  cardInputSchema,
  cardStatusSchema,
  projectInputSchema,
  stageSchema,
  type Actor,
  type Board,
  type Card,
  type CardStatus,
  type LedgerEntry,
  type NewLedgerEntry,
  type Project,
  type Stage,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { applyEvent as defaultApplyEvent } from "./projections.js";

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

type ProjectRow = { id: string; name: string; pitch: string; created_at: string };
type CardRow = {
  id: string; project_id: string; title: string; stage: Stage; status: CardStatus;
  created_at: string; updated_at: string;
};

const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, pitch: r.pitch, createdAt: r.created_at });
const toCard = (r: CardRow): Card => ({
  id: r.id, projectId: r.project_id, title: r.title, stage: r.stage, status: r.status,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export type BoardServiceOptions = {
  newId?: () => string;
  /** Test seam: replaces the projection reducer. */
  applyEvent?: (db: Db, e: LedgerEntry) => void;
};

export class BoardService {
  private readonly newId: () => string;
  private readonly apply: (db: Db, e: LedgerEntry) => void;

  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    opts: BoardServiceOptions = {},
  ) {
    this.newId = opts.newId ?? (() => randomUUID());
    this.apply = opts.applyEvent ?? defaultApplyEvent;
  }

  createProject(actor: Actor, input: { name: string; pitch?: string }): Project {
    const { name, pitch } = projectInputSchema.parse(input);
    const projectId = this.newId();
    return this.command(() => ({
      event: { projectId, actor, type: "project.created", payload: { projectId, name, pitch } },
      result: () => this.requireProject(projectId),
    }));
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC, rowid DESC").all() as ProjectRow[];
    return rows.map(toProject);
  }

  getBoard(projectId: string): Board {
    const project = this.requireProject(projectId);
    const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Card[]])) as Record<Stage, Card[]>;
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE project_id = ? ORDER BY created_at, rowid")
      .all(projectId) as CardRow[];
    for (const r of rows) columns[r.stage].push(toCard(r));
    return { project, columns };
  }

  addCard(actor: Actor, projectId: string, input: { title: string; stage: Stage }): Card {
    const { title, stage } = cardInputSchema.parse(input);
    const cardId = this.newId();
    return this.command(() => {
      this.requireProject(projectId);
      return {
        event: { projectId, actor, type: "card.created", payload: { cardId, title, stage } },
        result: () => this.requireCard(cardId),
      };
    });
  }

  moveCard(actor: Actor, cardId: string, to: Stage): Card {
    stageSchema.parse(to);
    return this.command(() => {
      const card = this.requireCard(cardId);
      if (card.stage === to) return { result: () => card };
      return {
        event: {
          projectId: card.projectId, actor, type: "card.moved",
          payload: { cardId, from: card.stage, to },
        },
        result: () => this.requireCard(cardId),
      };
    });
  }

  setCardStatus(actor: Actor, cardId: string, to: CardStatus): Card {
    cardStatusSchema.parse(to);
    return this.command(() => {
      const card = this.requireCard(cardId);
      if (card.status === to) return { result: () => card };
      return {
        event: {
          projectId: card.projectId, actor, type: "card.status_changed",
          payload: { cardId, from: card.status, to },
        },
        result: () => this.requireCard(cardId),
      };
    });
  }

  rebuildProjections(): void {
    this.db
      .transaction(() => {
        this.db.exec("DELETE FROM cards; DELETE FROM projects;");
        let afterSeq = 0;
        for (;;) {
          const batch = this.ledger.list({ afterSeq, limit: 500 });
          if (batch.length === 0) break;
          for (const e of batch) this.apply(this.db, e);
          afterSeq = batch[batch.length - 1]!.seq;
        }
      })
      .immediate();
  }

  /**
   * Runs one write transaction: the body may read state and returns an event to append (or none for a no-op).
   * The entry and its projection commit atomically; listeners are notified only after commit.
   */
  private command<T>(body: () => { event?: NewLedgerEntry; result: () => T }): T {
    const { entry, value } = this.db
      .transaction(() => {
        const { event, result } = body();
        if (!event) return { entry: undefined, value: result() };
        const entry = this.ledger.appendInTransaction(event);
        this.apply(this.db, entry);
        return { entry, value: result() };
      })
      .immediate();
    if (entry) this.ledger.notify(entry);
    return value;
  }

  private requireProject(id: string): Project {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!r) throw new NotFoundError("project", id);
    return toProject(r);
  }

  private requireCard(id: string): Card {
    const r = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
    if (!r) throw new NotFoundError("card", id);
    return toCard(r);
  }
}
