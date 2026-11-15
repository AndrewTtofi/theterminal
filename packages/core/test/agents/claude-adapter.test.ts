import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query as realSdkQuery, type HookCallbackMatcher, type HookInput, type Options, type SpawnOptions, type query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_SUBSCRIPTION_ACK } from "@theterminal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterStartOptions, GateResult, ProposedAction } from "../../src/agents/adapter.js";
import { ClaudeAdapter, VERIFIED_CLAUDE_CODE_VERSION, toolToAction } from "../../src/agents/claude-adapter.js";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { classify } from "../../src/agents/policy.js";
import { AgentRunner, DEFAULT_GATE_TIMEOUT_MS } from "../../src/agents/runner.js";
import type { McpServerSpec } from "../../src/connections/mcp.js";
import { EMPTY_GITCONFIG, WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService } from "../../src/board/board-service.js";
import { ProviderSettings } from "../../src/agents/settings.js";
import { openDatabase, type Db } from "../../src/db.js";
import { getRun, getSetting, listActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { ClaudeAdapter as IndexClaudeAdapter, ProviderSettings as IndexProviderSettings, toolToAction as indexToolToAction } from "../../src/index.js";

const FAKE_KEY = "sk-ant-TESTKEY0123456789abcdef";
const CONNECTION_KEY = "sk-ant-TESTKEY-0000000000";
const CWD = join("tmp", "worktree");
const MCP_ENV_SECRET = "TESTKEY-mcp-env-0000000000";
const MCP_HEADER_SECRET = "Bearer TESTKEY-mcp-header-0000000000";
const MCP_SPECS: McpServerSpec[] = [
  {
    serverName: "tt-abc12345", connectionId: "abc12345-0000-4000-8000-000000000000", name: "Docs", transport: "stdio",
    command: "npx", args: ["-y", "example-server"], env: { API_TOKEN: MCP_ENV_SECRET, MODE: "read" },
  },
  {
    serverName: "tt-9f8e7d6c", connectionId: "9f8e7d6c-0000-4000-8000-000000000000", name: "Tracker", transport: "http",
    url: "https://mcp.example.com/mcp", headers: { Authorization: MCP_HEADER_SECRET },
  },
];

describe("toolToAction", () => {
  const cases: [string, Record<string, unknown>, Partial<ProposedAction>][] = [
    ["Read", { file_path: "src/a.ts" }, { kind: "file_read", paths: ["src/a.ts"], summary: "Read src/a.ts" }],
    ["Read", {}, { kind: "file_read", paths: [] }],
    ["Glob", { pattern: "**/*.ts" }, { kind: "file_read", paths: [".", "**/*.ts"] }],
    ["Glob", { pattern: "*.ts", path: "/outside" }, { kind: "file_read", paths: ["/outside", "*.ts"] }],
    ["Grep", { pattern: "foo" }, { kind: "file_read", paths: ["."] }],
    ["Grep", { pattern: "foo", path: "../up" }, { kind: "file_read", paths: ["../up"] }],
    ["LS", { path: "src" }, { kind: "file_read", paths: ["src"] }],
    ["Write", { file_path: "notes.md", content: "x" }, { kind: "file_write", paths: ["notes.md"], summary: "Write notes.md" }],
    ["Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, { kind: "file_edit", paths: ["a.ts"], summary: "Edit a.ts" }],
    ["MultiEdit", { file_path: "a.ts", edits: [] }, { kind: "file_edit", paths: ["a.ts"] }],
    ["NotebookEdit", { notebook_path: "n.ipynb", new_source: "" }, { kind: "file_edit", paths: ["n.ipynb"] }],
    ["Bash", { command: "ls -la" }, { kind: "shell", paths: [], summary: "Run: ls -la" }],
    ["WebFetch", { url: "https://example.com", prompt: "p" }, { kind: "web", paths: [] }],
    ["WebSearch", { query: "q" }, { kind: "web", paths: [] }],
    ["mcp__server__tool", { a: 1 }, { kind: "mcp", paths: [] }],
    ["Task", { prompt: "go" }, { kind: "other", paths: [] }],
    ["PowerShell", { command: "Get-ChildItem" }, { kind: "shell", paths: [], summary: "Run: Get-ChildItem" }],
    ["Monitor", { description: "d", timeout_ms: 1, command: "tail -f log" }, { kind: "shell", paths: [], summary: "Run: tail -f log" }],
    ["Monitor", { description: "d", timeout_ms: 1, ws: { url: "wss://example.com/s" } }, { kind: "shell", paths: [], summary: "Run: watch wss://example.com/s" }],
    ["Agent", { description: "helper", prompt: "go", isolation: "remote" }, { kind: "other", paths: [], summary: "Run remote agent: helper" }],
    ["Task", { description: "helper", prompt: "go", isolation: "remote" }, { kind: "other", paths: [], summary: "Run remote agent: helper" }],
    ["SomethingNew", { file_path: "a.ts" }, { kind: "other", paths: [] }],
  ];
  it.each(cases)("maps %s %j", (tool, input, expected) => {
    const a = toolToAction(tool, input, CWD);
    expect(a).toMatchObject({ tool, input, ...expected });
    expect(a.summary.length).toBeGreaterThan(0);
  });

  it("passes the whole command to the gate: the runner redacts before it caps", () => {
    const a = toolToAction("Bash", { command: "x".repeat(400) }, CWD);
    expect(a.summary).toBe(`Run: ${"x".repeat(400)}`);
  });

  it("summarises absolute paths inside the worktree relative to it", () => {
    const abs = join(process.cwd(), CWD, "src", "a.ts");
    const a = toolToAction("Read", { file_path: abs }, join(process.cwd(), CWD));
    expect(a.paths).toEqual([abs]);
    expect(a.summary).toBe("Read src/a.ts");
  });

  it("shows / separators in summaries on every platform", () => {
    expect(toolToAction("Read", { file_path: "src\\a.ts" }, CWD).summary).toBe("Read src/a.ts");
    expect(toolToAction("LS", { path: "src\\deep\\dir" }, CWD).summary).toBe("List src/deep/dir");
    expect(toolToAction("Grep", { pattern: "x", path: "a\\b" }, CWD).summary).toBe("Search: x in a/b");
  });

  it.each(["{..,x}/*", "x/{a,..}/*", "[.][.]/*", "..*/x", "src/\\*.ts", "a/b..c/*", "!(x)/*", "src/{a,b}.ts"])(
    "asks for the Glob pattern %j",
    (pattern) => {
      expect(toolToAction("Glob", { pattern }, CWD).paths).toEqual([]);
      expect(toolToAction("Grep", { pattern: "x", glob: pattern }, CWD).paths).toEqual([]);
    },
  );

  it("still judges plain Glob and Grep glob patterns by path", () => {
    expect(toolToAction("Glob", { pattern: "src/**/*.ts" }, CWD).paths).toEqual([".", "src/**/*.ts"]);
    expect(toolToAction("Glob", { pattern: "docs/file-?.md" }, CWD).paths).toEqual([".", "docs/file-?.md"]);
    expect(toolToAction("Grep", { pattern: "x", glob: "*.ts" }, CWD).paths).toEqual(["."]);
    expect(toolToAction("Grep", { pattern: "x", glob: 3 }, CWD).paths).toEqual([]);
  });

  it("expands a home-relative path so it is never mistaken for a worktree path", () => {
    expect(toolToAction("Read", { file_path: "~/.ssh/id_rsa" }, CWD).paths).toEqual([join(homedir(), ".ssh/id_rsa")]);
    expect(toolToAction("Read", { file_path: "~" }, CWD).paths).toEqual([homedir()]);
    expect(toolToAction("Read", { file_path: "~other/x" }, CWD).paths).toEqual([]);
  });

  it("caps the PowerShell command and remote agent description in summaries", () => {
    expect(toolToAction("PowerShell", { command: "y".repeat(300) }, CWD).summary).toBe(`Run: ${"y".repeat(300)}`);
    expect(toolToAction("Agent", { description: "d".repeat(300), isolation: "remote" }, CWD).summary).toBe(`Run remote agent: ${"d".repeat(300)}`);
  });

  // The CLI trims path input before expanding "~", so padded paths must never be judged as written.
  const pads = [" ", "\t", "\n"];
  const padded = (p: string) => pads.flatMap((w) => [`${w}${p}`, `${p}${w}`]);
  it.each([
    ["Read", "file_path"],
    ["Grep", "path"],
    ["Glob", "path"],
    ["NotebookEdit", "notebook_path"],
  ])("asks for whitespace-padded paths in %s.%s", (tool, field) => {
    for (const p of [...padded("~/.ssh/id_rsa"), ...padded("/etc/passwd"), ...padded("~"), ...padded("src/a.ts")]) {
      const input: Record<string, unknown> = { [field]: p, pattern: "x" };
      expect(toolToAction(tool, input, CWD).paths, JSON.stringify(p)).toEqual([]);
    }
  });

  it("asks for path fields that are not strings", () => {
    expect(toolToAction("Read", { file_path: 42 }, CWD).paths).toEqual([]);
    expect(toolToAction("Grep", { pattern: "x", path: ["a"] }, CWD).paths).toEqual([]);
    expect(toolToAction("Read", { file_path: "" }, CWD).paths).toEqual([]);
  });

  it("names the server of one of our MCP tools, and the gate asks for it", () => {
    const a = toolToAction("mcp__tt-abc12345__list", {}, CWD);
    expect(a).toEqual({ tool: "mcp__tt-abc12345__list", kind: "mcp", summary: "MCP tool list on tt-abc12345", input: {}, paths: [] });
    expect(toolToAction("mcp__my_server__get_item", {}, CWD).summary).toBe("MCP tool get_item on my_server");
    expect(toolToAction("mcp__odd", {}, CWD)).toMatchObject({ kind: "mcp", summary: "MCP tool mcp__odd" });
    const wtRoot = mkdtempSync(join(tmpdir(), "claude-mcp-"));
    try {
      expect(classify(a, join(wtRoot, "wt"), new WorktreeManager(wtRoot)).verdict).toBe("ask");
    } finally {
      rmSync(wtRoot, { recursive: true, force: true });
    }
  });

  it("is exported from the core index", () => {
    expect(indexToolToAction).toBe(toolToAction);
    expect(IndexClaudeAdapter).toBe(ClaudeAdapter);
    expect(IndexProviderSettings).toBe(ProviderSettings);
  });
});

/** A scripted SDK step: a message to yield, or a tool call that runs the registered hooks. */
type Step =
  | { msg: Record<string, unknown> }
  | { tool: string; input: Record<string, unknown>; id: string; response?: unknown; error?: string; run?: string[] };

/**
 * The env Claude Code hands a Bash command: its own env, unless subprocess scrubbing is on (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
 * truthy, or GITHUB_ACTIONS truthy without the scrub variable set false), which strips cloud credentials.
 */
function claudeCommandEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const on = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v);
  const off = (v: string | undefined) => v !== undefined && /^(0|false|no|off)$/i.test(v);
  const scrub = on(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) || (on(env.GITHUB_ACTIONS) && !off(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !(scrub && /^(AWS_|AZURE_|ARM_|CLOUDSDK_|GOOGLE_)/.test(k))));
}

type HookOutput = { hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string } };

function fakeQuery(steps: Step[], opts: { hang?: boolean } = {}) {
  const calls: { prompt: unknown; options: Options }[] = [];
  const preDecisions: HookOutput[] = [];
  let closed = false;
  const fn = vi.fn((params: { prompt: unknown; options?: Options }) => {
    const options = params.options!;
    calls.push({ prompt: params.prompt, options });
    const run = async (event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure", input: Record<string, unknown>, id: string) => {
      const matchers: HookCallbackMatcher[] = options.hooks?.[event] ?? [];
      const outs: HookOutput[] = [];
      for (const m of matchers) {
        for (const h of m.hooks) {
          outs.push((await h({ ...input, hook_event_name: event } as unknown as HookInput, id, { signal: new AbortController().signal })) as HookOutput);
        }
      }
      return outs;
    };
    async function* gen() {
      for (const step of steps) {
        if (options.abortController?.signal.aborted || closed) throw new Error("aborted");
        if ("msg" in step) {
          yield step.msg;
          continue;
        }
        const base = { session_id: "s", transcript_path: "t", cwd: options.cwd, tool_name: step.tool, tool_input: step.input, tool_use_id: step.id };
        const [out] = await run("PreToolUse", base, step.id);
        preDecisions.push(out!);
        if (out?.hookSpecificOutput?.permissionDecision !== "allow") continue;
        if (step.error !== undefined) await run("PostToolUseFailure", { ...base, error: step.error }, step.id);
        else if (step.run) {
          // Runs the command for real, as Claude Code's Bash tool would, with the env it would give it.
          const stdout = execFileSync(step.run[0]!, step.run.slice(1), { env: claudeCommandEnv(options.env ?? {}), encoding: "utf8" });
          await run("PostToolUse", { ...base, tool_response: { stdout, stderr: "", interrupted: false } }, step.id);
        } else await run("PostToolUse", { ...base, tool_response: step.response }, step.id);
      }
      if (opts.hang) {
        await new Promise<void>((resolve) => options.abortController?.signal.addEventListener("abort", () => resolve()));
        throw new Error("aborted");
      }
    }
    const g = gen();
    return Object.assign(g, { close: () => { closed = true; }, interrupt: async () => undefined });
  });
  return { fn: fn as unknown as typeof sdkQuery, calls, preDecisions, get closed() { return closed; } };
}

const assistant = (text: string) => ({ msg: { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }, { type: "tool_use", id: "x", name: "Read", input: {} }] } } });
const success = (cost: number) => ({ msg: { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: cost } });

function harness(decide: (a: ProposedAction) => GateResult | Promise<GateResult> = () => ({ decision: "allow", reason: "ok" })) {
  const proposed: ProposedAction[] = [];
  const events: AdapterEvent[] = [];
  let n = 0;
  const abort = new AbortController();
  const opts: AdapterStartOptions = {
    cwd: CWD, projectId: "p1", prompt: "do it", authMode: "api_key", signal: abort.signal,
    gate: async (a) => {
      proposed.push(a);
      return { ...(await decide(a)), actionId: `act-${++n}` };
    },
    emit: (e) => events.push(e),
    recordDenied: async () => {},
    clean: (t) => t,
    credentials: { env: {}, mcpServers: [] },
  };
  return { opts, proposed, events, abort };
}

describe("ClaudeAdapter", () => {
  // Fake values for everything the adapter must strip or keep; the real environment is restored afterwards.
  const FAKE_ENV: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-ant-TESTKEYfromprocessenv0000",
    ANTHROPIC_AUTH_TOKEN: "fake-auth-token-value",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token-value",
    ANTHROPIC_BASE_URL: "https://proxy.example.com",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "0",
    ANTHROPIC_MODEL: "fake-model",
    ANTHROPIC_CUSTOM_HEADERS: "x-fake: 1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    GIT_AUTHOR_EMAIL: "someone@example.com",
    GIT_COMMITTER_NAME: "someone",
    GIT_DIR: "/nonexistent/fake.git",
  };
  const STRIPPED = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  const CLAUDE_BIN = "/opt/fake/bin/claude";
  const DATA_DIR = join(tmpdir(), "fake-data-dir");
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(FAKE_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(FAKE_ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("passes a locked-down configuration with a fail-closed PreToolUse hook", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    const { prompt, options } = q.calls[0]!;
    expect(prompt).toBe("do it");
    expect(options.cwd).toBe(CWD);
    expect(options.permissionMode).toBe("default");
    expect(options.settingSources).toEqual([]);
    expect(options).not.toHaveProperty("allowedTools");
    expect(options).not.toHaveProperty("canUseTool");
    expect(options.allowDangerouslySkipPermissions).toBeFalsy();
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    const pre = options.hooks!.PreToolUse!;
    expect(pre).toHaveLength(1);
    expect(pre[0]!.onFailure).toBe("block");
    expect(pre[0]!.matcher).toBeUndefined();
    // The runner's own gate timeout must fire first, so a timeout is recorded as a denial.
    expect(pre[0]!.timeout! * 1000).toBeGreaterThan(DEFAULT_GATE_TIMEOUT_MS);
  });

  it("gates each tool call before it runs, links results by tool-use id, and reports text and cost", async () => {
    const q = fakeQuery([
      assistant("Looking around"),
      { tool: "Read", input: { file_path: "README.md" }, id: "tu-1", response: "hello" },
      { tool: "Bash", input: { command: "npm test" }, id: "tu-2", response: { stdout: "ok", exitCode: 0 } },
      { tool: "Edit", input: { file_path: "a.ts" }, id: "tu-3", error: "old_string not found" },
      success(0.0123),
    ]);
    const h = harness();
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(r).toEqual({ status: "completed" });
    expect(h.proposed.map((a) => [a.tool, a.kind])).toEqual([["Read", "file_read"], ["Bash", "shell"], ["Edit", "file_edit"]]);
    expect(q.preDecisions.map((d) => d.hookSpecificOutput)).toEqual([
      { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ok" },
      { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ok" },
      { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ok" },
    ]);
    expect(h.events).toEqual([
      { type: "message", text: "Looking around" },
      { type: "action_result", actionId: "act-1", ok: true, output: "hello" },
      { type: "action_result", actionId: "act-2", ok: true, output: JSON.stringify({ stdout: "ok", exitCode: 0 }) },
      { type: "action_result", actionId: "act-3", ok: false, output: "old_string not found" },
      { type: "usage", costUsd: 0.0123 },
    ]);
  });

  it("returns a hook deny with the reason when the gate denies", async () => {
    const q = fakeQuery([{ tool: "Write", input: { file_path: "x" }, id: "tu-1", response: "written" }, success(0)]);
    const h = harness(() => ({ decision: "deny", reason: "outside worktree" }));
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(r.status).toBe("completed");
    expect(q.preDecisions[0]!.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "outside worktree",
    });
    expect(h.events.filter((e) => e.type === "action_result")).toEqual([]);
  });

  it("denies and fails the run with a redacted error when the gate throws", async () => {
    const q = fakeQuery([{ tool: "Read", input: { file_path: "a" }, id: "tu-1", response: "x" }, success(0)]);
    const h = harness(() => {
      throw new Error(`gate exploded with ${FAKE_KEY}`);
    });
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(q.preDecisions[0]!.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("gate");
    expect(r.error).not.toContain(FAKE_KEY);
    expect(h.events.filter((e) => e.type === "action_result")).toEqual([]);
  });

  it("api_key mode passes the configured key and drops anything that could redirect or override it", async () => {
    const q = fakeQuery([success(0)]);
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(harness().opts);
    const env = q.calls[0]!.options.env!;
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    for (const k of [...STRIPPED, "CLAUDE_CODE_OAUTH_TOKEN"]) expect(env).not.toHaveProperty(k);
    expect(Object.keys(env).filter((k) => /^ANTHROPIC_/i.test(k))).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-TESTKEYfromprocessenv0000"); // a copy, not the real env
  });

  it("api_key mode prefers the key the runner resolved from a connection over its own fallback", async () => {
    const q = fakeQuery([success(0)]);
    const fallback = vi.fn(() => FAKE_KEY);
    const h = harness();
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: fallback }).start({ ...h.opts, credentials: { apiKey: CONNECTION_KEY, env: {}, mcpServers: [] } });
    expect(q.calls[0]!.options.env!.ANTHROPIC_API_KEY).toBe(CONNECTION_KEY);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("api_key mode keeps the bundled Claude Code and never looks for one on PATH", async () => {
    const q = fakeQuery([success(0)]);
    const findClaude = vi.fn(() => CLAUDE_BIN);
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY, findClaude }).start(harness().opts);
    expect(q.calls[0]!.options).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(findClaude).not.toHaveBeenCalled();
  });

  it.each(["api_key", "subscription"] as const)("%s mode: the run's cloud grant reaches Claude Code and its Bash commands", async (authMode) => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    const credentials = { env: { AZURE_CLIENT_SECRET: "TESTKEY-azure-secret-0000000000" }, mcpServers: [] };
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY, bundled: () => CLAUDE_BIN }).start({ ...h.opts, authMode, credentials });
    const env = q.calls[0]!.options.env!;
    expect(env.AZURE_CLIENT_SECRET).toBe("TESTKEY-azure-secret-0000000000");
    // Claude Code hands its own env to Bash commands unless subprocess scrubbing is on, which this env never turns on.
    expect(Object.keys(env).filter((k) => /SUBPROCESS_ENV_SCRUB|^GITHUB_ACTIONS$/.test(k))).toEqual([]);
    expect(env.CLAUDE_CODE_ENTRYPOINT).not.toBe("local-agent");
  });

  it("an approved Bash command gets the grant in its env, and no API key it was not meant to see", async () => {
    const probe = "process.stdout.write(JSON.stringify({ s: process.env.AZURE_CLIENT_SECRET ?? null, o: process.env.OPENAI_API_KEY ?? null }))";
    const q = fakeQuery([{ tool: "Bash", input: { command: "node probe" }, id: "tu-1", run: [process.execPath, "-e", probe] }, success(0)]);
    vi.stubEnv("OPENAI_API_KEY", "sk-TESTKEY-openai-0000000000000000");
    vi.stubEnv("GITHUB_ACTIONS", "true"); // dropped by the allowlist, so it never turns scrubbing on
    const h = harness();
    const credentials = { env: { AZURE_CLIENT_SECRET: "TESTKEY-azure-secret-0000000000" }, mcpServers: [] };
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start({ ...h.opts, credentials });
    const done = h.events.find((e) => e.type === "action_result") as { output: string };
    expect(JSON.parse((JSON.parse(done.output) as { stdout: string }).stdout)).toEqual({ s: "TESTKEY-azure-secret-0000000000", o: null });
  });

  it("subscription mode runs the Claude Code bundled with the Agent SDK and never looks on PATH", async () => {
    const q = fakeQuery([success(0)]);
    const findClaude = vi.fn(() => CLAUDE_BIN);
    const bundled = "node_modules/@anthropic-ai/claude-agent-sdk-x/claude";
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, bundled: () => bundled, findClaude }).start({ ...harness().opts, authMode: "subscription" });
    expect(q.calls[0]!.options.pathToClaudeCodeExecutable).toBe(bundled);
    expect(findClaude).not.toHaveBeenCalled();
  });

  it("subscription mode uses the SDK's own platform binary when none is injected", async () => {
    const { bundledClaude } = await import("../../src/agents/bundled.js");
    const q = fakeQuery([success(0)]);
    const findClaude = vi.fn(() => CLAUDE_BIN);
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, findClaude }).start({ ...harness().opts, authMode: "subscription" });
    expect(q.calls[0]!.options.pathToClaudeCodeExecutable).toBe(bundledClaude());
    expect(findClaude).not.toHaveBeenCalled();
  });

  it("subscription mode falls back to Claude Code on PATH only when the bundled one is missing", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, bundled: () => null, findClaude: () => CLAUDE_BIN }).start({ ...h.opts, authMode: "subscription" });
    expect(q.calls[0]!.options.pathToClaudeCodeExecutable).toBe(CLAUDE_BIN);
  });

  it("subscription mode fails without starting Claude when there is no bundled Claude Code and none on PATH", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, bundled: () => null, findClaude: () => null }).start({ ...h.opts, authMode: "subscription" });
    expect(r).toEqual({ status: "failed", error: "Claude Code is unavailable: its bundled program is missing and none is on PATH" });
    expect(q.calls).toHaveLength(0);
  });

  it("api_key mode with no key fails with the exact message without starting Claude", async () => {
    const q = fakeQuery([success(0)]);
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => undefined }).start(harness().opts);
    expect(r).toEqual({ status: "failed", error: "No Anthropic API key configured" });
    expect(q.calls).toHaveLength(0);
  });

  it("subscription mode passes an env without any API key or auth token", async () => {
    const q = fakeQuery([success(0)]);
    const apiKey = vi.fn(() => FAKE_KEY);
    const h = harness();
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey, findClaude: () => CLAUDE_BIN }).start({ ...h.opts, authMode: "subscription" });
    const env = q.calls[0]!.options.env!;
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    for (const k of STRIPPED) expect(env).not.toHaveProperty(k);
    expect(Object.keys(env).filter((k) => /^ANTHROPIC_/i.test(k))).toEqual([]);
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN"); // not allowlisted: the CLI reads its own stored login
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(apiKey).not.toHaveBeenCalled();
  });

  it("strips every inherited GIT_* variable and points git at the empty global config", async () => {
    const q = fakeQuery([success(0)]);
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(harness().opts);
    const env = q.calls[0]!.options.env!;
    expect(env).not.toHaveProperty("GIT_AUTHOR_EMAIL");
    expect(env).not.toHaveProperty("GIT_COMMITTER_NAME");
    expect(env).not.toHaveProperty("GIT_DIR");
    expect(Object.keys(env).filter((k) => /^GIT_/i.test(k)).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(DATA_DIR, EMPTY_GITCONFIG));
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("defaults apiKey to process.env.ANTHROPIC_API_KEY", async () => {
    const q = fakeQuery([success(0)]);
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn }).start(harness().opts);
    expect(q.calls[0]!.options.env!.ANTHROPIC_API_KEY).toBe("sk-ant-TESTKEYfromprocessenv0000");
  });

  it("records a remote agent through the gate but never lets it run, even when allowed", async () => {
    const q = fakeQuery([{ tool: "Agent", input: { description: "helper", prompt: "go", isolation: "remote" }, id: "tu-1", response: "ran" }, success(0)]);
    const h = harness();
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(r.status).toBe("completed");
    expect(h.proposed).toEqual([expect.objectContaining({ tool: "Agent", kind: "other", summary: "Run remote agent: helper" })]);
    expect(q.preDecisions[0]!.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "remote agents are not supported",
    });
    expect(h.events).toEqual([
      { type: "action_result", actionId: "act-1", ok: false, output: "remote agents are not supported" },
      { type: "usage", costUsd: 0 },
    ]);
  });

  it("reports the result's cost and token usage", async () => {
    const usage = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 };
    const q = fakeQuery([{ msg: { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.25, usage } }]);
    const h = harness();
    expect(await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts)).toEqual({ status: "completed" });
    expect(h.events).toEqual([{ type: "usage", costUsd: 0.25, inputTokens: 120, outputTokens: 34 }]);
  });

  it("fails when Claude reports an error result, still reporting its cost", async () => {
    const q = fakeQuery([{ msg: { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.5, errors: ["too many turns"] } }]);
    const h = harness();
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(r).toEqual({ status: "failed", error: "too many turns" });
    expect(h.events).toEqual([{ type: "usage", costUsd: 0.5 }]);
  });

  describe("rate limits", () => {
    const start = async (steps: Step[]) => {
      const h = harness();
      const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: fakeQuery(steps).fn, apiKey: () => FAKE_KEY }).start(h.opts);
      return { r, limited: h.events.filter((e) => e.type === "rate_limited") };
    };
    const rateEvent = (status: string) => ({ msg: { type: "rate_limit_event", rate_limit_info: { status, rateLimitType: "five_hour" }, uuid: "u", session_id: "s" } });
    const retry = (error: string, delayMs: number) => ({
      msg: { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: delayMs, error_status: 429, error, uuid: "u", session_id: "s" },
    });

    it("emits rate_limited for a rejected rate_limit_event and ignores allowed ones", async () => {
      const { limited } = await start([rateEvent("allowed"), rateEvent("allowed_warning"), rateEvent("rejected"), success(0)]);
      expect(limited).toEqual([{ type: "rate_limited" }]);
    });

    it("emits rate_limited with the delay in whole seconds for an api_retry caused by a rate limit, and ignores other retries", async () => {
      const { limited } = await start([retry("overloaded", 4000), retry("rate_limit", 12_400), success(0)]);
      expect(limited).toEqual([{ type: "rate_limited", retryAfterS: 12 }]);
    });

    it("falls back to the error text of a result: an is_error result saying 429 rate limit is a rate limit", async () => {
      const { r, limited } = await start([{ msg: { type: "result", subtype: "success", is_error: true, result: "API Error: 429 rate limit exceeded", total_cost_usd: 0 } }]);
      expect(r.status).toBe("failed");
      expect(limited).toEqual([{ type: "rate_limited" }]);
    });

    it("does not count the fallback again after a typed signal, nor treat error_max_turns or other errors as rate limits", async () => {
      const typed = await start([rateEvent("rejected"), { msg: { type: "result", subtype: "success", is_error: true, result: "429 rate limit", total_cost_usd: 0 } }]);
      expect(typed.limited).toHaveLength(1);
      const turns = await start([{ msg: { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0, errors: ["rate limit of turns reached"] } }]);
      expect(turns.limited).toEqual([]);
      const other = await start([{ msg: { type: "result", subtype: "success", is_error: true, result: "invalid request", total_cost_usd: 0 } }]);
      expect(other.limited).toEqual([]);
    });
  });

  it("fails with a redacted error when the SDK throws", async () => {
    const q = fakeQuery([{ msg: { type: "system", subtype: "init" } }]);
    const throwing = ((p: Parameters<typeof sdkQuery>[0]) => {
      const g = (q.fn as unknown as (p: unknown) => AsyncGenerator)(p);
      return Object.assign((async function* () {
        yield* g;
        throw new Error(`spawn failed ${FAKE_KEY}`);
      })(), { close: () => undefined });
    }) as unknown as typeof sdkQuery;
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: throwing, apiKey: () => FAKE_KEY }).start(harness().opts);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("spawn failed");
    expect(r.error).not.toContain(FAKE_KEY);
  });

  it("aborting the signal aborts the query and closes it", async () => {
    const q = fakeQuery([assistant("working")], { hang: true });
    const h = harness();
    const done = new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(await done).toEqual({ status: "failed", error: "run stopped" });
    expect(q.calls[0]!.options.abortController!.signal.aborted).toBe(true);
    expect(q.closed).toBe(true);
  });

  it("hands the selected MCP servers to Claude Code with their secrets as variables of its env, keeping strictMcpConfig", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start({ ...h.opts, credentials: { env: {}, mcpServers: MCP_SPECS } });
    const { options } = q.calls[0]!;
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({
      "tt-abc12345": { type: "stdio", command: "npx", args: ["-y", "example-server"], env: { API_TOKEN: "${TT_MCP_0_0}", MODE: "${TT_MCP_0_1}" } },
      "tt-9f8e7d6c": { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "${TT_MCP_1_0}" } },
    });
    expect(options.env).toMatchObject({ TT_MCP_0_0: MCP_ENV_SECRET, TT_MCP_0_1: "read", TT_MCP_1_0: MCP_HEADER_SECRET });
    expect(JSON.stringify(options.mcpServers)).not.toContain("TESTKEY");
  });

  it("passes no mcpServers option and no MCP variables without MCP servers", async () => {
    const q = fakeQuery([success(0)]);
    await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(harness().opts);
    expect(q.calls[0]!.options).not.toHaveProperty("mcpServers");
    expect(Object.keys(q.calls[0]!.options.env!).filter((k) => k.startsWith("TT_MCP_"))).toEqual([]);
  });

  it("fails without starting Claude when an MCP server name is not one of ours", async () => {
    const q = fakeQuery([success(0)]);
    const bad = { ...MCP_SPECS[0]!, serverName: "tt_bad" } as McpServerSpec;
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start({ ...harness().opts, credentials: { env: {}, mcpServers: [bad] } });
    expect(r).toEqual({ status: "failed", error: "invalid MCP server name" });
    expect(q.calls).toHaveLength(0);
  });

  it("the command line the Agent SDK builds for Claude Code holds no MCP secret; its env does", async () => {
    // The real SDK, stopped at the point where it would spawn Claude Code: it puts mcpServers on the command line.
    let spawned: SpawnOptions | undefined;
    const capture = ((p: Parameters<typeof sdkQuery>[0]) => {
      try {
        return realSdkQuery({
          ...p,
          options: {
            ...p.options,
            spawnClaudeCodeProcess: (so) => {
              spawned = so;
              throw new Error("not spawning in tests");
            },
          },
        });
      } catch {
        return Object.assign((async function* () {})(), { close: () => undefined });
      }
    }) as unknown as typeof sdkQuery;
    const r = await new ClaudeAdapter({ dataDir: DATA_DIR, query: capture, apiKey: () => FAKE_KEY }).start({ ...harness().opts, credentials: { env: {}, mcpServers: MCP_SPECS } });
    expect(r.status).toBe("failed");
    expect(spawned).toBeDefined();
    const argv = [spawned!.command, ...spawned!.args].join(" ");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("${TT_MCP_0_0}");
    for (const secret of [MCP_ENV_SECRET, MCP_HEADER_SECRET, "TESTKEY"]) expect(argv).not.toContain(secret);
    expect(spawned!.env).toMatchObject({ TT_MCP_0_0: MCP_ENV_SECRET, TT_MCP_1_0: MCP_HEADER_SECRET });
  });

  it("the installed Agent SDK bundles the Claude Code version whose MCP variable expansion was verified", () => {
    // The package's exports hide package.json; it sits next to the entry point.
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { name: string; claudeCodeVersion: string };
    expect(pkg.name).toBe("@anthropic-ai/claude-agent-sdk");
    // A bump means: recheck that `--mcp-config` still expands ${VAR} (the live test), then update the constant.
    expect(pkg.claudeCodeVersion).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    expect(VERIFIED_CLAUDE_CODE_VERSION).toBe("2.1.323");
  });

  it("does not start Claude when the signal is already aborted", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    h.abort.abort();
    expect(await new ClaudeAdapter({ dataDir: DATA_DIR, query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts)).toEqual({ status: "failed", error: "run stopped" });
    expect(q.calls).toHaveLength(0);
  });
});

describe("ClaudeAdapter through the runner", () => {
  // A stored secret (not matched by any pattern) that straddles where summaries used to be cut.
  const STORED = "stored-conn-value-0123456789";

  it.each([
    ["a Bash command cut at 150", "Bash", { command: `echo ${"a".repeat(136)} ${STORED}` }],
    ["a remote agent description cut at 120", "Agent", { description: `${"d".repeat(110)} ${STORED}`, prompt: "go", isolation: "remote" }],
  ])("leaves no fragment of a stored secret across the old cap (%s) in the recorded summary", async (_label, tool, input) => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-runner-")));
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const owner = { kind: "human", id: "owner" } as const;
    const projectId = new BoardService(db, ledger).createProject(owner, { name: "Claude" }).id;
    const q = fakeQuery([{ tool, input, id: "tu-1", response: "ok" }, success(0)]);
    const claude = new ClaudeAdapter({ dataDir, query: q.fn, apiKey: () => FAKE_KEY });
    const runner = new AgentRunner({
      db, ledger, worktrees: new WorktreeManager(dataDir), broker: new ApprovalBroker(), adapters: { claude }, extraSecrets: () => [STORED], dataDir,
    });
    try {
      const run = await runner.start(owner, { projectId, adapter: "claude", prompt: "go" });
      // A shell command holding a secret is denied by policy; the remote agent waits for a human.
      await vi.waitFor(() => expect(listActions(db, run.id)).toHaveLength(1), { timeout: 5000 });
      runner.stop(owner, run.id);
      await vi.waitFor(() => expect(getRun(db, run.id)!.status).not.toBe("running"), { timeout: 5000 });
      const [action] = listActions(db, run.id);
      expect(action!.summary).toContain("[REDACTED]");
      expect(JSON.stringify(ledger.list())).not.toContain(STORED.slice(0, 6));
    } finally {
      await runner.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("ProviderSettings", () => {
  let db: Db;
  let ledger: Ledger;
  const owner = { kind: "human", id: "owner" } as const;
  beforeEach(() => {
    db = openDatabase(":memory:");
    ledger = new Ledger(db);
  });

  it("defaults to api_key", () => {
    expect(new ProviderSettings(db, ledger).getMode("claude")).toBe("api_key");
  });

  it("rejects subscription mode without the exact acknowledgement and records nothing", () => {
    const s = new ProviderSettings(db, ledger);
    expect(() => s.setMode(owner, "claude", "subscription")).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(() => s.setMode(owner, "claude", "subscription", `${CLAUDE_SUBSCRIPTION_ACK} `)).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(() => s.setMode(owner, "claude", "subscription", "yes")).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(ledger.list()).toEqual([]);
    expect(s.getMode("claude")).toBe("api_key");
  });

  it("records subscription mode with the acknowledgement, and switching back", () => {
    const s = new ProviderSettings(db, ledger);
    s.setMode(owner, "claude", "subscription", CLAUDE_SUBSCRIPTION_ACK);
    expect(s.getMode("claude")).toBe("subscription");
    expect(getSetting(db, "auth_mode:claude")).toBe("subscription");
    s.setMode(owner, "claude", "api_key", "ignored");
    expect(s.getMode("claude")).toBe("api_key");
    expect(ledger.list().map((e) => [e.type, e.actor, e.projectId, e.payload])).toEqual([
      ["settings.provider_auth_changed", owner, null, { provider: "claude", mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK }],
      ["settings.provider_auth_changed", owner, null, { provider: "claude", mode: "api_key", acknowledgement: "" }],
    ]);
  });
});
