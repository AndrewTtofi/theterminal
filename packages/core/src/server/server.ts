import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { openDatabase } from "../db.js";
import { Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService } from "../board/board-service.js";
import { registerRoutes } from "./routes.js";
import { registerAuth } from "./auth.js";
import { registerStaticUi } from "./static-ui.js";
import { registerLedgerStream } from "./events-ws.js";

export type RunningServer = {
  url: string;
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

export async function createServer(opts: {
  dataDir: string;
  port?: number;
  uiDir?: string;
  token?: string;
}): Promise<RunningServer> {
  mkdirSync(opts.dataDir, { recursive: true });
  const db = openDatabase(join(opts.dataDir, "ledger.db"));
  const ledger = new Ledger(db);
  const board = new BoardService(db, ledger);
  const token = loadToken(opts.dataDir, opts.token);

  const integrity = ledger.verify();
  if (!integrity.ok) ledger.readOnly = true;

  const app = Fastify();
  let boundPort = 0;
  try {
    registerAuth(app, { token, port: () => boundPort });
    registerLedgerStream(app, ledger);
    registerRoutes(app, { board, ledger, getIntegrity: () => integrity });
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
    url: `http://127.0.0.1:${boundPort}/?token=${token}`,
    port: boundPort,
    token,
    integrity,
    async close() {
      for (const client of app.websocketServer.clients) client.terminate();
      await app.close();
      db.close();
    },
  };
}
