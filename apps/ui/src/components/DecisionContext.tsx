import { plural, visibleControls } from "@theterminal/shared";
import type { AgentAction, LedgerEntry, PendingAgentAction, RunChanges } from "@theterminal/shared";
import { stripAnsi } from "./text";

/** What a pending action would do to a file, read from its recorded input: never computed. */
export type ProposedChange = {
  path: string | null;
  kind: "replace_file" | "edit" | "none";
  content?: string;
  oldText?: string;
  newText?: string;
};

/** The most lines one block of a proposed change shows; the rest stay in the card's Details. */
const MAX_PROPOSED_LINES = 200;

/** The first of `keys` whose value in `input` is a string. */
function pick(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * The change a file action proposes, from the field names the adapters record: a whole-file write (Claude's
 * `{ file_path, content }`) or an edit (`{ file_path, old_string, new_string }`). Anything else proposes nothing
 * the card can show, though a write that names its file keeps the path.
 */
export function proposedChange(action: Pick<AgentAction, "kind" | "input">): ProposedChange {
  const input = action.input;
  if (typeof input !== "object" || input === null) return { path: null, kind: "none" };
  const i = input as Record<string, unknown>;
  const path = pick(i, ["file_path", "path", "filePath"]) ?? null;
  if (action.kind === "file_write") {
    const content = pick(i, ["content", "new_content", "text"]);
    return content === undefined ? { path, kind: "none" } : { path, kind: "replace_file", content };
  }
  if (action.kind === "file_edit") {
    const oldText = pick(i, ["old_string", "old_text", "oldText"]);
    const newText = pick(i, ["new_string", "new_text", "newText"]);
    return oldText === undefined || newText === undefined ? { path, kind: "none" } : { path, kind: "edit", oldText, newText };
  }
  return { path: null, kind: "none" };
}

/** The text's lines (a final line break ends the last line rather than starting an empty one), cleaned for display. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => visibleControls(stripAnsi(l)));
}

/** One block of lines with a prefix, cut at the cap; how many lines were left out. */
function block(text: string, prefix: "+" | "-"): { lines: string[]; more: number } {
  const all = linesOf(text);
  return { lines: all.slice(0, MAX_PROPOSED_LINES).map((l) => `${prefix}${l}`), more: Math.max(0, all.length - MAX_PROPOSED_LINES) };
}

/** The last `n` things the run's agent said, oldest first. */
function lastMessages(entries: LedgerEntry[], runId: string, n: number): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
    const e = entries[i]!;
    if (e.type !== "agent.message" || typeof e.payload !== "object" || e.payload === null) continue;
    const p = e.payload as { runId?: unknown; text?: unknown };
    if (p.runId === runId && typeof p.text === "string") out.unshift(p.text);
  }
  return out;
}

/** How many files the run has changed, saying so when the server listed only some or could not count them. */
function changedSentence(c: RunChanges): string {
  if (c.tooMany) return "This run has changed too many files to count so far";
  return `This run has changed ${c.truncated ? "more than " : ""}${plural(c.files.length, "file")} so far`;
}

type Props = {
  action: PendingAgentAction;
  /** The run's project stream, or null when it is not loaded (another project's action). */
  entries: LedgerEntry[] | null;
  /** What the run has changed so far, or null when not known. */
  changes: RunChanges | null;
  /** Said in place of the changes when they cannot be read now (a live run's are read once it stops). */
  changesNote?: string | null;
  onSeeChanges(runId: string): void;
};

/**
 * What an Owner needs beside a decision: the change proposed (the recorded old and new text as -/+ lines), the
 * last two things the agent said before asking, and how many files its run has changed so far.
 */
export function DecisionContext({ action, entries, changes, changesNote = null, onSeeChanges }: Props) {
  const change = proposedChange(action);
  const blocks =
    change.kind === "replace_file"
      ? [block(change.content ?? "", "+")]
      : change.kind === "edit"
        ? [block(change.oldText ?? "", "-"), block(change.newText ?? "", "+")]
        : [];
  const said = entries === null ? [] : lastMessages(entries, action.runId, 2);

  return (
    <div className="decision-context">
      {change.kind !== "none" && (
        <>
          <h4>{change.path === null ? "Proposed change" : `Proposed change to ${visibleControls(change.path)}`}</h4>
          <pre className="proposed">
            {blocks.flatMap((b, bi) =>
              b.lines.map((l, li) => (
                <span key={`${bi}:${li}`} className={l.startsWith("+") ? "add" : "del"}>
                  {l}
                </span>
              )),
            )}
          </pre>
          {blocks
            .filter((b) => b.more > 0)
            .map((b, i) => (
              <p key={i} className="note">
                … {b.more} more lines in Details
              </p>
            ))}
        </>
      )}
      {said.length > 0 && (
        <>
          <p>Before this, the agent said:</p>
          <ul className="agent-said">
            {said.map((t, i) => (
              <li key={i}>{visibleControls(stripAnsi(t))}</li>
            ))}
          </ul>
        </>
      )}
      {changesNote !== null ? (
        <p className="note">{changesNote}</p>
      ) : (
        changes !== null &&
        (changes.files.length === 0 && !changes.truncated ? (
          <p className="note">Nothing changed yet</p>
        ) : (
          <p className="note">
            <span>{changedSentence(changes)}</span>{" "}
            <button type="button" onClick={() => onSeeChanges(action.runId)}>
              See changes
            </button>
          </p>
        ))
      )}
    </div>
  );
}
