import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import type { LinkIdentity } from "./identity.js";
import { sendError } from "../server/routes.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The paired machine whose pinned key opened this connection; null only on the pairing route. */
    linkPeer: { machineId: string } | null;
  }
}

/** The pinned machine for this SPKI DER, else null. */
export type PeerCheck = (spkiDer: Buffer) => { machineId: string } | null;

export type ListenerDeps = {
  identity: LinkIdentity;
  peer: PeerCheck;
  /** Whether a pairing window is open: only then may an unknown key reach the pairing route. */
  pairingOpen: () => boolean;
  /** Adds the `/link/v1/*` routes; called on every start, with a fresh instance. */
  register: (app: FastifyInstance) => void;
  /** Default `0.0.0.0`: IPv4 only, never a dual-stack `::`, so a peer's remote address is always dotted IPv4. */
  bind?: string;
};

/** The one route an unknown key may reach, and only while a pairing window is open. */
export const PAIR_PATH = "/link/v1/pair";
/** JSON bodies; the bundle routes (Task 7) set their own limit. */
export const LINK_BODY_LIMIT = 64 * 1024;
const PORT_ATTEMPTS = 21; // the requested port plus 20 above it
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 10_000;
/** Idle time on a socket before it is closed; a stream with nothing to send for this long is cut, and resumes. */
const IDLE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 300_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 64;

/** The client certificate's SPKI DER, or null when the client sent none. */
function clientSpki(socket: TLSSocket): Buffer | null {
  try {
    const cert = socket.getPeerX509Certificate();
    return cert ? cert.publicKey.export({ type: "spki", format: "der" }) : null;
  } catch {
    return null;
  }
}

/**
 * The link listener: an HTTPS server that accepts TLS 1.3 only, requires a client certificate and serves only the
 * `/link/v1/*` routes. A connection whose key is not a paired machine's is destroyed at the TLS layer before any byte
 * of a request is read, unless a pairing window is open, when it may reach the pairing route only. It has no cookie,
 * no bearer token, no static UI and no websocket: the pinned certificate is its only authentication.
 */
export class LinkListener {
  private app: FastifyInstance | null = null;
  private bound: number | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly deps: ListenerDeps) {}

  port(): number | null {
    return this.bound;
  }

  /** Binds `port`, or the first free one of the 20 above it (`0` picks any); returns the bound port. */
  async start(port: number): Promise<number> {
    if (this.app) throw new Error("the link listener is already running");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("port out of range");
    const host = this.deps.bind ?? "0.0.0.0";
    let lastError: unknown;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const candidate = port === 0 ? 0 : port + i;
      if (candidate > 65535) break;
      const app = this.build();
      try {
        await app.listen({ host, port: candidate });
        this.app = app;
        this.bound = (app.server.address() as AddressInfo).port;
        return this.bound;
      } catch (err) {
        await app.close().catch(() => undefined);
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        lastError = err;
        if (port === 0) break;
      }
    }
    throw lastError ?? new Error("no free port for the link listener");
  }

  /** Closes every socket, then the server. */
  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    this.bound = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (app) await app.close().catch(() => undefined);
  }

  private build(): FastifyInstance {
    const { identity, peer, pairingOpen } = this.deps;
    const app = Fastify({
      https: {
        ...identity.tls(),
        requestCert: true,
        // Every client certificate is self-signed: the pin below is the check, not a CA.
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      },
      bodyLimit: LINK_BODY_LIMIT,
      connectionTimeout: IDLE_TIMEOUT_MS,
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      forceCloseConnections: true,
      routerOptions: { maxParamLength: 200 },
    });
    const server = app.server;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.maxConnections = MAX_CONNECTIONS;
    const keys = new WeakMap<Socket, Buffer>();
    server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.once("close", () => this.sockets.delete(s));
    });
    // Before the HTTP layer's own listener, so a refused connection is never handed to it.
    server.prependListener("secureConnection", (s: TLSSocket) => {
      const spki = s.getProtocol() === "TLSv1.3" ? clientSpki(s) : null;
      if (spki === null || (peer(spki) === null && !pairingOpen())) {
        s.destroy();
        return;
      }
      keys.set(s, spki);
    });
    // A failed handshake (plain HTTP, TLS 1.2, a bad certificate) only closes that socket.
    server.on("tlsClientError", (_err, s) => s.destroy());

    app.decorateRequest("linkPeer", null);
    app.addHook("onRequest", async (request, reply) => {
      const socket = request.raw.socket;
      const spki = keys.get(socket);
      const known = spki === undefined ? null : peer(spki);
      request.linkPeer = known;
      const path = request.url.split("?")[0];
      if (known === null && path !== PAIR_PATH) {
        reply.raw.once("finish", () => socket.destroy());
        reply.header("connection", "close").code(403).send({ error: "unknown_machine" });
        return reply;
      }
    });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));
    app.setErrorHandler((err, _req, reply) => sendError(err, reply, app.log));
    this.deps.register(app);
    return app;
  }
}
