import type { ProposedAction } from "./adapter.js";
import { REDACTED } from "./redact.js";
import type { WorktreeManager } from "./worktrees.js";

export type Verdict = { verdict: "auto_allow" | "auto_deny" | "ask"; reason: string };

/** True for the marker `AgentRunner` records in place of an input over the size cap. */
const isTruncated = (input: unknown): boolean =>
  typeof input === "object" && input !== null && (input as { truncated?: unknown }).truncated === true;

/**
 * Decides what needs a human: outside paths are denied, and so is a shell command whose recorded input was
 * truncated or redacted (a human cannot review all of it); inside reads are allowed; the rest asks.
 */
export function classify(a: ProposedAction, worktreeAbs: string, wt: WorktreeManager): Verdict {
  const raw: unknown = a.paths;
  const paths: unknown[] = Array.isArray(raw) ? raw : [];
  if (paths.some((p) => typeof p !== "string" || wt.resolveInside(worktreeAbs, p) === null)) {
    return { verdict: "auto_deny", reason: "outside worktree" };
  }
  // A human cannot review what was not recorded in full.
  if (a.kind === "shell" && isTruncated(a.input)) return { verdict: "auto_deny", reason: "command too long to review" };
  // A redaction can swallow the rest of a line, hiding an executable tail from the reviewer.
  if (a.kind === "shell" && JSON.stringify(a.input ?? null).includes(REDACTED)) {
    return { verdict: "auto_deny", reason: "command contains a secret and cannot be fully reviewed" };
  }
  if (a.kind === "file_read" && paths.length > 0) return { verdict: "auto_allow", reason: "read-only inside worktree" };
  return { verdict: "ask", reason: "needs approval" };
}
