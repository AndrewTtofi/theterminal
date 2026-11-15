import type { Actor, Answers, NewLedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { IntakeService } from "../../src/intake/service.js";
import { commitEvents } from "../../src/events/commit.js";

export const human = { kind: "human", id: "owner" } as const;
export const agent = { kind: "agent", id: "run-1" } as const;

/** An internet-facing web product that takes payments and holds accounts, with an agent budget of $10. */
export const ANSWERS: Answers = {
  audience: "Members of a book club",
  outcome: "Keep a shared reading list and sell club memberships",
  success: "Members renew their membership",
  platform: ["web"],
  payments: "yes",
  personal_data: "accounts",
  exposure: "internet",
  budget_usd: 10,
  existing: "Nothing yet",
};

export type World = {
  db: Db;
  ledger: Ledger;
  board: BoardService;
  intake: IntakeService;
  /** Completed intake for the product above. */
  planned: string;
  /** No intake. */
  bare: string;
};

export function world(): World {
  const db = openDatabase(":memory:");
  const ledger = new Ledger(db);
  const board = new BoardService(db, ledger);
  const intake = new IntakeService({ db, ledger, username: "clubuser" });
  const planned = board.createProject(human, { name: "Book Club" }).id;
  const bare = board.createProject(human, { name: "Garden Log" }).id;
  return { db, ledger, board, intake, planned, bare };
}

export function completeIntake(w: World, projectId: string, answers: Answers = ANSWERS): void {
  w.intake.start(human, projectId, "A reading list for a book club");
  for (const [q, a] of Object.entries(answers)) w.intake.answer(human, projectId, q as never, a);
  w.intake.decide(human, projectId, "first_version", "smallest");
  w.intake.decide(human, projectId, "hosting", "local");
  for (const [d, c] of [["exposure_protection", "login"], ["payments_scope", "provider"], ["data_handling", "minimum"]] as const) {
    if (w.intake.get(projectId)!.decisions.some((x) => x.id === d)) w.intake.decide(human, projectId, d, c);
  }
  w.intake.complete(human, projectId);
}

export function emit(w: World, projectId: string, type: string, payload: unknown, actor: Actor = agent): void {
  commitEvents(w.db, w.ledger, () => ({
    events: [{ projectId, actor, type, payload } as NewLedgerEntry],
    result: () => undefined,
  }));
}

/** A run on the card (or the project) that finished with `costUsd` (null: no cost reported). */
export function finishedRun(w: World, projectId: string, runId: string, costUsd: number | null, cardId: string | null = null): void {
  emit(w, projectId, "agent.started", { runId, adapter: "fake", authMode: "none", prompt: "go", cardId, worktree: `wt/${runId}` }, human);
  emit(w, projectId, "agent.finished", { runId, status: "completed", costUsd, error: null });
}
