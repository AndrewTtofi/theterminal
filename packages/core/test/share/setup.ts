import type { Actor, Answers, NewLedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { IntakeService } from "../../src/intake/service.js";
import { GateService } from "../../src/gates/service.js";
import { ConnectionService } from "../../src/connections/service.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { commitEvents } from "../../src/events/commit.js";

export const human = { kind: "human", id: "owner" } as const;
export const agent = { kind: "agent", id: "run-1" } as const;

/** Every entry is one second after the last, from 09:00 UTC on 2026-11-15; the snapshot is built at noon. */
export const START = Date.parse("2026-11-15T09:00:00.000Z");
export const NOON = new Date("2026-11-15T12:00:00.000Z");

/** A private web idea with no payments and no personal data, with an agent budget of $25. */
export const ANSWERS: Answers = {
  audience: "Members of a book club",
  outcome: "Keep a shared reading list",
  success: "Members use it every week",
  platform: ["web"],
  payments: "no",
  personal_data: "none",
  exposure: "private",
  budget_usd: 25,
};

export type World = {
  db: Db;
  ledger: Ledger;
  board: BoardService;
  intake: IntakeService;
  gates: GateService;
  connections: ConnectionService;
  /** Moves the ledger's clock: the next entry is written at `iso`, and each one after a second later. */
  at: (iso: string) => void;
};

export function world(): World {
  const db = openDatabase(":memory:");
  let next = START;
  const ledger = new Ledger(db, {
    now: () => {
      const d = new Date(next);
      next += 1000;
      return d;
    },
  });
  const board = new BoardService(db, ledger);
  const intake = new IntakeService({ db, ledger, username: "clubuser" });
  const gates = new GateService({ db, ledger, username: "clubuser" });
  let n = 0;
  const connections = new ConnectionService({ db, ledger, secrets: new MemorySecretStore(), newId: () => `conn${++n}`, testers: {} });
  const at = (iso: string) => {
    next = Date.parse(iso);
  };
  return { db, ledger, board, intake, gates, connections, at };
}

/** Starts and answers the intake, decides `hosting` and `first_version`, and completes it (which adds five cards). */
export function completeIntake(
  w: World, projectId: string,
  decide: { hosting?: [string, string?]; first_version?: [string, string?] } = {},
): void {
  w.intake.start(human, projectId, "Reading lists for a club");
  for (const [q, a] of Object.entries(ANSWERS)) w.intake.answer(human, projectId, q as never, a);
  const [scope, scopeWhy] = decide.first_version ?? ["smallest"];
  const [hosting, hostingWhy] = decide.hosting ?? ["local"];
  w.intake.decide(human, projectId, "first_version", scope, scopeWhy);
  w.intake.decide(human, projectId, "hosting", hosting, hostingWhy);
  w.intake.complete(human, projectId);
}

export function emit(w: World, projectId: string | null, type: string, payload: unknown, actor: Actor = agent): void {
  commitEvents(w.db, w.ledger, () => ({
    events: [{ projectId, actor, type, payload } as NewLedgerEntry],
    result: () => undefined,
  }));
}

export function startRun(w: World, projectId: string, runId: string, adapter: string, cardId: string | null, prompt = "go"): void {
  const authMode = adapter === "fake" ? "none" : "api_key";
  emit(w, projectId, "agent.started", { runId, adapter, authMode, prompt, cardId, worktree: `wt/${runId}` }, human);
}
