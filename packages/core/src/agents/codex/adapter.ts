import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { ActionKind } from "@theterminal/shared";
import type { AdapterStartOptions, AgentAdapter, ProposedAction } from "../adapter.js";
import { buildChildEnv } from "../child-env.js";
import { JsonRpcPeer } from "../jsonrpc.js";
import { redact } from "../redact.js";
import { which } from "../which.js";
import * as P from "./protocol.js";

type StartResult = { status: "completed" | "failed"; error?: string };

const NO_CLI = "Codex CLI is not installed or not on PATH";
const CMD_SHIM = "Codex CLI must be a native executable on Windows (found a .cmd shim)";
const NO_API_KEY = "No OpenAI API key configured";
const NOT_LOGGED_IN = "Codex is not logged in; run 'codex login' yourself";
const CANNOT_GATE = "Codex approval policy cannot gate every action";
const STOPPED = "run stopped";
const CLIENT_VERSION = "0.0.0";
const MAX_COMMAND = 150;
const MAX_DIFF = 4000;
const MAX_OUTPUT = 4000;
const MAX_MESSAGE = 256 * 1024;
const STDERR_KEEP = 4096;
const STDERR_TAIL = 200;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const INTERRUPT_WAIT_MS = 1000;
const EXIT_WAIT_MS = 2000;
const KILL_GRACE_MS = 5000;

/**
 * Thread settings that keep every action behind our gate: `untrusted` asks for every command no exec-policy rule
 * allows and for every file change, approvals go to us rather than an auto-reviewer, and the sandbox may write
 * only the worktree, without network. Tools that would run without an approval request are switched off; any
 * that still appears is caught by the tripwire in `onItem`.
 */
const threadStartParams = (cwd: string): P.ThreadStartParams => ({
  cwd,
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
  sandbox: "workspace-write",
  ephemeral: true, // no session files written under the user's Codex home
  config: {
    web_search: "disabled",
    "sandbox_workspace_write.network_access": false,
    "sandbox_workspace_write.exclude_slash_tmp": true,
    "sandbox_workspace_write.exclude_tmpdir_env_var": true,
    "features.apps": false,
    "features.plugins": false,
    "features.browser_use": false,
    "features.computer_use": false,
    "features.image_generation": false,
    "features.multi_agent": false,
    "features.hooks": false,
  },
});

/** Whether the thread Codex actually started asks us before every command and file change. */
const isGated = (r: P.ThreadStartResponse): boolean =>
  r?.approvalPolicy === "untrusted" &&
  r.approvalsReviewer === "user" &&
  r.sandbox?.type === "workspaceWrite" &&
  r.sandbox.networkAccess === false;

/** Item types that are not actions (or are gated by an approval request). Anything else ran without our gate. */
const BENIGN_ITEMS = new Set([
  "userMessage", "agentMessage", "reasoning", "plan", "contextCompaction", "hookPrompt",
  "enteredReviewMode", "exitedReviewMode", "sleep", "functionCallOutput",
]);
const GATED_ITEMS = new Set(["commandExecution", "fileChange"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** A path for a summary: relative when inside `cwd`, with / on every platform. */
function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return (rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? path : rel).replace(/\\/g, "/");
}

const changeKind = (c: P.FileUpdateChange): "add" | "delete" | "update" =>
  c.kind?.type === "add" || c.kind?.type === "delete" ? c.kind.type : "update";
const movePath = (c: P.FileUpdateChange): string | null =>
  c.kind?.type === "update" && typeof c.kind.move_path === "string" && c.kind.move_path !== "" ? c.kind.move_path : null;

/**
 * Maps a Codex server-request to a ProposedAction. `paths` come only from the request (and, for a file change,
 * the changes Codex announced for that item); the policy decides. Unknown methods are `other`, so a human decides.
 */
export function codexApprovalToAction(
  method: string,
  params: unknown,
  cwd: string,
  changes?: P.FileUpdateChange[],
): ProposedAction {
  const p = isRecord(params) ? params : {};
  const display = (path: string) => displayPath(cwd, path);

  if (method === P.COMMAND_APPROVAL) {
    const command = str(p.command);
    const dir = str(p.cwd);
    return {
      tool: "codex.command",
      kind: "shell",
      summary: `Run: ${(command || "(no command)").slice(0, MAX_COMMAND)}`,
      input: dir ? { command, cwd: dir } : { command },
      paths: dir ? [dir] : [],
    };
  }

  if (method === P.FILE_CHANGE_APPROVAL) {
    const list = (changes ?? []).filter((c) => isRecord(c) && typeof c.path === "string" && c.path !== "");
    const paths = list.flatMap((c) => [c.path, ...(movePath(c) === null ? [] : [movePath(c)!])]);
    const grantRoot = str(p.grantRoot);
    if (grantRoot) paths.push(grantRoot);
    const allEdits = list.length > 0 && list.every((c) => changeKind(c) === "update" && movePath(c) === null);
    const kind: ActionKind = allEdits && !grantRoot ? "file_edit" : "file_write";
    const first = list[0];
    const verb = first === undefined ? "Edit" : { add: "Create", delete: "Delete", update: "Edit" }[changeKind(first)];
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : "";
    return {
      tool: "codex.fileChange",
      kind,
      summary: first === undefined ? "Edit (unknown files)" : `${verb} ${display(first.path)}${more}`,
      input: {
        changes: list.map((c) => ({
          path: c.path,
          kind: changeKind(c),
          ...(movePath(c) === null ? {} : { movePath: movePath(c) }),
          ...(typeof c.diff === "string" && c.diff !== "" ? { diff: c.diff.slice(0, MAX_DIFF) } : {}),
        })),
        ...(grantRoot ? { grantRoot } : {}),
      },
      paths,
    };
  }

  return { tool: `codex.${method}`, kind: "other", summary: `Unsupported Codex request: ${method}`, input: { method, params }, paths: [] };
}

type CommandSpec = { file: string; args: string[] };

/** Drives the user's installed `codex app-server`. Every command and file change waits for our gate. */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  private readonly dataDir: string;
  private readonly bin: () => string | null;
  private readonly apiKey: () => string | undefined;
  private readonly spawn: typeof nodeSpawn;
  private readonly command: CommandSpec | undefined;

  constructor(opts: {
    /** The data directory that holds the empty global git config (see WorktreeManager). */
    dataDir: string;
    /** Locates the user's own Codex CLI. Default: `codex` on PATH. */
    bin?: () => string | null;
    apiKey?: () => string | undefined;
    spawn?: typeof nodeSpawn;
    /** Tests only: run this program (e.g. node + a fake server script) instead of the located binary. */
    command?: CommandSpec;
  }) {
    this.dataDir = opts.dataDir;
    this.bin = opts.bin ?? (() => which("codex"));
    this.apiKey = opts.apiKey ?? (() => process.env.OPENAI_API_KEY);
    this.spawn = opts.spawn ?? nodeSpawn;
    this.command = opts.command;
  }

  async start(o: AdapterStartOptions): Promise<StartResult> {
    if (o.signal.aborted) return { status: "failed", error: STOPPED };
    if (o.authMode !== "api_key" && o.authMode !== "chatgpt") {
      return { status: "failed", error: `Unsupported auth mode for Codex: ${o.authMode}` };
    }
    let apiKey: string | undefined;
    if (o.authMode === "api_key") {
      apiKey = this.apiKey();
      if (!apiKey) return { status: "failed", error: NO_API_KEY };
    }
    let cmd = this.command;
    if (cmd === undefined) {
      const file = this.bin();
      if (file === null) return { status: "failed", error: NO_CLI };
      // Node cannot run a .cmd without a shell, and a shell would re-parse our arguments.
      if (/\.cmd$/i.test(file)) return { status: "failed", error: CMD_SHIM };
      cmd = { file, args: [] };
    }
    // api_key mode: keep the login in memory, so the user's own stored Codex login is never overwritten.
    const args = ["app-server", ...(apiKey === undefined ? [] : ["-c", "cli_auth_credentials_store=ephemeral"])];
    const env = buildChildEnv("codex", o.authMode, { apiKey, dataDir: this.dataDir });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(cmd.file, [...cmd.args, ...args], {
        cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      return { status: "failed", error: NO_CLI };
    }
    return new CodexSession(o, child, apiKey).run();
  }
}

/** One run: the handshake, the turn, approvals and notifications, and shutting the child down. */
class CodexSession {
  private readonly peer: JsonRpcPeer;
  private readonly exited: Promise<void>;
  private stderr = "";
  private threadId: string | undefined;
  private turnId: string | undefined;
  /** Set once the run is ending: from then on every approval is declined. */
  private stopping = false;
  private settle!: (r: StartResult) => void;
  private readonly outcome = new Promise<StartResult>((r) => (this.settle = r));
  private readonly fileChanges = new Map<string, P.FileUpdateChange[]>();
  private readonly allowed = new Map<string, string>(); // item id -> action id
  private readonly messages = new Map<string, string>(); // item id -> aggregated deltas

  constructor(
    private readonly o: AdapterStartOptions,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly apiKey: string | undefined,
  ) {
    this.exited = new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      child.once("close", () => r());
      child.once("error", () => r());
    });
    child.once("error", (e: NodeJS.ErrnoException) => {
      this.fail(e.code === "ENOENT" || e.code === "EACCES" ? NO_CLI : this.withStderr("Codex could not be started"));
    });
    child.stderr.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf8")).slice(-STDERR_KEEP);
    });
    this.peer = new JsonRpcPeer(
      { input: child.stdout, output: child.stdin },
      {
        onRequest: (m, p) => this.onRequest(m, p),
        onNotification: (m, p) => this.onNotification(m, p),
        allowMissingVersion: true,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    // Give a spawn error and the last stderr a moment to arrive, so the error says why.
    void this.peer.closed
      .then(() => Promise.race([this.exited, sleep(EXIT_WAIT_MS)]))
      .then(() => this.fail(this.withStderr("Codex exited before the turn completed")));
  }

  async run(): Promise<StartResult> {
    const onAbort = () => this.end({ status: "failed", error: STOPPED });
    this.o.signal.addEventListener("abort", onAbort, { once: true });
    void this.handshake().catch((e: unknown) => this.fail(redact(errorMessage(e))));
    const result = await this.outcome;
    this.o.signal.removeEventListener("abort", onAbort);
    await this.shutdown(this.o.signal.aborted);
    return this.o.signal.aborted ? { status: "failed", error: STOPPED } : result;
  }

  private async handshake(): Promise<void> {
    await this.peer.request(P.INITIALIZE, {
      clientInfo: { name: "theterminal", title: null, version: CLIENT_VERSION }, capabilities: null,
    } satisfies P.InitializeParams);
    this.peer.notify(P.INITIALIZED);
    if (this.apiKey !== undefined) {
      try {
        await this.peer.request(P.ACCOUNT_LOGIN_START, { type: "apiKey", apiKey: this.apiKey } satisfies P.LoginAccountParams);
      } catch {
        return this.fail("Codex did not accept the API key login");
      }
    } else {
      const acct = await this.peer.request<P.GetAccountResponse>(P.ACCOUNT_READ, { refreshToken: false } satisfies P.GetAccountParams);
      if (!isRecord(acct) || !isRecord(acct.account)) return this.fail(NOT_LOGGED_IN);
    }
    if (this.stopping) return;

    let thread: P.ThreadStartResponse;
    try {
      thread = await this.peer.request<P.ThreadStartResponse>(P.THREAD_START, threadStartParams(this.o.cwd));
    } catch (e) {
      // Codex refused our thread settings (an older CLI, or managed requirements forbid them).
      if (/^rpc error:/.test(errorMessage(e))) return this.fail(CANNOT_GATE);
      throw e;
    }
    if (!isGated(thread) || typeof thread.thread?.id !== "string") return this.fail(CANNOT_GATE);
    this.threadId = thread.thread.id;
    if (this.stopping) return;

    const turn = await this.peer.request<P.TurnStartResponse>(P.TURN_START, {
      threadId: this.threadId, input: [{ type: "text", text: this.o.prompt, text_elements: [] }],
    } satisfies P.TurnStartParams);
    this.turnId ??= str(turn?.turn?.id) || undefined;
  }

  private async onRequest(method: string, params: unknown): Promise<P.ApprovalResponse> {
    const decline: P.ApprovalResponse = { decision: "decline" };
    const p = isRecord(params) ? params : {};
    const itemId = str(p.itemId);
    const approval = method === P.COMMAND_APPROVAL || method === P.FILE_CHANGE_APPROVAL;
    if (this.stopping) {
      if (approval) return decline;
      throw new Error("run is ending");
    }
    const action = codexApprovalToAction(method, params, this.o.cwd, this.fileChanges.get(itemId));
    let g;
    try {
      g = await this.o.gate(action);
    } catch (e) {
      // Fail closed: the gate can no longer be trusted.
      this.fail(`gate error: ${redact(errorMessage(e))}`);
      if (approval) return decline;
      throw new Error("denied");
    }
    if (!approval) {
      // Recorded and decided, but we cannot serve it: refuse it whatever the decision.
      if (g.decision === "allow") {
        this.o.emit({ type: "action_result", actionId: g.actionId, ok: false, output: `unsupported request ${method}` });
      }
      throw new Error(`unsupported request ${method}`);
    }
    if (g.decision !== "allow" || this.stopping || itemId === "") return decline;
    this.allowed.set(itemId, g.actionId);
    return { decision: "accept" };
  }

  private onNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    switch (method) {
      case P.ITEM_STARTED:
      case P.ITEM_COMPLETED:
        if (isRecord(params.item)) this.onItem(method, params.item as P.ThreadItem);
        return;
      case P.AGENT_MESSAGE_DELTA: {
        const id = str(params.itemId);
        const text = (this.messages.get(id) ?? "") + str(params.delta);
        this.messages.set(id, text.slice(0, MAX_MESSAGE));
        return;
      }
      case P.TURN_COMPLETED: {
        const turn = isRecord(params.turn) ? (params.turn as P.Turn) : undefined;
        if (turn === undefined || (this.turnId !== undefined && turn.id !== this.turnId)) return;
        // Codex reports token counts but no dollar cost, so no usage event is emitted.
        if (turn.status === "completed") return this.end({ status: "completed" });
        const error = isRecord(turn.error) ? str(turn.error.message) : "";
        return this.fail(redact(error || `Codex turn ${turn.status}`));
      }
      case P.ERROR: {
        if (params.willRetry === true) return;
        const error = isRecord(params.error) ? str(params.error.message) : "";
        return this.fail(redact(error || "Codex reported an error"));
      }
    }
  }

  private onItem(method: string, item: P.ThreadItem): void {
    const id = str(item.id);
    const type = str(item.type);
    if (type === "agentMessage" && method === P.ITEM_COMPLETED) {
      const text = str((item as { text?: unknown }).text) || this.messages.get(id) || "";
      this.messages.delete(id);
      if (text) this.o.emit({ type: "message", text });
      return;
    }
    if (BENIGN_ITEMS.has(type)) return;
    if (!GATED_ITEMS.has(type)) return this.tripwire(type, item);

    const status = str((item as { status?: unknown }).status);
    if (type === "fileChange" && method === P.ITEM_STARTED) {
      // Announced before its approval request, which carries only the item id.
      const changes = (item as { changes?: unknown }).changes;
      this.fileChanges.set(id, Array.isArray(changes) ? (changes as P.FileUpdateChange[]) : []);
      return;
    }
    const actionId = this.allowed.get(id);
    if (actionId === undefined) {
      // A command starts only once approved; a change completes only once approved. Anything else bypassed us.
      if (status !== "declined") this.tripwire(type, item);
      return;
    }
    if (method !== P.ITEM_COMPLETED) return;
    this.allowed.delete(id);
    this.fileChanges.delete(id);
    const ok = status === "completed";
    const output =
      type === "commandExecution"
        ? str((item as { aggregatedOutput?: unknown }).aggregatedOutput)
        : `${status}: ${this.changedPaths(item)}`;
    this.o.emit({ type: "action_result", actionId, ok, output: output.slice(0, MAX_OUTPUT) });
  }

  private changedPaths(item: P.ThreadItem): string {
    const changes = (item as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) return "";
    return changes.map((c) => (isRecord(c) ? displayPath(this.o.cwd, str(c.path)) : "")).join(", ");
  }

  /** Codex did something that never reached our gate: record it, then end the run. */
  private tripwire(type: string, item: P.ThreadItem): void {
    const label = type || "an unknown item";
    const action: ProposedAction = {
      tool: `codex.${label}`, kind: "other", summary: `Codex ran ${label} without approval`, input: { item }, paths: [],
    };
    // Not awaited: the run is ending, and the runner denies whatever is still pending when it does.
    void Promise.resolve()
      .then(() => this.o.gate(action))
      .catch(() => {});
    this.fail(`Codex ran ${label} without approval`);
  }

  private fail(error: string): void {
    this.end({ status: "failed", error });
  }

  private end(r: StartResult): void {
    if (this.stopping) return;
    this.stopping = true;
    this.settle(r);
  }

  private withStderr(msg: string): string {
    const tail = this.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-STDERR_TAIL);
    return tail ? `${msg}: ${tail}` : msg;
  }

  /** Interrupts (on abort), then closes stdin, SIGTERM, and SIGKILL after the grace period. Waits for the exit. */
  private async shutdown(aborted: boolean): Promise<void> {
    const running = () => this.child.exitCode === null && this.child.signalCode === null;
    const waitExit = (ms: number) => Promise.race([this.exited.then(() => true), sleep(ms).then(() => false)]);
    if (aborted && running() && this.threadId !== undefined && this.turnId !== undefined) {
      const interrupt = this.peer.request(P.TURN_INTERRUPT, { threadId: this.threadId, turnId: this.turnId } satisfies P.TurnInterruptParams);
      await Promise.race([interrupt.catch(() => {}), sleep(INTERRUPT_WAIT_MS)]);
    }
    this.peer.close("done");
    if (running()) {
      this.child.stdin.end();
      if (!aborted && (await waitExit(EXIT_WAIT_MS))) return;
    }
    if (running()) {
      this.child.kill("SIGTERM");
      if (await waitExit(KILL_GRACE_MS)) return;
      this.child.kill("SIGKILL");
    }
    await waitExit(KILL_GRACE_MS);
  }
}
