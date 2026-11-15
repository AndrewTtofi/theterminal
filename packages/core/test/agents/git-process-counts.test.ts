import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@theterminal/shared";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { FakeAdapter } from "../../src/agents/fake-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { WorktreeManager, type GitRunner } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { fileDiff, listChanges, type ChangesDeps } from "../../src/changes/changes.js";
import { openDatabase, type Db } from "../../src/db.js";
import { getRun } from "../../src/events/projections.js";
import { RecordedText } from "../../src/intake/recorded-text.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { OverrideService } from "../../src/override/service.js";

const owner = { kind: "human", id: "owner" } as const;
const exec = promisify(execFile);

// Several run starts and views, each tens of git processes: seconds on Windows CI (see worktrees.test.ts).
const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 20_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

/**
 * How many git processes each operation may start. Every call still runs through runGit's hardening (the repository
 * probe, the include scan of the shared and worktree configuration, the filter scan, the `.gitattributes` scan of
 * HEAD's tree: four processes, more with `.gitattributes` files in HEAD's tree); within one operation (a GitScope)
 * that scan is done once per repository and worktree and reused while the configuration files it read are unchanged,
 * instead of before every call. Before this, every call scanned: a run start was 52 processes, a view 40, a discard 35.
 */
const PROCESSES = {
  /** `git version`, once per manager, on its first call. */
  version: 1,
  /**
   * `ensureProjectRepo` + `createRunWorktree` for a project whose repository does not exist yet: a scan of the empty
   * directory (nothing to keep) and `init`; a scan, the git directory check, the three identity keys (a write and the
   * listing that checks it, each), the HEAD check and the initial commit; `worktree add`; a scan of the new worktree
   * and its HEAD.
   */
  firstStart: 25,
  /** The same for a project whose repository exists and is configured: no `init`, no writes. */
  start: 12,
  /** One scan; the worktree check; the fork point; the scratch index (two); the two diffs and the untracked list. */
  listChanges: 11,
  /** As listChanges, with the file's diff (tracked) or the untracked list (untracked) last. */
  fileDiff: 11,
  /** One scan; the worktree check; the scratch index (two) and the count; `read-tree`, `reset`, `clean`. */
  discard: 11,
};

let dataDir: string;
let db: Db;
let ledger: Ledger;
let worktrees: WorktreeManager;
let runner: AgentRunner;
let count = 0;
let sequence: string[] = [];

/** The subcommand of a hardened git call (the first argument that is not a global option or a `-c` value). */
const subcommand = (args: string[]): string =>
  args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c" && args[i - 1] !== "--file") ?? "?";

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "count-data-")));
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  const counting: GitRunner = async (args, cwd, opts) => {
    count++;
    sequence.push(subcommand(args));
    return (await exec("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
  };
  worktrees = new WorktreeManager(dataDir, counting);
  runner = new AgentRunner({
    db, ledger, worktrees, broker: new ApprovalBroker(), adapters: { fake: new FakeAdapter([]) }, dataDir, username: "someuser", extraSecrets: () => [],
  });
  count = 0;
  sequence = [];
});
afterEach(async () => {
  await runner.shutdown();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const startRun = async (projectId: string): Promise<AgentRun> => {
  const r = await runner.start(owner, { projectId, adapter: "fake", prompt: "go" });
  await vi.waitFor(() => expect(getRun(db, r.id)!.status).not.toBe("running"), { timeout: 5000 });
  return r;
};
/**
 * Runs `fn` and asserts how many git processes it started. The failure message lists each process's subcommand, so a
 * count that moved says which call was added or dropped.
 */
const expectProcesses = async (label: string, expected: number, fn: () => Promise<unknown>): Promise<void> => {
  count = 0;
  sequence = [];
  await fn();
  expect(count, `${label}: ${sequence.join(" ")}`).toBe(expected);
};

describe("git processes per operation", () => {
  it("a run start, the changes list, a file diff and a discard each start a bounded number of git processes", async () => {
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;

    // The first start of a project creates its repository: `git version` once, then two extra scans (see PROCESSES).
    await expectProcesses("first run start", PROCESSES.version + PROCESSES.firstStart, () => startRun(projectId));

    // Later starts find the repository configured: one scan in the repository, one in the new worktree.
    let run!: AgentRun;
    await expectProcesses("run start", PROCESSES.start, async () => {
      run = await startRun(projectId);
    });

    // The agent commits a file, then changes it and adds an untracked one: one tracked and one untracked change.
    const wt = join(dataDir, run.worktree);
    writeFileSync(join(wt, "tracked.txt"), "one\n");
    await worktrees.runGit(wt, ["add", "tracked.txt"]);
    await worktrees.runGit(wt, ["commit", "--no-verify", "-m", "agent work"]);
    writeFileSync(join(wt, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(wt, "new.txt"), "new\n");

    const deps: ChangesDeps = {
      db, dataDir, worktrees, clean: (id, s, max) => runner.cleanFor(id)(s, max), settling: (id) => runner.settling(id),
    };
    await expectProcesses("listChanges", PROCESSES.listChanges, async () => {
      const c = await listChanges(deps, run.id);
      expect(c.files.map((f) => `${f.path}:${f.status}`)).toEqual(["new.txt:untracked", "tracked.txt:added"]);
    });
    await expectProcesses("fileDiff (tracked)", PROCESSES.fileDiff, async () => {
      expect((await fileDiff(deps, run.id, "tracked.txt")).status).toBe("added");
    });
    await expectProcesses("fileDiff (untracked)", PROCESSES.fileDiff, async () => {
      expect((await fileDiff(deps, run.id, "new.txt")).status).toBe("untracked");
    });

    const service = new OverrideService({
      ...deps, ledger, which: () => null,
      recorded: new RecordedText({ dataDir, username: "someuser", secrets: () => [] }),
    });
    try {
      await expectProcesses("discard", PROCESSES.discard, async () => {
        const { files } = await service.discard(owner, run.id, "the agent left the build broken");
        expect(files).toBe(2);
      });
    } finally {
      await service.shutdown();
    }
  });
});
