import { useMemo } from "react";
import { narrate, plural, visibleControls } from "@theterminal/shared";
import type { LedgerEntry, NarrationContext, NarrationTopic } from "@theterminal/shared";
import { stripAnsi } from "./text";

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

/** True for an override.* entry: painted red, with a text label, in every list of ledger entries. */
export const isOverride = (e: LedgerEntry): boolean => e.type.startsWith("override.");

/** The class of an entry's line: `attention` when it needs the Owner's eye, `override` for an override. */
export function entryClass(e: LedgerEntry, attention: boolean): string | undefined {
  const names = [attention && "attention", isOverride(e) && "override"].filter(Boolean);
  return names.length > 0 ? names.join(" ") : undefined;
}

/**
 * The text label that says an override is one without relying on its colour: shown before the headline of an
 * override entry whose headline does not already start with `OVERRIDE`.
 */
export function OverrideTag({ entry, headline }: { entry: LedgerEntry; headline: string }) {
  if (!isOverride(entry) || headline.startsWith("OVERRIDE")) return null;
  return (
    <>
      <span className="override-tag">OVERRIDE</span>{" "}
    </>
  );
}

/**
 * The raw record under a headline: the narration's detail, when it has one, then the payload. Text only; an
 * override's detail is a program's output, so its terminal codes are stripped first.
 */
function rawRecord(detail: string | null, payload: unknown, override: boolean): string {
  const json = canonicalPayload(payload);
  const shown = detail !== null && override ? stripAnsi(detail) : detail;
  return visibleControls(shown === null ? json : `${shown}\n\n${json}`);
}

/** An entry's raw record, folded under its headline; the summary's accessible name says which entry it belongs to. */
export function RawRecord({
  headline,
  detail,
  payload,
  override = false,
}: {
  headline: string;
  detail: string | null;
  payload: unknown;
  /** True for an override entry, whose detail is program output. */
  override?: boolean;
}) {
  return (
    <details className="raw">
      <summary aria-label={`Raw record: ${headline}`}>Raw</summary>
      <pre>{rawRecord(detail, payload, override)}</pre>
    </details>
  );
}

export function LedgerPanel({ entries, topics, ctx }: { entries: LedgerEntry[]; topics?: NarrationTopic[]; ctx?: NarrationContext }) {
  // Narrating every entry is the costly part: redone only when the entries or the context change, not per filter.
  const narrated = useMemo(
    () => [...entries].sort((a, b) => b.seq - a.seq).map((e) => ({ e, n: narrate(e, ctx) })),
    [entries, ctx],
  );
  // Overrides are always shown, whatever the filter says.
  const inTopics = ({ n }: { n: { topic: NarrationTopic } }) =>
    topics === undefined || n.topic === "override" || topics.includes(n.topic);
  const shown = narrated.filter(inTopics);
  const hiddenAttention = narrated.filter((x) => x.n.attention && !inTopics(x)).length;
  return (
    <aside className="ledger" aria-label="Ledger">
      <h2>Ledger</h2>
      {hiddenAttention > 0 && (
        <p className="note">
          {plural(hiddenAttention, "entry", "entries")} needing attention {hiddenAttention === 1 ? "is" : "are"} hidden by the topic filter
        </p>
      )}
      <ul>
        {shown.map(({ e, n }) => (
          <li key={e.seq} className={entryClass(e, n.attention)}>
            <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time> · <OverrideTag entry={e} headline={n.headline} />
            <span className="headline">{n.headline}</span>
            <RawRecord headline={n.headline} detail={n.detail} payload={e.payload} override={isOverride(e)} />
          </li>
        ))}
      </ul>
    </aside>
  );
}
