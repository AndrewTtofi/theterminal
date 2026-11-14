import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterStartOptions, GateResult, ProposedAction } from "../../src/agents/adapter.js";
import { CodexAdapter, codexApprovalToAction } from "../../src/agents/codex/adapter.js";
import { classify } from "../../src/agents/policy.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { CodexAdapter as IndexCodexAdapter, codexApprovalToAction as indexCodexApprovalToAction } from "../../src/index.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const FAKE_KEY = "sk-TESTKEY0123456789abcdef";
const CMD = "item/commandExecution/requestApproval";
const FILE = "item/fileChange/requestApproval";
const CWD = join("tmp", "worktree");

describe("codexApprovalToAction", () => {
  it("maps a command approval to a shell action", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", command: "ls -la", cwd: "/w/sub" }, "/w");
    expect(a).toEqual({
      tool: "codex.command", kind: "shell", summary: "Run: ls -la", input: { command: "ls -la", cwd: "/w/sub" }, paths: ["/w/sub"],
    });
  });

  it("caps the command in the summary at 150 characters and has no paths without a cwd", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", command: "x".repeat(400) }, CWD);
    expect(a.summary).toBe(`Run: ${"x".repeat(150)}`);
    expect(a.input).toEqual({ command: "x".repeat(400) });
    expect(a.paths).toEqual([]);
  });

  it("maps a file change to file_write or file_edit by change kind, with every changed path", () => {
    const add = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, [{ path: "a.txt", kind: { type: "add" }, diff: "+hi" }]);
    expect(add).toMatchObject({ tool: "codex.fileChange", kind: "file_write", summary: "Create a.txt", paths: ["a.txt"] });
    expect(add.input).toEqual({ changes: [{ path: "a.txt", kind: "add", diff: "+hi" }] });

    const edit = codexApprovalToAction(FILE, { itemId: "f2" }, CWD, [
      { path: "a.ts", kind: { type: "update", move_path: null }, diff: "" },
      { path: "b.ts", kind: { type: "update", move_path: null }, diff: "" },
      { path: "c.ts", kind: { type: "update", move_path: null }, diff: "" },
    ]);
    expect(edit).toMatchObject({ kind: "file_edit", summary: "Edit a.ts (+2 more)", paths: ["a.ts", "b.ts", "c.ts"] });

    const del = codexApprovalToAction(FILE, { itemId: "f3" }, CWD, [{ path: "old.txt", kind: { type: "delete" }, diff: "" }]);
    expect(del).toMatchObject({ kind: "file_write", summary: "Delete old.txt", paths: ["old.txt"] });
  });

  it("treats a move as a write to both paths", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, [{ path: "a.ts", kind: { type: "update", move_path: "../b.ts" }, diff: "" }]);
    expect(a).toMatchObject({ kind: "file_write", paths: ["a.ts", "../b.ts"] });
  });

  it("caps each diff preview at 4000 characters", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, CWD, [{ path: "a.ts", kind: { type: "add" }, diff: "d".repeat(9000) }]);
    expect((a.input as { changes: { diff: string }[] }).changes[0]!.diff).toHaveLength(4000);
  });

  it("adds a requested grant root to the paths so policy judges it", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1", grantRoot: "/elsewhere" }, CWD, [{ path: "a.ts", kind: { type: "add" }, diff: "" }]);
    expect(a.paths).toEqual(["a.ts", "/elsewhere"]);
  });

  it("asks a human when the changed files are unknown", () => {
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, CWD);
    expect(a).toMatchObject({ kind: "file_write", summary: "Edit (unknown files)", paths: [] });
  });

  it("summarises absolute paths inside the worktree relative to it", () => {
    const root = join(process.cwd(), CWD);
    const a = codexApprovalToAction(FILE, { itemId: "f1" }, root, [{ path: join(root, "src", "a.ts"), kind: { type: "add" }, diff: "" }]);
    expect(a.summary).toBe("Create src/a.ts");
  });

  it("maps any other request to an other action", () => {
    expect(codexApprovalToAction("item/tool/call", { a: 1 }, CWD)).toEqual({
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
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const script = (s: unknown) => vi.stubEnv("THETERMINAL_FAKE_SCRIPT", JSON.stringify(s));
  const fakeLog = (): LogEntry[] =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const received = (method: string) => fakeLog().filter((e) => e.received === method);
  const answers = (method: string) => fakeLog().filter((e) => e.answered === method);
  const make = (opts: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) =>
    new CodexAdapter({ dataDir: dir, command: { file: process.execPath, args: [FAKE] }, apiKey: () => FAKE_KEY, ...opts });

  function run(
    adapter: CodexAdapter,
    decide: (a: ProposedAction) => GateResult | Promise<GateResult> = () => ({ decision: "allow", reason: "ok" }),
    o: Partial<AdapterStartOptions> = {},
  ) {
    const proposed: ProposedAction[] = [];
    const events: AdapterEvent[] = [];
    let n = 0;
    const result = adapter.start({
      cwd: dir,
      prompt: "do the thing",
      authMode: "chatgpt",
      signal: new AbortController().signal,
      gate: async (a) => {
        proposed.push(a);
        const id = `act-${++n}`;
        return { ...(await decide(a)), actionId: id };
      },
      emit: (e) => events.push(e),
      ...o,
    });
    return { result, proposed, events };
  }

  it("runs a command the gate allows, answers accept and reports its result", async () => {
    script([{ approve: "command", command: "ls", itemId: "i1", output: "a.txt\n" }, { message: "All done." }]);
    const { result, proposed, events } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(proposed).toEqual([
      { tool: "codex.command", kind: "shell", summary: "Run: ls", input: { command: "ls" }, paths: [] },
    ]);
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }]);
    expect(events).toEqual([
      { type: "action_result", actionId: "act-1", ok: true, output: "a.txt\n" },
      { type: "message", text: "All done." },
    ]);
    // The handshake: initialize, then initialized, a login check, the strict thread and the prompt.
    const order = fakeLog().filter((e) => e.received).map((e) => e.received);
    expect(order.slice(0, 5)).toEqual(["initialize", "initialized", "account/read", "thread/start", "turn/start"]);
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

  it("caps a result's output at 4000 characters", async () => {
    script([{ approve: "command", command: "yes", itemId: "i1", output: "y".repeat(10_000) }]);
    const { result, events } = run(make());
    await result;
    expect((events[0] as { output: string }).output).toHaveLength(4000);
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

  it("records an unknown server-request and answers it with an error", async () => {
    script([{ unknownRequest: "item/tool/requestUserInput" }, { message: "ok" }]);
    const { result, proposed } = run(make(), (a) => ({ decision: a.kind === "other" ? "deny" : "allow", reason: "unsupported" }));
    expect(await result).toEqual({ status: "completed" });
    expect(proposed).toMatchObject([
      { kind: "other", tool: "codex.item/tool/requestUserInput", summary: "Unsupported Codex request: item/tool/requestUserInput" },
    ]);
    expect(answers("item/tool/requestUserInput")).toEqual([
      { answered: "item/tool/requestUserInput", error: { code: -32000, message: "denied" } },
    ]);
  });

  it("still answers an unknown request with an error when the gate allows it", async () => {
    script([{ unknownRequest: "x/y" }]);
    const { result, events } = run(make());
    expect(await result).toEqual({ status: "completed" });
    expect(answers("x/y")[0].error).toBeDefined();
    expect(events).toEqual([{ type: "action_result", actionId: "act-1", ok: false, output: "unsupported request x/y" }]);
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
    });
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

  it("fails and records the action when Codex runs a command that was never approved", async () => {
    script([{ ungated: "commandExecution", command: "cat notes.txt", itemId: "u1" }, { hang: true }]);
    const { result, proposed } = run(make());
    const r = await result;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/without approval/);
    expect(proposed).toMatchObject([{ kind: "other", tool: "codex.commandExecution" }]);
  });

  it("fails when Codex uses a tool that cannot be gated", async () => {
    script([{ ungated: "mcpToolCall" }, { hang: true }]);
    const { result, proposed } = run(make());
    expect((await result).error).toMatch(/mcpToolCall without approval/);
    expect(proposed).toMatchObject([{ kind: "other", tool: "codex.mcpToolCall" }]);
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

  it("emits no usage when only token counts are reported", async () => {
    script([{ message: "hi" }]);
    const { result, events } = run(make());
    await result;
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });

  it.each([
    ["exits on EOF", {}],
    ["ignores EOF and SIGTERM", { ignoreSigterm: true, ignoreEof: true }],
  ])("aborting mid-approval interrupts, kills Codex (which %s) within 6s and never accepts", async (_label, cfg) => {
    script({ ...cfg, steps: [{ approve: "command", command: "ls", itemId: "i1" }] });
    const ac = new AbortController();
    let gateDenied = false;
    let gateAsked!: () => void;
    const asked = new Promise<void>((r) => (gateAsked = r));
    const { result } = run(
      make(),
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
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(gateDenied).toBe(true);
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

  describe("auth modes", () => {
    beforeEach(() => {
      vi.stubEnv("OPENAI_API_KEY", "sk-INHERITED-TESTKEY");
      vi.stubEnv("CODEX_API_KEY", "sk-INHERITED-TESTKEY");
    });

    it("chatgpt mode passes no API key and relies on the user's own login", async () => {
      script([]);
      const { result } = run(make(), undefined, { authMode: "chatgpt" });
      expect(await result).toEqual({ status: "completed" });
      expect(fakeLog().find((e) => e.start).env).toEqual({ OPENAI_API_KEY: null, CODEX_API_KEY: null });
      expect(received("account/login/start")).toEqual([]);
    });

    it("chatgpt mode fails when the CLI reports no login", async () => {
      script({ loggedOut: true, steps: [] });
      const { result } = run(make(), undefined, { authMode: "chatgpt" });
      expect(await result).toEqual({ status: "failed", error: "Codex is not logged in; run 'codex login' yourself" });
      expect(received("thread/start")).toEqual([]);
    });

    it("api_key mode passes exactly the configured key and logs in with it, kept in memory only", async () => {
      script([]);
      const { result } = run(make(), undefined, { authMode: "api_key" });
      expect(await result).toEqual({ status: "completed" });
      const start = fakeLog().find((e) => e.start);
      expect(start.env).toEqual({ OPENAI_API_KEY: FAKE_KEY, CODEX_API_KEY: FAKE_KEY });
      expect(start.argv).toEqual(["app-server", "-c", "cli_auth_credentials_store=ephemeral"]);
      expect(received("account/login/start")[0].params).toEqual({ type: "apiKey", apiKey: FAKE_KEY });
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
    it("fails when codex is not on PATH", async () => {
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => null }));
      expect(await result).toEqual({ status: "failed", error: "Codex CLI is not installed or not on PATH" });
    });

    it("fails when the binary cannot be started", async () => {
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => join(dir, "missing", "codex") }));
      expect(await result).toEqual({ status: "failed", error: "Codex CLI is not installed or not on PATH" });
    });

    it("refuses a Windows .cmd shim rather than using a shell", async () => {
      const spawn = vi.fn();
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => "C:\\tools\\codex.CMD", spawn: spawn as never }));
      expect(await result).toEqual({ status: "failed", error: "Codex CLI must be a native executable on Windows (found a .cmd shim)" });
      expect(spawn).not.toHaveBeenCalled();
    });

    it("spawns the located binary with app-server, piped stdio and no shell", async () => {
      script([]);
      const real = (await import("node:child_process")).spawn;
      const spawn = vi.fn((file: string, args: string[], opts: object) => real(process.execPath, [FAKE, ...args], opts));
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => "/opt/codex/bin/codex", spawn: spawn as never }));
      expect(await result).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(
        "/opt/codex/bin/codex", ["app-server"], expect.objectContaining({ cwd: dir, stdio: ["pipe", "pipe", "pipe"], shell: false }),
      );
    });
  });
});
