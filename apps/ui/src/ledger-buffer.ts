import type { LedgerEntry } from "@theterminal/shared";

/** The most streamed entries kept in memory for a scope while the Owner has not paged older entries in. */
export const LIVE_CAP = 5000;

/** How long streamed entries are gathered before they are applied together. */
const BATCH_MS = 50;

/**
 * `incoming` after `current`, without entries `current` already has, in seq order. With a `cap`, only the newest
 * `cap` are kept, and `trimmed` says older ones were dropped (so the server holds older entries again).
 */
export function appendEntries(
  current: LedgerEntry[],
  incoming: LedgerEntry[],
  cap: number | null,
): { entries: LedgerEntry[]; trimmed: boolean } {
  const have = new Set(current.map((e) => e.seq));
  const fresh = incoming.filter((e) => !have.has(e.seq) && have.add(e.seq)).sort((a, b) => a.seq - b.seq);
  const merged = fresh.length === 0 ? current : [...current, ...fresh];
  if (cap === null || merged.length <= cap) return { entries: merged, trimmed: false };
  return { entries: merged.slice(-cap), trimmed: true };
}

/** `older` in front of `current`, without the entries `current` already has. */
export function prependEntries(older: LedgerEntry[], current: LedgerEntry[]): LedgerEntry[] {
  const have = new Set(current.map((e) => e.seq));
  return [...older.filter((e) => !have.has(e.seq)), ...current];
}

/** Gathers pushed items and hands them to `apply` together, at most once every 50 ms. */
export function batcher<T>(apply: (items: T[]) => void): { push: (item: T) => void; cancel: () => void } {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(item) {
      pending.push(item);
      timer ??= setTimeout(() => {
        timer = undefined;
        const items = pending;
        pending = [];
        apply(items);
      }, BATCH_MS);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}
