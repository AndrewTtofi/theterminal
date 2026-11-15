import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import Fastify, { type FastifyInstance } from "fastify";
import type { Principal, Role } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { AcmeManager, type AcmeClientLike } from "../../src/server/acme.js";
import { PUBLIC_ROUTE } from "../../src/server/auth.js";
import { RemoteListener, checkRemoteHost, listenerOf, type HostRule } from "../../src/server/remote.js";
import { registerRemoteRoutes } from "../../src/server/remote-routes.js";

/** The addresses every test machine claims to have, so certificates and labels do not depend on the host. */
export const TEST_ADDRESSES = { hostnames: ["tt-test.local"], addresses: ["192.168.1.10"] };

export function principal(role: Role, listener: Principal["listener"] = "local"): Principal {
  return {
    personId: role === "owner" ? "owner" : `p-${role}`,
    name: role,
    role,
    listener,
    method: role === "owner" && listener === "local" ? "token" : "passkey",
    sessionId: role === "owner" && listener === "local" ? null : `s-${role}`,
  };
}

export type Harness = {
  app: FastifyInstance;
  db: Db;
  ledger: Ledger;
  secrets: MemorySecretStore;
  remote: RemoteListener;
  /** Present when the harness was given an ACME client. */
  acme: AcmeManager | null;
  dataDir: string;
  uiDir: string;
  root: string;
  owner: { has: boolean };
  /** The plain (local) listener's port. */
  localPort: number;
  /** A new listener over the same data dir, db file and secret store, as after a restart. */
  restart(): Promise<Harness>;
  close(): Promise<void>;
};

const open: Harness[] = [];
const roots: string[] = [];

export async function closeAll(): Promise<void> {
  while (open.length) await open.pop()!.close().catch(() => undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/**
 * A real Fastify app on a plain loopback port, a RemoteListener feeding it TLS sockets, and a stand-in for the
 * auth hook's first two steps: the remote Host check with the `/healthz` exemption. The principal comes from an
 * `x-test-as: <role>` header, so the routes' own checks can be exercised.
 *
 * With `auth`, the real hook replaces the stand-in: the callback registers it (and any routes it needs) on the app
 * before it listens, given the listener's Host rule and the harness's db and ledger, and the principal is then the
 * hook's `request.principal`.
 */
export async function harness(
  opts: {
    root?: string;
    secrets?: MemorySecretStore;
    owner?: { has: boolean };
    now?: () => Date;
    /** Gives the listener an AcmeManager over this client (never the real Let's Encrypt in tests). */
    acmeClient?: AcmeClientLike;
    auth?: (app: FastifyInstance, ctx: { hostRule: () => HostRule; db: Db; ledger: Ledger }) => void;
    /** The machine's names and addresses the listener sees; default TEST_ADDRESSES. */
    localAddresses?: () => { hostnames: string[]; addresses: string[] };
    /** Milliseconds an idle TLS connection may stay open; default the listener's own. */
    idleTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "tt-remote-"));
  if (!opts.root) roots.push(root);
  const dataDir = join(root, "data");
  const uiDir = join(root, "ui");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uiDir, { recursive: true });
  const db = openDatabase(join(dataDir, "ledger.db"));
  const ledger = new Ledger(db);
  const secrets = opts.secrets ?? new MemorySecretStore();
  const owner = opts.owner ?? { has: true };

  const app = Fastify();
  let remote: RemoteListener | null = null;
  if (opts.auth) opts.auth(app, { hostRule: () => remote!.hostRule(), db, ledger });
  else {
    app.addHook("onRequest", async (request, reply) => {
      if (listenerOf(request) === "remote" && !checkRemoteHost(request, remote!.hostRule())) {
        return reply.code(403).send({ error: "bad_host" });
      }
    });
  }
  registerRemoteRoutes(app, {
    remote: { state: () => remote!.state(), enable: (a, i) => remote!.enable(a, i), disable: (a, o) => remote!.disable(a, o) },
    principalOf: opts.auth
      ? (request) => request.principal ?? null
      : (request) => {
          const as = request.headers["x-test-as"];
          return typeof as === "string" ? principal(as as Role, listenerOf(request)) : null;
        },
  });
  app.get("/whoami", { config: PUBLIC_ROUTE }, async (request) => ({ listener: listenerOf(request), ip: request.ip }));
  await app.listen({ port: 0, host: "127.0.0.1" });

  const acme = opts.acmeClient ? new AcmeManager({ secrets, dataDir, client: opts.acmeClient, now: opts.now }) : null;
  remote = new RemoteListener({
    http: app.server,
    db,
    ledger,
    secrets,
    people: { hasOwnerCredential: () => owner.has },
    dataDir,
    uiDir,
    now: opts.now,
    localAddresses: opts.localAddresses ?? (() => TEST_ADDRESSES),
    ...(opts.idleTimeoutMs !== undefined && { idleTimeoutMs: opts.idleTimeoutMs }),
    ...(acme ? { acme, acmePort: 0 } : {}),
  });
  const h: Harness = {
    app,
    db,
    ledger,
    secrets,
    remote,
    acme,
    dataDir,
    uiDir,
    root,
    owner,
    localPort: (app.server.address() as AddressInfo).port,
    async restart() {
      await h.close();
      open.splice(open.indexOf(h), 1);
      return harness({ root, secrets, owner, now: opts.now, acmeClient: opts.acmeClient, auth: opts.auth, localAddresses: opts.localAddresses, idleTimeoutMs: opts.idleTimeoutMs });
    },
    async close() {
      await remote!.close();
      await app.close();
      db.close();
    },
  };
  open.push(h);
  return h;
}

/** A port nothing listens on right now. */
export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

export type RawResponse = { status: number; headers: Record<string, string>; body: string };

/**
 * One HTTP/1.1 request over TLS to 127.0.0.1:<port>, pinned: the request is written only after the server's
 * certificate's SHA-256 fingerprint equals `pin`, and a mismatch rejects without sending a byte.
 */
export function pinnedRequest(
  port: number,
  pin: string,
  req: { method?: string; path: string; host?: string; connectHost?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: req.connectHost ?? "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5000);
    let data = "";
    socket.once("secureConnect", () => {
      const fp = socket.getPeerCertificate().fingerprint256;
      if (fp !== pin) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("fingerprint mismatch"));
        return;
      }
      const headers: Record<string, string> = { host: req.host ?? `127.0.0.1:${port}`, connection: "close", ...req.headers };
      if (req.body !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(req.body));
      }
      const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      socket.write(`${req.method ?? "GET"} ${req.path} HTTP/1.1\r\n${head}\r\n${req.body ?? ""}`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const [head = "", ...rest] = data.split("\r\n\r\n");
      const [statusLine = "", ...lines] = head.split("\r\n");
      const match = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
      if (!match) {
        reject(new Error("no HTTP response"));
        return;
      }
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(":");
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      let body = rest.join("\r\n\r\n");
      if (headers["transfer-encoding"] === "chunked") body = unchunk(body);
      resolve({ status: Number(match[1]), headers, body });
    });
  });
}

function unchunk(s: string): string {
  let out = "";
  let rest = s;
  for (;;) {
    const i = rest.indexOf("\r\n");
    if (i < 0) return out;
    const size = parseInt(rest.slice(0, i), 16);
    if (!size) return out;
    out += rest.slice(i + 2, i + 2 + size);
    rest = rest.slice(i + 2 + size + 2);
  }
}
