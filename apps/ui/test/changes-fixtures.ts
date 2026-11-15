import type { AgentRun, DirListing, FileContent, FileDiff, LedgerEntry, RunChanges } from "@theterminal/shared";

/** A one-hunk diff of `notes.txt`: line 1 kept, line 2 replaced. */
export const NOTES_DIFF = [
  "diff --git a/notes.txt b/notes.txt",
  "index 1111111..2222222 100644",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1,2 +1,2 @@",
  " first",
  "-removed",
  "+added",
  "",
].join("\n");

export const BASE = "0123456789abcdef0123456789abcdef01234567";

export const run1: AgentRun = {
  id: "run1", projectId: "p1", cardId: null, adapter: "fake", authMode: "none",
  prompt: "Write the release notes for the next version of the app", status: "completed",
  worktree: "w/run1", costUsd: null, inputTokens: null, outputTokens: null, error: null,
  startedAt: "2026-11-15T10:00:00.000Z", finishedAt: null,
};

export const changes = (over: Partial<RunChanges> = {}): RunChanges => ({
  runId: "run1",
  base: BASE,
  head: "fedcba9876543210fedcba9876543210fedcba98",
  files: [{ path: "notes.txt", status: "added", added: 1, deleted: 0, binary: false }],
  truncated: false,
  ...over,
});

export const fileDiff = (over: Partial<FileDiff> = {}): FileDiff => ({
  runId: "run1", path: "notes.txt", status: "modified", binary: false, tooLarge: false, added: 1, deleted: 1, text: NOTES_DIFF, ...over,
});

export const fileContent = (over: Partial<FileContent> = {}): FileContent => ({
  runId: "run1", path: "src/a.ts", size: 12, binary: false, tooLarge: false, text: "one\ntwo\n", ...over,
});

export const listing = (path: string, entries: DirListing["entries"], truncated = false): DirListing => ({
  runId: "run1", path, entries, truncated,
});

let seq = 100;
/** A ledger entry of `type` whose payload names `runId`. */
export const runEntry = (type: LedgerEntry["type"], runId: string): LedgerEntry => ({
  seq: ++seq, id: `e${seq}`, ts: "2026-11-15T10:00:00.000Z", projectId: "p1", actor: { kind: "agent", id: runId }, type,
  payload: { runId }, prevHash: "", hash: "",
});
