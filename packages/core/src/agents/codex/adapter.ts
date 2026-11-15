import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ActionKind } from "@theterminal/shared";
import { RATE_LIMIT_TEXT, retryAfterSeconds, type AdapterStartOptions, type AgentAdapter, type ProposedAction } from "../adapter.js";
import { CHILD_ENV_ALLOWLIST, CHILD_ENV_ALLOWLIST_PREFIXES, WIN32_ALLOWLIST, buildChildEnv } from "../child-env.js";
import { LOCAL_MODEL_ENV_ALLOWLIST } from "../../capacity/local-models.js";
import type { LocalModelSource } from "../../connections/service.js";
import { JsonRpcPeer } from "../jsonrpc.js";
import { heldTailStart, redact } from "../redact.js";
import { bundledCodex, type BundledCli } from "../bundled.js";
import { which } from "../which.js";
import * as P from "./protocol.js";

type StartResult = { status: "completed" | "failed"; error?: string };

const NO_CLI = "Codex CLI is unavailable: its bundled program is missing and none is on PATH";
const CMD_SHIM = "Codex CLI must be a native executable on Windows (found a .cmd shim)";
const NO_API_KEY = "No OpenAI API key configured";
const NOT_LOGGED_IN = "Codex is not logged in; run 'codex login' yourself";
const CANNOT_GATE = "Codex approval policy cannot gate every action";
const NETWORK_DENIED = "network access is not supported in Codex runs";
const HAS_RULES = "Codex has 'always allow' rules that would bypass approvals; remove them from your Codex rules folder or use API-key mode";
const RULES_UNCHECKED = "Codex rules could not be checked; use API-key mode";
const MCP_ENABLED = "Codex MCP servers could not be disabled; remove them or use API-key mode";
const NO_HOME = "Codex home folder could not be created";
/**
 * The adapter-owned, empty Codex home for api_key mode and local-model runs (one per project): no user rules, MCP
 * servers, hooks or login.
 */
export const CODEX_HOME_DIR = "codex-home";
const CHAT_WIRE_API = "Codex no longer supports the chat API style: set the local model connection's API style to responses";
/** The model provider a local-model thread runs on, and the variable that carries its server's key to Codex. */
const LOCAL_PROVIDER = "theterminal_local";
const LOCAL_KEY_VAR = "LOCAL_MODEL_API_KEY";
/** Project ids are generated names; anything else could climb out of the data directory. */
const PROJECT_ID = /^[A-Za-z0-9_-]+$/;
const STOPPED = "run stopped";
const CLIENT_VERSION = "0.0.0";
const MAX_STDIN_COMMAND = 60;
const MAX_STDIN_INPUT = 80;
const MAX_DIFF = 4000;
const MAX_MESSAGE = 256 * 1024;
const STDERR_KEEP = 4096;
const STDERR_TAIL = 200;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const INTERRUPT_WAIT_MS = 1000;
const EXIT_WAIT_MS = 2000;
const KILL_GRACE_MS = 5000;
/** MCP server names we can address as a dotted config key. */
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * What Codex would otherwise reach out for on its own, switched off for every run, so an offline run (a local model)
 * talks to nothing but its model server. Checked against the bundled Codex 0.169.0, whose config loader rejects a
 * wrong type or value for each of these keys (so each one exists): `check_for_update_on_startup` (bool),
 * `analytics.enabled` and `feedback.enabled` (bool), and `otel.exporter`, `otel.metrics_exporter` and
 * `otel.trace_exporter` (one of none, statsig, otlp-http, otlp-grpc). An unknown key is silently ignored, so that
 * check is what shows they are real. They are given at process start (`-c`), where analytics and telemetry are set
 * up, and again in every thread's config.
 */
const QUIET_CONFIG: Readonly<Record<string, boolean | string>> = {
  check_for_update_on_startup: false,
  "analytics.enabled": false,
  "feedback.enabled": false,
  "otel.exporter": "none",
  "otel.metrics_exporter": "none",
  "otel.trace_exporter": "none",
};
export const CODEX_QUIET_ARGS: readonly string[] = Object.entries(QUIET_CONFIG).flatMap(([k, v]) => [
  "-c", `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`,
]);

/**
 * The thread settings that put a local-model run on the model server, checked against the bundled Codex 0.169.0 with
 * an empty CODEX_HOME and no login: `thread/start` accepts these dotted keys and answers `modelProvider:
 * "theterminal_local"`; with `requires_openai_auth = false` the thread starts and the turn posts to
 * `<base_url>/responses` with no login at all (`account/read` still reports no account, so it is not asked); with
 * `env_key` the request carries `Authorization: Bearer <that variable>`, without it no Authorization header.
 * `wire_api = "chat"` is refused at `thread/start` ("no longer supported"), so the adapter refuses it first.
 */
function localModelConfig(m: LocalModelSource): Record<string, unknown> {
  const p = `model_providers.${LOCAL_PROVIDER}`;
  return {
    model: m.model,
    model_provider: LOCAL_PROVIDER,
    [`${p}.name`]: "Local model",
    [`${p}.base_url`]: m.baseUrl,
    [`${p}.wire_api`]: m.wireApi,
    [`${p}.requires_openai_auth`]: false,
    ...(m.apiKey ? { [`${p}.env_key`]: LOCAL_KEY_VAR } : {}),
  };
}

/**
 * Thread settings that keep every action behind our gate: `untrusted` asks for every command no exec-policy rule
 * allows and for every file change, approvals go to us rather than an auto-reviewer, and the sandbox may write
 * only the worktree, without network. Tools that would run without an approval request are switched off; any
 * that still appears is caught by the tripwire in `onItem`.
 */
const threadStartParams = (cwd: string, mcpServers: string[], localModel?: LocalModelSource): P.ThreadStartParams => ({
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
    "features.view_image": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.hooks": false,
    ...Object.fromEntries(mcpServers.map((name) => [`mcp_servers.${name}.enabled`, false])),
    ...QUIET_CONFIG,
    ...(localModel ? localModelConfig(localModel) : {}),
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
/** Notifications that only an executing command produces. */
const COMMAND_RUNNING = new Set([P.COMMAND_OUTPUT_DELTA, P.COMMAND_TERMINAL_INTERACTION]);

/** Whether `<dir>/rules` holds any `.rules` file. Only directory entry names are read, never file contents. */
async function hasRules(dir: string): Promise<boolean> {
  try {
    return (await readdir(join(dir, "rules"))).some((name) => name.toLowerCase().endsWith(".rules"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(RULES_UNCHECKED);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Any non-null network context marks a network request, even a malformed one: fail closed. */
const isNetworkRequest = (p: Record<string, unknown>): boolean => p.networkApprovalContext != null;
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
 * Summaries carry whole commands, which the runner redacts before it caps. The few parts capped here for layout
 * (a stdin approval's command and input, each diff preview) go through `clean` (the run's live redaction) first,
 * so a cut never leaves a fragment of a secret that no pattern matches.
 */
export function codexApprovalToAction(
  method: string,
  params: unknown,
  cwd: string,
  clean: (s: string) => string,
  changes?: P.FileUpdateChange[],
): ProposedAction {
  const p = isRecord(params) ? params : {};
  const display = (path: string) => displayPath(cwd, path);

  if (method === P.COMMAND_APPROVAL && isNetworkRequest(p)) {
    // Network access for a command that is already running: a separate web action, never the command itself.
    // A malformed context still counts as a network request.
    const ctx = isRecord(p.networkApprovalContext) ? p.networkApprovalContext : {};
    const host = str(ctx.host);
    const protocol = str(ctx.protocol);
    return {
      tool: "codex.network", kind: "web", summary: `Network access to ${host || "(unknown host)"} (${protocol || "unknown"})`,
      input: { host, protocol }, paths: [],
    };
  }

  if (method === P.COMMAND_APPROVAL && p.kind === "writeStdin") {
    // Input typed into a command that is already running (the input is the reason): never the command itself.
    // The summary shows what will be typed, with control characters escaped so a newline cannot hide. Both parts
    // are cleaned (then escaped) before they are cut, so a cut never leaves a fragment of a secret behind.
    const command = str(p.command);
    const dir = str(p.cwd);
    const reason = str(p.reason);
    const shownCommand = clean(command || "(no command)").slice(0, MAX_STDIN_COMMAND);
    const typed = JSON.stringify(clean(reason)).slice(1, -1).slice(0, MAX_STDIN_INPUT);
    return {
      tool: "codex.stdin",
      kind: "shell",
      summary: `Type into ${shownCommand}: ${typed}`,
      input: { command, cwd: dir, kind: p.kind, reason },
      paths: dir ? [dir] : [],
    };
  }

  if (method === P.COMMAND_APPROVAL) {
    const command = str(p.command);
    const dir = str(p.cwd);
    const reason = str(p.reason);
    return {
      tool: "codex.command",
      kind: "shell",
      summary: `Run: ${command || "(no command)"}`,
      input: { command, ...(dir ? { cwd: dir } : {}), ...(reason ? { reason } : {}) },
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
          ...(typeof c.diff === "string" && c.diff !== "" ? { diff: clean(c.diff).slice(0, MAX_DIFF) } : {}),
        })),
        ...(grantRoot ? { grantRoot } : {}),
      },
      paths,
    };
  }

  return { tool: `codex.${method}`, kind: "other", summary: `Unsupported Codex request: ${method}`, input: { method, params }, paths: [] };
}

type CommandSpec = { file: string; args: string[] };

/** Drives `codex app-server` (the bundled Codex CLI by default). Every command and file change waits for our gate. */
/**
 * What a Codex command never sees once a cloud grant turns off Codex's default *KEY*, *SECRET*, *TOKEN* filter
 * (`shell_environment_policy.exclude`: case-insensitive globs, the same syntax as those defaults). Defence in depth:
 * `include_only` already admits none of them.
 */
export const CODEX_COMMAND_EXCLUDES: readonly string[] = [
  "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_*", "CODEX_*", "NODE_REPL_AUTH_TOKEN",
  "LOCAL_MODEL_*",
];

/** The git pins buildChildEnv sets: a command keeps using the empty global git config. */
const GIT_PINS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"];

const POLICY_CONFLICT =
  "Your Codex configuration's shell_environment_policy conflicts with The Terminal's credential passing; remove `filters` from it";

/**
 * `-c` overrides that make a Codex command's env exactly the allowlisted variables, the git pins and the grant's own
 * variables: inherit everything (the CLI's env is already allowlisted), skip the default excludes that would drop
 * the grant's secrets and tokens, keep only those names, and exclude every provider key anyway.
 */
export function codexCommandPolicyArgs(grantNames: string[], platform: NodeJS.Platform = process.platform): string[] {
  // A local model's key is for Codex itself: never let it through, whatever the caller passes.
  const grants = grantNames.filter((n) => !LOCAL_MODEL_ENV_ALLOWLIST.includes(n));
  const includeOnly = [
    ...CHILD_ENV_ALLOWLIST, ...(platform === "win32" ? WIN32_ALLOWLIST : []), ...CHILD_ENV_ALLOWLIST_PREFIXES.map((p) => `${p}*`),
    ...GIT_PINS, ...grants,
  ];
  return [
    "-c", 'shell_environment_policy.inherit="all"',
    "-c", "shell_environment_policy.ignore_default_excludes=true",
    "-c", `shell_environment_policy.include_only=${JSON.stringify(includeOnly)}`,
    "-c", `shell_environment_policy.exclude=${JSON.stringify(CODEX_COMMAND_EXCLUDES)}`,
  ];
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  private readonly dataDir: string;
  private readonly bundled: () => BundledCli | null;
  private readonly bin: () => string | null;
  private readonly apiKey: () => string | undefined;
  private readonly spawn: typeof nodeSpawn;
  private readonly command: CommandSpec | undefined;
  private readonly exists: (p: string) => boolean;
  private readonly killGraceMs: number;
  private readonly fakeEnv: NodeJS.ProcessEnv;

  constructor(opts: {
    /** The data directory that holds the empty global git config (see WorktreeManager). */
    dataDir: string;
    /** The Codex CLI shipped with The Terminal. Default: `bundledCodex`. */
    bundled?: () => BundledCli | null;
    /** Locates a Codex CLI on PATH, consulted only when there is no bundled one. Default: `codex` on PATH. */
    bin?: () => string | null;
    apiKey?: () => string | undefined;
    spawn?: typeof nodeSpawn;
    /** Tests only: run this program (e.g. node + a fake server script) instead of the located binary. */
    command?: CommandSpec;
    /** Injectable for tests: whether a file exists (used to look behind an npm .cmd shim). */
    exists?: (p: string) => boolean;
    /** How long to wait after SIGTERM before SIGKILL. Default 5000. */
    killGraceMs?: number;
    /** Tests only: the fixture CLI's script variables, snapshotted once at construction (see fakeAgentEnv). */
    fakeEnv?: NodeJS.ProcessEnv;
  }) {
    this.dataDir = opts.dataDir;
    this.fakeEnv = opts.fakeEnv ?? {};
    this.bundled = opts.bundled ?? (() => bundledCodex());
    this.bin = opts.bin ?? (() => which("codex"));
    this.apiKey = opts.apiKey ?? (() => process.env.OPENAI_API_KEY);
    this.spawn = opts.spawn ?? nodeSpawn;
    this.command = opts.command;
    this.exists = opts.exists ?? existsSync;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  }

  async start(o: AdapterStartOptions): Promise<StartResult> {
    if (o.signal.aborted) return { status: "failed", error: STOPPED };
    // Mode "none" is a local model's: there is no login, only the model server on this computer.
    const localModel = o.authMode === "none" ? o.credentials.localModel : undefined;
    if (o.authMode !== "api_key" && o.authMode !== "chatgpt" && localModel === undefined) {
      return { status: "failed", error: `Unsupported auth mode for Codex: ${o.authMode}` };
    }
    if (localModel?.wireApi === "chat") return { status: "failed", error: CHAT_WIRE_API };
    let apiKey: string | undefined;
    if (o.authMode === "api_key") {
      apiKey = o.credentials.apiKey ?? this.apiKey();
      if (!apiKey) return { status: "failed", error: NO_API_KEY };
    }
    // A test command first, then the bundled CLI, and PATH only when the bundled one is missing.
    let cmd = this.command ?? this.bundled() ?? undefined;
    if (cmd === undefined) {
      const file = this.bin();
      if (file === null) return { status: "failed", error: NO_CLI };
      if (/\.cmd$/i.test(file)) {
        // Node cannot run a .cmd without a shell, and a shell would re-parse our arguments. An npm install's shim
        // runs this script with node, so run it the same way; anything else is refused.
        const script = join(dirname(file), "node_modules", "@openai", "codex", "bin", "codex.js");
        if (!this.exists(script)) return { status: "failed", error: CMD_SHIM };
        cmd = { file: process.execPath, args: [script] };
      } else {
        cmd = { file, args: [] };
      }
    }
    // api_key mode: keep the login in memory, so the user's own stored Codex login is never overwritten. A local model
    // has no login at all.
    const args = ["app-server", ...CODEX_QUIET_ARGS, ...(apiKey === undefined ? [] : ["-c", "cli_auth_credentials_store=ephemeral"])];
    // Codex drops every *KEY*, *SECRET* and *TOKEN* variable from the env of the commands it runs by default, which
    // would drop a cloud grant's secret and token. With a grant, its command env policy is set explicitly instead.
    // So it is with a local model's key, which Codex's own process needs (`env_key`) and its commands must never see:
    // the explicit policy leaves it out of `include_only` and lists it in `exclude`.
    const grantNames = Object.keys(o.credentials.env).filter((n) => !LOCAL_MODEL_ENV_ALLOWLIST.includes(n));
    const localKey: Record<string, string> = localModel?.apiKey ? { [LOCAL_KEY_VAR]: localModel.apiKey } : {};
    if (grantNames.length > 0 || localModel?.apiKey) args.push(...codexCommandPolicyArgs(grantNames));
    const extraEnv = { ...Object.fromEntries(grantNames.map((n) => [n, o.credentials.env[n]!])), ...localKey };
    const childEnv = buildChildEnv("codex", o.authMode, { apiKey, dataDir: this.dataDir, cliHome: o.credentials.cliHome, extraEnv, configHome: o.credentials.configHome });
    const env = { ...childEnv, ...this.fakeEnv };
    if (o.authMode === "api_key" || localModel !== undefined) {
      // An empty home of our own: none of the user's exec-policy rules, MCP servers or hooks apply. The runner's
      // per-run home when it gives one (a collaborator's run, which must find nothing of the Owner's or of other runs),
      // otherwise the project's shared one.
      if (!PROJECT_ID.test(o.projectId)) return { status: "failed", error: NO_HOME };
      const home = o.credentials.configHome ?? join(this.dataDir, "projects", o.projectId, CODEX_HOME_DIR);
      try {
        mkdirSync(home, { recursive: true });
      } catch {
        return { status: "failed", error: NO_HOME };
      }
      env.CODEX_HOME = home;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(cmd.file, [...cmd.args, ...args], {
        cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      return { status: "failed", error: NO_CLI };
    }
    return new CodexSession(o, child, apiKey, this.killGraceMs, localModel).run();
  }
}

/** One run: the handshake, the turn, approvals and notifications, and shutting the child down. */
class CodexSession {
  private readonly peer: JsonRpcPeer;
  private readonly exited: Promise<void>;
  /** The last STDERR_KEEP characters of stderr up to `stderrHeld`, cleaned. */
  private stderr = "";
  /** The raw tail of stderr that may still go on (see `heldTailStart`), cleaned with the rest once it ends. */
  private stderrHeld = "";
  private stderrWithheld = false;
  private threadId: string | undefined;
  private turnId: string | undefined;
  /** The latest cumulative token counts Codex reported for our thread. */
  private tokenTotal: { inputTokens: unknown; outputTokens: unknown } | undefined;
  /** Whether a rate limit was reported for the current error, so the failed turn that follows is not counted again. */
  private rateLimitSeen = false;
  /** Set once the run is ending: from then on every approval is declined. */
  private stopping = false;
  private settle!: (r: StartResult) => void;
  private readonly outcome = new Promise<StartResult>((r) => (this.settle = r));
  private readonly fileChanges = new Map<string, P.FileUpdateChange[]>();
  private readonly commands = new Map<string, { command: string; cwd: string }>();
  private readonly allowed = new Map<string, string>(); // item id -> action id
  private readonly reported = new Set<string>(); // item ids whose result was emitted
  private readonly messages = new Map<string, string>(); // item id -> aggregated deltas

  constructor(
    private readonly o: AdapterStartOptions,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly apiKey: string | undefined,
    private readonly killGraceMs: number,
    private readonly localModel: LocalModelSource | undefined,
  ) {
    this.exited = new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      child.once("close", () => r());
      child.once("error", () => r());
    });
    child.once("error", (e: NodeJS.ErrnoException) => {
      this.fail(e.code === "ENOENT" || e.code === "EACCES" ? NO_CLI : this.withStderr("Codex could not be started"));
    });
    const decoder = new StringDecoder("utf8");
    child.stderr.on("data", (d: Buffer) => this.onStderr(decoder.write(d)));
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
    void this.handshake().catch(async (e: unknown) => {
      // A Codex that exits at startup closes the pipe first: let its stderr arrive, so a known refusal is explained.
      if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.stdout.readable) {
        await Promise.race([this.exited, sleep(EXIT_WAIT_MS)]);
      }
      this.fail(this.policyConflict() ? POLICY_CONFLICT : redact(errorMessage(e)));
    });
    const result = await this.outcome;
    this.o.signal.removeEventListener("abort", onAbort);
    await this.shutdown(this.o.signal.aborted);
    return this.o.signal.aborted ? { status: "failed", error: STOPPED } : result;
  }

  private async handshake(): Promise<void> {
    const init = await this.peer.request<P.InitializeResponse>(P.INITIALIZE, {
      clientInfo: { name: "theterminal", title: null, version: CLIENT_VERSION }, capabilities: null,
    } satisfies P.InitializeParams);
    this.peer.notify(P.INITIALIZED);
    if (this.apiKey !== undefined) {
      try {
        await this.peer.request(P.ACCOUNT_LOGIN_START, { type: "apiKey", apiKey: this.apiKey } satisfies P.LoginAccountParams);
      } catch {
        return this.fail("Codex did not accept the API key login");
      }
    } else if (this.localModel === undefined) {
      const acct = await this.peer.request<P.GetAccountResponse>(P.ACCOUNT_READ, { refreshToken: false } satisfies P.GetAccountParams);
      if (!isRecord(acct) || !isRecord(acct.account)) return this.fail(NOT_LOGGED_IN);
    }
    // The Codex home in use (the user's own, or our isolated one) and the project may hold exec-policy allow
    // rules, which skip approval.
    const home = isRecord(init) ? str(init.codexHome) : "";
    if (!isAbsolute(home)) return this.fail(RULES_UNCHECKED);
    try {
      if ((await hasRules(home)) || (await hasRules(join(this.o.cwd, ".codex")))) return this.fail(HAS_RULES);
    } catch {
      return this.fail(RULES_UNCHECKED);
    }
    // MCP servers can run read-only tools without approval: switch every one off for this thread.
    const mcpServers = (await this.listMcpServers({})).map((s) => s.name);
    if (!mcpServers.every((n) => MCP_NAME.test(n))) return this.fail(MCP_ENABLED);
    if (this.stopping) return;

    let thread: P.ThreadStartResponse;
    try {
      thread = await this.peer.request<P.ThreadStartResponse>(P.THREAD_START, threadStartParams(this.o.cwd, mcpServers, this.localModel));
    } catch (e) {
      // Codex refused our thread settings (an older CLI, or managed requirements forbid them).
      if (/^rpc error:/.test(errorMessage(e))) return this.fail(CANNOT_GATE);
      throw e;
    }
    if (!isGated(thread) || typeof thread.thread?.id !== "string") return this.fail(CANNOT_GATE);
    this.threadId = thread.thread.id;
    // Always re-check: the thread may see servers the global list did not (e.g. a trusted project's config).
    const now = await this.listMcpServers({ threadId: this.threadId });
    if (!now.every((s) => s.runtimeStatus === "disabled")) return this.fail(MCP_ENABLED);
    if (this.stopping) return;

    const turn = await this.peer.request<P.TurnStartResponse>(P.TURN_START, {
      threadId: this.threadId, input: [{ type: "text", text: this.o.prompt, text_elements: [] }],
    } satisfies P.TurnStartParams);
    this.turnId ??= str(turn?.turn?.id) || undefined;
  }

  /** Every MCP server Codex knows of, following pagination. */
  private async listMcpServers(params: { threadId?: string }): Promise<P.McpServerStatus[]> {
    const all: P.McpServerStatus[] = [];
    let cursor: string | null = null;
    do {
      const page: P.ListMcpServerStatusResponse = await this.peer.request<P.ListMcpServerStatusResponse>(
        P.MCP_SERVER_STATUS_LIST, cursor === null ? params : { ...params, cursor },
      );
      if (!isRecord(page) || !Array.isArray(page.data)) throw new Error(MCP_ENABLED);
      for (const s of page.data) all.push({ name: isRecord(s) ? str(s.name) : "", runtimeStatus: isRecord(s) ? (s.runtimeStatus ?? null) : null });
      cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : null;
    } while (cursor !== null && all.length < 10_000);
    return all;
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
    if (!approval) {
      // We cannot serve it: record it as denied without asking anyone, and refuse it at once.
      const reason = `unsupported request ${method}`;
      this.refuse(method, params, reason);
      throw new Error(reason);
    }
    if (method === P.COMMAND_APPROVAL && isNetworkRequest(p)) {
      // Never asked: accepting may re-run the command outside the sandbox (orchestrator.rs). Recorded and declined.
      this.refuse(method, params, NETWORK_DENIED);
      return decline;
    }
    // The command item was announced before this request; its command fills in one the request leaves out.
    const cached = this.commands.get(itemId);
    const request = method === P.COMMAND_APPROVAL && cached !== undefined
      ? { ...p, command: p.command ?? cached.command, cwd: p.cwd ?? cached.cwd }
      : params;
    let g;
    try {
      g = await this.o.gate(codexApprovalToAction(method, request, this.o.cwd, this.o.clean, this.fileChanges.get(itemId)));
    } catch (e) {
      // Fail closed: the gate can no longer be trusted.
      this.fail(`gate error: ${redact(errorMessage(e))}`);
      return decline;
    }
    if (g.decision !== "allow" || this.stopping || itemId === "") return decline;
    // Input to a running command has its own item id and no item result; the running command keeps its own.
    if (p.kind !== "writeStdin") this.allowed.set(itemId, g.actionId);
    return { decision: "accept" };
  }

  /** Records a request we refuse without asking anyone; a failure to record it fails the run. */
  private refuse(method: string, params: unknown, reason: string): void {
    const failed = (e: unknown) => this.fail(`gate error: ${redact(errorMessage(e))}`);
    try {
      this.o.recordDenied(codexApprovalToAction(method, params, this.o.cwd, this.o.clean), reason).catch(failed);
    } catch (e) {
      failed(e);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    if (COMMAND_RUNNING.has(method)) {
      // Evidence that a command is executing: it must be one we accepted.
      const id = str(params.itemId);
      if (!this.allowed.has(id)) this.tripwire("commandExecution", { type: "commandExecution", id });
      return;
    }
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
      case P.TURN_STARTED: {
        // May arrive before the turn/start response: from here on only this turn's completion ends the run.
        const turn = isRecord(params.turn) ? params.turn : undefined;
        if (this.threadId !== undefined && str(params.threadId) !== this.threadId) return;
        this.turnId ??= str(turn?.id) || undefined;
        return;
      }
      case P.TOKEN_USAGE_UPDATED: {
        // Cumulative for the thread: remember the latest, report it once when the turn ends.
        if (this.threadId === undefined || str(params.threadId) !== this.threadId) return;
        const usage = isRecord(params.tokenUsage) && isRecord(params.tokenUsage.total) ? params.tokenUsage.total : undefined;
        if (usage !== undefined) this.tokenTotal = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        return;
      }
      case P.TURN_COMPLETED: {
        const turn = isRecord(params.turn) ? (params.turn as P.Turn) : undefined;
        if (turn === undefined || (this.turnId !== undefined && turn.id !== this.turnId)) return;
        // Codex reports token counts but no dollar cost.
        this.reportUsage();
        if (turn.status === "completed") return this.end({ status: "completed" });
        const error = isRecord(turn.error) ? str(turn.error.message) : "";
        if (!this.rateLimitSeen) this.noteRateLimit(error);
        return this.fail(redact(error || `Codex turn ${turn.status}`));
      }
      case P.ERROR: {
        const error = isRecord(params.error) ? str(params.error.message) : "";
        // A rate limit Codex retries is still one the provider imposed: each such notification is counted.
        this.rateLimitSeen = this.noteRateLimit(error);
        if (params.willRetry === true) return;
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
    if (method === P.ITEM_STARTED) {
      // Both are announced before their approval request; remember what they will do. Starting is not running:
      // a command that runs unapproved shows output or completes, and that trips below.
      if (type === "fileChange") {
        const changes = (item as { changes?: unknown }).changes;
        if (!this.allowed.has(id)) this.fileChanges.set(id, Array.isArray(changes) ? (changes as P.FileUpdateChange[]) : []);
      } else {
        this.commands.set(id, { command: str((item as { command?: unknown }).command), cwd: str((item as { cwd?: unknown }).cwd) });
      }
      return;
    }
    const actionId = this.allowed.get(id);
    if (actionId === undefined) {
      // Completing without our accept means it bypassed us (a declined one completes as declined).
      if (status !== "declined") this.tripwire(type, item);
      return;
    }
    if (this.reported.has(id)) return;
    this.reported.add(id);
    this.commands.delete(id);
    this.fileChanges.delete(id);
    const ok = status === "completed";
    const output =
      type === "commandExecution"
        ? str((item as { aggregatedOutput?: unknown }).aggregatedOutput)
        : `${status}: ${this.changedPaths(item)}`;
    this.o.emit({ type: "action_result", actionId, ok, output }); // whole: the runner caps it after redacting
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
    this.o.recordDenied(action, "ran without approval").catch(() => {});
    this.fail(`Codex ran ${label} without approval`);
  }

  /**
   * Emits rate_limited when an error message reads as a rate limit (a heuristic: Codex's `account/rateLimits/*`
   * figures are not read yet), with the wait it names. Returns whether it did.
   */
  private noteRateLimit(message: string): boolean {
    if (!RATE_LIMIT_TEXT.test(message)) return false;
    const retryAfterS = retryAfterSeconds(message);
    this.o.emit(retryAfterS === undefined ? { type: "rate_limited" } : { type: "rate_limited", retryAfterS });
    return true;
  }

  private fail(error: string): void {
    this.end({ status: "failed", error });
  }

  private end(r: StartResult): void {
    if (this.stopping) return;
    this.stopping = true;
    this.settle(r);
  }

  /** Emits the thread's token totals once (the counts are cumulative), if Codex reported any. */
  private reportUsage(): void {
    const t = this.tokenTotal;
    this.tokenTotal = undefined;
    if (t === undefined) return;
    const counts = Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
    if (Object.keys(counts).length > 0) this.o.emit({ type: "usage", ...counts });
  }

  /**
   * Adds stderr text to the window. Only what can no longer go on is cleaned (see `heldTailStart`): a chunk can end
   * inside a secret, and cleaning that part alone could redact it and leave the rest of it, which follows in the next
   * chunk, plain. The window is cut only after cleaning. Without a working clean, stderr is withheld for good.
   */
  private onStderr(text: string): void {
    if (this.stderrWithheld || text === "") return;
    const raw = this.stderrHeld + text;
    const held = heldTailStart(raw);
    this.stderrHeld = raw.slice(held);
    if (held === 0) return;
    try {
      this.stderr = this.o.clean(this.stderr + raw.slice(0, held)).slice(-STDERR_KEEP);
    } catch {
      this.stderr = this.stderrHeld = "";
      this.stderrWithheld = true;
    }
  }

  /** Codex refused to start: the user's own policy uses `filters`, and ours sets `exclude` and `include_only`. */
  private policyConflict(): boolean {
    return (this.stderr + this.stderrHeld).includes("cannot mix `filters` with legacy");
  }

  private withStderr(msg: string): string {
    if (this.policyConflict()) return POLICY_CONFLICT;
    // Cleaned whole (the held tail too) before the tail is cut, so the cut never leaves part of a secret behind; no
    // tail if that fails.
    let tail = "";
    try {
      tail = this.o.clean((this.stderr + this.stderrHeld).replace(/\x1b\[[0-9;]*m/g, "")).trim().slice(-STDERR_TAIL);
    } catch {
      // Report the failure without the tail.
    }
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
      if (await waitExit(this.killGraceMs)) return;
      this.child.kill("SIGKILL");
    }
    await waitExit(KILL_GRACE_MS);
  }
}
