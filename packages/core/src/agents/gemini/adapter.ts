import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ToolCallTracker, type ToolCallUpdate, type ToolStatus } from "./tool-calls.js";

type StartResult = { status: "completed" | "failed"; error?: string };
type Spawn = typeof nodeSpawn;
type Rec = Record<string, unknown>;

const NO_API_KEY = "No Gemini API key configured";
const NO_CLI = "Gemini CLI is not installed or not on PATH";
const CMD_SHIM = "Gemini CLI on PATH is a .cmd shim, which cannot be run without a shell; install a native gemini executable";
const NOT_LOGGED_IN = "Gemini is not logged in; run 'gemini' once yourself";
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
 * Gemini's built-in tools that run only through our gate: `read_file` reads through `fs/read_text_file`;
 * `write_file` and `replace` ask permission and then write through `fs/write_text_file`; `run_shell_command`
 * asks permission. Everything else (glob, grep, list_directory, read_many_files, web fetch and search,
 * memory, todos, skills, subagents) would run inside Gemini without asking, so it is not loaded.
 */
const CORE_TOOLS = ["read_file", "write_file", "replace", "run_shell_command"];
/** `--extensions none` loads no extension; the MCP allowlist names a server that does not exist, so none connects. */
const ACP_ARGS = ["--acp", "--approval-mode", "default", "--extensions", "none", "--allowed-mcp-server-names", "theterminal-none"];
const MAX_COMMAND = 150;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_CHUNK = 4000;
const MESSAGE_PAUSE_MS = 250;
const STDERR_TAIL = 500;
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

/** Lines `line` (1-based) onwards, at most `limit` of them, each with its line ending. */
function selectLines(text: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (line == null && limit == null) return text;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const start = line == null ? 0 : Math.max(Math.floor(line) - 1, 0);
  return lines.slice(start, limit == null ? undefined : start + Math.max(Math.floor(limit), 0)).join("");
}

function geminiSettings(mode: AuthMode): Rec {
  return {
    security: { auth: { selectedType: mode === "google" ? "oauth-personal" : "gemini-api-key" }, disableAlwaysAllow: true },
    tools: { core: CORE_TOOLS, allowed: [] },
  };
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
  private readonly command: { file: string; args: string[] } | undefined;
  private readonly worktrees: WorktreeManager;

  constructor(opts: {
    /** The data directory that holds the empty global git config (see WorktreeManager). */
    dataDir: string;
    /** Locates the user's own Gemini CLI. Default: `gemini` on PATH. */
    bin?: () => string | null;
    apiKey?: () => string | undefined;
    spawn?: Spawn;
    /** Test override: spawn this program (with these arguments before the ACP flags) instead of the CLI. */
    command?: { file: string; args: string[] };
  }) {
    this.dataDir = opts.dataDir;
    this.bin = opts.bin ?? (() => which("gemini"));
    this.apiKey = opts.apiKey ?? (() => process.env.GEMINI_API_KEY);
    this.spawn = opts.spawn ?? nodeSpawn;
    this.command = opts.command;
    this.worktrees = new WorktreeManager(opts.dataDir);
  }

  async start(o: AdapterStartOptions): Promise<StartResult> {
    if (o.signal.aborted) return { status: "failed", error: STOPPED };
    const env = this.env(o.authMode);
    if (typeof env === "string") return { status: "failed", error: env };
    let file: string;
    let args: string[];
    if (this.command) {
      file = this.command.file;
      args = [...this.command.args, ...ACP_ARGS];
    } else {
      const bin = this.bin();
      if (bin === null) return { status: "failed", error: NO_CLI };
      if (/\.(?:cmd|bat)$/i.test(bin)) return { status: "failed", error: CMD_SHIM }; // a shim needs a shell; never spawn with one
      file = bin;
      args = ACP_ARGS;
    }
    const settingsDir = mkdtempSync(join(tmpdir(), "theterminal-gemini-"));
    try {
      const settings = join(settingsDir, "settings.json");
      writeFileSync(settings, JSON.stringify(geminiSettings(o.authMode)));
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settings; // system settings win the merge over the user's and the workspace's
      env.NO_BROWSER = "true"; // a missing Google login fails instead of opening a browser from a background run
      return await new GeminiRun(o, this.spawn, this.worktrees, env).run(file, args);
    } finally {
      rmSync(settingsDir, { recursive: true, force: true });
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
    this.terminalEnv = { ...env };
    delete this.terminalEnv.GEMINI_API_KEY;
    delete this.terminalEnv.GOOGLE_API_KEY;
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

  /** A setup request with a short timeout. In Google-login mode a failure here means Gemini could not log in. */
  private async setup(method: string, params: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini did not answer ${method} in time`)), SETUP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.peer.request(method, params), timeout]);
    } catch (e) {
      if (this.o.authMode === "google" && !this.o.signal.aborted) throw new Error(NOT_LOGGED_IN);
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
    // Recorded through the gate (the runner denies it as the run ends) and the run fails: nothing more of it may run.
    const title = ev.call.title || `${ev.call.kind ?? "unknown"} tool`;
    void this.o.gate({ tool: toolName(u), kind: "other", summary: `Ungated tool: ${title}`, input: u, paths: [] }).catch(() => undefined);
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
        this.fail(`unknown request from agent: ${method}`);
        throw new Error("unknown request");
    }
  }

  /** The request's params when they are an object for our session; otherwise the run fails. */
  private params(method: string, params: unknown): Rec {
    if (!isRecord(params) || params.sessionId !== this.sessionId) throw this.malformed(method);
    return params;
  }

  private malformed(method: string): Error {
    this.fail(`malformed request from agent: ${method}`);
    return new Error("malformed request");
  }

  private result(actionId: string, ok: boolean, output: string): void {
    this.o.emit({ type: "action_result", actionId, ok, output });
  }

  private async onPermission(p: Rec): Promise<unknown> {
    const tc = p.toolCall;
    if (!isRecord(tc) || typeof tc.toolCallId !== "string" || !Array.isArray(p.options)) throw this.malformed("session/request_permission");
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
    this.tracker.permission(this.asUpdate(tc), g.actionId);
    return { outcome: { outcome: "selected", optionId: once.optionId } };
  }

  private async onRead(method: string, p: Rec): Promise<unknown> {
    const { path, line, limit } = p;
    if (!isString(path) || !optional(line, isNumber) || !optional(limit, isNumber)) throw this.malformed(method);
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
    if (!isString(path) || !isString(content)) throw this.malformed(method);
    this.flushText();
    this.tracker.mediate(path);
    const g = await this.o.gate({ tool: method, kind: "file_write", summary: `Write ${display(this.o.cwd, path)}`, input: { path, content }, paths: [path] });
    if (g.decision !== "allow") throw new Error(g.reason);
    const real = this.worktrees.resolveInside(this.o.cwd, path);
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
    if (!isString(command) || !optional(args, isStringArray) || !optional(cwd, isString) || !optional(outputByteLimit, isNumber)) throw this.malformed(method);
    if (!optional(env, (v): v is { name: string; value: string }[] => Array.isArray(v) && v.every(isEnvVar))) throw this.malformed(method);
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
    if (!isString(id)) throw this.malformed(method);
    const known = (ok: boolean) => {
      if (!ok) {
        this.fail(`unknown terminal from agent: ${method}`);
        throw new Error("unknown terminal");
      }
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
