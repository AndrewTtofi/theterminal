import type { LedgerEntry } from "@theterminal/shared";
import type { Db } from "../db.js";

type Payload = Record<string, string>;

/** Projection reducer: applies one ledger entry to the projects/cards tables. Unknown types are ignored. */
export function applyEvent(db: Db, e: LedgerEntry): void {
  const p = e.payload as Payload;
  switch (e.type) {
    case "project.created":
      db.prepare("INSERT INTO projects (id, name, pitch, created_at) VALUES (?, ?, ?, ?)").run(
        p.projectId, p.name, p.pitch, e.ts,
      );
      break;
    case "card.created":
      db.prepare(
        `INSERT INTO cards (id, project_id, title, stage, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'todo', ?, ?)`,
      ).run(p.cardId, e.projectId, p.title, p.stage, e.ts, e.ts);
      break;
    case "card.moved":
      db.prepare("UPDATE cards SET stage = ?, updated_at = ? WHERE id = ?").run(p.to, e.ts, p.cardId);
      break;
    case "card.status_changed":
      db.prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ?").run(p.to, e.ts, p.cardId);
      break;
    default:
      break;
  }
}
