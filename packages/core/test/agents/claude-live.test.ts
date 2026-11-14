import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEvent, ProposedAction } from "../../src/agents/adapter.js";
import { ClaudeAdapter } from "../../src/agents/claude-adapter.js";

// Opt-in only: THETERMINAL_LIVE_CLAUDE=1 runs a real Claude Code session (api_key mode, key from the environment).
describe.skipIf(process.env.THETERMINAL_LIVE_CLAUDE !== "1")("ClaudeAdapter live", () => {
  let worktree: string;
  beforeEach(() => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), "claude-live-")));
    writeFileSync(join(worktree, "README.md"), "The magic word is pineapple.\n");
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it("runs a tiny read-only prompt with every tool call gated", async () => {
    const proposed: ProposedAction[] = [];
    const events: AdapterEvent[] = [];
    let n = 0;
    const r = await new ClaudeAdapter().start({
      cwd: worktree,
      prompt: "Read README.md and reply with the magic word only. Do not modify anything.",
      authMode: "api_key",
      signal: new AbortController().signal,
      gate: async (a) => {
        proposed.push(a);
        const ok = a.kind === "file_read";
        return { decision: ok ? "allow" : "deny", reason: ok ? "read" : "read-only test", actionId: `act-${++n}` };
      },
      emit: (e) => events.push(e),
    });
    expect(r).toEqual({ status: "completed" });
    expect(proposed.some((a) => a.tool === "Read")).toBe(true);
    expect(events.some((e) => e.type === "action_result" && e.ok)).toBe(true);
    expect(events.some((e) => e.type === "message" && /pineapple/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  }, 180_000);
});
