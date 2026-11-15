import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterStartOptions, GateResult, ProposedAction } from "../../src/agents/adapter.js";
import { spawn as nodeSpawn } from "node:child_process";
import { CHILD_ENV_ALLOWLIST, WIN32_ALLOWLIST, fakeAgentEnv } from "../../src/agents/child-env.js";
import { CODEX_COMMAND_EXCLUDES, CodexAdapter, codexApprovalToAction } from "../../src/agents/codex/adapter.js";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { classify } from "../../src/agents/policy.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { BoardService } from "../../src/board/board-service.js";
import { openDatabase } from "../../src/db.js";
import { getRun, listActions, listPendingActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { redact } from "../../src/agents/redact.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { CodexAdapter as IndexCodexAdapter, codexApprovalToAction as indexCodexApprovalToAction } from "../../src/index.js";

// A stored secret no pattern matches, and the clean() a runner would pass with it in its live secrets.
const STORED = "stored-conn-value-0123456789";
const liveClean = (t: string) => redact(t, [STORED]);
/** Fails when any 6-character stretch of `secret` is in `text`. */
function expectNoFragment(text: string, secret: string): void {
  for (let i = 0; i + 6 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 6));
}
const FAKE = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const FAKE_KEY = "sk-TESTKEY0123456789abcdef";
const CMD = "item/commandExecution/requestApproval";
const FILE = "item/fileChange/requestApproval";
const CWD = join("tmp", "worktree");

describe("codexApprovalToAction", () => {
  it("maps a command approval to a shell action", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", command: "ls -la", cwd: "/w/sub" }, "/w", redact);
    expect(a).toEqual({
      tool: "codex.command", kind: "shell", summary: "Run: ls -la", input: { command: "ls -la", cwd: "/w/sub" }, paths: ["/w/sub"],
    });
  });

  it("passes the whole command in the summary (the runner caps after redacting) and has no paths without a cwd", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", command: "x".repeat(400) }, CWD, redact);
    expect(a.summary).toBe(`Run: ${"x".repeat(400)}`);
    expect(a.input).toEqual({ command: "x".repeat(400) });
    expect(a.paths).toEqual([]);
  });

  it("maps a file change to file_write or file_edit by change kind, with every changed path", () => {
    const add = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, redact, [{ path: "a.txt", kind: { type: "add" }, diff: "+hi" }]);
    expect(add).toMatchObject({ tool: "codex.fileChange", kind: "file_write", summary: "Create a.txt", paths: ["a.txt"] });
    expect(add.input).toEqual({ changes: [{ path: "a.txt", kind: "add", diff: "+hi" }] });

    const edit = codexApprovalToAction(FILE, { itemId: "f2" }, CWD, redact, [
      { path: "a.ts", kind: { type: "update", move_path: null }, diff: "" },
      { path: "b.ts", kind: { type: "update", move_path: null }, diff: "" },
      { path: "c.ts", kind: { type: "update", move_path: null }, diff: "" },
    ]);
    expect(edit).toMatchObject({ kind: "file_edit", summary: "Edit a.ts (+2 more)", paths: ["a.ts", "b.ts", "c.ts"] });

    const del = codexApprovalToAction(FILE, { itemId: "f3" }, CWD, redact, [{ path: "old.txt", kind: { type: "delete" }, diff: "" }]);
    expect(del).toMatchObject({ kind: "file_write", summary: "Delete old.txt", paths: ["old.txt"] });
  });

  it("treats a move as a write to both paths", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, redact, [{ path: "a.ts", kind: { type: "update", move_path: "../b.ts" }, diff: "" }]);
    expect(a).toMatchObject({ kind: "file_write", paths: ["a.ts", "../b.ts"] });
  });

  it("caps each diff preview at 4000 characters, cleaned before the cut", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, redact, [{ path: "a.ts", kind: { type: "add" }, diff: "d".repeat(9000) }]);
    expect((a.input as { changes: { diff: string }[] }).changes[0]!.diff).toHaveLength(4000);
    const diff = `${"d".repeat(3990)}${STORED}${"d".repeat(100)}`;
    const b = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, liveClean, [{ path: "a.ts", kind: { type: "add" }, diff }]);
    const shown = (b.input as { changes: { diff: string }[] }).changes[0]!.diff;
    expect(shown).toBe(`${"d".repeat(3990)}[REDACTED]`);
  });

  it("cleans a stdin approval's command and input with the run's live secrets before capping them", () => {
    const a = codexApprovalToAction(
      CMD, { itemId: "s1", kind: "writeStdin", command: `${"c".repeat(55)}${STORED}`, reason: `${"b".repeat(75)}${STORED}` }, CWD, liveClean,
    );
    expect(a.summary).toBe(`Type into ${"c".repeat(55)}[REDA: ${"b".repeat(75)}[REDA`);
    expect(a.summary).not.toContain(STORED.slice(0, 3));
  });

  it("adds a requested grant root to the paths so policy judges it", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1", grantRoot: "/elsewhere" }, CWD, redact, [{ path: "a.ts", kind: { type: "add" }, diff: "" }]);
    expect(a.paths).toEqual(["a.ts", "/elsewhere"]);
  });

  it("asks a human when the changed files are unknown", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, redact);
    expect(a).toMatchObject({ kind: "file_write", summary: "Edit (unknown files)", paths: [] });
  });

  it("summarises absolute paths inside the worktree relative to it", () => {
    const root = join(process.cwd(), CWD);
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, root, redact, [{ path: join(root, "src", "a.ts"), kind: { type: "add" }, diff: "" }]);
    expect(a.summary).toBe("Create src/a.ts");
  });

  it("maps a network approval to a web action, never to the command it belongs to", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", command: null, cwd: null, networkApprovalContext: { host: "example.com", protocol: "https" } }, CWD, redact);
    expect(a).toEqual({
      tool: "codex.network", kind: "web", summary: "Network access to example.com (https)",
      input: { host: "example.com", protocol: "https" }, paths: [],
    });
  });

  it("records the request's reason for a plain command", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", kind: "command", command: "ls", reason: "list the files" }, CWD, redact);
    expect(a.input).toEqual({ command: "ls", reason: "list the files" });
  });

  it("maps a stdin approval to sending input to the running command, never to running it", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", kind: "writeStdin", command: "python3 repl.py", cwd: "/w", reason: "y\n" }, "/w", redact);
    expect(a).toEqual({
      tool: "codex.stdin", kind: "shell", summary: "Type into python3 repl.py: y\\n",
      input: { command: "python3 repl.py", cwd: "/w", kind: "writeStdin", reason: "y\n" }, paths: ["/w"],
    });
    const long = codexApprovalToAction(CMD, { itemId: "i1", kind: "writeStdin", command: "x".repeat(400), reason: "q".repeat(400) }, CWD, redact);
    expect(long.summary).toBe(`Type into ${"x".repeat(60)}: ${"q".repeat(80)}`);
  });

  it("shows the typed input of a stdin approval with control characters made visible", () => {
    const a = codexApprovalToAction(CMD, { itemId: "s1", kind: "writeStdin", command: "bash", cwd: "/w", reason: "rm -rf /\n" }, "/w", redact);
    expect(a.summary).toBe("Type into bash: rm -rf /\\n");
    const ctl = codexApprovalToAction(CMD, { itemId: "s1", kind: "writeStdin", command: "bash", reason: "\u0003\t\r" }, CWD, redact);
    expect(ctl.summary).toBe("Type into bash: \\u0003\\t\\r");
    // Redacted before it is cut: a token that straddles the cut leaves no fragment behind.
    const key = "sk-ant-TESTKEY-0000000000";
    const cut = codexApprovalToAction(CMD, { itemId: "s1", kind: "writeStdin", command: "bash", reason: `${"a".repeat(70)}${key}` }, CWD, redact);
    expect(cut.summary).toBe(`Type into bash: ${"a".repeat(70)}[REDACTED]`);
    const none = codexApprovalToAction(CMD, { itemId: "s1", kind: "writeStdin", reason: "q" }, CWD, redact);
    expect(none.summary).toBe("Type into (no command): q");
  });

  it.each([["a string", "registry.example.com"], ["an array", ["x"]], ["a number", 1]])(
    "treats a malformed network context (%s) as a network request",
    (_label, ctx) => {
      const a = codexApprovalToAction(CMD, { itemId: "i1", command: "npm install", networkApprovalContext: ctx }, CWD, redact);
      expect(a).toEqual({
        tool: "codex.network", kind: "web", summary: "Network access to (unknown host) (unknown)", input: { host: "", protocol: "" }, paths: [],
      });
    },
  );

  it("maps any other request to an other action", () => {
    expect(codexApprovalToAction("item/tool/call", { a: 1 }, CWD, redact)).toEqual({
      tool: "codex.item/tool/call", kind: "other", summary: "Unsupported Codex request: item/tool/call",
      input: { method: "item/tool/call", params: { a: 1 } }, paths: [],
    });
  });

  it("is exported from the package index", () => {
    expect(IndexCodexAdapter).toBe(CodexAdapter);
    expect(indexCodexApprovalToAction).toBe(codexApprovalToAction);
  });
});

type LogEntry = Record<string, any>;

describe("CodexAdapter (fake app-server)", () => {
  let dir: string;
  let logFile: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-adapter-")));
    logFile = join(dir, "fake.log");
    vi.stubEnv("THETERMINAL_FAKE_LOG", logFile);
    vi.stubEnv("THETERMINAL_FAKE_AGENT", "1"); // lets the fixture CLI receive its THETERMINAL_FAKE_* script variables
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** For tests that build the adapter before script(): filled in by script(), still a fixed object per adapter. */
  const lateFake: NodeJS.ProcessEnv = {};
  const script = (s: unknown) => {
    vi.stubEnv("THETERMINAL_FAKE_CODEX_SCRIPT", JSON.stringify(s));
    Object.assign(lateFake, fakeAgentEnv());
  };
  const fakeLog = (): LogEntry[] =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const received = (method: string) => fakeLog().filter((e) => e.received === method);
  const answers = (method: string) => fakeLog().filter((e) => e.answered === method);
  const make = (opts: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) =>
    new CodexAdapter({ dataDir: dir, command: { file: process.execPath, args: [FAKE] }, apiKey: () => FAKE_KEY, fakeEnv: fakeAgentEnv(), ...opts });

  function run(
    adapter: CodexAdapter,
    decide: (a: ProposedAction) => GateResult | Promise<GateResult> = () => ({ decision: "allow", reason: "ok" }),
    o: Partial<AdapterStartOptions> = {},
  ) {
    const proposed: ProposedAction[] = [];
    const denied: [ProposedAction, string][] = [];
    const events: AdapterEvent[] = [];
    const usage: AdapterEvent[] = []; // kept apart: the fake reports token totals at the end of every turn
    let n = 0;
    const result = adapter.start({
      cwd: dir,
      projectId: "p1",
      prompt: "do the thing",
      authMode: "chatgpt",
      signal: new AbortController().signal,
      gate: async (a) => {
        proposed.push(a);
        const id = `act-${++n}`;
        return { ...(await decide(a)), actionId: id };
      },
      emit: (e) => (e.type === "usage" ? usage : events).push(e),
      recordDenied: async (a, reason) => {
        denied.push([a, reason]);
      },
      clean: (t) => t,
      credentials: { env: {}, mcpServers: [] },
      ...o,
    });
    return { result, proposed, denied, events, usage };
  }

  it("runs a command the gate allows (announced before its approval), answers accept and reports its result", async () => {
    script([{ approve: "command", command: "ls", itemId: "i1", output: "a.txt\n" }, { message: "All done." }]);
    const { result, proposed, events } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(proposed).toEqual([
      // The approval carries no cwd here; the one announced in item/started fills it in.
      { tool: "codex.command", kind: "shell", summary: "Run: ls", input: { command: "ls", cwd: dir }, paths: [dir] },
    ]);
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }]);
    expect(events).toEqual([
      { type: "action_result", actionId: "act-1", ok: true, output: "a.txt\n" },
      { type: "message", text: "All done." },
    ]);
    // The handshake: initialize, initialized, a login check, the MCP inventory, the strict thread, its MCP
    // re-check, and the prompt.
    const order = fakeLog().filter((e) => e.received).map((e) => e.received);
    expect(order.slice(0, 7)).toEqual([
      "initialize", "initialized", "account/read", "mcpServerStatus/list", "thread/start", "mcpServerStatus/list", "turn/start",
    ]);
    expect(received("initialize")[0].params.clientInfo).toMatchObject({ name: "theterminal" });
    expect(received("turn/start")[0].params).toMatchObject({
      threadId: "thread-1", input: [{ type: "text", text: "do the thing", text_elements: [] }],
    });
    expect(fakeLog().find((e) => e.start).cwd).toBe(dir);
    expect(fakeLog().find((e) => e.start).argv).toEqual(["app-server"]);
  });

  it("reports a failed command as a failed result", async () => {
    script([{ approve: "command", command: "false", itemId: "i1", output: "boom", exitCode: 1 }]);
    const { result, events } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(events).toEqual([{ type: "action_result", actionId: "act-1", ok: false, output: "boom" }]);
  });

  it("passes a result's whole output on (the runner caps it after redacting)", async () => {
    script([{ approve: "command", command: "yes", itemId: "i1", output: "y".repeat(10_000) }]);
    const { result, events } = run(make());
    await result;
    expect((events[0] as { output: string }).output).toHaveLength(10_000);
  });

  it("answers decline for a denied command and reports no result", async () => {
    script([{ approve: "command", command: "rm -rf build", itemId: "i1" }]);
    const { result, events } = run(make(), () => ({ decision: "deny", reason: "no" }));
    expect(await result).toEqual({ status: "completed" });
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "decline" }]);
    expect(events).toEqual([]);
  });

  it("declines a file change outside the worktree through the policy", async () => {
    const wt = new WorktreeManager(dir);
    const outside = join(dir, "..", "escape.txt");
    script([
      { approve: "fileChange", itemId: "f1", changes: [{ path: outside, kind: "add", diff: "+x" }] },
      { approve: "fileChange", itemId: "f2", changes: [{ path: join(dir, "inside.txt"), kind: "update", diff: "-a\n+b" }] },
    ]);
    const { result, proposed, events } = run(make(), (a) => {
      const v = classify(a, dir, wt);
      return { decision: v.verdict === "auto_deny" ? "deny" : "allow", reason: v.reason };
    });
    expect(await result).toEqual({ status: "completed" });
    expect(proposed.map((a) => [a.kind, a.paths])).toEqual([
      ["file_write", [outside]],
      ["file_edit", [join(dir, "inside.txt")]],
    ]);
    expect(answers(FILE).map((e) => e.result)).toEqual([{ decision: "decline" }, { decision: "accept" }]);
    expect(events).toEqual([{ type: "action_result", actionId: "act-2", ok: true, output: "completed: inside.txt" }]);
  });

  it("records an unknown server-request as denied without asking anyone, and answers it with an error", async () => {
    script([{ unknownRequest: "item/tool/requestUserInput" }, { message: "ok" }]);
    const { result, proposed, denied } = run(make(), () => new Promise<GateResult>(() => {}));
    expect(await result).toEqual({ status: "completed" });
    expect(proposed).toEqual([]);
    expect(denied).toEqual([[
      {
        kind: "other", tool: "codex.item/tool/requestUserInput", summary: "Unsupported Codex request: item/tool/requestUserInput",
        input: { method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "u1" } }, paths: [],
      },
      "unsupported request item/tool/requestUserInput",
    ]]);
    expect(answers("item/tool/requestUserInput")).toEqual([
      { answered: "item/tool/requestUserInput", error: { code: -32000, message: "denied" } },
    ]);
  });

  it("starts the thread with the strict approval policy, the user as reviewer and a networkless workspace sandbox", async () => {
    script([]);
    const { result } = run(make());
    expect(await result).toEqual({ status: "completed" });
    const p = received("thread/start")[0].params;
    expect(p).toMatchObject({
      cwd: dir, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write", ephemeral: true,
    });
    expect(p.config).toMatchObject({
      web_search: "disabled",
      "sandbox_workspace_write.network_access": false,
      "sandbox_workspace_write.exclude_slash_tmp": true,
      "sandbox_workspace_write.exclude_tmpdir_env_var": true,
      "features.view_image": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
    });
  });

  it("always declines network access during an accepted command, recording it as denied without asking anyone", async () => {
    script([{ approve: "command", command: "npm install", itemId: "i1", output: "installed", network: { host: "registry.example.com", protocol: "https" } }]);
    // Even a gate that allows everything is never asked: accepting could re-run the command outside the sandbox.
    const { result, proposed, denied, events } = run(make(), () => ({ decision: "allow", reason: "r" }));
    expect(await result).toEqual({ status: "completed" });
    expect(proposed.map((a) => [a.kind, a.summary])).toEqual([["shell", "Run: npm install"]]);
    expect(denied).toEqual([[
      {
        kind: "web", tool: "codex.network", summary: "Network access to registry.example.com (https)",
        input: { host: "registry.example.com", protocol: "https" }, paths: [],
      },
      "network access is not supported in Codex runs",
    ]]);
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }, { decision: "decline" }]);
    // The command's result still belongs to the command's action.
    expect(events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: "installed" }]);
  });

  it("asks before sending input to a running command, labelled as input, and keeps the command's result on the command", async () => {
    script([{ approve: "command", command: "python3 repl.py", itemId: "i1", output: "done", stdin: "y\n" }]);
    const { result, proposed, events } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(proposed).toEqual([
      { tool: "codex.command", kind: "shell", summary: "Run: python3 repl.py", input: { command: "python3 repl.py", cwd: dir }, paths: [dir] },
      {
        tool: "codex.stdin", kind: "shell", summary: "Type into python3 repl.py: y\\n",
        input: { command: "python3 repl.py", cwd: dir, kind: "writeStdin", reason: "y\n" }, paths: [dir],
      },
    ]);
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }, { decision: "accept" }]);
    expect(events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: "done" }]);
  });

  it("declines denied input to a running command without failing the run", async () => {
    script([{ approve: "command", command: "python3 repl.py", itemId: "i1", output: "done", stdin: "rm -rf /\n" }]);
    const { result, proposed, events } = run(make(), (a) => ({ decision: a.tool === "codex.stdin" ? "deny" : "allow", reason: "r" }));
    expect(await result).toEqual({ status: "completed" });
    expect(proposed[1]).toMatchObject({ tool: "codex.stdin", summary: "Type into python3 repl.py: rm -rf /\\n" });
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }, { decision: "decline" }]);
    expect(events).toEqual([{ type: "action_result", actionId: "act-1", ok: true, output: "done" }]);
  });

  it("always declines a malformed network context without asking anyone", async () => {
    script([{ approve: "command", command: "npm install", itemId: "i1", output: "installed", network: "registry.example.com" }]);
    const { result, proposed, denied } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(proposed.map((a) => a.tool)).toEqual(["codex.command"]);
    expect(denied).toMatchObject([[{ tool: "codex.network", kind: "web" }, "network access is not supported in Codex runs"]]);
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }, { decision: "decline" }]);
  });

  it("ignores a completed turn other than the one announced by turn/started", async () => {
    script({ strayTurnCompleted: "turn-0", steps: [{ message: "All done." }] });
    const { result, events } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(events).toEqual([{ type: "message", text: "All done." }]);
  });

  it("uses the command announced in item/started when the approval omits it", async () => {
    script([{ approve: "command", command: "make test", cwd: dir, itemId: "i1", nullCommand: true }]);
    const { result, proposed } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(proposed).toMatchObject([{ kind: "shell", summary: "Run: make test", input: { command: "make test", cwd: dir }, paths: [dir] }]);
  });

  it("does not trip on a command that was announced and then declined", async () => {
    script([{ approve: "command", command: "ls", itemId: "i1" }, { message: "ok" }]);
    const { result } = run(make(), () => ({ decision: "deny", reason: "no" }));
    expect(await result).toEqual({ status: "completed" });
  });

  it.each([
    ["a weaker policy", { threadStartPolicy: "on-request" }],
    ["a rejected thread/start", { threadStartError: "unknown variant `untrusted`" }],
  ])("refuses to start when the CLI answers with %s", async (_label, cfg) => {
    script({ ...cfg, steps: [{ approve: "command", command: "ls", itemId: "i1" }] });
    const { result, proposed } = run(make());
    expect(await result).toEqual({ status: "failed", error: "Codex approval policy cannot gate every action" });
    expect(received("turn/start")).toEqual([]);
    expect(proposed).toEqual([]);
  });

  it("fails and records the action when a command that was never approved produces output", async () => {
    script([{ ungated: "commandExecution", command: "cat notes.txt", itemId: "u1" }, { hang: true }]);
    const { result, proposed, denied } = run(make());
    const r = await result;
    expect(r).toEqual({ status: "failed", error: "Codex ran commandExecution without approval" });
    expect(proposed).toEqual([]);
    expect(denied).toMatchObject([[{ kind: "other", tool: "codex.commandExecution" }, "ran without approval"]]);
  });

  it("fails when Codex uses a tool that cannot be gated", async () => {
    script([{ ungated: "mcpToolCall" }, { hang: true }]);
    const { result, denied } = run(make());
    expect((await result).error).toMatch(/mcpToolCall without approval/);
    expect(denied).toMatchObject([[{ kind: "other", tool: "codex.mcpToolCall" }, "ran without approval"]]);
  });

  it("fails the run with the turn's error", async () => {
    script([{ fail: "model overloaded" }]);
    const { result } = run(make());
    expect(await result).toEqual({ status: "failed", error: "model overloaded" });
  });

  it("fails when Codex exits mid-turn, with a short stderr tail", async () => {
    script([{ exit: 3, stderr: `${"noise ".repeat(200)}fatal: it broke` }]);
    const { result } = run(make());
    const r = await result;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/fatal: it broke$/);
    expect(r.error!.length).toBeLessThanOrEqual(300);
  });

  it("cleans stderr before its window is cut, so a stored key straddling the window leaves no fragment in the error", async () => {
    // The key straddles the 4096 characters the adapter keeps. What follows it cleans down to a few characters, so the
    // short tail the error shows would otherwise start with the key's second half.
    const after = `\nAuthorization: Bearer ${"t".repeat(4058)}`;
    script([{ exit: 3, stderr: `${"x".repeat(4086)}${STORED}${after}` }]);
    const { result } = run(make(), undefined, { clean: liveClean });
    const r = await result;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^Codex exited before the turn completed: .*Bearer \[REDACTED\]$/s);
    expectNoFragment(r.error!, STORED);
  });

  // A stored key, and keys only a built-in pattern finds (a fragment of which, cleaned on its own, matches too).
  const SPLIT_SECRETS = [STORED, "sk-ant-api03-TESTKEYabcdefghijklmnop", "ghp_TESTKEY0123456789abcdefghij"];
  const splitStderr = (secret: string, at: number) => [`warn: retry\nerror: token ${secret.slice(0, at)}`, `${secret.slice(at)} rejected\n`];

  it("holds an unfinished stderr line raw until it ends, so a key split across two chunks at any position leaves no fragment", async () => {
    const cases = SPLIT_SECRETS.flatMap((secret) => Array.from({ length: secret.length - 1 }, (_, i) => [secret, i + 1] as const));
    for (let i = 0; i < cases.length; i += 12) {
      await Promise.all(
        cases.slice(i, i + 12).map(async ([secret, at]) => {
          // Each run reads its own script: the adapter's fake env is fixed when it is made.
          const env = { ...fakeAgentEnv(), THETERMINAL_FAKE_CODEX_SCRIPT: JSON.stringify([{ exit: 3, stderr: splitStderr(secret, at) }]) };
          const { result } = run(make({ fakeEnv: env }), undefined, { clean: liveClean });
          const r = await result;
          expect(r.status).toBe("failed");
          expect(r.error, `${secret.slice(0, 4)} split at ${at}`).toMatch(/error: token \[REDACTED\] rejected$/);
          expectNoFragment(r.error!, secret);
        }),
      );
    }
  }, 60_000);

  it("through the runner: a key split across two stderr chunks leaves no fragment in agent.finished or anywhere in the ledger", async () => {
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const owner = { kind: "human", id: "owner" } as const;
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Codex" }).id;
    const runner = new AgentRunner({
      db, ledger, worktrees: new WorktreeManager(dir), broker: new ApprovalBroker(), adapters: { codex: make({ fakeEnv: lateFake }) },
      extraSecrets: () => [STORED], dataDir: dir,
    });
    try {
      for (const secret of SPLIT_SECRETS) {
        for (const at of [1, 6, Math.floor(secret.length / 2), secret.length - 1]) {
          script([{ exit: 3, stderr: splitStderr(secret, at) }]);
          const run = await runner.start(owner, { projectId, adapter: "codex", prompt: "go" });
          await vi.waitFor(() => expect(getRun(db, run.id)!.status).not.toBe("running"), { timeout: 10_000, interval: 50 });
          const finished = ledger.list().filter((e) => e.type === "agent.finished").at(-1)!;
          expect(JSON.stringify(finished.payload)).toContain("error: token [REDACTED] rejected");
          const all = JSON.stringify(ledger.list());
          for (let i = 0; i + 6 <= secret.length; i++) expect(all).not.toContain(secret.slice(i, i + 6));
        }
      }
    } finally {
      await runner.shutdown();
    }
  }, 60_000);

  it("through the runner: a stored secret across the old command and stdin caps leaves no fragment in the record", async () => {
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const owner = { kind: "human", id: "owner" } as const;
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Codex" }).id;
    const runner = new AgentRunner({
      db, ledger, worktrees: new WorktreeManager(dir), broker: new ApprovalBroker(), adapters: { codex: make({ fakeEnv: lateFake }) },
      extraSecrets: () => [STORED], dataDir: dir,
    });
    script([
      // Cut at 150 before: "echo " + 136 + " " leaves 8 characters of the secret. Denied by policy (it holds a secret).
      { approve: "command", command: `echo ${"a".repeat(136)} ${STORED}`, itemId: "i1" },
      // Cut at 80 before: 72 typed characters leave 8 of the secret. The command itself is clean, so a human allows it.
      { approve: "command", command: "cat", itemId: "i2", stdin: `${"b".repeat(72)}${STORED}` },
    ]);
    try {
      const run = await runner.start(owner, { projectId, adapter: "codex", prompt: "go" });
      await vi.waitFor(
        () => {
          for (const a of listPendingActions(db, projectId)) runner.decide(owner, a.id, "allow", "fine");
          expect(getRun(db, run.id)!.status).not.toBe("running");
        },
        { timeout: 10_000, interval: 50 },
      );
      const summaries = listActions(db, run.id).map((a) => a.summary);
      expect(summaries).toEqual([
        `Run: echo ${"a".repeat(136)} [REDACTED]`,
        "Run: cat",
        `Type into cat: ${"b".repeat(72)}[REDACTE`,
      ]);
      expect(JSON.stringify(ledger.list())).not.toContain(STORED.slice(0, 6));
    } finally {
      await runner.shutdown();
    }
  });

  it("emits the thread's token totals once, at turn completion", async () => {
    script([{ message: "hi" }]);
    const { result, events, usage } = run(make());
    await result;
    expect(usage).toEqual([{ type: "usage", inputTokens: 6, outputTokens: 4 }]);
    expect(events).toEqual([{ type: "message", text: "hi" }]);
  });

  it.each([
    ["exits on EOF", {}],
    ["ignores EOF and SIGTERM", { ignoreSigterm: true, ignoreEof: true }],
  ])("aborting mid-approval interrupts, kills Codex (which %s) promptly and never accepts", async (_label, cfg) => {
    script({ ...cfg, steps: [{ approve: "command", command: "ls", itemId: "i1" }] });
    const ac = new AbortController();
    let gateDenied = false;
    let gateAsked!: () => void;
    const asked = new Promise<void>((r) => (gateAsked = r));
    const { result } = run(
      make({ killGraceMs: 300 }),
      () =>
        new Promise<GateResult>((resolve) => {
          gateAsked();
          ac.signal.addEventListener("abort", () => {
            gateDenied = true;
            resolve({ decision: "deny", reason: "run stopped" });
          });
        }),
      { signal: ac.signal },
    );
    await asked;
    const pid: number = fakeLog().find((e) => e.start).pid;
    const t0 = Date.now();
    ac.abort();
    expect(await result).toEqual({ status: "failed", error: "run stopped" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(gateDenied).toBe(true);
    if ("ignoreSigterm" in cfg && process.platform !== "win32") expect(fakeLog().some((e) => e.signal === "SIGTERM")).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(received("turn/interrupt")).toHaveLength(1);
    expect(answers(CMD).every((e) => e.result?.decision !== "accept")).toBe(true);
  }, 10_000);

  it("returns stopped without spawning when already aborted", async () => {
    script([]);
    const ac = new AbortController();
    ac.abort();
    const { result } = run(make(), undefined, { signal: ac.signal });
    expect(await result).toEqual({ status: "failed", error: "run stopped" });
    expect(fakeLog()).toEqual([]);
  });

  it("the child env is exactly the allowlist plus what we set; the fake flag is read at construction", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-TESTSECRET");
    vi.stubEnv("NPM_TOKEN", "npm-TESTTOKEN");
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    vi.stubEnv("GITHUB_TOKEN", "gh-TESTTOKEN");
    script([]);
    const adapter = make({
      spawn: ((f: string, a: string[], o: { env: NodeJS.ProcessEnv }) => {
        seen.push(o.env);
        return nodeSpawn(f, a, o as never);
      }) as typeof nodeSpawn,
    });
    vi.stubEnv("THETERMINAL_FAKE_AGENT", ""); // unset after construction: the snapshot still carries the script
    const seen: NodeJS.ProcessEnv[] = [];
    const { result } = run(adapter, undefined, { authMode: "chatgpt" });
    expect(await result).toEqual({ status: "completed" });
    const keys = Object.keys(seen[0]!);
    for (const k of ["AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "NODE_OPTIONS", "GITHUB_TOKEN", "THETERMINAL_FAKE_AGENT"]) expect(keys).not.toContain(k);
    const allowed = new Set([
...CHILD_ENV_ALLOWLIST, ...(process.platform === "win32" ? WIN32_ALLOWLIST : []), "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "THETERMINAL_FAKE_CODEX_SCRIPT", "THETERMINAL_FAKE_LOG"]);
    const fold = (k: string) => (process.platform === "win32" ? k.toUpperCase() : k);
    const allowedFolded = new Set([...allowed].map(fold));
    expect(keys.filter((k) => !allowedFolded.has(fold(k)) && !fold(k).startsWith("LC_"))).toEqual([]);
    expect(keys).toContain("THETERMINAL_FAKE_CODEX_SCRIPT");
  });

  describe("auth modes", () => {
    beforeEach(() => {
      vi.stubEnv("OPENAI_API_KEY", "sk-INHERITED-TESTKEY");
      vi.stubEnv("CODEX_API_KEY", "sk-INHERITED-TESTKEY");
    });

    it("chatgpt mode passes no API key and no CODEX_HOME (the CLI's default home holds the login)", async () => {
      vi.stubEnv("CODEX_HOME", join(dir, "users-codex-home"));
      script([]);
      const { result } = run(make(), undefined, { authMode: "chatgpt" });
      expect(await result).toEqual({ status: "completed" });
      const start = fakeLog().find((e) => e.start);
      expect(start.env).toEqual({ OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_HOME: null });
      expect(start.argv).not.toContain("cli_auth_credentials_store=ephemeral");
      expect(received("account/login/start")).toEqual([]);
    });

    it("chatgpt mode refuses when Codex has exec-policy rules, without reading them", async () => {
      const home = join(dir, "home");
      mkdirSync(join(home, "rules"), { recursive: true });
      writeFileSync(join(home, "rules", "notes.txt"), "not a rules file");
      script({ codexHome: home, steps: [] });
      expect(await run(make()).result).toEqual({ status: "completed" });

      writeFileSync(join(home, "rules", "default.rules"), "prefix_rule(pattern=[\"ls\"], decision=\"allow\")");
      const { result } = run(make());
      expect(await result).toEqual({
        status: "failed",
        error: "Codex has 'always allow' rules that would bypass approvals; remove them from your Codex rules folder or use API-key mode",
      });
      expect(received("thread/start")).toHaveLength(1); // only the first run started a thread
    });

    it("chatgpt mode refuses when the worktree has project exec-policy rules", async () => {
      mkdirSync(join(dir, ".codex", "rules"), { recursive: true });
      writeFileSync(join(dir, ".codex", "rules", "project.rules"), "");
      script([]);
      const { result } = run(make());
      expect((await result).error).toMatch(/'always allow' rules/);
      expect(received("thread/start")).toEqual([]);
    });

    it("chatgpt mode disables every configured MCP server and checks they are disabled", async () => {
      script({ mcpServers: ["docs", "tracker"], steps: [] });
      const { result } = run(make());
      expect(await result).toEqual({ status: "completed" });
      expect(received("thread/start")[0].params.config).toMatchObject({
        "mcp_servers.docs.enabled": false, "mcp_servers.tracker.enabled": false,
      });
      expect(received("mcpServerStatus/list").map((e) => e.params)).toEqual([{}, { threadId: "thread-1" }]);
    });

    it("re-lists MCP servers after the thread starts, and refuses one only the thread sees", async () => {
      script({ mcpAddedByThread: ["project-server"], steps: [] });
      const { result } = run(make());
      expect(await result).toEqual({ status: "failed", error: "Codex MCP servers could not be disabled; remove them or use API-key mode" });
      expect(received("mcpServerStatus/list").map((e) => e.params)).toEqual([{}, { threadId: "thread-1" }]);
      expect(received("turn/start")).toEqual([]);
    });

    it("chatgpt mode refuses to start the turn when an MCP server stays enabled", async () => {
      script({ mcpServers: ["docs"], mcpIgnoresDisable: true, steps: [] });
      const { result } = run(make());
      expect(await result).toEqual({ status: "failed", error: "Codex MCP servers could not be disabled; remove them or use API-key mode" });
      expect(received("turn/start")).toEqual([]);
    });

    it("chatgpt mode fails when the CLI reports no login", async () => {
      script({ loggedOut: true, steps: [] });
      const { result } = run(make(), undefined, { authMode: "chatgpt" });
      expect(await result).toEqual({ status: "failed", error: "Codex is not logged in; run 'codex login' yourself" });
      expect(received("thread/start")).toEqual([]);
    });

    it("api_key mode passes exactly the configured key, an isolated CODEX_HOME, and logs in in memory only", async () => {
      vi.stubEnv("CODEX_HOME", join(dir, "users-codex-home"));
      script([]);
      const { result } = run(make(), undefined, { authMode: "api_key" });
      expect(await result).toEqual({ status: "completed" });
      const start = fakeLog().find((e) => e.start);
      const home = join(dir, "projects", "p1", "codex-home");
      expect(start.env).toEqual({ OPENAI_API_KEY: FAKE_KEY, CODEX_API_KEY: FAKE_KEY, CODEX_HOME: home });
      expect(existsSync(home)).toBe(true);
      expect(received("mcpServerStatus/list").map((e) => e.params)).toEqual([{}, { threadId: "thread-1" }]);
      expect(start.argv).toEqual(["app-server", "-c", "cli_auth_credentials_store=ephemeral"]);
      expect(received("account/login/start")[0].params).toEqual({ type: "apiKey", apiKey: FAKE_KEY });
    });

    it("api_key mode prefers the key the runner resolved from a connection over its own fallback", async () => {
      script([]);
      const connectionKey = "sk-TESTKEY-connection-0000000000";
      const fallback = vi.fn(() => FAKE_KEY);
      const { result } = run(make({ apiKey: fallback }), undefined, { authMode: "api_key", credentials: { apiKey: connectionKey, env: {}, mcpServers: [] } });
      expect(await result).toEqual({ status: "completed" });
      expect(fakeLog().find((e) => e.start).env).toMatchObject({ OPENAI_API_KEY: connectionKey, CODEX_API_KEY: connectionKey });
      expect(received("account/login/start")[0].params).toEqual({ type: "apiKey", apiKey: connectionKey });
      expect(fallback).not.toHaveBeenCalled();
    });

    it("chatgpt mode points CODEX_HOME at the connection's CLI home folder", async () => {
      const cliHome = join(dir, "connection-codex-home");
      script([]);
      const { result } = run(make(), undefined, { authMode: "chatgpt", credentials: { cliHome, env: {}, mcpServers: [] } });
      expect(await result).toEqual({ status: "completed" });
      expect(fakeLog().find((e) => e.start).env).toEqual({ OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_HOME: cliHome });
    });

    it.each(["api_key", "chatgpt"] as const)("%s mode: the run's cloud grant reaches Codex and, through its env policy, its commands", async (authMode) => {
      script([]);
      const envs: NodeJS.ProcessEnv[] = [];
      const spawn = ((file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        envs.push(opts.env);
        return nodeSpawn(file, args, opts as never);
      }) as unknown as typeof nodeSpawn;
      const credentials = { env: { AZURE_CLIENT_SECRET: "TESTKEY-azure-secret-0000000000" }, mcpServers: [] };
      const { result } = run(make({ spawn }), undefined, { authMode, credentials });
      expect(await result).toEqual({ status: "completed" });
      expect(envs[0]!.AZURE_CLIENT_SECRET).toBe("TESTKEY-azure-secret-0000000000");
      // Codex drops *KEY*, *SECRET* and *TOKEN* names from its commands' env by default: keep them, but never a provider key.
      const argv: string[] = fakeLog().find((e) => e.start).argv;
      expect(argv).toContain("shell_environment_policy.ignore_default_excludes=true");
      expect(argv).toContain(`shell_environment_policy.exclude=${JSON.stringify(CODEX_COMMAND_EXCLUDES)}`);
      expect(CODEX_COMMAND_EXCLUDES).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]));
    });

    it("without a cloud grant leaves Codex's command env policy alone", async () => {
      script([]);
      const { result } = run(make(), undefined, { authMode: "chatgpt" });
      expect(await result).toEqual({ status: "completed" });
      expect(fakeLog().find((e) => e.start).argv).toEqual(["app-server"]);
    });

    it("api_key mode keeps a separate Codex home per project", async () => {
      script([]);
      await run(make(), undefined, { authMode: "api_key", projectId: "p2" }).result;
      expect(fakeLog().find((e) => e.start).env.CODEX_HOME).toBe(join(dir, "projects", "p2", "codex-home"));
    });

    it("api_key mode refuses a project id that is not a plain name", async () => {
      script([]);
      const { result } = run(make(), undefined, { authMode: "api_key", projectId: "../p1" });
      expect(await result).toEqual({ status: "failed", error: "Codex home folder could not be created" });
      expect(fakeLog()).toEqual([]);
    });

    it("api_key mode checks its own Codex home for rules too", async () => {
      const rules = join(dir, "projects", "p1", "codex-home", "rules");
      mkdirSync(rules, { recursive: true });
      writeFileSync(join(rules, "default.rules"), "");
      script([]);
      const { result } = run(make(), undefined, { authMode: "api_key" });
      expect((await result).error).toMatch(/'always allow' rules/);
      expect(received("thread/start")).toEqual([]);
    });

    it("api_key mode fails without a configured key", async () => {
      script([]);
      const { result } = run(make({ apiKey: () => undefined }), undefined, { authMode: "api_key" });
      expect(await result).toEqual({ status: "failed", error: "No OpenAI API key configured" });
      expect(fakeLog()).toEqual([]);
    });

    it("rejects an auth mode Codex does not offer", async () => {
      const { result } = run(make(), undefined, { authMode: "subscription" });
      expect(await result).toEqual({ status: "failed", error: "Unsupported auth mode for Codex: subscription" });
    });
  });

  describe("locating the CLI", () => {
    const NO_CLI = "Codex CLI is unavailable: its bundled program is missing and none is on PATH";
    const noBundled = () => null;
    /** Runs the fake server whatever program the adapter chose, recording what it asked for. */
    const recordingSpawn = async () => {
      const real = (await import("node:child_process")).spawn;
      return vi.fn((_file: string, args: string[], opts: object) => real(process.execPath, [FAKE, ...args.slice(args.indexOf("app-server"))], opts));
    };

    it("runs the bundled Codex by default and never looks on PATH", async () => {
      script([]);
      const spawn = await recordingSpawn();
      const bin = vi.fn(() => "/opt/codex/bin/codex");
      const native = { file: join(dir, "node_modules", "@openai", "codex-x", "vendor", "bin", "codex"), args: [] };
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: () => native, bin, spawn: spawn as never }));
      expect(await result).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(native.file, ["app-server"], expect.objectContaining({ shell: false }));
      expect(bin).not.toHaveBeenCalled();
    });

    it.each([
      ["win32", "x64"],
      ["linux", "x64"],
    ] as const)("on %s-%s with @openai/codex but no native package, falls back to PATH, never the JS launcher", async (platform, arch) => {
      script([]);
      const { bundledCodex } = await import("../../src/agents/bundled.js");
      const coreDir = join(dir, "core");
      const pkg = join(coreDir, "node_modules", "@openai", "codex");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
      writeFileSync(join(pkg, "bin", "codex.js"), "");
      const spawn = await recordingSpawn();
      const bin = vi.fn(() => "/opt/codex/bin/codex");
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: () => bundledCodex({ coreDir, platform, arch }), bin, spawn: spawn as never }));
      expect(await result).toEqual({ status: "completed" });
      expect(bin).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith("/opt/codex/bin/codex", ["app-server"], expect.anything());
    });

    it("uses the package's own bundled Codex when none is injected", async () => {
      script([]);
      const { bundledCodex } = await import("../../src/agents/bundled.js");
      const expected = bundledCodex()!;
      const spawn = await recordingSpawn();
      const bin = vi.fn(() => null);
      const { result } = run(new CodexAdapter({ dataDir: dir, bin, spawn: spawn as never }));
      expect(await result).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(expected.file, [...expected.args, "app-server"], expect.anything());
      expect(bin).not.toHaveBeenCalled();
    });

    it("consults PATH only when the bundled lookup returns null", async () => {
      script([]);
      const spawn = await recordingSpawn();
      const bundled = vi.fn(() => null);
      const bin = vi.fn(() => "/opt/codex/bin/codex");
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled, bin, spawn: spawn as never }));
      expect(await result).toEqual({ status: "completed" });
      expect(bundled).toHaveBeenCalledOnce();
      expect(bin).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith("/opt/codex/bin/codex", ["app-server"], expect.anything());
    });

    it("a test command wins over the bundled program", async () => {
      script([]);
      const bundled = vi.fn(() => null);
      const { result } = run(make({ bundled }));
      expect(await result).toEqual({ status: "completed" });
      expect(bundled).not.toHaveBeenCalled();
    });

    it("fails when there is no bundled Codex and none on PATH", async () => {
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: noBundled, bin: () => null }));
      expect(await result).toEqual({ status: "failed", error: NO_CLI });
    });

    it("fails when the binary cannot be started", async () => {
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: noBundled, bin: () => join(dir, "missing", "codex") }));
      expect(await result).toEqual({ status: "failed", error: NO_CLI });
    });

    it("runs the script behind an npm .cmd shim with node instead of a shell", async () => {
      script([]);
      const shim = join(dir, "npm", "codex.CMD");
      const target = join(dir, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      const real = (await import("node:child_process")).spawn;
      const spawn = vi.fn((_file: string, args: string[], opts: object) => real(process.execPath, [FAKE, ...args.slice(1)], opts));
      const exists = vi.fn((p: string) => p === target);
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: noBundled, bin: () => shim, spawn: spawn as never, exists }));
      expect(await result).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(process.execPath, [target, "app-server"], expect.objectContaining({ shell: false }));
    });

    it("refuses a .cmd shim with no npm package script behind it", async () => {
      const spawn = vi.fn();
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: noBundled, bin: () => join(dir, "codex.cmd"), spawn: spawn as never, exists: () => false }));
      expect(await result).toEqual({ status: "failed", error: "Codex CLI must be a native executable on Windows (found a .cmd shim)" });
      expect(spawn).not.toHaveBeenCalled();
    });

    it("spawns the located binary with app-server, piped stdio and no shell", async () => {
      script([]);
      const real = (await import("node:child_process")).spawn;
      const spawn = vi.fn((file: string, args: string[], opts: object) => real(process.execPath, [FAKE, ...args], opts));
      const { result } = run(new CodexAdapter({ dataDir: dir, bundled: noBundled, bin: () => "/opt/codex/bin/codex", spawn: spawn as never }));
      expect(await result).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(
        "/opt/codex/bin/codex", ["app-server"], expect.objectContaining({ cwd: dir, stdio: ["pipe", "pipe", "pipe"], shell: false }),
      );
    });
  });
});
