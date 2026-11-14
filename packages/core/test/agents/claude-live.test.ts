import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, ProposedAction } from "../../src/agents/adapter.js";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { ClaudeAdapter } from "../../src/agents/claude-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase } from "../../src/db.js";
import { getRun, listActions, listPendingActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";

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
    const r = await new ClaudeAdapter({ dataDir: worktree }).start({
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

  it("records a write the human denies as denied, and the file is never created", async () => {
    const owner = { kind: "human", id: "owner" } as const;
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Live" }).id;
    const runner = new AgentRunner({
      db, ledger, worktrees: new WorktreeManager(worktree), broker: new ApprovalBroker(),
      adapters: { claude: new ClaudeAdapter({ dataDir: worktree }) }, extraSecrets: [], dataDir: worktree,
    });
    try {
      const run = await runner.start(owner, {
        projectId, adapter: "claude",
        prompt: "Use the Write tool to create a file named hello.txt containing the word hi. If it is denied, stop and reply done.",
      });
      // The test is the human: deny every action that asks, until the run ends.
      await vi.waitFor(
        () => {
          for (const a of listPendingActions(db, projectId)) runner.decide(owner, a.id, "deny", "live test denies writes");
          expect(getRun(db, run.id)!.status).not.toBe("running");
        },
        { timeout: 170_000, interval: 200 },
      );
      const writes = listActions(db, run.id).filter((a) => a.kind === "file_write" || a.kind === "file_edit" || a.kind === "shell");
      expect(writes.length).toBeGreaterThan(0);
      for (const a of writes) expect(a).toMatchObject({ status: "denied", decidedBy: "human", reason: "live test denies writes" });
      expect(existsSync(join(worktree, run.worktree, "hello.txt"))).toBe(false);
    } finally {
      await runner.shutdown();
      db.close();
    }
  }, 180_000);
});
