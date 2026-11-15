import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { TTL_MINUTES, type Actor, type NewLedgerEntry, type ShareLink, type ShareScope } from "@theterminal/shared";
import type { Db } from "../db.js";
import { LedgerReadOnlyError, type Ledger } from "../ledger/ledger.js";
import { commitEvent } from "../events/commit.js";
import { getShareSnapshot, listShareLinks } from "../events/projections.js";
import { HumanRequiredError } from "../intake/service.js";
import { NotFoundError } from "../board/board-service.js";
import { SHARE_CSP } from "./render.js";
import { AddressNotAllowedError, LinkNotActiveError, ShareLinkActiveError } from "./errors.js";

export const SHARE_PORT_DEFAULT = 4400;
export const SHARE_PORT_ATTEMPTS = 21;
export const MAX_TOKEN_FAILURES = 20;
export const TOKEN_BYTES = 32;
/** Concurrent connections one link's listener accepts; a share page is read by a handful of people. */
export const SHARE_MAX_CONNECTIONS = 32;
/** Milliseconds a viewer has to send the request headers, and to complete the whole request. */
export const SHARE_HEADERS_TIMEOUT_MS = 10_000;
export const SHARE_REQUEST_TIMEOUT_MS = 15_000;

/** A `randomBytes(TOKEN_BYTES).toString("base64url")` string: 43 characters, 256 bits. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const LINKS: Actor = { kind: "system", id: "share" };
const ttlSchema = z.union(TTL_MINUTES.map((m) => z.literal(m)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]);

export type ShareAddress = { address: string; scope: ShareScope; label: string };

/** What the manager needs from the share service: the confirmed bytes, checked against the ledger's hash. */
export type ShareHtmlReader = { readHtml(shareId: string): string };

/**
 * The addresses a link may be served on: loopback first, then every non-internal IPv4 address in interface-name
 * then address order. Never a wildcard and never IPv6.
 */
export function shareAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): ShareAddress[] {
  const local: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      const family = info.family as string | number;
      if (info.internal || (family !== "IPv4" && family !== 4)) continue;
      if (!isIPv4(info.address) || info.address === "0.0.0.0") continue;
      local.push({ name, address: info.address });
    }
  }
  local.sort((a, b) => (a.name === b.name ? compareIPv4(a.address, b.address) : a.name < b.name ? -1 : 1));
  const out: ShareAddress[] = [{ address: "127.0.0.1", scope: "this_computer", label: "This computer only" }];
  const seen = new Set(["127.0.0.1"]);
  for (const { address } of local) {
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({ address, scope: "local_network", label: `Local network (${address})` });
  }
  return out;
}

function compareIPv4(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export type LinkManagerDeps = {
  db: Db;
  ledger: Ledger;
  service: ShareHtmlReader;
  port?: number;
  addresses?: () => ShareAddress[];
  now?: () => Date;
  newId?: () => string;
  /** 32 random bytes, base64url. Tests inject one; anything not shaped like that is refused. */
  randomToken?: () => string;
  /** Where a background failure is reported (default `console.error`); it is only ever given a fixed sentence. */
  log?: (message: string) => void;
};

const END_NOT_RECORDED = "The Terminal: a share link was closed but its end could not be recorded";

type EndKind = "revoked" | "expired" | "stopped";
type EndReason = "owner" | "too_many_failures" | "shutdown" | "restart";

/** One listener serving one confirmed page to whoever holds its token. */
type LiveLink = {
  id: string;
  projectId: string;
  app: FastifyInstance;
  /** False from the moment the link starts ending, so no request is served while it closes. */
  serving: boolean;
  ended: Promise<void> | null;
  timer: NodeJS.Timeout | null;
};

const digestOf = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** The page's CSP, plus the one directive a meta tag cannot carry: no one may frame the page. */
const HEADER_CSP = `${SHARE_CSP}; frame-ancestors 'none'`;

/** Every response, page or refusal, carries these. */
function secure(reply: FastifyReply): FastifyReply {
  return reply
    .header("Content-Security-Policy", HEADER_CSP)
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("Cache-Control", "no-store");
}

/**
 * One link listener's Fastify options: bounded and quiet. A request that arrives while the listener closes goes
 * through the routes like any other (they answer 404 `{}` once the link stops serving) instead of Fastify's bare
 * 503, so every response carries the security headers.
 */
export function shareFastifyOptions() {
  return {
    logger: false,
    bodyLimit: 1024,
    routerOptions: { maxParamLength: 100 },
    exposeHeadRoutes: false,
    forceCloseConnections: true,
    return503OnClosing: false,
    connectionTimeout: SHARE_REQUEST_TIMEOUT_MS,
    requestTimeout: SHARE_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 100,
    frameworkErrors: (_err: unknown, _req: unknown, reply: FastifyReply) => {
      void secure(reply).code(400).send({});
    },
  } as const;
}

/**
 * Serves a confirmed share page read-only, behind a token in the path, on this computer or the local network,
 * for as long as the link lives and the workspace runs. The token is shown once, in the returned url; the ledger
 * and memory keep only its SHA-256 digest. Each link has its own listener, closed on revoke, expiry, too many
 * wrong tokens or shutdown, so ending a link drops every connection at once.
 */
export class ShareLinkManager {
  private readonly db: Db;
  private readonly ledger: Ledger;
  private readonly service: ShareHtmlReader;
  private readonly port: number;
  private readonly addresses: () => ShareAddress[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly randomToken: () => string;
  private readonly log: (message: string) => void;
  private readonly live = new Map<string, LiveLink>();
  /** Projects with a create in flight, so two concurrent creates cannot both pass the one-link check. */
  private readonly pending = new Set<string>();
  private closed = false;

  constructor(deps: LinkManagerDeps) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.service = deps.service;
    this.port = deps.port ?? SHARE_PORT_DEFAULT;
    this.addresses = deps.addresses ?? (() => shareAddresses());
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID());
    this.randomToken = deps.randomToken ?? (() => randomBytes(TOKEN_BYTES).toString("base64url"));
    this.log = deps.log ?? ((message) => console.error(message));
  }

  async create(actor: Actor, shareId: string, address: string, ttlMinutes: number): Promise<{ link: ShareLink; url: string }> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const ttl = ttlSchema.parse(ttlMinutes);
    const record = getShareSnapshot(this.db, shareId);
    if (!record) throw new NotFoundError("share snapshot", shareId);
    const bytes = Buffer.from(this.service.readHtml(shareId), "utf8");
    const projectId = record.projectId;
    // A link that cannot be recorded is never opened: refuse before anything listens.
    if (this.ledger.readOnly) throw new LedgerReadOnlyError();
    if (this.closed) throw new Error("the share link server is shutting down");
    if (this.pending.has(projectId) || this.hasActive(projectId)) throw new ShareLinkActiveError();
    const offered = this.addresses().find((a) => a.address === address);
    if (!offered || !isIPv4(address) || address === "0.0.0.0") throw new AddressNotAllowedError();
    const token = this.randomToken();
    if (!TOKEN_SHAPE.test(token)) throw new Error("the share token source did not give 32 random bytes");
    const expected = digestOf(token);

    this.pending.add(projectId);
    try {
      const linkId = this.newId();
      const expiresAt = new Date(this.now().getTime() + ttl * 60_000);
      const app = Fastify(shareFastifyOptions());
      app.server.maxConnections = SHARE_MAX_CONNECTIONS;
      app.server.headersTimeout = SHARE_HEADERS_TIMEOUT_MS;
      app.removeAllContentTypeParsers();
      const link: LiveLink = { id: linkId, projectId, app, serving: true, ended: null, timer: null };
      let boundPort = 0;
      let failures = 0;

      app.addHook("onRequest", async (request, reply) => {
        if (request.headers.host !== `${address}:${boundPort}`) return secure(reply).code(403).send({});
        if (request.method !== "GET" && request.method !== "HEAD") return secure(reply).code(405).send({});
      });
      app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
        const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
        return secure(reply).code(code).send({});
      });
      app.setNotFoundHandler((_req, reply) => secure(reply).code(404).send({}));
      app.route({
        method: ["GET", "HEAD"],
        url: "/:token",
        handler: async (request, reply) => {
          const supplied = (request.params as { token: string }).token;
          if (!link.serving) return secure(reply).code(404).send({});
          if (this.now().getTime() >= expiresAt.getTime()) {
            void this.end(link, "expired").catch(this.reportEnd);
            return secure(reply).code(404).send({});
          }
          if (timingSafeEqual(digestOf(supplied), expected)) {
            return secure(reply).code(200).type("text/html; charset=utf-8").send(bytes);
          }
          // Only something shaped like a token is a guess; a browser's /favicon.ico is not.
          if (TOKEN_SHAPE.test(supplied) && ++failures >= MAX_TOKEN_FAILURES) {
            void this.end(link, "revoked", "too_many_failures").catch(this.reportEnd);
          }
          return secure(reply).code(404).send({});
        },
      });

      await this.listen(app, address, (p) => (boundPort = p));
      if (this.closed) {
        await app.close();
        throw new Error("the share link server is shutting down");
      }

      let entry: ShareLink;
      try {
        entry = commitEvent(this.db, this.ledger, () => ({
          event: {
            projectId, actor, type: "share.link_created",
            payload: { linkId, shareId, tokenDigest: expected.toString("hex"), expiresAt: expiresAt.toISOString(), port: boundPort, scope: offered.scope },
          } as NewLedgerEntry,
          result: () => listShareLinks(this.db, { projectId }).find((l) => l.id === linkId)!,
        }));
      } catch (err) {
        await app.close();
        throw err;
      }

      this.live.set(linkId, link);
      link.timer = setTimeout(() => {
        void this.end(link, "expired").catch(this.reportEnd);
      }, Math.max(0, expiresAt.getTime() - this.now().getTime()));
      link.timer.unref();
      return { link: entry, url: `http://${address}:${boundPort}/${token}` };
    } finally {
      this.pending.delete(projectId);
    }
  }

  async revoke(actor: Actor, linkId: string): Promise<void> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const link = this.live.get(linkId);
    if (!link || !link.serving) throw new LinkNotActiveError();
    await this.end(link, "revoked", "owner", actor);
  }

  /**
   * The links the ledger records, with one correction that fails safe: a row the ledger still calls active but no
   * listener here serves (after a read-only restart, recoverOnStartup cannot record its end) is reported as
   * stopped, which is what the next writable start records. Nothing is ever shown as live that is not.
   */
  list(projectId?: string): ShareLink[] {
    return listShareLinks(this.db, projectId ? { projectId } : {}).map((l) =>
      l.state === "active" && !this.live.get(l.id)?.serving ? { ...l, state: "stopped" } : l,
    );
  }

  /** Links with a listener up right now; what `/api/status` reports. */
  activeCount(): number {
    return this.live.size;
  }

  /** Every link the ledger still calls active had its listener die with the last process: record that. */
  recoverOnStartup(): void {
    for (const row of listShareLinks(this.db, { state: "active" })) {
      if (this.live.has(row.id)) continue;
      this.commitEnd(row.projectId, row.id, "stopped", "restart", LINKS);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live.values()].map((l) => this.end(l, "stopped", "shutdown").catch(this.reportEnd)));
  }

  /** A background end (timer, guesses, shutdown) has no caller to throw to: say so, without the error's text. */
  private readonly reportEnd = (): void => {
    this.log(END_NOT_RECORDED);
  };

  private hasActive(projectId: string): boolean {
    for (const l of this.live.values()) if (l.projectId === projectId) return true;
    return listShareLinks(this.db, { state: "active", projectId }).length > 0;
  }

  private async listen(app: FastifyInstance, host: string, bound: (port: number) => void): Promise<void> {
    await app.ready();
    let lastError: unknown;
    for (let i = 0; i < SHARE_PORT_ATTEMPTS; i++) {
      const candidate = this.port === 0 ? 0 : this.port + i;
      try {
        await app.listen({ host, port: candidate });
        bound((app.server.address() as AddressInfo).port);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          await app.close().catch(() => undefined);
          throw err;
        }
        lastError = err;
      }
    }
    await app.close().catch(() => undefined);
    throw new Error(`No free port between ${this.port} and ${this.port + SHARE_PORT_ATTEMPTS - 1} for the share link`, { cause: lastError });
  }

  /** Stops serving at once, closes the listener (dropping open connections), then records why. Idempotent. */
  private end(link: LiveLink, kind: EndKind, reason?: EndReason, actor: Actor = LINKS): Promise<void> {
    if (link.ended) return link.ended;
    link.serving = false;
    if (link.timer) clearTimeout(link.timer);
    link.ended = (async () => {
      try {
        await link.app.close();
      } finally {
        this.live.delete(link.id);
      }
      this.commitEnd(link.projectId, link.id, kind, reason, actor);
    })();
    return link.ended;
  }

  private commitEnd(projectId: string, linkId: string, kind: EndKind, reason: EndReason | undefined, actor: Actor): void {
    const payload = kind === "expired" ? { linkId } : { linkId, reason };
    commitEvent(this.db, this.ledger, () => ({
      event: { projectId, actor, type: `share.${kind}`, payload } as NewLedgerEntry,
      result: () => undefined,
    }));
  }
}
