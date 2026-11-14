import { homedir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, HookInput, Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_SUBSCRIPTION_ACK } from "@theterminal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterStartOptions, GateResult, ProposedAction } from "../../src/agents/adapter.js";
import { ClaudeAdapter, toolToAction } from "../../src/agents/claude-adapter.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../../src/agents/runner.js";
import { ClaudeSettings } from "../../src/agents/settings.js";
import { openDatabase, type Db } from "../../src/db.js";
import { getSetting } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { ClaudeAdapter as IndexClaudeAdapter, ClaudeSettings as IndexClaudeSettings, toolToAction as indexToolToAction } from "../../src/index.js";

const FAKE_KEY = "sk-ant-TESTKEY0123456789abcdef";
const CWD = join("tmp", "worktree");

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

  it("caps the command in a Bash summary at 150 characters", () => {
    const a = toolToAction("Bash", { command: "x".repeat(400) }, CWD);
    expect(a.summary).toBe(`Run: ${"x".repeat(150)}`);
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
    expect(toolToAction("PowerShell", { command: "y".repeat(300) }, CWD).summary).toBe(`Run: ${"y".repeat(150)}`);
    expect(toolToAction("Agent", { description: "d".repeat(300), isolation: "remote" }, CWD).summary).toBe(`Run remote agent: ${"d".repeat(120)}`);
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

  it("is exported from the core index", () => {
    expect(indexToolToAction).toBe(toolToAction);
    expect(IndexClaudeAdapter).toBe(ClaudeAdapter);
    expect(IndexClaudeSettings).toBe(ClaudeSettings);
  });
});

/** A scripted SDK step: a message to yield, or a tool call that runs the registered hooks. */
type Step =
  | { msg: Record<string, unknown> }
  | { tool: string; input: Record<string, unknown>; id: string; response?: unknown; error?: string };

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
        else await run("PostToolUse", { ...base, tool_response: step.response }, step.id);
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
    cwd: CWD, prompt: "do it", authMode: "api_key", signal: abort.signal,
    gate: async (a) => {
      proposed.push(a);
      return { ...(await decide(a)), actionId: `act-${++n}` };
    },
    emit: (e) => events.push(e),
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
  };
  const STRIPPED = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  const CLAUDE_BIN = "/opt/fake/bin/claude";
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
    await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
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
    const r = await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
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
    const r = await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
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
    const r = await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(q.preDecisions[0]!.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("gate");
    expect(r.error).not.toContain(FAKE_KEY);
    expect(h.events.filter((e) => e.type === "action_result")).toEqual([]);
  });

  it("api_key mode passes the configured key and drops anything that could redirect or override it", async () => {
    const q = fakeQuery([success(0)]);
    await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(harness().opts);
    const env = q.calls[0]!.options.env!;
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    for (const k of [...STRIPPED, "CLAUDE_CODE_OAUTH_TOKEN"]) expect(env).not.toHaveProperty(k);
    expect(Object.keys(env).filter((k) => /^ANTHROPIC_/i.test(k))).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-TESTKEYfromprocessenv0000"); // a copy, not the real env
  });

  it("api_key mode keeps the bundled Claude Code and never looks for one on PATH", async () => {
    const q = fakeQuery([success(0)]);
    const findClaude = vi.fn(() => CLAUDE_BIN);
    await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY, findClaude }).start(harness().opts);
    expect(q.calls[0]!.options).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(findClaude).not.toHaveBeenCalled();
  });

  it("subscription mode runs the user's own Claude Code found on PATH", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    await new ClaudeAdapter({ query: q.fn, findClaude: () => CLAUDE_BIN }).start({ ...h.opts, authMode: "subscription" });
    expect(q.calls[0]!.options.pathToClaudeCodeExecutable).toBe(CLAUDE_BIN);
  });

  it("subscription mode fails without starting Claude when Claude Code is not on PATH", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    const r = await new ClaudeAdapter({ query: q.fn, findClaude: () => null }).start({ ...h.opts, authMode: "subscription" });
    expect(r).toEqual({ status: "failed", error: "Claude Code is not installed or not on PATH" });
    expect(q.calls).toHaveLength(0);
  });

  it("api_key mode with no key fails with the exact message without starting Claude", async () => {
    const q = fakeQuery([success(0)]);
    const r = await new ClaudeAdapter({ query: q.fn, apiKey: () => undefined }).start(harness().opts);
    expect(r).toEqual({ status: "failed", error: "No Anthropic API key configured" });
    expect(q.calls).toHaveLength(0);
  });

  it("subscription mode passes an env without any API key or auth token", async () => {
    const q = fakeQuery([success(0)]);
    const apiKey = vi.fn(() => FAKE_KEY);
    const h = harness();
    await new ClaudeAdapter({ query: q.fn, apiKey, findClaude: () => CLAUDE_BIN }).start({ ...h.opts, authMode: "subscription" });
    const env = q.calls[0]!.options.env!;
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    for (const k of STRIPPED) expect(env).not.toHaveProperty(k);
    expect(Object.keys(env).filter((k) => /^ANTHROPIC_/i.test(k))).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-oauth-token-value"); // the user's own CLI login is left alone
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(apiKey).not.toHaveBeenCalled();
  });

  it("defaults apiKey to process.env.ANTHROPIC_API_KEY", async () => {
    const q = fakeQuery([success(0)]);
    await new ClaudeAdapter({ query: q.fn }).start(harness().opts);
    expect(q.calls[0]!.options.env!.ANTHROPIC_API_KEY).toBe("sk-ant-TESTKEYfromprocessenv0000");
  });

  it("records a remote agent through the gate but never lets it run, even when allowed", async () => {
    const q = fakeQuery([{ tool: "Agent", input: { description: "helper", prompt: "go", isolation: "remote" }, id: "tu-1", response: "ran" }, success(0)]);
    const h = harness();
    const r = await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
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

  it("fails when Claude reports an error result, still reporting its cost", async () => {
    const q = fakeQuery([{ msg: { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.5, errors: ["too many turns"] } }]);
    const h = harness();
    const r = await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    expect(r).toEqual({ status: "failed", error: "too many turns" });
    expect(h.events).toEqual([{ type: "usage", costUsd: 0.5 }]);
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
    const r = await new ClaudeAdapter({ query: throwing, apiKey: () => FAKE_KEY }).start(harness().opts);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("spawn failed");
    expect(r.error).not.toContain(FAKE_KEY);
  });

  it("aborting the signal aborts the query and closes it", async () => {
    const q = fakeQuery([assistant("working")], { hang: true });
    const h = harness();
    const done = new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts);
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.abort.abort();
    expect(await done).toEqual({ status: "failed", error: "run stopped" });
    expect(q.calls[0]!.options.abortController!.signal.aborted).toBe(true);
    expect(q.closed).toBe(true);
  });

  it("does not start Claude when the signal is already aborted", async () => {
    const q = fakeQuery([success(0)]);
    const h = harness();
    h.abort.abort();
    expect(await new ClaudeAdapter({ query: q.fn, apiKey: () => FAKE_KEY }).start(h.opts)).toEqual({ status: "failed", error: "run stopped" });
    expect(q.calls).toHaveLength(0);
  });
});

describe("ClaudeSettings", () => {
  let db: Db;
  let ledger: Ledger;
  const owner = { kind: "human", id: "owner" } as const;
  beforeEach(() => {
    db = openDatabase(":memory:");
    ledger = new Ledger(db);
  });

  it("defaults to api_key", () => {
    expect(new ClaudeSettings(db, ledger).getMode()).toBe("api_key");
  });

  it("rejects subscription mode without the exact acknowledgement and records nothing", () => {
    const s = new ClaudeSettings(db, ledger);
    expect(() => s.setMode(owner, "subscription")).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(() => s.setMode(owner, "subscription", `${CLAUDE_SUBSCRIPTION_ACK} `)).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(() => s.setMode(owner, "subscription", "yes")).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(ledger.list()).toEqual([]);
    expect(s.getMode()).toBe("api_key");
  });

  it("records subscription mode with the acknowledgement, and switching back", () => {
    const s = new ClaudeSettings(db, ledger);
    s.setMode(owner, "subscription", CLAUDE_SUBSCRIPTION_ACK);
    expect(s.getMode()).toBe("subscription");
    expect(getSetting(db, "claude_auth_mode")).toBe("subscription");
    s.setMode(owner, "api_key", "ignored");
    expect(s.getMode()).toBe("api_key");
    expect(ledger.list().map((e) => [e.type, e.actor, e.projectId, e.payload])).toEqual([
      ["settings.claude_auth_changed", owner, null, { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK }],
      ["settings.claude_auth_changed", owner, null, { mode: "api_key", acknowledgement: "" }],
    ]);
  });
});
