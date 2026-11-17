import { execFile as nodeExecFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { arch, cpus, homedir, release, totalmem } from "node:os";
import { promisify } from "node:util";
import Fastify from "fastify";
import { openDatabase, type Db } from "../db.js";
import { Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService } from "../board/board-service.js";
import { AgentCards } from "../board/agent-cards.js";
import { registerRoutes } from "./routes.js";
import { registerAuth, assertRoutesHaveRoles, APP_HOST } from "./auth.js";
import { AUTH_THROTTLE, Throttle } from "./throttle.js";
import { SessionStore } from "../people/sessions.js";
import { ChallengeStore } from "../people/challenges.js";
import { LockoutStore } from "../people/lockouts.js";
import { PeopleService } from "../people/service.js";
import { getPerson } from "../events/projections.js";
import { registerStaticUi } from "./static-ui.js";
import { acquireDataDirLock } from "./data-dir-lock.js";
import { announceBootstrapInvite, watchBootstrapInvite } from "./bootstrap-invite.js";
import { registerLedgerStream } from "./events-ws.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { registerIntakeRoutes } from "./intake-routes.js";
import { registerStoryRoutes } from "./story-routes.js";
import { registerChangesRoutes } from "./changes-routes.js";
import { registerOverrideRoutes } from "./override-routes.js";
import { registerPeopleRoutes } from "./people-routes.js";
import { RemoteListener, type EnableInput } from "./remote.js";
import { registerRemoteRoutes } from "./remote-routes.js";
import { AcmeManager } from "./acme.js";
import { OverrideService } from "../override/service.js";
import { IntakeService } from "../intake/service.js";
import { GateService } from "../gates/service.js";
import { registerGitHubRoutes } from "./github-routes.js";
import { registerGateRoutes } from "./gates-routes.js";
import { registerCapacityRoutes } from "./capacity-routes.js";
import { wireLink } from "./link-wiring.js";
import type { LinkService } from "../link/service.js";
import type { Discovery } from "../link/discovery.js";
import { registerLinkRoutes } from "./link-routes.js";
import { RemoteRunService } from "../link/remote-runs.js";
import { registerShareRoutes } from "./share-routes.js";
import { registerShareLinkRoutes } from "./share-link-routes.js";
import { shareCleaner } from "../share/clean.js";
import { buildSnapshot } from "../share/snapshot.js";
import { ShareService } from "../share/service.js";
import { ShareLinkManager, shareAddresses } from "../share/link-server.js";
import { GitHubClient } from "../github/client.js";
import { GitHubRepos } from "../github/repos.js";
import { SourceService } from "../sources/service.js";
import { WritebackService } from "../sources/writeback.js";
import { registerSourcesRoutes } from "./sources-routes.js";
import { registerHomeRoutes } from "./home-routes.js";
import { registerCardRoutes } from "./card-routes.js";
import { registerPreviewRoutes } from "./preview-routes.js";
import { PreviewService } from "../preview/service.js";
import { detectTools, realTools } from "../preview/native.js";
import { installRequestDeadlines, type RequestDeadlines } from "./request-deadlines.js";
import { ConnectionService } from "../connections/service.js";
import { SignInManager, fakeLoginEnv } from "../connections/signin.js";
import { commitEvent } from "../events/commit.js";
import { CONNECTION_TESTERS, cloudTesters } from "../connections/testers.js";
import { fakeSts, realSts, type StsCaller } from "../connections/cloud/aws.js";
import { mintCloudGrant } from "../connections/cloud/grant.js";
import { RecordedText } from "../intake/recorded-text.js";
import { ChunkedSecretStore, type SecretStore } from "../secrets/store.js";
import { KeychainSecretStore } from "../secrets/keychain-store.js";
import { MemorySecretStore } from "../secrets/memory-store.js";
import { FileSecretStore, assertKeyOutsideDataDir, type SecretStoreKind } from "../secrets/file-store.js";
import {
  ADAPTERS, PROVIDERS, RESTRICTED_SIGNIN_ENV, type Actor, type AdapterId, type CapacityReport, type HardwareInfo, type LocalEngine, type NativeTools,
  type Provider, type TlsMode,
} from "@theterminal/shared";
import { detectHardware, fakeHardware, type ExecFile } from "../capacity/hardware.js";
import { LLAMACPP_URL, OLLAMA_URL, detectLocalEngines, isLoopbackUrl } from "../capacity/local-models.js";
import type { AgentAdapter } from "../agents/adapter.js";
import type { PreviewHost } from "./preview-host.js";
import { ApprovalBroker } from "../agents/approvals.js";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { baseChildEnv, fakeAgentEnv } from "../agents/child-env.js";
import { CodexAdapter } from "../agents/codex/adapter.js";
import { FakeAdapter, type FakeStep } from "../agents/fake-adapter.js";
import { GeminiAdapter } from "../agents/gemini/adapter.js";
import { redact, secretEnvValues } from "../agents/redact.js";
import { API_KEY_ENV, AgentRunner } from "../agents/runner.js";
import { ProviderSettings } from "../agents/settings.js";
import { bundledClaude, bundledCodex, bundledGemini, type BundledCli } from "../agents/bundled.js";
import { which as whichOnPath } from "../agents/which.js";
import { SharedGitconfigModifiedError, WorktreeManager, ensureEmptyGitconfig, type SharedGitconfigProblem } from "../agents/worktrees.js";
import { NetworkObserver, observedFetch } from "../network.js";

export type RunningServer = {
  /** Where to open the workspace: the app hostname, with the bootstrap token. */
  url: string;
  /** Token-free loopback address, for local clients. */
  loopbackUrl: string;
  port: number;
  token: string;
  integrity: VerifyResult;
  /** `https://<domain or first address>:<port>/` while the remote listener is up, else null. Read live. */
  readonly remoteUrl: string | null;
  /** The served certificate's SHA-256 fingerprint while the remote listener is up, else null. Read live. */
  readonly fingerprint: string | null;
  close(): Promise<void>;
};

/** The CLI's remote flags, as `createServer({ remote })` takes them. */
export type RemoteOptions = {
  /** `--remote`: turn remote access on at start, as the system actor `cli`. Without it the recorded state decides. */
  enabled?: boolean;
  port?: number;
  bind?: string;
  domain?: string;
  tls?: TlsMode;
  certFile?: string;
  keyFile?: string;
  /** Tests only: the plain ACME challenge listener's port (Let's Encrypt connects to 80). */
  acmePort?: number;
};

const DEFAULT_PORT = 4317;
/** The server itself, turning remote access on because the command line said so. */
const CLI_ACTOR: Actor = { kind: "system", id: "cli" };
/**
 * Timeouts on the shared HTTP server, which the TLS listener's decrypted sockets go through too: the whole request
 * (headers and body) within a minute, the headers within half of it, and an idle keep-alive connection closed after
 * thirty seconds. One file of an upload (up to 50 MiB, perhaps over a slow link) is spared the whole-request minute
 * and is cut off instead after a minute without a byte (installRequestDeadlines). Loopback requests never come near
 * them; a slow or silent network client does.
 */
const REQUEST_DEADLINES: RequestDeadlines = { wholeMs: 60_000, idleMs: 60_000, checkMs: 1_000 };
const HEADERS_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;

const PORT_ATTEMPTS = 21; // the requested port plus 20 above it
/** How often abandoned uploads and leftover staging folders are swept. */
const UPLOAD_SWEEP_MS = 10 * 60_000;

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
 * Where connection secrets live: the injected store, else the encrypted file store when the flags ask for it (the
 * CLI's `--secret-store file`; never from the environment), else the OS keychain. Under THETERMINAL_FAKE_AGENT=1
 * (tests and demos only), THETERMINAL_SECRET_STORE=memory selects an in-process store; it is ignored otherwise.
 * The file store refuses a key file inside the data folder (KeyInsideDataDirError) unless `allowKeyInDataDir`: a
 * backup of the data folder must not hold the key and the ciphertext together.
 */
export function selectSecretStore(
  env: NodeJS.ProcessEnv = process.env,
  injected?: SecretStore,
  flags: { store?: "keychain" | "file"; keyFile?: string; dataDir?: string; allowKeyInDataDir?: boolean } = {},
): { store: SecretStore; kind: SecretStoreKind } {
  if (injected) {
    const kind = injected instanceof FileSecretStore ? "file" : injected instanceof MemorySecretStore ? "memory" : "keychain";
    return { store: injected, kind };
  }
  if (flags.store === "file") {
    const { keyFile, dataDir } = flags;
    if (!keyFile || !dataDir) throw new Error("the file secret store needs a key file and a data folder");
    assertKeyOutsideDataDir(keyFile, dataDir, flags.allowKeyInDataDir ?? false);
    return { store: new FileSecretStore({ file: join(dataDir, SECRETS_FILE), keyFile, createKey: true }), kind: "file" };
  }
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_SECRET_STORE === "memory") return { store: new MemorySecretStore(), kind: "memory" };
  // Test-time guard (vitest sets VITEST): a test server that names no store never reaches the real keychain.
  if (env.VITEST) throw new Error("Refusing to use the real keychain under vitest: inject `secrets` or set the test flags");
  return { store: new ChunkedSecretStore(new KeychainSecretStore()), kind: "keychain" };
}

/** The file store's ciphertext, inside the data folder (its key is not). */
export const SECRETS_FILE = "secrets.enc.json";

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
 * - this computer's model servers: Ollama's `/api/version` and `/api/tags` answer one fake model, anything on the
 *   llama.cpp port is refused (`ECONNREFUSED`), and a GET to `/v1/models` on any loopback address lists that model, so
 *   the detector and the connection tester agree;
 * - anything else answers 200 `{}` when any request header value contains `TESTKEY`, and 401 otherwise.
 */
const fakeHttp: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const local = fakeLocalModels(url, method);
  if (local !== undefined) return local;
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

/** Tests only: the one model the fake model servers hold. */
const FAKE_LOCAL_MODEL = { name: "fake-coder:7b", size: 4 * 1024 ** 3, details: { parameter_size: "7B", quantization_level: "Q4_K_M" } };

/** The fake HTTP's answer for this computer's model servers (see fakeHttp), or undefined for any other URL. */
function fakeLocalModels(url: string, method: string): Response | undefined {
  if (url.startsWith(`${LLAMACPP_URL}/`) || url === LLAMACPP_URL) {
    throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED", cause: { code: "ECONNREFUSED" } });
  }
  if (method !== "GET") return undefined;
  if (url === `${OLLAMA_URL}/api/version`) return jsonResponse(200, { version: "0.0.0-fake" });
  if (url === `${OLLAMA_URL}/api/tags`) return jsonResponse(200, { models: [FAKE_LOCAL_MODEL] });
  if (isLoopbackUrl(url) && new URL(url).pathname.replace(/\/+$/, "").endsWith("/v1/models")) {
    return jsonResponse(200, { object: "list", data: [{ id: FAKE_LOCAL_MODEL.name, object: "model" }] });
  }
  return undefined;
}

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

/** Detects this computer's model servers with the plain fetch: loopback probes are never observed or proxied. */
const realLocalEngines = (): Promise<LocalEngine[]> => detectLocalEngines({ fetch: globalThis.fetch });
/** Tests only: the model servers the fake HTTP serves. */
const fakeLocalEngines = (): Promise<LocalEngine[]> => detectLocalEngines({ fetch: fakeHttp });

/**
 * The local model detector: the injected one, else the real probes. Under THETERMINAL_FAKE_AGENT=1,
 * THETERMINAL_FAKE_HTTP=1 selects a detector over the fake HTTP; it is ignored otherwise.
 */
export function selectLocalEngines(
  env: NodeJS.ProcessEnv = process.env, injected?: () => Promise<LocalEngine[]>,
): () => Promise<LocalEngine[]> {
  if (injected) return injected;
  if (env.THETERMINAL_FAKE_AGENT === "1" && env.THETERMINAL_FAKE_HTTP === "1") return fakeLocalEngines;
  return realLocalEngines;
}

const PROVIDER_WORDS: Record<Provider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

/**
 * At start: a recorded own-plan mode that the restricted sign-in switch being off turns into `api_key` is reported,
 * so the Owner learns why runs use an API key. Fixed text with the providers' fixed names only.
 */
export function warnTurnedOff(providers: Provider[], warn: (message: string) => void = console.warn): void {
  for (const p of providers) {
    warn(
      `The Terminal: signing in with your own ${PROVIDER_WORDS[p]} plan is turned off, so ${PROVIDER_WORDS[p]} runs use an API key. ` +
        `Start with ${RESTRICTED_SIGNIN_ENV}=1 to turn it on.`,
    );
  }
}

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
  /** `file`: the encrypted file store, with its key at `secretKeyFile` (the CLI's `--secret-store`). */
  secretStore?: "keychain" | "file";
  secretKeyFile?: string;
  /** Lets `secretKeyFile` sit inside the data folder (refused otherwise). */
  allowKeyInDataDir?: boolean;
  /**
   * Called once at startup with the Owner bootstrap link, while remote access listens and nobody has claimed the
   * Owner identity (the CLI prints it). The link is also written to `<dataDir>/bootstrap-invite` (mode 0600).
   */
  bootstrapInvite?: (url: string) => void;
  /** Tests only: the fetch connection tests use. Default: the real fetch (see selectFetch). */
  fetch?: typeof fetch;
  /** Tests only: the STS caller AWS tests and grants use. Default: the AWS SDK (see selectSts). */
  sts?: StsCaller;
  /** Detects this computer's hardware. Default: the real programs (see selectHardware). */
  hardware?: () => Promise<HardwareInfo>;
  /** Detects the model servers on this computer. Default: the real probes (see selectLocalEngines). */
  localEngines?: () => Promise<LocalEngine[]>;
  /**
   * The address the link listener binds once the Owner enabled linking. Default `0.0.0.0` (IPv4, the local network);
   * tests pass `127.0.0.1`. The workspace server itself always binds loopback.
   */
  linkBind?: string;
  /** The port the link listener asks for when the Owner enables linking. Default 4418; tests pass 0. */
  linkPort?: number;
  /** Finds other Terminals on the network. Default: mDNS, or the in-process fake under the test flags (selectDiscovery). */
  discovery?: Discovery;
  /** Tests only: shorter reconnect waits (and stream idle timeout) for runs on linked machines. */
  remoteRuns?: { backoffMs?: number[]; streamIdleMs?: number };
  /** Tests only: shorter whole-request and upload idle limits. Default: a minute each (REQUEST_DEADLINES). */
  requestDeadlines?: RequestDeadlines;
  /** The first port a share link tries (it tries 20 above it too). Default 4400; tests pass 0 for any free port. */
  sharePort?: number;
  /**
   * The remote (network, TLS) listener. With `enabled`, it is turned on at start as the system actor `cli`, whatever
   * the ledger says; otherwise the recorded state decides (startIfEnabled). On a headless server the flag is the switch.
   */
  remote?: RemoteOptions;
  /**
   * The restricted sign-in switch: lets the Owner choose and use Claude's subscription and Gemini's Google sign-in,
   * which those providers do not allow other apps to use. Default off. The CLI sets it from
   * `--allow-restricted-signin` or THETERMINAL_RESTRICTED_SIGNIN=1, read once at start.
   */
  restrictedSignIn?: boolean;
  /**
   * Shows the system folder picker through the host (the desktop app), resolving with an absolute path or null. Set
   * by the CLI only when it runs under a host with an IPC channel; absent on a headless server, which then answers
   * `folder_picker_unavailable`.
   */
  pickFolder?: () => Promise<string | null>;
  /**
   * Shows and captures a website preview's device views through the host (the desktop app). Set by the CLI only when
   * it runs under a host with an IPC channel; absent on a headless server.
   */
  previewHost?: PreviewHost;
  /** Tests only: what the native tools route reports. Default: detection with the real programs (detectTools). */
  nativeTools?: () => Promise<NativeTools>;
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
  let link: LinkService | undefined; // shut down here when the start fails
  try {
    const db = openDatabase(join(opts.dataDir, "ledger.db"));
    openedDb = db;
    const ledger = new Ledger(db);
    const token = loadToken(opts.dataDir, opts.token);
    // One scrubber and secret check for everything the Owner writes into the ledger: project names, card titles,
    // intake answers, waiver reasons. Secrets are read on every check (like the runner's), so a value stored later
    // is refused at once; connections and runner are declared below and only read when a request arrives.
    const recorded = new RecordedText({
      dataDir: opts.dataDir,
      secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()],
    });
    const board = new BoardService(db, ledger, { recorded });

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
    // The Owner's own calls to the internet (connection tests, cloud grants, GitHub) go through the observed fetch,
    // whose outcomes infer the network state. Local-model detection and the link client keep the plain fetch.
    const network = new NetworkObserver();
    const fetchFn = observedFetch(selectFetch(process.env, opts.fetch), network);
    const { store: secrets, kind: secretStoreKind } = selectSecretStore(process.env, opts.secrets, {
      store: opts.secretStore,
      keyFile: opts.secretKeyFile,
      dataDir: opts.dataDir,
      allowKeyInDataDir: opts.allowKeyInDataDir,
    });
    // The file store is verified at startup: its key is created when missing, so it exists before the first secret is
    // saved, and every existing entry must open with it. The operator chose this store explicitly: a key (or
    // ciphertext file) it cannot use, including a right-sized key that does not open the file, refuses the start with
    // SecretStoreUnavailableError, unlike the keychain, which is reported and lets the server start.
    if (secrets instanceof FileSecretStore) secrets.verify();
    const connections = new ConnectionService({
      db,
      ledger,
      secrets,
      testers: { ...CONNECTION_TESTERS, ...cloudTesters(sts) },
      fetch: fetchFn,
      // Names other machines are told (publicConnections) are scrubbed like recorded text, and redacted of the token
      // and minted values too (the runner is declared below; read lazily).
      scrub: (t: string): string => recorded.scrub(t),
      extraSecrets: (): string[] => [token, ...secretEnvValues(process.env), ...runner.mintedSecrets()],
    });
    await connections.load(); // never throws: an unavailable keychain is reported, and the server still starts
    // Linked machines' capacity: this computer's own report is set once the capacity routes exist (below); the link
    // listener, which answers paired machines from it, starts only after that.
    let localCapacity: (() => Promise<CapacityReport>) | null = null;
    const programAvailable = (p: Provider) => fakeCli[p] !== undefined || bundled[p]() !== null || which(PROVIDER_CLI[p]) !== null;
    // Constructed here, loaded (identity, and the listener when the recorded opt-in says so) just before app.ready().
    const wired = wireLink({
      db, ledger, secrets, bind: opts.linkBind ?? "0.0.0.0", ...(opts.discovery !== undefined && { discovery: opts.discovery }),
      // A paired machine's name is cleaned like any text that crosses the link.
      cleanText: (t: string) => connections.publicText(t),
      capacity: {
        report: () => (localCapacity ? localCapacity() : Promise.reject(new Error("capacity is not ready"))),
        adapters: () => ADAPTERS.filter((id) => adapters[id] !== undefined && (id === "fake" || programAvailable(id))),
        connections,
      },
      // Read when the listener starts (link.load(), last), when the runner and the rest below exist.
      runs: () => ({
        runner, worktrees, dataDir: opts.dataDir,
        // A paired machine's project name is cleaned like any text that crosses the link (6a's publicText).
        cleanText: (t: string) => connections.publicText(t),
        changes: { db, dataDir: opts.dataDir, worktrees, clean, settling: (id: string) => runner.settling(id) },
      }),
    });
    link = wired.link;
    const linkService = link;

    const restrictedSignIn = opts.restrictedSignIn === true;
    const signin = new SignInManager({
      dataDir: opts.dataDir,
      restrictedSignIn,
      program: (p) => signinProgram(p, fakeCli, bundled, which),
      cliHome: (p) => connections.credentialsFor(p)?.cliHome,
      extraEnv: fakeLoginEnv(),
      // Minted cloud values too: the runner keeps every one for the life of the process (declared below; read lazily).
      secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()],
      // Recorded as the person who started the login (the route names them from the principal).
      record: (provider, ok, actor) =>
        commitEvent(db, ledger, () => ({
          event: { projectId: null, actor, type: "connection.signin", payload: { provider, ok } },
          result: () => undefined,
        })),
    });

    // The gates before the runner: the agents' card markers (AgentCards) move cards only through them.
    const gates = new GateService({ db, ledger, recorded });
    const cards = new AgentCards({ db, ledger, gates, board, recorded });

    const worktrees = new WorktreeManager(opts.dataDir);
    const runner = new AgentRunner({
      db,
      ledger,
      worktrees,
      broker: new ApprovalBroker(),
      adapters,
      // Read on every clean: secrets added later (a key stored through the API) are redacted at once, and a removed
      // connection's values stay in secretValues() until the process exits. The runner adds every value it mints.
      extraSecrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues()],
      credentials: (p) => connections.credentialsFor(p),
      selectConnections: (ids) => connections.selectForRun(ids),
      mintCloud: (source, signal) => mintCloudGrant(source, { sts, fetch: fetchFn, signal }),
      dataDir: opts.dataDir,
      restrictedSignIn,
      cards,
      ...(opts.shutdownTimeoutMs !== undefined && { shutdownTimeoutMs: opts.shutdownTimeoutMs }),
    });

    const clean = (runId: string, s: string, max: number) => runner.cleanFor(runId)(s, max);
    // What a linked machine sent is shown through this machine's own cleaning (redact, scrub, redact), never trusted
    // as the worker cleaned it: the ledger keeps the signed bytes, every view and export gets this.
    const cleanMirrored = (s: string): string => {
      const secrets = [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()];
      return redact(recorded.scrub(redact(s, secrets)), secrets);
    };
    const overrides = new OverrideService({ db, ledger, dataDir: opts.dataDir, worktrees, recorded, clean, which, settling: (id) => runner.settling(id) });
    // Previews the person confirms: each stage cleaned like the run's own output; a website's screenshots come from
    // the desktop app's device views, when there is a desktop app.
    const previewHost = opts.previewHost;
    const previews = new PreviewService({
      db, ledger, dataDir: opts.dataDir, worktrees, clean, settling: (id) => runner.settling(id),
      ownPorts: () => [boundPort, remoteListener.state().port].filter((p) => p > 0),
      ...(previewHost !== undefined && { capture: (id: string) => previewHost.capture(id) }),
    });
    const nativeTools =
      opts.nativeTools ??
      (() => detectTools(realTools(process.platform), { platform: process.platform, env: baseChildEnv(opts.dataDir), homedir: homedir() }));
    // Runs this computer asks a linked machine to do: followed through its signed entries, decided and stopped there.
    const remote = new RemoteRunService({
      db, ledger, link: linkService, worktrees, dataDir: opts.dataDir, clean: cleanMirrored,
      ...(opts.remoteRuns?.backoffMs !== undefined && { backoffMs: opts.remoteRuns.backoffMs }),
      ...(opts.remoteRuns?.streamIdleMs !== undefined && { streamIdleMs: opts.remoteRuns.streamIdleMs }),
    });

    const intake = new IntakeService({ db, ledger, recorded });

    // People: one session store, one challenge store, one lockout store, one service and one auth throttle for the
    // whole server. The auth hook reads sessions and people here; the sign-in routes, the remote listener and the
    // event stream take the rest from this same object as they are wired.
    const sessions = new SessionStore(db);
    const lockouts = new LockoutStore();
    const people = {
      sessions,
      lockouts,
      challenges: new ChallengeStore(),
      throttle: new Throttle(AUTH_THROTTLE),
      service: new PeopleService({ db, ledger, sessions, lockouts, recorded }),
    };

    const github = new GitHubClient({ fetch: fetchFn, source: () => connections.githubSource() });
    // The person's repositories (listing, importing, publishing): the first enabled GitHub connection's token, whether
    // or not it names a repository.
    const repos = new GitHubRepos({ fetch: fetchFn, token: () => connections.githubToken() });
    // Imported names are redacted of every secret the server knows, as everything else it shows.
    const knownSecrets = (): string[] => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()];
    const sources = new SourceService({
      db, ledger, worktrees, board, github: repos, dataDir: opts.dataDir, recorded, redact: (s: string) => redact(s, knownSecrets()),
    });
    const writeback = new WritebackService({
      db, ledger, worktrees, github: repos, dataDir: opts.dataDir, settling: (id: string) => runner.settling(id),
    });
    // Uploads left by an earlier server, and abandoned ones (an hour old), are removed at start and every ten minutes.
    sources.sweep(new Date());
    const uploadSweep = setInterval(() => sources.sweep(new Date()), UPLOAD_SWEEP_MS);
    uploadSweep.unref();

    // Share: the share page's cleaner and service.
    // The cleaner reads every secret the server knows on each call, minted cloud values included, like every cleaner here.
    const shareClean = shareCleaner({
      dataDir: opts.dataDir,
      secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues(), ...runner.mintedSecrets()],
    });
    const share = new ShareService({
      db,
      ledger,
      dataDir: opts.dataDir,
      clean: shareClean,
      build: (id, o) =>
        buildSnapshot(
          {
            db, ledger, integrity: () => integrity, gates, connections: () => connections.list(),
            // The client reports "unknown" when GitHub is not connected; the page says "not connected" instead.
            ci: async () => (connections.githubSource() ? github.ciStatus() : null),
            hardware: () => connections.hardware(),
            clean: shareClean,
          },
          id,
          o,
        ),
    });
    // Each live link is its own read-only listener; the status bar counts those listeners, never the ledger's rows.
    // The server has no logger of its own (Fastify's is off), so a background end that cannot be recorded goes to
    // the console as a fixed sentence, like the server's other start and shutdown warnings.
    const links = new ShareLinkManager({
      db, ledger, service: share, addresses: () => shareAddresses(), log: (message) => console.error(message),
      ...(opts.sharePort !== undefined && { port: opts.sharePort }),
    });
    const shareLinks = (): number => links.activeCount();

    // Node's own whole-request timeout is off (0): it would cut off a large upload file, so installRequestDeadlines
    // enforces it instead for every other request. The headers timeout stays Node's.
    const app = Fastify({ requestTimeout: 0, keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS, http: { headersTimeout: HEADERS_TIMEOUT_MS } });
    installRequestDeadlines(app.server, opts.requestDeadlines ?? REQUEST_DEADLINES);
    let boundPort = 0;
    let stopBootstrapWatch = (): void => undefined;
    // The network listener: off until the ledger or the command line says otherwise. Its decrypted sockets go to this
    // same app, told apart by request.listener. Certificates from Let's Encrypt come through the ACME manager, whose
    // client is the fake CA only under the test flags (selectAcmeClient).
    const acme = new AcmeManager({ secrets, dataDir: opts.dataDir });
    const remoteListener = new RemoteListener({
      http: app.server, db, ledger, secrets, people: people.service, dataDir: opts.dataDir, uiDir: opts.uiDir ?? null, acme,
      ...(opts.secretKeyFile !== undefined && { secretKeyFile: opts.secretKeyFile }),
    });
    const remoteView = () => remoteListener.state();
    try {
      if (!ledger.readOnly) runner.recoverOnStartup(); // nothing survived the restart: deny and fail
      if (!ledger.readOnly) overrides.recoverOnStartup(); // an override's process never survives a restart
      if (!ledger.readOnly) links.recoverOnStartup(); // no link's listener survives a restart
      if (!ledger.readOnly) previews.recoverOnStartup(); // no preview's process survives a restart
      registerAuth(app, {
        token,
        port: () => boundPort,
        // The remote listener's own names and port: anything else over TLS is 403 bad_host.
        hostRule: () => remoteListener.hostRule(),
        sessions: people.sessions,
        person: (id) => getPerson(db, id),
      });
      registerLedgerStream(app, ledger, cleanMirrored, { sessions: people.sessions });
      registerRoutes(app, { board, gates, ledger, getIntegrity: () => integrity, clean: cleanMirrored });
      registerGateRoutes(app, { gates, principal: (req) => req.principal });
      const settings = new ProviderSettings(db, ledger, { restrictedSignIn });
      warnTurnedOff(settings.turnedOff());
      registerAgentRoutes(app, {
        db,
        runner,
        settings,
        adapters: ADAPTERS.filter((id) => adapters[id] !== undefined),
        // As a run would locate it: a test fixture, else the bundled program, else (only then) PATH.
        available: programAvailable,
        apiKey: (p) => (connections.credentialsFor(p)?.apiKey ? "connection" : process.env[API_KEY_ENV[p]] ? "environment" : "none"),
        clean: cleanMirrored,
        remoteRuns: remote,
      });
      registerIntakeRoutes(app, { intake });
      registerStoryRoutes(app, { db, ledger, clean: cleanMirrored });
      registerChangesRoutes(app, { db, dataDir: opts.dataDir, worktrees, clean, settling: (id) => runner.settling(id) });
      registerOverrideRoutes(app, { overrides });
      // Invite links name the remote listener's real address and fingerprint while it is up.
      registerPeopleRoutes(app, { db, ledger, ...people, recorded, port: () => boundPort, remote: remoteView });
      registerRemoteRoutes(app, { remote: remoteListener, principalOf: (req) => req.principal });
      registerConnectionRoutes(app, {
        db, connections, signin, ledger, intake,
        // A GitHub failure never breaks /api/status: ciStatusNow answers from the cache, else "unknown".
        ci: () => (connections.githubSource() ? github.ciStatusNow() : null),
        machines: () => linkService.counts(),
        network: () => network.state(),
        shareLinks,
        remote: remoteView,
        secretStore: () => secretStoreKind,
      });
      registerGitHubRoutes(app, { github });
      registerHomeRoutes(app, { db, clean: cleanMirrored });
      registerCardRoutes(app, { db, cards, clean: cleanMirrored });
      registerPreviewRoutes(app, {
        db, dataDir: opts.dataDir, previews, nativeTools,
        ...(previewHost !== undefined && { previewHost }), ...(opts.uiDir !== undefined && { uiDir: opts.uiDir }),
        uiDeny: opts.secretKeyFile === undefined ? [] : [opts.secretKeyFile],
      });
      registerSourcesRoutes(app, {
        db, sources, writeback, github: repos, ...(opts.pickFolder !== undefined && { pickFolder: opts.pickFolder }),
      });
      registerShareRoutes(app, { db, ledger, share });
      registerShareLinkRoutes(app, { links, addresses: () => shareAddresses() });
      localCapacity = registerCapacityRoutes(app, {
        db, connections, modes: (p) => settings.getMode(p), hardware: selectHardware(process.env, opts.hardware),
        localEngines: selectLocalEngines(process.env, opts.localEngines), machines: () => wired.capacity.all(),
      }).report;
      registerLinkRoutes(app, { link: linkService, capacity: wired.capacity, db, ...(opts.linkPort !== undefined && { port: opts.linkPort }) });
      if (opts.uiDir) registerStaticUi(app, opts.uiDir, { deny: opts.secretKeyFile === undefined ? [] : [opts.secretKeyFile] });
      // Last: a recorded opt-in starts the link listener, whose routes may use everything constructed above.
      await linkService.load(); // never throws: an unavailable keychain or a failed bind is reported
      // Runs on linked machines survive a restart: the runner left them alone; follow each from its cursor again.
      if (!ledger.readOnly) remote.resume();
      await app.ready();
      // Every route needs a place in the role table: an unlisted one would answer 500 to everybody, so refuse to start.
      const unlisted = assertRoutesHaveRoles(app);
      if (unlisted.length > 0) throw new Error(`Refusing to start: routes without a role: ${unlisted.join(", ")}`);

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

      // The network listener, once the app answers: `--remote` turns it on as the system actor (the bootstrap invite is
      // the way in when no Owner credential exists yet); otherwise the recorded state decides. A server asked for
      // remote access never comes up without it: any failure here (a bad flag or certificate file, a port in use, a
      // refused certificate order, a read-only ledger) fails the start, and the catch below closes everything.
      if (opts.remote?.enabled) {
        const { enabled: _on, ...flags } = opts.remote;
        const input: EnableInput = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined));
        await remoteListener.enable(CLI_ACTOR, input);
      } else {
        await remoteListener.startIfEnabled();
      }
      // The Owner bootstrap link: issued once per start while nobody owns the workspace and remote access listens; the
      // file holding it goes as soon as the Owner joins (and at any start after that).
      stopBootstrapWatch = watchBootstrapInvite(ledger, opts.dataDir);
      if (!ledger.readOnly) {
        announceBootstrapInvite({
          db, people: people.service, dataDir: opts.dataDir, remote: remoteListener.state(),
          ...(opts.bootstrapInvite && { bootstrapInvite: opts.bootstrapInvite }),
        });
      }
    } catch (err) {
      clearInterval(uploadSweep);
      stopBootstrapWatch();
      await remoteListener.close().catch(() => undefined);
      await remote.shutdown();
      await linkService.shutdown();
      await links.shutdown();
      await overrides.shutdown();
      await previews.shutdown();
      await signin.shutdown();
      await app.close().catch(() => undefined);
      throw err;
    }

    /** The remote listener's address while it is up: the domain, else its first real address (never the wildcard bind). */
    const remoteUrl = (): string | null => {
      const s = remoteListener.state();
      if (!s.enabled || !s.listening) return null;
      const address = s.addresses[0] ?? s.bind;
      return `https://${s.domain ?? (address.includes(":") ? `[${address}]` : address)}:${s.port}/`;
    };

    return {
      url: `http://${APP_HOST}:${boundPort}/?token=${token}`,
      loopbackUrl: `http://127.0.0.1:${boundPort}/`,
      port: boundPort,
      token,
      integrity,
      get remoteUrl() {
        return remoteUrl();
      },
      get fingerprint() {
        const s = remoteListener.state();
        return s.enabled && s.listening ? s.fingerprint : null;
      },
      async close() {
        try {
          clearInterval(uploadSweep);
          stopBootstrapWatch();
          await remoteListener.close(); // the network listener goes first: nothing from outside reaches the rest of the shutdown
          await remote.shutdown(); // stops following runs on linked machines; they go on there and resume on restart
          await linkService.shutdown(); // no linked machine reaches this computer while the rest shuts down
          await links.shutdown(); // closes every share link's listener and records it, while the db is open
          await overrides.shutdown(); // kills every override's process tree and records it, while the db is open
          await runner.shutdown(); // stops runs and denies pending actions while the db is still open
          await previews.shutdown(); // kills every preview's process tree and records it, while the db is open
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
    await link?.shutdown().catch(() => undefined);
    try {
      openedDb?.close();
    } finally {
      lock.release();
    }
    throw err;
  }
}
