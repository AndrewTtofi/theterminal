import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProposedAction } from "../../src/agents/adapter.js";
import { CodexAdapter } from "../../src/agents/codex/adapter.js";

// Opt-in only: THETERMINAL_LIVE_CODEX=1 runs the user's installed `codex app-server` with their own ChatGPT login.
describe.skipIf(process.env.THETERMINAL_LIVE_CODEX !== "1")("CodexAdapter live", () => {
  let worktree: string;
  beforeEach(() => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), "codex-live-")));
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it("asks before creating a file, and a denied write never happens", async () => {
    const proposed: ProposedAction[] = [];
    let n = 0;
    const r = await new CodexAdapter({ dataDir: worktree }).start({
      cwd: worktree,
      prompt: "Create a file named hello.txt containing the word hi. If that is declined, stop and reply done.",
      authMode: "chatgpt",
      signal: new AbortController().signal,
      gate: async (a) => {
        proposed.push(a);
        return { decision: "deny", reason: "live test denies everything", actionId: `act-${++n}` };
      },
      emit: () => {},
    });
    expect(r).toEqual({ status: "completed" });
    expect(proposed.some((a) => a.kind === "file_write" || a.kind === "shell")).toBe(true);
    expect(existsSync(join(worktree, "hello.txt"))).toBe(false);
  }, 180_000);
});
