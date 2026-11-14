import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { query as sdkQuery, type HookCallback, type HookJSONOutput, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ActionKind } from "@theterminal/shared";
import type { AdapterStartOptions, AgentAdapter, ProposedAction } from "./adapter.js";
import { redact } from "./redact.js";
import { which } from "./which.js";

type StartResult = { status: "completed" | "failed"; error?: string };

const NO_API_KEY = "No Anthropic API key configured";
const NO_CLAUDE_CODE = "Claude Code is not installed or not on PATH";
/** Inherited variables that could send requests elsewhere, pick another provider or authenticate differently. */
const INHERITED_CLAUDE_ENV = /^(?:ANTHROPIC_|CLAUDE_CODE_USE_)/i;
const STOPPED = "run stopped";
const MAX_COMMAND = 150;
const MAX_DESCRIPTION = 120;
const REMOTE_AGENT = "remote agents are not supported";
/** Hook timeout in seconds: a gate may wait on a human for a long time. A timeout blocks the tool. */
const GATE_TIMEOUT_S = 24 * 60 * 60;

const FILE_EDIT = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

function errorMessage(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
}

/**
 * A path field from tool input, or null when it cannot be judged (not a string, empty, padded with whitespace,
 * or `~user`). The CLI trims a path and then expands `~` and `~/…`; padding is refused rather than mirrored, and
 * `~` is expanded the same way, so a home path is never resolved inside the worktree.
 */
function pathField(v: unknown): string | null {
  if (typeof v !== "string" || v !== v.trim()) return null;
  const p = v.trim(); // already trimmed; kept so the "~" checks below match what the CLI sees
  if (p === "") return null;
  if (p === "~") return homedir();
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2));
  if (p.startsWith("~")) return null;
  return p;
}

/**
 * A glob pattern that can be judged as a path: plain path characters plus `*`, `?` and `**`, and no `..`
 * anywhere. Braces, classes, escapes, negation and the like could spell a way out, so they ask a human.
 */
const PLAIN_GLOB = /^[\p{L}\p{N}\p{M}_\-./ *?]*$/u;
const isPlainGlob = (v: unknown): v is string => typeof v === "string" && PLAIN_GLOB.test(v) && !v.includes("..");

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An Agent (or legacy Task) call that would run on a remote machine, outside our gate. */
const isRemoteAgent = (tool: string, input: Record<string, unknown>): boolean =>
  (tool === "Agent" || tool === "Task") && input.isolation === "remote";

/**
 * Maps an SDK tool call to a ProposedAction. `kind` and `paths` come only from the tool name and the tool's own
 * input fields; policy auto-allows reads whose paths are all inside the worktree, so anything that cannot be
 * judged yields no paths (asks a human) and unknown tools are `other` (always ask).
 */
export function toolToAction(tool: string, input: Record<string, unknown>, cwd: string): ProposedAction {
  // Summaries use / on every platform.
  const display = (p: string): string => {
    const rel = relative(cwd, resolve(cwd, p));
    return (rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? p : rel).replace(/\\/g, "/");
  };
  const one = (field: unknown, fallback?: string): string[] => {
    const p = pathField(field == null && fallback !== undefined ? fallback : field);
    return p === null ? [] : [p];
  };
  const action = (kind: ActionKind, summary: string, paths: string[] = []): ProposedAction => ({ tool, kind, summary, input, paths });

  switch (tool) {
    case "Read": {
      const paths = one(input.file_path);
      return action("file_read", `Read ${paths[0] ? display(paths[0]) : "(no path)"}`, paths);
    }
    case "Glob": {
      const root = one(input.path, ".");
      const pattern = isPlainGlob(input.pattern) ? one(input.pattern) : [];
      // The pattern itself may be absolute or climb out, so it is checked as a path too.
      const paths = root.length && pattern.length ? [...root, ...pattern] : [];
      return action("file_read", `Find files: ${str(input.pattern)} in ${root[0] ? display(root[0]) : "(no path)"}`, paths);
    }
    case "Grep": {
      const paths = input.glob === undefined || isPlainGlob(input.glob) ? one(input.path, ".") : [];
      return action("file_read", `Search: ${str(input.pattern)} in ${paths[0] ? display(paths[0]) : "(no path)"}`, paths);
    }
    case "LS": {
      const paths = one(input.path);
      return action("file_read", `List ${paths[0] ? display(paths[0]) : "(no path)"}`, paths);
    }
    case "Write": {
      const paths = one(input.file_path);
      return action("file_write", `Write ${paths[0] ? display(paths[0]) : "(no path)"}`, paths);
    }
    case "Bash":
    case "PowerShell":
      return action("shell", `Run: ${str(input.command).slice(0, MAX_COMMAND)}`);
    case "Monitor": {
      const ws = isRecord(input.ws) ? str(input.ws.url) : "";
      const what = typeof input.command === "string" ? input.command : `watch ${ws}`;
      return action("shell", `Run: ${what.slice(0, MAX_COMMAND)}`);
    }
    case "WebFetch":
      return action("web", `Fetch ${str(input.url)}`);
    case "WebSearch":
      return action("web", `Web search: ${str(input.query)}`);
  }
  if (FILE_EDIT.has(tool)) {
    const paths = one(tool === "NotebookEdit" ? input.notebook_path : input.file_path);
    return action("file_edit", `Edit ${paths[0] ? display(paths[0]) : "(no path)"}`, paths);
  }
  if (isRemoteAgent(tool, input)) return action("other", `Run remote agent: ${str(input.description).slice(0, MAX_DESCRIPTION)}`);
  if (tool.startsWith("mcp__")) return action("mcp", `MCP tool ${tool}`);
  return action("other", `Use ${tool}`);
}

const asOutput = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** Drives Claude Code through the Agent SDK. Every tool call is gated in a fail-closed PreToolUse hook. */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  private readonly query: typeof sdkQuery;
  private readonly apiKey: () => string | undefined;
  private readonly findClaude: () => string | null;

  constructor(
    opts: {
      query?: typeof sdkQuery;
      apiKey?: () => string | undefined;
      /** Locates the user's own Claude Code for subscription mode. Default: `claude` on PATH. */
      findClaude?: () => string | null;
    } = {},
  ) {
    this.query = opts.query ?? sdkQuery;
    this.apiKey = opts.apiKey ?? (() => process.env.ANTHROPIC_API_KEY);
    this.findClaude = opts.findClaude ?? (() => which("claude"));
  }

  async start(o: AdapterStartOptions): Promise<StartResult> {
    if (o.signal.aborted) return { status: "failed", error: STOPPED };
    const env = this.env(o.authMode);
    if (typeof env === "string") return { status: "failed", error: env };
    // Subscription mode runs the user's own installed Claude Code with its own login; api_key mode the bundled one.
    let executable: string | null = null;
    if (o.authMode === "subscription") {
      executable = this.findClaude();
      if (executable === null) return { status: "failed", error: NO_CLAUDE_CODE };
    }

    const controller = new AbortController();
    const actionIds = new Map<string, string>(); // tool-use id -> allowed action id
    let failure: string | null = null;

    const pre: HookCallback = async (input, toolUseID) => {
      const deny = (reason: string): HookJSONOutput => ({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      });
      if (input.hook_event_name !== "PreToolUse") return deny("unexpected hook event");
      try {
        const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
        const g = await o.gate(toolToAction(input.tool_name, toolInput, o.cwd));
        if (g.decision !== "allow") return deny(g.reason);
        if (isRemoteAgent(input.tool_name, toolInput)) {
          // Recorded and decided above, but a remote agent would run outside the gate: never let it start.
          o.emit({ type: "action_result", actionId: g.actionId, ok: false, output: REMOTE_AGENT });
          return deny(REMOTE_AGENT);
        }
        actionIds.set(input.tool_use_id ?? toolUseID, g.actionId);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: g.reason } };
      } catch (e) {
        // Fail closed: deny this call and stop the run, since the gate can no longer be trusted.
        failure ??= `gate error: ${redact(errorMessage(e))}`;
        controller.abort();
        return deny("gate error");
      }
    };
    const post: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") {
        const actionId = actionIds.get(input.tool_use_id ?? toolUseID);
        if (actionId !== undefined) {
          actionIds.delete(input.tool_use_id ?? toolUseID);
          const ok = input.hook_event_name === "PostToolUse";
          o.emit({ type: "action_result", actionId, ok, output: ok ? asOutput(input.tool_response) : input.error });
        }
      }
      return {};
    };

    const options: Options = {
      cwd: o.cwd,
      env,
      abortController: controller,
      permissionMode: "default",
      settingSources: [],
      strictMcpConfig: true, // only our (empty) MCP config: no user, project or plugin servers
      persistSession: false, // no transcripts written under the user's Claude config dir
      ...(executable !== null && { pathToClaudeCodeExecutable: executable }),
      hooks: {
        PreToolUse: [{ hooks: [pre], onFailure: "block", timeout: GATE_TIMEOUT_S }],
        PostToolUse: [{ hooks: [post] }],
        PostToolUseFailure: [{ hooks: [post] }],
      },
    };

    const q = this.query({ prompt: o.prompt, options });
    const stop = () => {
      controller.abort();
      try {
        q.close();
      } catch {
        // Already closed.
      }
    };
    o.signal.addEventListener("abort", stop, { once: true });

    let result: StartResult | null = null;
    try {
      for await (const m of q) result = this.handle(m, o) ?? result;
    } catch (e) {
      if (!o.signal.aborted && failure === null) failure = redact(errorMessage(e));
    } finally {
      o.signal.removeEventListener("abort", stop);
    }
    if (o.signal.aborted) return { status: "failed", error: STOPPED };
    if (failure !== null) return { status: "failed", error: failure };
    return result ?? { status: "failed", error: "Claude ended without a result" };
  }

  /** Emits what a message carries; returns the run outcome for a result message. */
  private handle(m: SDKMessage, o: AdapterStartOptions): StartResult | null {
    if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "text" && block.text) o.emit({ type: "message", text: block.text });
      }
      return null;
    }
    if (m.type !== "result") return null;
    if (Number.isFinite(m.total_cost_usd)) o.emit({ type: "usage", costUsd: m.total_cost_usd });
    if (m.subtype === "success" && !m.is_error) return { status: "completed" };
    const detail = m.subtype === "success" ? m.result : m.errors.join("; ");
    return { status: "failed", error: redact(detail || m.subtype) };
  }

  /** The child-process environment for an auth mode, or an error message. A copy: process.env is never changed. */
  private env(mode: AdapterStartOptions["authMode"]): Record<string, string | undefined> | string {
    const env: Record<string, string | undefined> = { ...process.env };
    // Inherited settings that could send requests elsewhere or authenticate with something other than our choice.
    for (const k of Object.keys(env)) {
      if (INHERITED_CLAUDE_ENV.test(k)) delete env[k];
    }
    // Keep the shell in the worktree root after every command, so relative paths resolve where the gate judged them.
    env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
    if (mode === "subscription") return env; // the user's own Claude Code login is used, untouched
    if (mode !== "api_key") return `Unsupported auth mode for Claude: ${mode}`;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const key = this.apiKey();
    if (!key) return NO_API_KEY;
    env.ANTHROPIC_API_KEY = key;
    return env;
  }
}
