import type { LedgerEntry, NewLedgerEntry } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { applyEvent } from "./projections.js";

/**
 * The one commit path for state events. Runs one immediate transaction: `build` may read state and returns the
 * events to append (none for a no-op), every entry and its projection commit atomically and in order, and
 * listeners are notified of each entry, in order, only after commit. `result` runs inside the transaction, so a
 * throw from `build` or `result` rolls the whole batch back; a caller that must record an entry and then fail
 * returns the failure from `result` and throws after this returns.
 */
export function commitEvents<T>(
  db: Db,
  ledger: Ledger,
  build: () => { events: NewLedgerEntry[]; result: (entries: LedgerEntry[]) => T },
  apply: (db: Db, e: LedgerEntry) => void = applyEvent,
): T {
  const { entries, value } = db
    .transaction(() => {
      const { events, result } = build();
      const entries: LedgerEntry[] = [];
      for (const event of events) {
        const entry = ledger.appendInTransaction(event);
        apply(db, entry);
        entries.push(entry);
      }
      return { entries, value: result(entries) };
    })
    .immediate();
  for (const entry of entries) ledger.notify(entry);
  return value;
}

/** `commitEvents` for at most one event. */
export function commitEvent<T>(
  db: Db,
  ledger: Ledger,
  build: () => { event?: NewLedgerEntry; result: (entry: LedgerEntry | null) => T },
  apply: (db: Db, e: LedgerEntry) => void = applyEvent,
): T {
  return commitEvents(
    db,
    ledger,
    () => {
      const { event, result } = build();
      return { events: event ? [event] : [], result: (entries) => result(entries[0] ?? null) };
    },
    apply,
  );
}
