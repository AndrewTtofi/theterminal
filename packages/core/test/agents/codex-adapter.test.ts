import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  it("maps a network approval to a web action, never to the command it belongs to", () => {
    const a = codexApprovalToAction(CMD, { itemId: "i1", command: null, cwd: null, networkApprovalContext: { host: "example.com", protocol: "https" } }, CWD);
    expect(a).toEqual({
      tool: "codex.network", kind: "web", summary: "Network access to example.com (https)",
      input: { host: "example.com", protocol: "https" }, paths: [],
    });
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
    const denied: [ProposedAction, string][] = [];
    const events: AdapterEvent[] = [];
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
      emit: (e) => events.push(e),
      recordDenied: async (a, reason) => {
        denied.push([a, reason]);
      },
      ...o,
    });
    return { result, proposed, denied, events };
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

  it("asks separately for network access during an accepted command, without reusing its command", async () => {
    script([{ approve: "command", command: "npm install", itemId: "i1", network: { host: "registry.example.com", protocol: "https" } }]);
    const { result, proposed } = run(make(), (a) => ({ decision: a.kind === "web" ? "deny" : "allow", reason: "r" }));
    expect(await result).toEqual({ status: "completed" });
    expect(proposed.map((a) => [a.kind, a.summary])).toEqual([
      ["shell", "Run: npm install"],
      ["web", "Network access to registry.example.com (https)"],
    ]);
    expect(answers(CMD).map((e) => e.result)).toEqual([{ decision: "accept" }, { decision: "decline" }]);
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

  it("emits no usage when only token counts are reported", async () => {
    script([{ message: "hi" }]);
    const { result, events } = run(make());
    await result;
    expect(events.some((e) => e.type === "usage")).toBe(false);
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

  describe("auth modes", () => {
    beforeEach(() => {
      vi.stubEnv("OPENAI_API_KEY", "sk-INHERITED-TESTKEY");
      vi.stubEnv("CODEX_API_KEY", "sk-INHERITED-TESTKEY");
    });

    it("chatgpt mode passes no API key, keeps the user's CODEX_HOME and relies on their own login", async () => {
      vi.stubEnv("CODEX_HOME", join(dir, "users-codex-home"));
      script([]);
      const { result } = run(make(), undefined, { authMode: "chatgpt" });
      expect(await result).toEqual({ status: "completed" });
      const start = fakeLog().find((e) => e.start);
      expect(start.env).toEqual({ OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_HOME: join(dir, "users-codex-home") });
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
    it("fails when codex is not on PATH", async () => {
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => null }));
      expect(await result).toEqual({ status: "failed", error: "Codex CLI is not installed or not on PATH" });
    });

    it("fails when the binary cannot be started", async () => {
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => join(dir, "missing", "codex") }));
      expect(await result).toEqual({ status: "failed", error: "Codex CLI is not installed or not on PATH" });
    });

    it("runs the script behind an npm .cmd shim with node instead of a shell", async () => {
      script([]);
      const shim = join(dir, "npm", "codex.CMD");
      const target = join(dir, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      const real = (await import("node:child_process")).spawn;
      const spawn = vi.fn((_file: string, args: string[], opts: object) => real(process.execPath, [FAKE, ...args.slice(1)], opts));
      const exists = vi.fn((p: string) => p === target);
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => shim, spawn: spawn as never, exists }));
      expect(await result).toEqual({ status: "completed" });
      expect(spawn).toHaveBeenCalledWith(process.execPath, [target, "app-server"], expect.objectContaining({ shell: false }));
    });

    it("refuses a .cmd shim with no npm package script behind it", async () => {
      const spawn = vi.fn();
      const { result } = run(new CodexAdapter({ dataDir: dir, bin: () => join(dir, "codex.cmd"), spawn: spawn as never, exists: () => false }));
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
