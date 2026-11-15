import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, LedgerEntry } from "@theterminal/shared";
import { ZodError } from "zod";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { FakeAdapter } from "../../src/agents/fake-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { WorktreeManager, type GitRunner } from "../../src/agents/worktrees.js";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { BoardService, NotFoundError } from "../../src/board/board-service.js";
import { RunActiveError, listChanges } from "../../src/changes/changes.js";
import { openDatabase, type Db } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { getRun, listPendingActions } from "../../src/events/projections.js";
import { RecordedText } from "../../src/intake/recorded-text.js";
import { HumanRequiredError, SecretInTextError } from "../../src/intake/service.js";
import { Ledger } from "../../src/ledger/ledger.js";
import {
  OVERRIDE_OUTPUT_CHARS, OverrideBusyError, OverrideService, ProgramNotAllowedError, ProgramNotFoundError, type OverrideDeps,
} from "../../src/override/service.js";
import { plainGit, plantSubmoduleTrap } from "../fixtures/submodule-trap.js";

const owner = { kind: "human", id: "owner" } as const;
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";
const REASON = "the agent left the build broken";
const posix = process.platform !== "win32";

let dataDir: string;
let outside: string;
let db: Db;
let ledger: Ledger;
let worktrees: WorktreeManager;
let runner: AgentRunner;
let run: AgentRun;
let wt: string;
let service: OverrideService;

const which = (cmd: string) => (cmd === "node" ? process.execPath : null);
const depsWith = (extra: Partial<OverrideDeps> = {}): OverrideDeps => ({
  db, ledger, dataDir, worktrees, which,
  recorded: new RecordedText({ dataDir, username: "someuser", secrets: () => [KEY] }),
  clean: (id, s, max) => runner.cleanFor(id)(s, max),
  settling: (id) => runner.settling(id),
  ...extra,
});

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "override-data-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "override-out-")));
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  worktrees = new WorktreeManager(dataDir);
  const projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
  runner = new AgentRunner({
    db, ledger, worktrees, broker: new ApprovalBroker(), adapters: { fake: new FakeAdapter([]) },
    extraSecrets: () => [KEY], dataDir, username: "someuser",
  });
  run = await runner.start(owner, { projectId, adapter: "fake", prompt: "go" });
  await vi.waitFor(() => expect(getRun(db, run.id)!.status).not.toBe("running"), { timeout: 5000 });
  wt = join(dataDir, run.worktree);
  service = new OverrideService(depsWith());
});
afterEach(async () => {
  await service.shutdown();
  await runner.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const entries = (type: string): LedgerEntry[] => ledger.list({ limit: 1000 }).filter((e) => e.type === type);
const completedFor = (overrideId: string) => entries("override.completed").find((e) => (e.payload as { overrideId: string }).overrideId === overrideId);
/** Waits for the override's completion entry and returns its payload. */
const completion = async (overrideId: string, timeout = 10_000) => {
  await vi.waitFor(() => expect(completedFor(overrideId)).toBeDefined(), { timeout });
  return completedFor(overrideId)!.payload as {
    ok: boolean; exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string;
  };
};
const node = (code: string, extra: { cwd?: string } = {}) => ({ program: "node", args: ["-e", code], reason: REASON, ...extra });
/** Expects the promise to reject with `type`, and the ledger to be unchanged. */
const refused = async (p: () => Promise<unknown>, type: new (...a: never[]) => Error) => {
  const head = ledger.headSeq();
  await expect(p()).rejects.toBeInstanceOf(type);
  expect(ledger.headSeq()).toBe(head);
  expect(service.active(run.id)).toBe(false);
};

describe("command", () => {
  it("records override.command, runs the program in the working copy, then records override.completed", async () => {
    const { overrideId } = await service.command(owner, run.id, node("console.log('hi')"));
    const [cmd] = entries("override.command");
    expect(cmd!.payload).toEqual({ overrideId, runId: run.id, program: "node", args: ["-e", "console.log('hi')"], cwd: ".", reason: REASON });
    expect(cmd!.actor).toEqual(owner);
    expect(cmd!.projectId).toBe(run.projectId);
    const done = await completion(overrideId);
    expect(done).toMatchObject({ ok: true, exitCode: 0, signal: null, timedOut: false, output: "hi\n" });
    expect(Number.isInteger(done.durationMs)).toBe(true);
    expect(completedFor(overrideId)!.seq).toBeGreaterThan(cmd!.seq);
    expect(service.active(run.id)).toBe(false);
  });

  it("redacts a stored secret the program prints, read from a file in the working copy", async () => {
    writeFileSync(join(wt, "notes.txt"), `key=${KEY}\n`);
    const { overrideId } = await service.command(owner, run.id, node("process.stdout.write(require('fs').readFileSync('notes.txt','utf8'))"));
    const done = await completion(overrideId);
    expect(done.output).toBe("key=[REDACTED]\n");
    expect(JSON.stringify(ledger.list({ limit: 1000 }))).not.toContain(KEY);
  });

  it("records stderr after a marker, makes control characters visible, and cuts long output after cleaning", async () => {
    const a = await service.command(owner, run.id, node("process.stdout.write('out\\x1b[31m'); process.stderr.write('err')"));
    expect((await completion(a.overrideId)).output).toBe("out\\u001b[31m\n[stderr]\nerr");
    // The key is built at run time: an argument holding it would be refused.
    const b = await service.command(owner, run.id, node("process.stdout.write(('zq-TESTKEY-e2e-'+'opaque-0000000000').repeat(2000))"));
    const out = (await completion(b.overrideId)).output;
    expect(out.length).toBe(OVERRIDE_OUTPUT_CHARS);
    expect(out.startsWith("[REDACTED][REDACTED]")).toBe(true);
    expect(out).not.toContain("TESTKEY");
  });

  it("records a failing exit code as not ok", async () => {
    const { overrideId } = await service.command(owner, run.id, node("process.exit(3)"));
    expect(await completion(overrideId)).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
  });

  it("kills a program that runs too long", async () => {
    service = new OverrideService(depsWith({ timeoutMs: 200 }));
    const { overrideId } = await service.command(owner, run.id, node("setTimeout(()=>{},5000)"));
    expect(await completion(overrideId)).toMatchObject({ ok: false, timedOut: true, signal: "SIGKILL", exitCode: null });
  });

  it("kills a program whose output passes the buffer and keeps what was read", async () => {
    const { overrideId } = await service.command(owner, run.id, node("process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000)"));
    const done = await completion(overrideId);
    expect(done).toMatchObject({ ok: false, exitCode: null, signal: "SIGKILL", timedOut: false });
    expect(done.output.length).toBe(OVERRIDE_OUTPUT_CHARS);
    expect(done.output.startsWith("xxxx")).toBe(true);
  });

  it.runIf(posix)("kills the whole process tree on a timeout", async () => {
    service = new OverrideService(depsWith({ timeoutMs: 500 }));
    const code =
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
      "console.log(c.pid);setInterval(()=>{},1000)";
    const { overrideId } = await service.command(owner, run.id, node(code));
    const done = await completion(overrideId);
    expect(done.timedOut).toBe(true);
    const pid = Number(done.output.trim());
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  }, 20_000);

  it("gives the program only the allowlisted environment, with git kept out of the parent folders", async () => {
    process.env.THETERMINAL_TEST_SECRET_TOKEN = "TESTKEY-env-0000000000";
    try {
      const { overrideId } = await service.command(owner, run.id, node("console.log(JSON.stringify(Object.keys(process.env).sort()))"));
      const names = JSON.parse((await completion(overrideId)).output) as string[];
      expect(names).not.toContain("THETERMINAL_TEST_SECRET_TOKEN");
      expect(names).toEqual(expect.arrayContaining(["GIT_CEILING_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]));
    } finally {
      delete process.env.THETERMINAL_TEST_SECRET_TOKEN;
    }
  });

  it("runs in a subfolder of the working copy, recorded relative to it", async () => {
    mkdirSync(join(wt, "sub"));
    const { overrideId } = await service.command(owner, run.id, node("console.log(process.cwd())", { cwd: "sub" }));
    expect((await completion(overrideId)).output).toBe(`.${sep}sub\n`);
    expect(entries("override.command")[0]!.payload).toMatchObject({ cwd: "sub" });
  });

  it("refuses a folder outside the working copy, a file, a missing folder and .git", async () => {
    writeFileSync(join(wt, "file.txt"), "x");
    for (const cwd of ["../", "..", outside, "file.txt", "missing", ".git"]) {
      await refused(() => service.command(owner, run.id, node("1", { cwd })), NotFoundError);
    }
  });

  it("scrubs the home folder and username from what it records, and runs the arguments as given", async () => {
    const home = join(homedir(), "x");
    const { overrideId } = await service.command(owner, run.id, { program: "node", args: ["-e", "console.log(process.argv[1])", home, "someuser"], reason: REASON });
    expect(entries("override.command")[0]!.payload).toMatchObject({ args: ["-e", "console.log(process.argv[1])", join("~", "x"), "<user>"] });
    expect(await completion(overrideId)).toMatchObject({ ok: true });
    const typed = await service.command(owner, run.id, { program: process.execPath, args: ["-e", "1"], reason: REASON });
    await completion(typed.overrideId);
    const recorded = (entries("override.command")[1]!.payload as { program: string }).program;
    expect(recorded).not.toContain(homedir());
  });

  it("refuses a run that is still running with RunActiveError", async () => {
    const live = new AgentRunner({
      db, ledger, worktrees, broker: new ApprovalBroker(), dataDir, extraSecrets: () => [KEY], username: "someuser",
      adapters: {
        fake: new FakeAdapter([
          { propose: { tool: "Write", kind: "file_write", summary: "write notes", input: { path: "notes.md" }, paths: ["notes.md"] } },
        ]),
      },
    });
    try {
      const r = await live.start(owner, { projectId: run.projectId, adapter: "fake", prompt: "wait" });
      await vi.waitFor(() => expect(listPendingActions(db, run.projectId)).toHaveLength(1), { timeout: 5000 });
      const head = ledger.headSeq();
      await expect(service.command(owner, r.id, node("1"))).rejects.toThrow(new RunActiveError("an agent is still working in this run"));
      await expect(service.discard(owner, r.id, REASON)).rejects.toBeInstanceOf(RunActiveError);
      expect(ledger.headSeq()).toBe(head);
    } finally {
      await live.shutdown();
    }
  });

  it("refuses bad input before recording anything", async () => {
    await refused(() => service.command(owner, run.id, { ...node("1"), reason: "short" }), ZodError);
    await refused(() => service.command(owner, run.id, { ...node("1"), reason: "          short          " }), ZodError);
    await refused(() => service.command(owner, run.id, { ...node("1"), extra: 1 } as never), ZodError);
    await refused(() => service.command(owner, run.id, { program: "node", args: Array(65).fill("x"), reason: REASON }), ZodError);
    await refused(() => service.command(owner, run.id, { program: "node", args: ["x".repeat(1001)], reason: REASON }), ZodError);
    await refused(() => service.command(owner, run.id, { program: "", args: [], reason: REASON }), ZodError);
  });

  it("refuses a secret in an argument, the reason or the program", async () => {
    await refused(() => service.command(owner, run.id, { program: "node", args: ["-e", "'sk-ant-TESTKEY-0000000000'"], reason: REASON }), SecretInTextError);
    await refused(() => service.command(owner, run.id, { program: "node", args: [KEY], reason: REASON }), SecretInTextError);
    await refused(() => service.command(owner, run.id, { ...node("1"), reason: `because ${KEY} leaked` }), SecretInTextError);
    await refused(() => service.command(owner, run.id, { program: `/bin/${KEY}`, args: [], reason: REASON }), SecretInTextError);
  });

  it("refuses programs inside the working copy or the data folder, relative paths and batch files", async () => {
    const inside = join(wt, "tool");
    writeFileSync(inside, "#!/bin/sh\n");
    chmodSync(inside, 0o755);
    const data = join(dataDir, "tool");
    writeFileSync(data, "#!/bin/sh\n");
    chmodSync(data, 0o755);
    await refused(() => service.command(owner, run.id, { program: "./node_modules/.bin/x", args: [], reason: REASON }), ProgramNotAllowedError);
    await refused(() => service.command(owner, run.id, { program: inside, args: [], reason: REASON }), ProgramNotAllowedError);
    await refused(() => service.command(owner, run.id, { program: data, args: [], reason: REASON }), ProgramNotAllowedError);
    for (const name of ["x.cmd", "Y.BAT"]) {
      const batch = join(outside, name);
      writeFileSync(batch, "");
      const s = new OverrideService(depsWith({ which: () => batch }));
      await refused(() => s.command(owner, run.id, { program: "x", args: [], reason: REASON }), ProgramNotAllowedError);
    }
    // A PATH entry that resolves into the working copy is refused too.
    const s = new OverrideService(depsWith({ which: () => inside }));
    await refused(() => s.command(owner, run.id, { program: "tool", args: [], reason: REASON }), ProgramNotAllowedError);
  });

  it.runIf(posix)("refuses a PATH entry outside that is a symlink into the working copy", async () => {
    const inside = join(wt, "tool");
    writeFileSync(inside, "#!/bin/sh\n");
    chmodSync(inside, 0o755);
    const link = join(outside, "tool");
    symlinkSync(inside, link);
    const s = new OverrideService(depsWith({ which: () => link }));
    await refused(() => s.command(owner, run.id, { program: "tool", args: [], reason: REASON }), ProgramNotAllowedError);
    await refused(() => s.command(owner, run.id, { program: link, args: [], reason: REASON }), ProgramNotAllowedError);
  });

  it.runIf(posix)("refuses a folder that is a symlink to a .git folder, and records a symlinked folder by its real path", async () => {
    mkdirSync(join(wt, "inner", ".git"), { recursive: true });
    symlinkSync(join(wt, "inner", ".git"), join(wt, "link"));
    await refused(() => service.command(owner, run.id, node("1", { cwd: "link" })), NotFoundError);
    mkdirSync(join(wt, "sub"));
    symlinkSync(join(wt, "sub"), join(wt, "alias"));
    const { overrideId } = await service.command(owner, run.id, node("1", { cwd: "alias" }));
    await completion(overrideId);
    expect(entries("override.command")[0]!.payload).toMatchObject({ cwd: "sub" });
  });

  it("refuses a stopped run whose agent has not returned yet", async () => {
    let release!: () => void;
    const returned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: AgentAdapter = {
      id: "fake",
      start: async () => {
        await returned; // ignores the abort until released
        return { status: "completed" };
      },
    };
    const live = new AgentRunner({
      db, ledger, worktrees, broker: new ApprovalBroker(), dataDir, extraSecrets: () => [KEY], username: "someuser", adapters: { fake: slow },
    });
    try {
      const r = await live.start(owner, { projectId: run.projectId, adapter: "fake", prompt: "slow" });
      live.stop(owner, r.id);
      expect(getRun(db, r.id)!.status).toBe("stopped");
      const s = new OverrideService(depsWith({ settling: (id) => live.settling(id) }));
      const head = ledger.headSeq();
      await expect(s.command(owner, r.id, node("1"))).rejects.toThrow(new RunActiveError("an agent is still working in this run"));
      await expect(s.discard(owner, r.id, REASON)).rejects.toBeInstanceOf(RunActiveError);
      expect(ledger.headSeq()).toBe(head);
      release();
      await vi.waitFor(() => expect(live.settling(r.id)).toBe(false));
      const { overrideId } = await s.command(owner, r.id, node("1"));
      expect(await completion(overrideId)).toMatchObject({ ok: true });
    } finally {
      release();
      await live.shutdown();
    }
  });

  it.runIf(posix)("completes soon after the program exits even when an escaped child keeps its output open", async () => {
    const code =
      "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'});console.log(c.pid);c.unref()";
    const started = Date.now();
    const { overrideId } = await service.command(owner, run.id, node(code));
    const done = await completion(overrideId, 8000);
    const pid = Number(done.output.trim());
    try {
      expect(Date.now() - started).toBeLessThan(8000);
      expect(done).toMatchObject({ ok: true, exitCode: 0 });
      expect(service.active(run.id)).toBe(false);
    } finally {
      if (pid > 0) process.kill(pid, "SIGKILL");
    }
  }, 15_000);

  it.runIf(posix)("completes at the timeout even when an escaped child keeps its output open", async () => {
    service = new OverrideService(depsWith({ timeoutMs: 500 }));
    const code =
      "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)";
    const { overrideId } = await service.command(owner, run.id, node(code));
    const done = await completion(overrideId, 5000);
    const pid = Number(done.output.trim());
    try {
      expect(done).toMatchObject({ ok: false, timedOut: true, signal: "SIGKILL" });
      expect(service.active(run.id)).toBe(false);
    } finally {
      if (pid > 0) process.kill(pid, "SIGKILL");
    }
  }, 15_000);

  it("refuses a program that is not on PATH or does not exist", async () => {
    await refused(() => service.command(owner, run.id, { program: "nope-not-here", args: [], reason: REASON }), ProgramNotFoundError);
    await refused(() => service.command(owner, run.id, { program: "bad name", args: [], reason: REASON }), ProgramNotFoundError);
    await refused(() => service.command(owner, run.id, { program: join(outside, "missing"), args: [], reason: REASON }), ProgramNotFoundError);
  });

  it("refuses a second override while one runs, and anyone but a human", async () => {
    const first = await service.command(owner, run.id, node("setTimeout(()=>{},5000)"));
    expect(service.active(run.id)).toBe(true);
    const head = ledger.headSeq();
    await expect(service.command(owner, run.id, node("1"))).rejects.toBeInstanceOf(OverrideBusyError);
    await expect(service.discard(owner, run.id, REASON)).rejects.toBeInstanceOf(OverrideBusyError);
    expect(ledger.headSeq()).toBe(head);
    await service.shutdown();
    expect(await completion(first.overrideId)).toMatchObject({ ok: false, signal: "SIGKILL" });
    service = new OverrideService(depsWith());
    await refused(() => service.command({ kind: "system", id: "runner" }, run.id, node("1")), HumanRequiredError);
    await refused(() => service.command({ kind: "agent", id: "fake" }, run.id, node("1")), HumanRequiredError);
    await refused(() => service.discard({ kind: "system", id: "runner" }, run.id, REASON), HumanRequiredError);
    await refused(() => service.command(owner, "no-such-run", node("1")), NotFoundError);
  });

  it.runIf(posix)("records a program that cannot start as a failed override", async () => {
    const fake = join(outside, "not-executable");
    writeFileSync(fake, "plain text");
    chmodSync(fake, 0o644);
    const { overrideId } = await service.command(owner, run.id, { program: fake, args: [], reason: REASON });
    const done = await completion(overrideId);
    expect(done).toMatchObject({ ok: false, exitCode: null });
    expect(done.output).not.toContain(outside);
  });
});

describe("shutdown", () => {
  it("waits for a discard's git call to finish and records its real outcome", async () => {
    const exec = promisify(execFile);
    const slowGit: GitRunner = async (args, cwd, opts) => {
      if (args.includes("reset")) await new Promise((r) => setTimeout(r, 5500)); // longer than the 5 s wait for commands
      return (await exec("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
    };
    service = new OverrideService(depsWith({ worktrees: new WorktreeManager(dataDir, slowGit) }));
    writeFileSync(join(wt, "u.txt"), "x");
    const discarding = service.discard(owner, run.id, REASON);
    await vi.waitFor(() => expect(entries("override.discard")).toHaveLength(1), { timeout: 5000 });
    await service.shutdown();
    const { overrideId } = await discarding;
    expect(completedFor(overrideId)!.payload).toMatchObject({ ok: true, exitCode: 0 });
    expect(existsSync(join(wt, "u.txt"))).toBe(false);
  }, 20_000);

  it("kills a long command and records it completed with SIGKILL", async () => {
    const { overrideId } = await service.command(owner, run.id, node("setInterval(()=>{},1000)"));
    await service.shutdown();
    expect(completedFor(overrideId)!.payload).toMatchObject({ ok: false, signal: "SIGKILL", timedOut: false });
    expect(service.active(run.id)).toBe(false);
  });
});

describe("discard", () => {
  const git = (args: string[]) => worktrees.runGit(wt, args);

  it("drops uncommitted and staged work, counts only those files, and keeps the agent's commits", async () => {
    writeFileSync(join(wt, "kept.txt"), "committed\n");
    await git(["add", "-A"]);
    await git(["commit", "--no-verify", "-m", "agent work"]);
    writeFileSync(join(wt, "kept.txt"), "changed\n");
    await git(["add", "kept.txt"]);
    mkdirSync(join(wt, "new"));
    writeFileSync(join(wt, "new", "untracked.txt"), "x\n");

    const result = await service.discard(owner, run.id, `  ${REASON}  `);
    expect(result.files).toBe(2);
    const [d] = entries("override.discard");
    expect(d!.payload).toEqual({ overrideId: result.overrideId, runId: run.id, reason: REASON, files: 2 });
    const done = completedFor(result.overrideId)!;
    expect(done.seq).toBeGreaterThan(d!.seq);
    expect(done.payload).toMatchObject({ ok: true, exitCode: 0, signal: null, timedOut: false });
    expect(readFileSync(join(wt, "kept.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(wt, "new"))).toBe(false);
    const changes = await listChanges(depsWith(), run.id);
    expect(changes.files.map((f) => f.path)).toEqual(["kept.txt"]);
    expect(service.active(run.id)).toBe(false);
  });

  it("records a discard with nothing to drop as zero files", async () => {
    const result = await service.discard(owner, run.id, REASON);
    expect(result.files).toBe(0);
    expect(completedFor(result.overrideId)!.payload).toMatchObject({ ok: true });
  });

  it("counts a rename on the working-tree side once (final review, Minor 4)", async () => {
    writeFileSync(join(wt, "a.txt"), "content\n");
    await git(["add", "-A"]);
    await git(["commit", "--no-verify", "-m", "agent work"]);
    renameSync(join(wt, "a.txt"), join(wt, "b.txt"));
    await git(["add", "-N", "b.txt"]); // porcelain v1 shows ` R a.txt -> b.txt`: one entry with an extra field
    const result = await service.discard(owner, run.id, REASON);
    expect(result.files).toBe(1);
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(existsSync(join(wt, "b.txt"))).toBe(false);
  });

  it.runIf(posix)("never recurses into a planted submodule, so its filter driver never runs; plain git does (final review, Important 1)", async () => {
    const trap = await plantSubmoduleTrap(wt, outside);
    writeFileSync(join(wt, "scratch.txt"), "x\n");
    const result = await service.discard(owner, run.id, REASON);
    expect(completedFor(result.overrideId)!.payload).toMatchObject({ ok: true });
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
    expect(trap.ran()).toBe(false);
    expect(existsSync(trap.inner)).toBe(false); // nothing was restored inside the submodule
    // Control: the same repository under plain git recurses and runs the driver.
    await plainGit(wt, "reset", "--hard", "HEAD");
    expect(trap.ran()).toBe(true);
  });

  it("refuses a short reason or a secret in it", async () => {
    await refused(() => service.discard(owner, run.id, "short"), ZodError);
    await refused(() => service.discard(owner, run.id, `drop it, ${KEY}`), SecretInTextError);
  });
});

describe("recoverOnStartup", () => {
  it("closes an override left without a completion, once", () => {
    for (const type of ["override.command", "override.discard"] as const) {
      commitEvent(db, ledger, () => ({
        event: {
          projectId: run.projectId, actor: owner, type,
          payload: type === "override.command"
            ? { overrideId: "o-cmd", runId: run.id, program: "node", args: [], cwd: ".", reason: REASON }
            : { overrideId: "o-disc", runId: run.id, reason: REASON, files: 1 },
        },
        result: () => undefined,
      }));
    }
    service.recoverOnStartup();
    for (const id of ["o-cmd", "o-disc"]) {
      expect(completedFor(id)!.payload).toEqual({
        overrideId: id, runId: run.id, ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, output: "workspace restarted",
      });
      expect(completedFor(id)!.projectId).toBe(run.projectId);
    }
    const head = ledger.headSeq();
    service.recoverOnStartup();
    expect(ledger.headSeq()).toBe(head);
  });
});
