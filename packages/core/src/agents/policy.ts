import type { ProposedAction } from "./adapter.js";
import type { WorktreeManager } from "./worktrees.js";

export type Verdict = { verdict: "auto_allow" | "auto_deny" | "ask"; reason: string };

/** Decides what needs a human: outside paths are denied, inside reads are allowed, the rest asks. */
export function classify(a: ProposedAction, worktreeAbs: string, wt: WorktreeManager): Verdict {
  const paths: unknown[] = Array.isArray(a.paths) ? a.paths : [];
  if (paths.some((p) => typeof p !== "string" || wt.resolveInside(worktreeAbs, p) === null)) {
    return { verdict: "auto_deny", reason: "outside worktree" };
  }
  if (a.kind === "file_read" && paths.length > 0) return { verdict: "auto_allow", reason: "read-only inside worktree" };
  return { verdict: "ask", reason: "needs approval" };
}
