import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { openDatabase } from "../db.js";
import { Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService } from "../board/board-service.js";
import { registerRoutes } from "./routes.js";
import { registerAuth, APP_HOST } from "./auth.js";
import { registerStaticUi } from "./static-ui.js";
import { registerLedgerStream } from "./events-ws.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { ADAPTERS, PROVIDERS, type AdapterId, type Provider } from "@theterminal/shared";
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

export async function createServer(opts: {
  dataDir: string;
  port?: number;
  uiDir?: string;
  token?: string;
  /** How long close() waits for agent adapters to return after stopping them. */
  shutdownTimeoutMs?: number;
  /** Tests only: the PATH lookup for provider CLIs. Default: the PATH of this process. */
  which?: Which;
  /** Tests only: replaces the bundled program lookups. Default: the packages installed with this one. */
  bundled?: Partial<BundledPrograms>;
}): Promise<RunningServer> {
  const which: Which = opts.which ?? whichOnPath;
  // Located once, at startup: every listing and run start reuses the result.
  const lookups: BundledPrograms = { ...BUNDLED, ...opts.bundled };
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
  const db = openDatabase(join(opts.dataDir, "ledger.db"));
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

  const runner = new AgentRunner({
    db,
    ledger,
    worktrees: new WorktreeManager(opts.dataDir),
    broker: new ApprovalBroker(),
    adapters,
    extraSecrets: () => [token, ...secretEnvValues(process.env)], // read on every clean: secrets added later are redacted at once
    dataDir: opts.dataDir,
    ...(opts.shutdownTimeoutMs !== undefined && { shutdownTimeoutMs: opts.shutdownTimeoutMs }),
  });

  const app = Fastify();
  let boundPort = 0;
  try {
    if (!ledger.readOnly) runner.recoverOnStartup(); // nothing survived the restart: deny and fail
    registerAuth(app, { token, port: () => boundPort });
    registerLedgerStream(app, ledger);
    registerRoutes(app, { board, ledger, getIntegrity: () => integrity });
    registerAgentRoutes(app, {
      db,
      runner,
      settings: new ProviderSettings(db, ledger),
      adapters: ADAPTERS.filter((id) => adapters[id] !== undefined),
      // As a run would locate it: a test fixture, else the bundled program, else (only then) PATH.
      available: (p) => fakeCli[p] !== undefined || bundled[p]() !== null || which(PROVIDER_CLI[p]) !== null,
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
    await app.close().catch(() => undefined);
    db.close();
    throw err;
  }

  return {
    url: `http://${APP_HOST}:${boundPort}/?token=${token}`,
    loopbackUrl: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    token,
    integrity,
    async close() {
      await runner.shutdown(); // stops runs and denies pending actions while the db is still open
      for (const client of app.websocketServer.clients) client.terminate();
      await app.close();
      db.close();
    },
  };
}
