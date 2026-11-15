import { execFile as nodeExecFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { arch, cpus, release, totalmem } from "node:os";
import { promisify } from "node:util";
import Fastify from "fastify";
import { openDatabase, type Db } from "../db.js";
import { Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService } from "../board/board-service.js";
import { registerRoutes } from "./routes.js";
import { registerAuth, APP_HOST } from "./auth.js";
import { registerStaticUi } from "./static-ui.js";
import { acquireDataDirLock } from "./data-dir-lock.js";
import { registerLedgerStream } from "./events-ws.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { registerIntakeRoutes } from "./intake-routes.js";
import { registerStoryRoutes } from "./story-routes.js";
import { IntakeService } from "../intake/service.js";
import { GateService } from "../gates/service.js";
import { registerGitHubRoutes } from "./github-routes.js";
import { registerCapacityRoutes } from "./capacity-routes.js";
import { GitHubClient } from "../github/client.js";
import { ConnectionService } from "../connections/service.js";
import { SignInManager, fakeLoginEnv } from "../connections/signin.js";
import { commitEvent } from "../events/commit.js";
import { CONNECTION_TESTERS, cloudTesters } from "../connections/testers.js";
import { fakeSts, realSts, type StsCaller } from "../connections/cloud/aws.js";
import { mintCloudGrant } from "../connections/cloud/grant.js";
import { ChunkedSecretStore, type SecretStore } from "../secrets/store.js";
import { KeychainSecretStore } from "../secrets/keychain-store.js";
import { MemorySecretStore } from "../secrets/memory-store.js";
import { ADAPTERS, PROVIDERS, type AdapterId, type HardwareInfo, type Provider } from "@theterminal/shared";
import { detectHardware, fakeHardware, type ExecFile } from "../capacity/hardware.js";
import type { AgentAdapter } from "../agents/adapter.js";
import { ApprovalBroker } from "../agents/approvals.js";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { fakeAgentEnv } from "../agents/child-env.js";
import { CodexAdapter } from "../agents/codex/adapter.js";
import { FakeAdapter, type FakeStep } from "../agents/fake-adapter.js";
import { GeminiAdapter } from "../agents/gemini/adapter.js";
import { secretEnvValues } from "../agents/redact.js";
import { AgentRunner } from "../agents/runner.js";
import { ProviderSettings } from "../agents/settings.js";
import { bundledClaude, bundledCodex, bundledGemini, type BundledCli } from "../agents/bundled.js";
import { which as whichOnPath } from "../agents/which.js";
import { SharedGitconfigModifiedError, WorktreeManager, ensureEmptyGitconfig, type SharedGitconfigProblem } from "../agents/worktrees.js";

export type RunningServer = {
  /** Where to open the workspace: the app hostname, with the bootstrap token. */
  url: string;
  /** Token-free loopback address, for local clients. */
  loopbackUrl: string;
  port: number;
  token: string;
  integrity: VerifyResult;
  close(): Promise<void>;
};

const DEFAULT_PORT = 4317;
const PORT_ATTEMPTS = 21; // the requested port plus 20 above it

function loadToken(dataDir: string, given?: string): string {
  if (given) return given;
  const file = join(dataDir, "token");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // writeFile's mode is ignored when the file already exists
  } catch {
    // best effort (Windows)
  }
  return token;
}

/** The UI directory is served unauthenticated, so the data dir (token, ledger.db) must never be under it. */
function assertDataDirOutsideUiDir(dataDir: string, uiDir: string): void {
  const data = realpathSync.native(dataDir);
  const ui = realpathSync.native(uiDir);
  const rel = relative(ui, data);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    throw new Error(
      `Refusing to start: the data directory (${data}) is inside the UI directory (${ui}), ` +
        "which is served without authentication. Choose a data directory outside it.",
    );
  }
}

/** Demo script for the fake adapter: an inside read, a shell action that asks, then completion. */
const DEFAULT_FAKE_SCRIPT: FakeStep[] = [
  {
    propose: { tool: "Read", kind: "file_read", summary: "read README.md", input: { path: "README.md" }, paths: ["README.md"] },
    result: { ok: true, output: "(fake) README contents" },
  },
  {
    propose: { tool: "Bash", kind: "shell", summary: "run the tests", input: { command: "npm test" }, paths: [] },
    result: { ok: true, output: "(fake) tests passed" },
  },
];

/** The CLI each provider runs, as looked up on PATH when its bundled program is missing. */
const PROVIDER_CLI: Record<Provider, string> = { claude: "claude", codex: "codex", gemini: "gemini" };

/** The agent programs shipped with The Terminal (see bundled.ts); each returns null when its package is missing. */
export type BundledPrograms = {
  claude: () => string | null;
  codex: () => BundledCli | null;
  gemini: () => BundledCli | null;
};
const BUNDLED: BundledPrograms = { claude: () => bundledClaude(), codex: () => bundledCodex(), gemini: () => bundledGemini() };

/** Locates a CLI on PATH: an absolute path, or null. */
export type Which = (cmd: string) => string | null;

type CliCommand = { file: string; args: string[] };

/**
 * Where a provider's login and status commands run from, as a run would locate the CLI: a test fixture, else the
 * bundled program, else PATH. On Windows a PATH `.cmd` cannot run without a shell: Codex's npm shim is run as its
 * script with this Node, as the Codex adapter does; any other `.cmd` is not used (Gemini's is never run to sign in).
 */
export function signinProgram(
  p: Provider,
  fakeCli: Partial<Record<Provider, CliCommand>>,
  bundled: BundledPrograms,
  which: Which,
): CliCommand | null {
  const fake = fakeCli[p];
  if (fake) return fake;
  if (p === "claude") {
    const file = bundled.claude();
    if (file !== null) return { file, args: [] };
  } else {
    const cli = bundled[p]();
    if (cli !== null) return cli;
  }
  const file = which(PROVIDER_CLI[p]);
  if (file === null) return null;
  if (!/\.cmd$/i.test(file) || p === "gemini") return { file, args: [] };
  if (p !== "codex") return null;
  const script = join(dirname(file), "node_modules", "@openai", "codex", "bin", "codex.js");
  return existsSync(script) ? { file: process.execPath, args: [script] } : null;
}

/**
 * Tests only: when THETERMINAL_FAKE_AGENT=1, THETERMINAL_<PROVIDER>_BIN may name a fixture script that stands in
 * for that provider's CLI, run with this Node (the fixture reads its own THETERMINAL_FAKE_<PROVIDER>_SCRIPT).
 * Ignored otherwise, so a real workspace always uses the bundled CLI (or, if that is missing, the one on PATH).
 */
function fakeCliCommand(p: Provider): CliCommand | undefined {
  const fixture = process.env[`THETERMINAL_${p.toUpperCase()}_BIN`];
  if (process.env.THETERMINAL_FAKE_AGENT !== "1" || !fixture) return undefined;
  return { file: process.execPath, args: [fixture] };
}

/**
 * Claude, Codex and Gemini always (their programs are located at run start, not here); the scripted fake adapter only
 * when THETERMINAL_FAKE_AGENT=1 (tests and demos).
 */
function buildAdapters(
  dataDir: string,
  which: Which,
  bundled: BundledPrograms,
  fakeCli: Partial<Record<Provider, CliCommand>>,
): Partial<Record<AdapterId, AgentAdapter>> {
  const codexCommand = fakeCli.codex;
  const geminiCommand = fakeCli.gemini;
  // Test-only fixture variables, decided once here (not at run time) while THETERMINAL_FAKE_AGENT is in force.
  const fakeEnv = fakeAgentEnv();
  const adapters: Partial<Record<AdapterId, AgentAdapter>> = {
    claude: new ClaudeAdapter({ dataDir, bundled: bundled.claude, findClaude: () => which("claude") }),
    // The API key is read from OPENAI_API_KEY when each run starts.
    codex: new CodexAdapter({ dataDir, bundled: bundled.codex, bin: () => which("codex"), fakeEnv, ...(codexCommand && { command: codexCommand }) }),
    // The API key is read from GEMINI_API_KEY when each run starts.
    gemini: new GeminiAdapter({ dataDir, bundled: bundled.gemini, bin: () => which("gemini"), fakeEnv, ...(geminiCommand && { command: geminiCommand }) }),
  };
  if (process.env.THETERMINAL_FAKE_AGENT === "1") {
    const raw = process.env.THETERMINAL_FAKE_SCRIPT;
    let script: FakeStep[] = DEFAULT_FAKE_SCRIPT;
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Refusing to start: THETERMINAL_FAKE_SCRIPT is not valid JSON");
      }
      if (!Array.isArray(parsed)) throw new Error("Refusing to start: THETERMINAL_FAKE_SCRIPT must be a JSON array of steps");
      script = parsed as FakeStep[];
    }
    adapters.fake = new FakeAdapter(script);
  }
  return adapters;
}

const GITCONFIG_REPAIR_FAILED = "the shared git config could not be repaired; agent runs will fail until this is fixed";
const GITCONFIG_WARNINGS: Partial<Record<SharedGitconfigProblem, string>> = {
  not_file: "the shared git config is not a regular file; agent runs will fail until it is removed",
  linked: "the shared git config has another hard link; agent runs will fail until it is removed",
  unchecked: "the shared git config could not be checked; agent runs will fail until this is fixed",
};

/**
 * At start, while nothing runs: a shared git config modified before this start is emptied and made read-only again.
 * One that cannot be repaired is left alone with a warning, and every run then fails before its CLI starts. Never
 * throws, and the warning is fixed text: console output ends up in bug reports, so it holds no path or fs error.
 */
export function repairSharedGitconfig(dataDir: string, ensure = ensureEmptyGitconfig, warn: (message: string) => void = console.warn): void {
  try {
    ensure(dataDir, { repair: true });
  } catch (e) {
    const known = e instanceof SharedGitconfigModifiedError ? GITCONFIG_WARNINGS[e.reason] : undefined;
    warn(`The Terminal: ${known ?? GITCONFIG_REPAIR_FAILED}`);
  }
}

/**
 * Where connection secrets live: the injected store, else the OS keychain. Under THETERMINAL_FAKE_AGENT=1 (tests and
 * demos only), THETERMINAL_SECRET_STORE=memory selects an in-process store; it is ignored otherwise.
 */
export function selectSecretStore(env: NodeJS.ProcessEnv = process.env, injected?: SecretStore): SecretStore {
  if (injected) return injected;
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_SECRET_STORE === "memory") return new MemorySecretStore();
  return new ChunkedSecretStore(new KeychainSecretStore());
}

const FAKE_TOKEN = { access_token: "TESTKEY-access-token-0000000000", expires_in: 3600, token_type: "Bearer" };
const AZURE_TOKEN_URL = /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function bodyText(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<string> {
  if (init?.body !== undefined && init.body !== null) return typeof init.body === "string" ? init.body : String(init.body);
  return input instanceof Request ? input.text() : "";
}

const GITHUB_REPO_URL = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[^?]*)?(\?.*)?$/;

/** Canned GitHub bodies for `owner/name`, with fields the client must drop (logins, bodies). */
function fakeGitHub(owner: string, name: string, path: string): unknown {
  const fullName = `${owner}/${name}`;
  const html = `https://github.com/${fullName}`;
  const user = { login: "example-user", id: 1 };
  switch (path) {
    case "":
      return { full_name: fullName, default_branch: "main", html_url: html, private: false, owner: user };
    case "/branches":
      return [{ name: "main", protected: true }, { name: "feature/e2e", protected: false }];
    case "/pulls":
      return [{
        number: 7, title: "Add the thing", draft: false, html_url: `${html}/pull/7`, updated_at: "2026-11-15T10:00:00Z",
        head: { ref: "feature/e2e", user }, base: { ref: "main", user }, user, body: "Fake pull request.",
      }];
    case "/actions/runs":
      return {
        total_count: 2,
        workflow_runs: [
          { id: 101, name: "CI", status: "completed", conclusion: "success", head_branch: "main", html_url: `${html}/actions/runs/101`, updated_at: "2026-11-15T09:00:00Z", actor: user },
          { id: 102, name: "CI", status: "in_progress", conclusion: null, head_branch: "feature/e2e", html_url: `${html}/actions/runs/102`, updated_at: "2026-11-15T09:30:00Z", actor: user },
        ],
      };
    default:
      return undefined;
  }
}

/**
 * Tests only. Never performs network I/O. In this order:
 * - a POST to the Google or Azure token endpoint answers a fake token when the form holds `grant_type` (and, for
 *   Azure, a `client_secret` containing `TESTKEY`), and 401 otherwise;
 * - a GET to `https://api.github.com/repos/<owner>/<name>…` answers canned bodies for that repository when the
 *   Bearer token contains `TESTKEY` (401 otherwise), and 404 when `<name>` is `missing`;
 * - anything else answers 200 `{}` when any request header value contains `TESTKEY`, and 401 otherwise.
 */
const fakeHttp: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const google = url === "https://oauth2.googleapis.com/token";
  const azure = AZURE_TOKEN_URL.test(url);
  if (method === "POST" && (google || azure)) {
    const form = new URLSearchParams(await bodyText(input, init));
    const granted = form.has("grant_type") && (google || (form.get("client_secret") ?? "").includes("TESTKEY"));
    return granted ? jsonResponse(200, FAKE_TOKEN) : jsonResponse(401, { error: "invalid_client" });
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const repo = method === "GET" ? GITHUB_REPO_URL.exec(url) : null;
  if (repo) {
    const [, owner = "", name = "", path = ""] = repo;
    if (!/^Bearer \S*TESTKEY/.test(headers.get("authorization") ?? "")) return jsonResponse(401, { message: "Bad credentials" });
    const body = name === "missing" ? undefined : fakeGitHub(owner, name, path);
    return body === undefined ? jsonResponse(404, { message: "Not Found" }) : jsonResponse(200, body);
  }
  let accepted = false;
  headers.forEach((value) => {
    if (value.includes("TESTKEY")) accepted = true;
  });
  return accepted ? jsonResponse(200, {}) : jsonResponse(401, { error: "unauthorized" });
};

/**
 * The fetch connection tests use: the injected one, else the real fetch. Under THETERMINAL_FAKE_AGENT=1,
 * THETERMINAL_FAKE_HTTP=1 selects a stub that never leaves the process; it is ignored otherwise.
 */
export function selectFetch(env: NodeJS.ProcessEnv = process.env, injected?: typeof fetch): typeof fetch {
  if (injected) return injected;
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_FAKE_HTTP === "1") return fakeHttp;
  return globalThis.fetch;
}

/**
 * The STS caller AWS tests and grants use: the injected one, else the AWS SDK. Under THETERMINAL_FAKE_AGENT=1,
 * THETERMINAL_FAKE_HTTP=1 selects a stub that never leaves the process; it is ignored otherwise.
 */
export function selectSts(env: NodeJS.ProcessEnv = process.env, injected?: StsCaller): StsCaller {
  if (injected) return injected;
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_FAKE_HTTP === "1") return fakeSts;
  return realSts;
}

const execFileAsync = promisify(nodeExecFile);
const execFileUtf8: ExecFile = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, { ...opts, encoding: "utf8" });
  return { stdout };
};

/** Detects this computer with the real programs (see detectHardware). */
const realHardware = (): Promise<HardwareInfo> =>
  detectHardware({
    execFile: execFileUtf8, platform: process.platform, arch: arch(), totalmem, cpus, release,
    which: (cmd) => whichOnPath(cmd), env: process.env,
  });
/** Tests only: the fixed machine, stamped with the time of each detection. */
const fakeDetector = async (): Promise<HardwareInfo> => ({ ...fakeHardware, detectedAt: new Date().toISOString() });

/**
 * The hardware detector: the injected one, else the real programs. Under THETERMINAL_FAKE_AGENT=1,
 * THETERMINAL_FAKE_HARDWARE=1 selects a fixed fake machine, so tests never depend on a runner's GPU; it is ignored otherwise.
 */
export function selectHardware(env: NodeJS.ProcessEnv = process.env, injected?: () => Promise<HardwareInfo>): () => Promise<HardwareInfo> {
  if (injected) return injected;
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_FAKE_HARDWARE === "1") return fakeDetector;
  return realHardware;
}

/** The server's own variable per provider: a development and live-test fallback when no connection holds a key. */
const API_KEY_ENV: Record<Provider, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

export async function createServer(opts: {
  dataDir: string;
  port?: number;
  uiDir?: string;
  token?: string;
  /** How long close() waits for agent adapters to return after stopping them. */
  shutdownTimeoutMs?: number;
  /** Tests only: the PATH lookup for provider CLIs. Default: the PATH of this process. */
  which?: Which;
  /**
   * The directory of the `@theterminal/core` install whose bundled agent programs are used (a host passes it as
   * `--core-dir`). Default: this package's own directory.
   */
  coreDir?: string;
  /** Tests only: replaces the bundled program lookups. Default: the packages installed with this one. */
  bundled?: Partial<BundledPrograms>;
  /** Where connection secrets live. Default: the OS keychain (see selectSecretStore). */
  secrets?: SecretStore;
  /** Tests only: the fetch connection tests use. Default: the real fetch (see selectFetch). */
  fetch?: typeof fetch;
  /** Tests only: the STS caller AWS tests and grants use. Default: the AWS SDK (see selectSts). */
  sts?: StsCaller;
  /** Detects this computer's hardware. Default: the real programs (see selectHardware). */
  hardware?: () => Promise<HardwareInfo>;
}): Promise<RunningServer> {
  const which: Which = opts.which ?? whichOnPath;
  // Located once, at startup: every listing and run start reuses the result.
  const coreDir = opts.coreDir;
  const defaults: BundledPrograms =
    coreDir === undefined
      ? BUNDLED
      : { claude: () => bundledClaude({ coreDir }), codex: () => bundledCodex({ coreDir }), gemini: () => bundledGemini({ coreDir }) };
  const lookups: BundledPrograms = { ...defaults, ...opts.bundled };
  const located = { claude: lookups.claude(), codex: lookups.codex(), gemini: lookups.gemini() };
  const bundled: BundledPrograms = { claude: () => located.claude, codex: () => located.codex, gemini: () => located.gemini };
  // Read once, at startup: the adapters and the install state below must agree for the server's lifetime.
  const fakeCli: Partial<Record<Provider, CliCommand>> = Object.fromEntries(
    PROVIDERS.flatMap((p) => {
      const command = fakeCliCommand(p);
      return command ? [[p, command]] : [];
    }),
  );
  const adapters = buildAdapters(opts.dataDir, which, bundled, fakeCli);
  mkdirSync(opts.dataDir, { recursive: true });
  if (opts.uiDir) assertDataDirOutsideUiDir(opts.dataDir, opts.uiDir);
  // Before the ledger opens: the CLI and the desktop app share one data folder, and only one server may use it.
  const lock = acquireDataDirLock(opts.dataDir);
  let openedDb: Db | undefined; // closed here when the start fails
  try {
    const db = openDatabase(join(opts.dataDir, "ledger.db"));
    openedDb = db;
    const ledger = new Ledger(db);
    const board = new BoardService(db, ledger);
    const token = loadToken(opts.dataDir, opts.token);

    // Projections are derived state: rebuild them from the verified ledger so out-of-band edits are undone.
    const integrity = ledger.verify();
    if (integrity.ok) {
      board.rebuildProjections();
    } else {
      board.rebuildProjections({ beforeSeq: integrity.brokenAtSeq });
      ledger.readOnly = true;
    }

    repairSharedGitconfig(opts.dataDir);

    const sts = selectSts(process.env, opts.sts);
    const fetchFn = selectFetch(process.env, opts.fetch);
    const connections = new ConnectionService({
      db,
      ledger,
      secrets: selectSecretStore(process.env, opts.secrets),
      testers: { ...CONNECTION_TESTERS, ...cloudTesters(sts) },
      fetch: fetchFn,
    });
    await connections.load(); // never throws: an unavailable keychain is reported, and the server still starts

    const signin = new SignInManager({
      dataDir: opts.dataDir,
      program: (p) => signinProgram(p, fakeCli, bundled, which),
      cliHome: (p) => connections.credentialsFor(p)?.cliHome,
      extraEnv: fakeLoginEnv(),
      // Minted cloud values too: the runner keeps every one for the life of the process (declared below; read lazily).
      secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()],
      record: (provider, ok) =>
        commitEvent(db, ledger, () => ({
          event: { projectId: null, actor: { kind: "human", id: "owner" }, type: "connection.signin", payload: { provider, ok } },
          result: () => undefined,
        })),
    });

    const runner = new AgentRunner({
      db,
      ledger,
      worktrees: new WorktreeManager(opts.dataDir),
      broker: new ApprovalBroker(),
      adapters,
      // Read on every clean: secrets added later (a key stored through the API) are redacted at once, and a removed
      // connection's values stay in secretValues() until the process exits. The runner adds every value it mints.
      extraSecrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues()],
      credentials: (p) => connections.credentialsFor(p),
      selectConnections: (ids) => connections.selectForRun(ids),
      mintCloud: (source, signal) => mintCloudGrant(source, { sts, fetch: fetchFn, signal }),
      dataDir: opts.dataDir,
      ...(opts.shutdownTimeoutMs !== undefined && { shutdownTimeoutMs: opts.shutdownTimeoutMs }),
    });

    const intake = new IntakeService({
      db,
      ledger,
      dataDir: opts.dataDir,
      // Read on every check, like the runner's: a value stored later is refused at once.
      secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()],
    });

    // The same scrubbing and secret check as the intake, for waiver reasons.
    const gates = new GateService({
      db,
      ledger,
      dataDir: opts.dataDir,
      secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()],
    });

    const github = new GitHubClient({ fetch: fetchFn, source: () => connections.githubSource() });

    const app = Fastify();
    let boundPort = 0;
    try {
      if (!ledger.readOnly) runner.recoverOnStartup(); // nothing survived the restart: deny and fail
      registerAuth(app, { token, port: () => boundPort });
      registerLedgerStream(app, ledger);
      registerRoutes(app, { board, gates, ledger, getIntegrity: () => integrity });
      const settings = new ProviderSettings(db, ledger);
      registerAgentRoutes(app, {
        db,
        runner,
        settings,
        adapters: ADAPTERS.filter((id) => adapters[id] !== undefined),
        // As a run would locate it: a test fixture, else the bundled program, else (only then) PATH.
        available: (p) => fakeCli[p] !== undefined || bundled[p]() !== null || which(PROVIDER_CLI[p]) !== null,
        apiKey: (p) => (connections.credentialsFor(p)?.apiKey ? "connection" : process.env[API_KEY_ENV[p]] ? "environment" : "none"),
      });
      registerIntakeRoutes(app, { intake });
      registerStoryRoutes(app, { db, ledger });
      registerConnectionRoutes(app, {
        db, connections, signin, ledger, intake,
        // A GitHub failure never breaks /api/status: ciStatusNow answers from the cache, else "unknown".
        ci: () => (connections.githubSource() ? github.ciStatusNow() : null),
      });
      registerGitHubRoutes(app, { github });
      registerCapacityRoutes(app, {
        db, connections, modes: (p) => settings.getMode(p), hardware: selectHardware(process.env, opts.hardware),
      });
      if (opts.uiDir) registerStaticUi(app, opts.uiDir);
      await app.ready();

      const first = opts.port ?? DEFAULT_PORT;
      let lastError: unknown;
      for (let i = 0; i < PORT_ATTEMPTS; i++) {
        const candidate = first === 0 ? 0 : first + i;
        try {
          await app.listen({ host: "127.0.0.1", port: candidate });
          boundPort = (app.server.address() as AddressInfo).port;
          lastError = undefined;
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
          lastError = err;
        }
      }
      if (lastError) {
        throw new Error(`No free port between ${first} and ${first + PORT_ATTEMPTS - 1}; pass --port to choose another`);
      }
    } catch (err) {
      await signin.shutdown();
      await app.close().catch(() => undefined);
      throw err;
    }

    return {
      url: `http://${APP_HOST}:${boundPort}/?token=${token}`,
      loopbackUrl: `http://127.0.0.1:${boundPort}/`,
      port: boundPort,
      token,
      integrity,
      async close() {
        try {
          await runner.shutdown(); // stops runs and denies pending actions while the db is still open
          await signin.shutdown(); // kills every login and status check before the db closes
          for (const client of app.websocketServer.clients) client.terminate();
          await app.close();
        } finally {
          // Always: a db left open keeps its files locked, and a restart in this process could not take them. The
          // lock release only ever removes our own lock, so a second close() is harmless.
          db.close();
          lock.release();
        }
      },
    };
  } catch (err) {
    try {
      openedDb?.close();
    } finally {
      lock.release();
    }
    throw err;
  }
}
