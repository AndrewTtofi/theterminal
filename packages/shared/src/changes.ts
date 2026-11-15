/**
 * What an agent run changed in its working copy, and the read-only views of it: a diff, a directory listing, a
 * file's text. The limits are fixed numbers, applied by the service after cleaning and reported in the response
 * (`truncated`, `tooLarge`), so the UI never has to guess what it was not sent.
 */

/** Changed files listed for one run. */
export const MAX_CHANGED_FILES = 500;
/** Lines of one file's diff. */
export const MAX_DIFF_LINES = 5000;
/** One file's diff, in bytes of UTF-8 after cleaning; over it the diff is `tooLarge` with no text. */
export const MAX_DIFF_BYTES = 1_048_576;
/** One file's text, in bytes; over it the file is `tooLarge` with no text. */
export const MAX_FILE_BYTES = 1_048_576;
/** Entries of one directory listing. */
export const MAX_DIR_ENTRIES = 2000;
/** Lines a viewer renders before it stops and says so. */
export const MAX_RENDERED_LINES = 20000;

export type ChangeStatus = "added" | "modified" | "deleted" | "typechange" | "untracked" | "unchanged";
/**
 * `added` and `deleted` are line counts, null for binary and untracked files. `cleaned` is set when cleaning changed
 * the path (it looked like a secret or a private path): the path shown is not the real one, so it opens nothing.
 */
export type ChangedFile = {
  path: string;
  status: ChangeStatus;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  cleaned?: true;
};
/**
 * `base` and `head` are full commit ids; `files` are sorted by path. `tooMany` is set when the run changed too much
 * to list at all: `files` is then partial or empty and must not be counted or summed.
 */
export type RunChanges = { runId: string; base: string; head: string; files: ChangedFile[]; truncated: boolean; tooMany?: boolean };
export type FileDiff = {
  runId: string;
  path: string;
  status: ChangeStatus;
  binary: boolean;
  tooLarge: boolean;
  added: number | null;
  deleted: number | null;
  text: string | null;
};
/**
 * `other` is a symlink, socket or anything else that is not a plain file or directory; it is never followed.
 * `cleaned` is set when cleaning changed the name, which then opens nothing.
 */
export type DirEntry = { name: string; kind: "file" | "dir" | "other"; size: number | null; cleaned?: true };
/** Directories first, then files, each by name; `.git` is never listed. */
export type DirListing = { runId: string; path: string; entries: DirEntry[]; truncated: boolean };
export type FileContent = { runId: string; path: string; size: number; binary: boolean; tooLarge: boolean; text: string | null };

export type DiffLine = { kind: "context" | "add" | "del" | "meta"; text: string; oldNo: number | null; newNo: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };

/**
 * `@@ -a[,b] +c[,d] @@`, anchored, with no nested or overlapping repetition, so it fails in time linear in the
 * line. Nine digits at most: larger numbers are not real line numbers.
 */
const HUNK_HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;

const meta = (text: string): DiffLine => ({ kind: "meta", text, oldNo: null, newNo: null });

/**
 * Splits a unified diff (as `git diff` prints it) into hunks with old and new line numbers.
 *
 * Each line is looked at once, so the time is linear in the text. Lines before the first hunk go in a hunk with
 * the header `""`, all as `meta`. Inside a hunk, ` ` is context, `+` an added line and `-` a removed one, while
 * the header's counts last; `---` and `+++` past them, `diff --git`, `index`, `Binary files`, `\ No newline at end
 * of file` and anything unrecognised are `meta`, which moves no counter. Never throws; `""` gives `[]`.
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const raw = text.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const r of raw) {
    const line = r.endsWith("\r") ? r.slice(0, -1) : r;
    const m = line.startsWith("@@ ") ? HUNK_HEADER.exec(line) : null;
    if (m) {
      current = { header: line, lines: [] };
      hunks.push(current);
      inHunk = true;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      continue;
    }
    if (current === null) {
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    if (!inHunk) {
      current.lines.push(meta(line));
      continue;
    }
    const lead = line.charAt(0);
    const body = line.slice(1);
    if (lead === " ") {
      current.lines.push({ kind: "context", text: body, oldNo: oldNo++, newNo: newNo++ });
      oldLeft--;
      newLeft--;
    } else if (lead === "-" && (oldLeft > 0 || !line.startsWith("---"))) {
      current.lines.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null });
      oldLeft--;
    } else if (lead === "+" && (newLeft > 0 || !line.startsWith("+++"))) {
      current.lines.push({ kind: "add", text: body, oldNo: null, newNo: newNo++ });
      newLeft--;
    } else {
      current.lines.push(meta(line));
    }
  }
  return hunks;
}
