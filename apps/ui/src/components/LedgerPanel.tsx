import { narrate, visibleControls } from "@theterminal/shared";
import type { LedgerEntry, NarrationContext, NarrationTopic } from "@theterminal/shared";

/** The plain-language headline of one entry; kept for callers and tests. */
export const describeEntry = (e: LedgerEntry, ctx?: NarrationContext): string => narrate(e, ctx).headline;

/** A value with its object keys sorted, so the raw record reads the same however it was built. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v !== "object" || v === null) return v;
  const rec = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map((k) => [k, sortKeys(rec[k])]),
  );
}

/** The payload as indented JSON with sorted keys. */
export function canonicalPayload(payload: unknown): string {
  try {
    return JSON.stringify(sortKeys(payload), null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}

/** The raw record under a headline: the narration's detail, when it has one, then the payload. Text only. */
function rawRecord(detail: string | null, payload: unknown): string {
  const json = canonicalPayload(payload);
  return visibleControls(detail === null ? json : `${detail}\n\n${json}`);
}

export function LedgerPanel({ entries, topics, ctx }: { entries: LedgerEntry[]; topics?: NarrationTopic[]; ctx?: NarrationContext }) {
  const shown = [...entries]
    .sort((a, b) => b.seq - a.seq)
    .map((e) => ({ e, n: narrate(e, ctx) }))
    .filter(({ n }) => topics === undefined || topics.includes(n.topic));
  return (
    <aside className="ledger" aria-label="Ledger">
      <h2>Ledger</h2>
      <ul>
        {shown.map(({ e, n }) => (
          <li key={e.seq} className={n.attention ? "attention" : undefined}>
            <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time> · {n.headline}
            <details className="raw">
              <summary>Raw</summary>
              <pre>{rawRecord(n.detail, e.payload)}</pre>
            </details>
          </li>
        ))}
      </ul>
    </aside>
  );
}
