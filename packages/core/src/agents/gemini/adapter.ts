import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ActionKind, AuthMode } from "@theterminal/shared";
import type { AdapterStartOptions, AgentAdapter, ProposedAction } from "../adapter.js";
import { buildChildEnv } from "../child-env.js";
import { JsonRpcPeer } from "../jsonrpc.js";
import { redact } from "../redact.js";
import { which } from "../which.js";
import { WorktreeManager } from "../worktrees.js";
import { Terminals, type ExitStatus } from "./terminals.js";
import { ToolCallTracker, type Diff, type ToolCallUpdate, type ToolStatus } from "./tool-calls.js";

type StartResult = { status: "completed" | "failed"; error?: string };
type Spawn = typeof nodeSpawn;
type Rec = Record<string, unknown>;

const NO_API_KEY = "No Gemini API key configured";
const NO_CLI = "Gemini CLI is not installed or not on PATH";
const CMD_SHIM = "Gemini CLI must be a native executable on Windows (found a .cmd shim)";
const NOT_LOGGED_IN = "Gemini is not logged in; run 'gemini' once yourself";
const COMMAND_PROMPT = "Gemini treats a prompt starting with / or $ as a command; rephrase it";
const STOPPED = "run stopped";
const UNGATED = "agent executed an ungated tool";
const MODE_CHANGED = "agent changed its approval mode";
const NO_ASKING_MODE = "Gemini offers no approval mode that asks for every tool";
const NO_ALLOW_ONCE = "agent offered no allow_once option";
const OUTSIDE = "outside worktree";

/** ACP v1. Gemini answers with the client's version when it supports it; anything else is refused. */
const PROTOCOL_VERSION = 1;
/** The Gemini approval mode in which every tool asks (`autoEdit` and `yolo` auto-approve; `plan` is read-only). */
const DEFAULT_MODE = "default";
/**
 * Gemini's built-in tools that can run only through our gate: `read_file` reads through `fs/read_text_file`;
 * `write_file` and `replace` write through `fs/write_text_file`; `run_shell_command` runs inside Gemini after
 * `session/request_permission`. Everything else (glob, grep, list_directory, read_many_files, web fetch and
 * search, memory, todos, skills, subagents) would run inside Gemini without asking, so it is not loaded.
 */
const CORE_TOOLS = ["read_file", "write_file", "replace", "run_shell_command"];
/**
 * The policy file passed with `--policy`. Gemini's policy engine turns each `tools.core` entry into an allow
 * rule (user tier, priority 4.25) and auto-allows "safe" shell commands, so an allowlist alone lets tools run
 * without asking. A `--policy` directory is loaded at the user tier in place of the user's own policy
 * directories (priority p becomes 4 + p/1000): the ask rules land at 4.999 and outrank every settings-derived
 * allow, their `argsPattern` skips the shell heuristics, and the wildcard deny at 4.998 covers every other
 * tool the registry can expose (glob, grep_search, list_directory, read_many_files, web_fetch,
 * google_web_search, save_memory, write_todos, skills, subagents, MCP tools...). Only admin-tier policies
 * (/etc/gemini-cli, remote admin settings) rank higher.
 */
const POLICY_TOML =
  CORE_TOOLS.map((tool) => `[[rule]]\ntoolName = "${tool}"\ndecision = "ask_user"\npriority = 999\nargsPattern = ".*"\n`).join("\n") +
  `\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n`;
/** `--extensions none` loads no extension; the MCP allowlist names a server that does not exist, so none connects. */
const ACP_ARGS = ["--acp", "--approval-mode", "default", "--extensions", "none", "--allowed-mcp-server-names", "theterminal-none"];
/** Per run: our policy directory replaces the user's, and `--allowed-tools` replaces `tools.allowed` with a name matching no tool. */
const runArgs = (policies: string): string[] => [...ACP_ARGS, "--policy", policies, "--allowed-tools", "theterminal-none"];
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Variables of every provider's key family: a terminal command run for the agent never sees them. */
const PROVIDER_ENV = /^(?:ANTHROPIC_|CLAUDE_CODE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|VERTEX)/i;
const MAX_COMMAND = 150;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_CHUNK = 4000;
const MESSAGE_PAUSE_MS = 250;
const STDERR_TAIL = 200;
const SETUP_TIMEOUT_MS = 60 * 1000;
/** A prompt turn waits on humans: longer than the runner's gate timeout, so a slow decision never ends the turn. */
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const KILL_GRACE_MS = 5000;

const TOOL_KINDS: Record<string, ActionKind> = { edit: "file_edit", delete: "file_write", execute: "shell", read: "file_read", fetch: "web" };
const isWindows = process.platform === "win32";

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const optional = <T>(v: unknown, ok: (x: unknown) => x is T): v is T | null | undefined => v === undefined || v === null || ok(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isEnvVar = (v: unknown): v is { name: string; value: string } => isRecord(v) && typeof v.name === "string" && typeof v.value === "string";

function errorMessage(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
}

/** A path for a summary: relative to the worktree with / separators; anything outside is shown as given. */
function display(cwd: string, p: string): string {
  const rel = relative(cwd, resolve(cwd, p));
  return (rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? p : rel).replace(/\\/g, "/");
}

/** The paths of a tool call's locations, or [] when any of them cannot be judged (so policy asks). */
function locationPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const paths: string[] = [];
  for (const l of v) {
    if (!isRecord(l) || typeof l.path !== "string" || l.path === "") return [];
    paths.push(l.path);
  }
  return paths;
}

/** The text a tool call's content carries, for the recorded result. */
function contentText(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const parts: string[] = [];
  for (const c of v) {
    if (!isRecord(c)) continue;
    if (c.type === "content" && isRecord(c.content) && c.content.type === "text" && typeof c.content.text === "string") parts.push(c.content.text);
    else if (c.type === "diff" && typeof c.path === "string") parts.push(`diff ${c.path}`);
    else if (c.type === "terminal" && typeof c.terminalId === "string") parts.push(`terminal ${c.terminalId}`);
  }
  return parts.join("\n");
}

const toolName = (tc: Rec): string => (typeof tc.name === "string" && tc.name !== "" ? tc.name : "gemini");

/** The files a tool call's `diff` content promises to write. */
function diffsOf(v: unknown): Diff[] {
  if (!Array.isArray(v)) return [];
  const diffs: Diff[] = [];
  for (const c of v) {
    if (isRecord(c) && c.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") diffs.push({ path: c.path, newText: c.newText });
  }
  return diffs;
}

/** Lines `line` (1-based) onwards, at most `limit` of them, each with its line ending. */
function selectLines(text: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (line == null && limit == null) return text;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const start = line == null ? 0 : Math.max(Math.floor(line) - 1, 0);
  return lines.slice(start, limit == null ? undefined : start + Math.max(Math.floor(limit), 0)).join("");
}

/**
 * User-scope settings for the isolated home used in api_key mode (a system settings file would be ignored:
 * Gemini only honours one owned by root). The API-key auth type, the tool allowlist (nothing else is even
 * registered), folder trust on so a repo-planted `.gemini/settings.json` is ignored (the worktree is never
 * trusted in that home), no hooks, no tool discovery or call commands, no MCP server command, no legacy
 * sandbox, and no repo `.env` (one could point the API key at another host).
 */
const HOME_SETTINGS: Rec = {
  security: { auth: { selectedType: "gemini-api-key" }, disableAlwaysAllow: true, folderTrust: { enabled: true } },
  tools: { core: CORE_TOOLS, discoveryCommand: "", callCommand: "", sandbox: false },
  mcp: { serverCommand: "" },
  hooksConfig: { enabled: false },
  advanced: { ignoreLocalEnv: true },
};

/**
 * The script behind an npm `.cmd` shim: `<dir>/node_modules/@google/gemini-cli/package.json`'s `bin.gemini`,
 * which must stay inside that package. Node cannot run a `.cmd` without a shell, and a shell would re-parse
 * our arguments, so the script is run with node directly. Null when anything is off.
 */
function shimTarget(shim: string, readFile: (p: string) => string, exists: (p: string) => boolean): string | null {
  const dir = join(dirname(shim), "node_modules", "@google", "gemini-cli");
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFile(join(dir, "package.json")));
  } catch {
    return null;
  }
  const bin = isRecord(pkg) && isRecord(pkg.bin) ? pkg.bin.gemini : undefined;
  if (typeof bin !== "string" || bin === "") return null;
  const target = resolve(dir, bin);
  const rel = relative(dir, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return exists(target) ? target : null;
}

/**
 * Drives the user's installed `gemini` CLI in ACP mode as its client. We advertise the `fs` and `terminal`
 * capabilities, so file reads, file writes and (should Gemini use them) commands come to us: each is gated
 * first and then performed by us inside the worktree. `session/request_permission` is gated too, and a tool
 * call that reaches execution without either is reported as ungated: the run fails and Gemini is killed.
 *
 * Gemini is configured for this run alone through a system settings file in a temp dir (never `~/.gemini`),
 * and `authenticate` is never called: on this CLI it rewrites the user's settings and can clear their login.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly id = "gemini" as const;
  private readonly dataDir: string;
  private readonly bin: () => string | null;
  private readonly apiKey: () => string | undefined;
  private readonly spawn: Spawn;
  private readonly exists: (p: string) => boolean;
  private readonly readFile: (p: string) => string;
  private readonly command: { file: string; args: string[] } | undefined;
  private readonly worktrees: WorktreeManager;

  constructor(opts: {
    /** The data directory that holds the empty global git config (see WorktreeManager). */
    dataDir: string;
    /** Locates the user's own Gemini CLI. Default: `gemini` on PATH. */
    bin?: () => string | null;
    apiKey?: () => string | undefined;
    spawn?: Spawn;
    /** Injectable for tests: the file system used to look behind an npm .cmd shim. */
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string;
    /** Test override: spawn this program (with these arguments before the ACP flags) instead of the CLI. */
    command?: { file: string; args: string[] };
  }) {
    this.dataDir = opts.dataDir;
    this.bin = opts.bin ?? (() => which("gemini"));
    this.apiKey = opts.apiKey ?? (() => process.env.GEMINI_API_KEY);
    this.spawn = opts.spawn ?? nodeSpawn;
    this.exists = opts.exists ?? existsSync;
    this.readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
    this.command = opts.command;
    this.worktrees = new WorktreeManager(opts.dataDir);
  }

  async start(o: AdapterStartOptions): Promise<StartResult> {
    if (o.signal.aborted) return { status: "failed", error: STOPPED };
    // Gemini runs a prompt starting with "/" or "$" as one of its own commands (some write files or download code), unrecorded.
    if (/^[/$]/.test(o.prompt.trimStart())) return { status: "failed", error: COMMAND_PROMPT };
    if (!PROJECT_ID.test(o.projectId)) return { status: "failed", error: "invalid projectId" };
    const env = this.env(o.authMode);
    if (typeof env === "string") return { status: "failed", error: env };
    let file: string;
    let base: string[];
    if (this.command) {
      file = this.command.file;
      base = this.command.args;
    } else {
      const bin = this.bin();
      if (bin === null) return { status: "failed", error: NO_CLI };
      if (/\.cmd$/i.test(bin)) {
        const target = shimTarget(bin, this.readFile, this.exists);
        if (target === null) return { status: "failed", error: CMD_SHIM };
        file = process.execPath;
        base = [target];
      } else {
        file = bin;
        base = [];
      }
    }
    const runDir = mkdtempSync(join(tmpdir(), "theterminal-gemini-"));
    try {
      const policies = join(runDir, "policies");
      mkdirSync(policies);
      writeFileSync(join(policies, "theterminal.toml"), POLICY_TOML);
      if (o.authMode === "api_key") {
        // An isolated home of our own: our settings apply, and nothing of the user's ~/.gemini (settings,
        // policies, hooks, trusted folders, credentials) is read or copied.
        const home = join(this.dataDir, "projects", o.projectId, "gemini-home");
        mkdirSync(join(home, ".gemini"), { recursive: true });
        writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify(HOME_SETTINGS));
        env.GEMINI_CLI_HOME = home;
      }
      // Google-login mode runs in the user's own home (the login lives there and is never read or copied), so the
      // user's own settings stay in force: their hooks, tool discovery/call commands and MCP server command run as
      // the user configured them. Those are the user's commands, not agent actions; the policy file, the argv
      // overrides and the ungated-tool detector still gate everything the agent itself does.
      env.GEMINI_CLI_NO_RELAUNCH = "1"; // the npm entry point would otherwise relaunch the CLI as a child our signals never reach
      env.NO_BROWSER = "true"; // a missing Google login fails instead of opening a browser from a background run
      return await new GeminiRun(o, this.spawn, this.worktrees, env).run(file, [...base, ...runArgs(policies)]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  /** The child-process environment for an auth mode, or an error message. A copy: process.env is never changed. */
  private env(mode: AuthMode): NodeJS.ProcessEnv | string {
    if (mode !== "api_key" && mode !== "google") return `Unsupported auth mode for Gemini: ${mode}`;
    if (mode === "google") return buildChildEnv("gemini", mode, { dataDir: this.dataDir }); // the user's own login, untouched
    const key = this.apiKey();
    if (!key) return NO_API_KEY;
    return buildChildEnv("gemini", mode, { apiKey: key, dataDir: this.dataDir });
  }
}

/** One Gemini process and ACP session, from spawn to exit. */
class GeminiRun {
  private child!: ChildProcess;
  private peer!: JsonRpcPeer;
  private exited!: Promise<void>;
  private readonly tracker: ToolCallTracker;
  private readonly terminals: Terminals;
  /** Terminal id -> the allowed action it runs for. */
  private readonly terminalActions = new Map<string, string>();
  /** The agent's env without provider keys: terminal commands never see them. */
  private readonly terminalEnv: NodeJS.ProcessEnv;
  private sessionId: string | null = null;
  private inTurn = false;
  private failure: string | null = null;
  private pendingText = "";
  private flushTimer: NodeJS.Timeout | undefined;
  private stderrTail = "";
  private closing: Promise<void> | null = null;

  constructor(
    private readonly o: AdapterStartOptions,
    private readonly spawn: Spawn,
    private readonly worktrees: WorktreeManager,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    const fold = (p: string) => (isWindows ? p.toLowerCase() : p);
    this.tracker = new ToolCallTracker((a, b) => fold(resolve(o.cwd, a)) === fold(resolve(o.cwd, b)));
    this.terminals = new Terminals(spawn, (id, status, output) => this.onTerminalExit(id, status, output));
    this.terminalEnv = {};
    for (const [k, v] of Object.entries(env)) {
      if (!PROVIDER_ENV.test(k)) this.terminalEnv[k] = v;
    }
  }

  async run(file: string, args: string[]): Promise<StartResult> {
    try {
      this.child = this.spawn(file, args, { cwd: this.o.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return { status: "failed", error: `Gemini could not be started: ${redact(errorMessage(e))}` };
    }
    this.exited = new Promise((resolve) => this.child.on("close", () => resolve()));
    this.child.on("error", (e) => this.fail(`Gemini could not be started: ${redact(errorMessage(e))}`));
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    this.peer = new JsonRpcPeer(
      { input: this.child.stdout!, output: this.child.stdin! },
      { onRequest: (m, p) => this.onRequest(m, p), onNotification: (m, p) => this.onNotification(m, p), requestTimeoutMs: PROMPT_TIMEOUT_MS },
    );
    const stop = () => void this.shutdown();
    this.o.signal.addEventListener("abort", stop, { once: true });
    let result: StartResult;
    try {
      result = await this.converse();
    } catch (e) {
      result = { status: "failed", error: this.describe(e) };
    } finally {
      this.o.signal.removeEventListener("abort", stop);
      this.flushText();
      await this.shutdown();
    }
    if (this.o.signal.aborted) return { status: "failed", error: STOPPED };
    if (this.failure !== null) return { status: "failed", error: this.failure };
    return result;
  }

  /** initialize, session/new, the asking mode, then the prompt turn. */
  private async converse(): Promise<StartResult> {
    const init = await this.setup("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "theterminal", title: "The Terminal", version: "0" },
    });
    if (!isRecord(init) || init.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol version: ${isRecord(init) ? String(init.protocolVersion) : "none"}`);
    }
    const session = await this.setup("session/new", { cwd: this.o.cwd, mcpServers: [] });
    if (!isRecord(session) || typeof session.sessionId !== "string" || session.sessionId === "") throw new Error("Gemini returned no session id");
    this.sessionId = session.sessionId;
    if (isRecord(session.modes) && session.modes.currentModeId !== DEFAULT_MODE) {
      const modes = Array.isArray(session.modes.availableModes) ? session.modes.availableModes : [];
      if (!modes.some((m: unknown) => isRecord(m) && m.id === DEFAULT_MODE)) throw new Error(NO_ASKING_MODE);
      await this.setup("session/set_mode", { sessionId: this.sessionId, modeId: DEFAULT_MODE });
    }
    this.inTurn = true;
    const res = await this.peer.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: this.o.prompt }] });
    this.inTurn = false;
    const stopReason = isRecord(res) && typeof res.stopReason === "string" ? res.stopReason : "unknown";
    if (stopReason === "end_turn") return { status: "completed" };
    return { status: "failed", error: `Gemini stopped: ${stopReason}` };
  }

  /**
   * A setup request with a short timeout. In Google-login mode, a `session/new` error (that is where Gemini
   * authenticates) or a timeout (a missing login makes it prompt on stdin) means Gemini could not log in.
   */
  private async setup(method: string, params: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = Symbol("timeout");
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), SETUP_TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([this.peer.request(method, params), timeout]);
      if (res !== timedOut) return res;
      if (this.o.authMode === "google") throw new Error(NOT_LOGGED_IN);
      throw new Error(`Gemini did not answer ${method} in time`);
    } catch (e) {
      if (this.o.authMode === "google" && method === "session/new" && errorMessage(e).startsWith("rpc error:")) throw new Error(NOT_LOGGED_IN);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private describe(e: unknown): string {
    const msg = errorMessage(e);
    if (msg === "rpc closed: eof") {
      const tail = redact(this.stderrTail.trim());
      return tail === "" ? "Gemini exited unexpectedly" : `Gemini exited unexpectedly: ${tail}`;
    }
    if (msg === "rpc closed: protocol error") return "Gemini sent a malformed message";
    if (msg === "rpc closed: output error") return "Gemini stopped reading";
    return redact(msg.replace(/^rpc error: /, ""));
  }

  /** Fails the run (first reason wins) and stops Gemini, once the response to the offending request has been queued. */
  private fail(reason: string): void {
    this.failure ??= reason;
    setImmediate(() => void this.shutdown());
  }

  /** Cancels an unfinished turn, kills every terminal and Gemini itself, and closes the peer. Idempotent. */
  private shutdown(): Promise<void> {
    this.closing ??= (async () => {
      if (this.inTurn && this.sessionId !== null) this.peer.notify("session/cancel", { sessionId: this.sessionId });
      const terminals = this.terminals.closeAll();
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill();
        const hard = setTimeout(() => this.child.kill("SIGKILL"), KILL_GRACE_MS);
        void this.exited.then(() => clearTimeout(hard));
      }
      this.peer.close("aborted");
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((r) => {
        timer = setTimeout(r, KILL_GRACE_MS + 1000);
      });
      await Promise.race([Promise.all([terminals, this.exited]), bound]);
      clearTimeout(timer);
    })();
    return this.closing;
  }

  // ---- notifications ----

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    if (!isRecord(params) || params.sessionId !== this.sessionId || !isRecord(params.update)) return this.fail("update for an unknown session");
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (isRecord(u.content) && u.content.type === "text" && typeof u.content.text === "string") this.text(u.content.text);
        return;
      case "tool_call":
      case "tool_call_update":
        this.flushText();
        return this.onToolCall(u);
      case "current_mode_update":
        if (u.currentModeId !== DEFAULT_MODE) this.fail(MODE_CHANGED);
        return;
      default:
        return;
    }
  }

  private onToolCall(u: Rec): void {
    if (typeof u.toolCallId !== "string") return this.fail("malformed tool call from agent");
    let ev;
    try {
      ev = this.tracker.update(this.asUpdate(u));
    } catch (e) {
      return this.fail(errorMessage(e));
    }
    if (ev === null) return;
    if (ev.type === "result") return this.o.emit({ type: "action_result", actionId: ev.actionId, ok: ev.ok, output: contentText(u.content) });
    // Recorded as requested and denied (no one is asked about something that already ran) and the run fails.
    const title = ev.call.title || `${ev.call.kind ?? "unknown"} tool`;
    void this.o.recordDenied({ tool: toolName(u), kind: "other", summary: `Ungated tool: ${title}`, input: u, paths: [] }, UNGATED).catch(() => undefined);
    this.fail(UNGATED);
  }

  private asUpdate(tc: Rec): ToolCallUpdate {
    return {
      toolCallId: tc.toolCallId as string,
      kind: typeof tc.kind === "string" ? tc.kind : null,
      status: typeof tc.status === "string" ? (tc.status as ToolStatus) : null,
      title: typeof tc.title === "string" ? tc.title : null,
      locations: Array.isArray(tc.locations) ? locationPaths(tc.locations) : null,
    };
  }

  /** Streamed chunks are joined into one message: flushed before any tool activity, when large, or after a pause. */
  private text(t: string): void {
    this.pendingText += t;
    if (this.pendingText.length >= MAX_MESSAGE_CHUNK) return this.flushText();
    this.flushTimer ??= setTimeout(() => this.flushText(), MESSAGE_PAUSE_MS);
  }

  private flushText(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pendingText === "") return;
    const text = this.pendingText;
    this.pendingText = "";
    this.o.emit({ type: "message", text });
  }

  // ---- requests from the agent ----

  private onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.onPermission(this.params(method, params));
      case "fs/read_text_file":
        return this.onRead(method, this.params(method, params));
      case "fs/write_text_file":
        return this.onWrite(method, this.params(method, params));
      case "terminal/create":
        return this.onTerminalCreate(method, this.params(method, params));
      case "terminal/output":
      case "terminal/wait_for_exit":
      case "terminal/kill":
      case "terminal/release":
        return this.onTerminal(method, this.params(method, params));
      default:
        throw this.unsupported(method, params, `unknown request from agent: ${method}`);
    }
  }

  /** The request's params when they are an object for our session; otherwise the run fails. */
  private params(method: string, params: unknown): Rec {
    if (!isRecord(params) || params.sessionId !== this.sessionId) throw this.malformed(method, params);
    return params;
  }

  private malformed(method: string, params: unknown): Error {
    return this.unsupported(method, params, `malformed request from agent: ${method}`);
  }

  /** A request we refuse outright: recorded as requested and denied, answered with an error, and the run fails. */
  private unsupported(method: string, params: unknown, reason: string): Error {
    void this.o.recordDenied({ tool: method, kind: "other", summary: `Unsupported request: ${method}`, input: params, paths: [] }, reason).catch(() => undefined);
    this.fail(reason);
    return new Error(reason);
  }

  private result(actionId: string, ok: boolean, output: string): void {
    this.o.emit({ type: "action_result", actionId, ok, output });
  }

  private async onPermission(p: Rec): Promise<unknown> {
    const tc = p.toolCall;
    if (!isRecord(tc) || typeof tc.toolCallId !== "string" || !Array.isArray(p.options)) throw this.malformed("session/request_permission", p);
    this.flushText();
    const kind = typeof tc.kind === "string" ? tc.kind : null;
    const title = typeof tc.title === "string" && tc.title !== "" ? tc.title : `${kind ?? "unknown"} tool`;
    const action: ProposedAction = { tool: toolName(tc), kind: (kind !== null && TOOL_KINDS[kind]) || "other", summary: title, input: tc, paths: locationPaths(tc.locations) };
    const options: unknown[] = p.options;
    const g = await this.o.gate(action);
    const option = (k: string) => options.find((x) => isRecord(x) && x.kind === k && typeof x.optionId === "string") as Rec | undefined;
    const reject = () => {
      const r = option("reject_once");
      return r ? { outcome: { outcome: "selected", optionId: r.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    if (g.decision !== "allow") {
      this.tracker.permission(this.asUpdate(tc), null);
      return reject();
    }
    const once = option("allow_once"); // never allow_always: every call is decided on its own
    if (!once) {
      this.tracker.permission(this.asUpdate(tc), null);
      this.result(g.actionId, false, NO_ALLOW_ONCE);
      return reject();
    }
    this.tracker.permission(this.asUpdate(tc), g.actionId, diffsOf(tc.content));
    return { outcome: { outcome: "selected", optionId: once.optionId } };
  }

  private async onRead(method: string, p: Rec): Promise<unknown> {
    const { path, line, limit } = p;
    if (!isString(path) || !optional(line, isNumber) || !optional(limit, isNumber)) throw this.malformed(method, p);
    this.flushText();
    this.tracker.mediate(path);
    const input: Rec = { path, ...(line != null && { line }), ...(limit != null && { limit }) };
    const g = await this.o.gate({ tool: method, kind: "file_read", summary: `Read ${display(this.o.cwd, path)}`, input, paths: [path] });
    if (g.decision !== "allow") throw new Error(g.reason);
    const real = this.worktrees.resolveInside(this.o.cwd, path);
    if (real === null) return this.refuse(g.actionId, OUTSIDE);
    let content: string;
    try {
      content = selectLines(await readCapped(real), line, limit);
    } catch (e) {
      return this.refuse(g.actionId, errorMessage(e));
    }
    this.result(g.actionId, true, content);
    return { content };
  }

  private async onWrite(method: string, p: Rec): Promise<unknown> {
    const { path, content } = p;
    if (!isString(path) || !isString(content)) throw this.malformed(method, p);
    this.flushText();
    this.tracker.mediate(path);
    const inside = (q: string) => this.worktrees.resolveInside(this.o.cwd, q);
    const real = inside(path);
    // The write an allowed permission request promised, byte for byte: performed under that approval, not asked again.
    const approved = real === null ? null : this.tracker.claimWrite(real, content, inside);
    if (approved !== null) {
      try {
        await writeAtomic(real!, content);
      } catch (e) {
        this.tracker.disown(approved); // this is the call's result; its completion must not report another
        return this.refuse(approved.actionId!, errorMessage(e));
      }
      return {};
    }
    const g = await this.o.gate({ tool: method, kind: "file_write", summary: `Write ${display(this.o.cwd, path)}`, input: { path, content }, paths: [path] });
    if (g.decision !== "allow") throw new Error(g.reason);
    if (real === null) return this.refuse(g.actionId, OUTSIDE);
    try {
      await writeAtomic(real, content);
    } catch (e) {
      return this.refuse(g.actionId, errorMessage(e));
    }
    this.result(g.actionId, true, `wrote ${Buffer.byteLength(content, "utf8")} bytes`);
    return {};
  }

  private async onTerminalCreate(method: string, p: Rec): Promise<unknown> {
    const { command, args, env, cwd, outputByteLimit } = p;
    if (!isString(command) || !optional(args, isStringArray) || !optional(cwd, isString) || !optional(outputByteLimit, isNumber)) throw this.malformed(method, p);
    if (!optional(env, (v): v is { name: string; value: string }[] => Array.isArray(v) && v.every(isEnvVar))) throw this.malformed(method, p);
    this.flushText();
    this.tracker.mediate();
    const argv = args ?? [];
    const input: Rec = { command, args: argv, ...(cwd != null && { cwd }), ...(env != null && { env }), ...(outputByteLimit != null && { outputByteLimit }) };
    const summary = `Run: ${[command, ...argv].join(" ").slice(0, MAX_COMMAND)}`;
    const g = await this.o.gate({ tool: method, kind: "shell", summary, input, paths: cwd == null ? [] : [cwd] });
    if (g.decision !== "allow") throw new Error(g.reason);
    let dir = this.o.cwd;
    if (cwd != null) {
      const real = this.worktrees.resolveInside(this.o.cwd, cwd);
      if (real === null) return this.refuse(g.actionId, `cwd ${OUTSIDE}`);
      if (!(await stat(real).then((s) => s.isDirectory(), () => false))) return this.refuse(g.actionId, "cwd is not a directory");
      dir = real;
    }
    const terminalEnv = { ...this.terminalEnv };
    for (const v of env ?? []) terminalEnv[v.name] = v.value;
    const terminalId = this.terminals.create(command, argv, { cwd: dir, env: terminalEnv, outputByteLimit });
    this.terminalActions.set(terminalId, g.actionId);
    return { terminalId };
  }

  private async onTerminal(method: string, p: Rec): Promise<unknown> {
    const id = p.terminalId;
    if (!isString(id)) throw this.malformed(method, p);
    const known = (ok: boolean) => {
      if (!ok) throw this.unsupported(method, p, `unknown terminal from agent: ${method}`);
    };
    switch (method) {
      case "terminal/output": {
        const out = this.terminals.output(id);
        known(out !== undefined);
        return out;
      }
      case "terminal/wait_for_exit": {
        const exit = this.terminals.waitForExit(id);
        known(exit !== undefined);
        return await exit;
      }
      case "terminal/kill":
        known(this.terminals.kill(id));
        return {};
      default:
        known(this.terminals.release(id));
        return {};
    }
  }

  private onTerminalExit(terminalId: string, status: ExitStatus, output: string): void {
    const actionId = this.terminalActions.get(terminalId);
    if (actionId === undefined) return;
    this.terminalActions.delete(terminalId);
    this.result(actionId, status.exitCode === 0, output);
  }

  /** Records that an allowed action was not performed after all, and tells the agent it was denied. */
  private refuse(actionId: string, why: string): never {
    this.result(actionId, false, why);
    throw new Error(why);
  }
}

/** The whole file as UTF-8, only for a regular file of at most MAX_READ_BYTES. */
async function readCapped(real: string): Promise<string> {
  const st = await stat(real);
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.size > MAX_READ_BYTES) throw new Error("file is larger than 8 MiB");
  const h = await open(real, "r");
  try {
    const buf = await h.readFile();
    if (buf.length > MAX_READ_BYTES) throw new Error("file is larger than 8 MiB");
    return buf.toString("utf8");
  } finally {
    await h.close();
  }
}

/** Writes through a temp file in the same directory, then renames it into place. */
async function writeAtomic(real: string, content: string): Promise<void> {
  await mkdir(dirname(real), { recursive: true });
  const tmp = join(dirname(real), `.${basename(real)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, real);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}
