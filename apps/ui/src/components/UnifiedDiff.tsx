import { parseUnifiedDiff, visibleControls } from "@theterminal/shared";
import type { DiffLine } from "@theterminal/shared";
import { stripAnsi } from "./text";

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " ", meta: "" };

/** Diff text as the Owner reads it: terminal escapes dropped, hidden characters shown as escapes. */
const shown = (s: string) => visibleControls(stripAnsi(s));

/**
 * A unified diff as plain text, one row per line with its old and new line numbers. Rows are React text nodes
 * only: nothing in the diff is ever read as markup.
 */
export function UnifiedDiff({ text }: { text: string }) {
  const hunks = parseUnifiedDiff(text);
  return (
    <pre className="diff">
      {hunks.flatMap((h, i) => [
        ...(h.header === ""
          ? []
          : [
              <div key={`${i}h`} className="line hunk">
                <span className="ln" />
                <span className="ln" />
                <span className="text">{shown(h.header)}</span>
              </div>,
            ]),
        ...h.lines.map((l, j) => (
          <div key={`${i}:${j}`} className={`line ${l.kind}`}>
            <span className="ln">{l.oldNo ?? ""}</span>
            <span className="ln">{l.newNo ?? ""}</span>
            <span className="text">{SIGN[l.kind] + shown(l.text)}</span>
          </div>
        )),
      ])}
    </pre>
  );
}
