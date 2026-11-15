import { MAX_RENDERED_LINES, parseUnifiedDiff, visibleControls } from "@theterminal/shared";
import type { DiffLine } from "@theterminal/shared";
import { stripAnsi } from "./text";

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " ", meta: "" };
/** Read out before an added or removed row, which colour alone would not tell a screen reader. */
const SPOKEN: Partial<Record<DiffLine["kind"], string>> = { add: "Added: ", del: "Removed: " };

/** Diff text as the Owner reads it: terminal escapes dropped, hidden characters shown as escapes. */
const shown = (s: string) => visibleControls(stripAnsi(s));
const count = (n: number) => n.toLocaleString("en-US");

/** The row's line numbers in words, since the number columns are hidden from screen readers. */
function numbers(oldNo: number | null, newNo: number | null): string | undefined {
  const parts = [oldNo === null ? null : `old line ${oldNo}`, newNo === null ? null : `new line ${newNo}`].filter((p) => p !== null);
  if (parts.length === 0) return undefined;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Row = { key: string; kind: DiffLine["kind"] | "hunk"; text: string; oldNo: number | null; newNo: number | null };

/**
 * A unified diff as plain text, one row per line with its old and new line numbers, at most `MAX_RENDERED_LINES`
 * rows with a note saying so. Rows are React text nodes only: nothing in the diff is ever read as markup.
 */
export function UnifiedDiff({ text }: { text: string }) {
  const rows: Row[] = parseUnifiedDiff(text).flatMap((h, i) => [
    ...(h.header === "" ? [] : [{ key: `${i}h`, kind: "hunk" as const, text: shown(h.header), oldNo: null, newNo: null }]),
    ...h.lines.map((l, j) => ({ key: `${i}:${j}`, kind: l.kind, text: SIGN[l.kind] + shown(l.text), oldNo: l.oldNo, newNo: l.newNo })),
  ]);
  const painted = rows.slice(0, MAX_RENDERED_LINES);
  return (
    <>
      {rows.length > painted.length && (
        <p className="note">
          Showing the first {count(MAX_RENDERED_LINES)} lines of {count(rows.length)}
        </p>
      )}
      <pre className="diff">
        {painted.map((r) => (
          <div key={r.key} className={`line ${r.kind}`} title={numbers(r.oldNo, r.newNo)}>
            <span className="ln" aria-hidden="true">
              {r.oldNo ?? ""}
            </span>
            <span className="ln" aria-hidden="true">
              {r.newNo ?? ""}
            </span>
            {r.kind !== "hunk" && SPOKEN[r.kind] !== undefined && <span className="visually-hidden">{SPOKEN[r.kind]}</span>}
            <span className="text">{r.text}</span>
          </div>
        ))}
      </pre>
    </>
  );
}
