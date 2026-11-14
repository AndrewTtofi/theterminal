import type { LedgerEntry, NewLedgerEntry } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { applyEvent } from "./projections.js";

/**
 * The one commit path for state events. Runs one immediate transaction: `build` may read state and returns an
 * event to append (or none for a no-op), the entry and its projection commit atomically, and listeners are
 * notified only after commit.
 */
export function commitEvent<T>(
  db: Db,
  ledger: Ledger,
  build: () => { event?: NewLedgerEntry; result: (entry: LedgerEntry | null) => T },
  apply: (db: Db, e: LedgerEntry) => void = applyEvent,
): T {
  const { entry, value } = db
    .transaction(() => {
      const { event, result } = build();
      if (!event) return { entry: null, value: result(null) };
      const entry = ledger.appendInTransaction(event);
      apply(db, entry);
      return { entry, value: result(entry) };
    })
    .immediate();
  if (entry) ledger.notify(entry);
  return value;
}
