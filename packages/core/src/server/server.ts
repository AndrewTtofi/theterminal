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
import { ADAPTERS, type AdapterId } from "@theterminal/shared";
import type { AgentAdapter } from "../agents/adapter.js";
import { ApprovalBroker } from "../agents/approvals.js";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { FakeAdapter, type FakeStep } from "../agents/fake-adapter.js";
import { secretEnvValues } from "../agents/redact.js";
import { AgentRunner } from "../agents/runner.js";
import { ClaudeSettings } from "../agents/settings.js";
import { WorktreeManager } from "../agents/worktrees.js";

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

/** Claude always; the scripted fake adapter only when THETERMINAL_FAKE_AGENT=1 (tests and demos). */
function buildAdapters(): Partial<Record<AdapterId, AgentAdapter>> {
  const adapters: Partial<Record<AdapterId, AgentAdapter>> = { claude: new ClaudeAdapter() };
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

export async function createServer(opts: {
  dataDir: string;
  port?: number;
  uiDir?: string;
  token?: string;
  /** How long close() waits for agent adapters to return after stopping them. */
  shutdownTimeoutMs?: number;
}): Promise<RunningServer> {
  const adapters = buildAdapters();
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

  const runner = new AgentRunner({
    db,
    ledger,
    worktrees: new WorktreeManager(opts.dataDir),
    broker: new ApprovalBroker(),
    adapters,
    extraSecrets: [token, ...secretEnvValues(process.env)],
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
      settings: new ClaudeSettings(db, ledger),
      adapters: ADAPTERS.filter((id) => adapters[id] !== undefined),
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
