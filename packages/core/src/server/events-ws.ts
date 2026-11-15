import { createHash, randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { LedgerEntry } from "@theterminal/shared";
import type { Ledger } from "../ledger/ledger.js";
import type { SessionStore } from "../people/sessions.js";
import { builtInClean, displayEntry } from "../link/mirrored.js";
import { trimForRole } from "../ledger/trim.js";
import { PresenceRegistry } from "./presence.js";

const PAGE = 500;
/** A client frame is a small JSON object; anything larger is refused by the socket itself. */
const MAX_CLIENT_FRAME = 4096;
/** How often each socket is pinged; one that has not answered by the next ping is terminated. */
export const EVENTS_PING_MS = 30_000;
/** Entries that end a person's open sockets: their role (and so what they may see) changed, or they are gone. */
const CLOSES_SOCKETS: Record<string, string> = { "person.role_changed": "role changed", "person.removed": "removed" };

export type LedgerStreamOptions = {
  /** Sockets are closed with 1008 "revoked" when their session (by id hash) or their person is revoked. */
  sessions?: Pick<SessionStore, "onRevoke">;
  /** Who is here; one registry per server. */
  presence?: PresenceRegistry;
  /** How often expired presence is swept and announced. Default 30 s. */
  sweepMs?: number;
  /** Client presence frames each socket may send per window; the rest are dropped. Default 10 per 10 s. */
  presenceRate?: { max: number; windowMs: number };
  /** The ping interval; a socket that misses one is terminated. Default EVENTS_PING_MS. */
  pingMs?: number;
};

type Client = {
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
  ping: () => void;
  terminate: () => void;
  /** Cleared at each ping, set by the pong: false at the next ping means the peer is gone. */
  alive: boolean;
  personId: string;
  sessionHash: string | null;
};

const hashOf = (id: string): string => createHash("sha256").update(id).digest("hex");

/**
 * WS /api/events?afterSeq=N: every entry with seq > N in order, then each new append live. A linked machine's mirrored
 * entries are sent through `clean`, this machine's own redaction.
 *
 * The same socket carries presence: the server sends { type: "presence", people } once on connect and on every change
 * (an entry always has "seq", a presence frame never does), and the client sends { type: "presence", projectId, view }.
 * The principal is required; each socket keeps only sha256(sessionId), so a single-session revoke closes exactly that
 * session's sockets; a role change or removal closes every socket of the person (1008), so what they may see is judged
 * again on reconnect. Each socket is pinged on an interval and terminated when it stops answering, so an idle remote
 * connection whose peer is gone does not linger. GET /api/presence answers the same list.
 */
export function registerLedgerStream(
  app: FastifyInstance,
  ledger: Ledger,
  clean: (s: string) => string = builtInClean,
  opts: LedgerStreamOptions = {},
): void {
  const presence = opts.presence ?? new PresenceRegistry();
  const rate = opts.presenceRate ?? { max: 10, windowMs: 10_000 };
  const clients = new Map<string, Client>();

  const frame = (people: unknown) => JSON.stringify({ type: "presence", people });
  const stopPresence = presence.onChange((people) => {
    const data = frame(people);
    for (const c of clients.values()) c.send(data);
  });
  const closeAll = (personId: string, sessionIdHash: string | null, reason: string): void => {
    for (const [id, c] of clients) {
      if (c.personId !== personId) continue;
      if (sessionIdHash !== null && c.sessionHash !== sessionIdHash) continue;
      clients.delete(id);
      presence.leave(id);
      c.close(1008, reason);
    }
  };
  const stopRevoke = opts.sessions?.onRevoke((personId, sessionIdHash) => closeAll(personId, sessionIdHash, "revoked"));
  const stopRoles = ledger.onAppend((e) => {
    const reason = CLOSES_SOCKETS[e.type];
    const personId = (e.payload as { personId?: unknown }).personId;
    if (reason !== undefined && typeof personId === "string") closeAll(personId, null, reason);
  });
  const sweeper = setInterval(() => presence.sweep(), opts.sweepMs ?? 30_000);
  sweeper.unref();
  const pinger = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.terminate(); // its close event removes it from clients and presence
        continue;
      }
      c.alive = false;
      c.ping();
    }
  }, opts.pingMs ?? EVENTS_PING_MS);
  pinger.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    clearInterval(pinger);
    stopPresence();
    stopRevoke?.();
    stopRoles();
    clients.clear();
  });

  app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME } });
  app.register(async (scope) => {
    scope.get("/api/presence", async () => presence.list());

    scope.get("/api/events", { websocket: true }, (socket, request) => {
      const principal = request.principal;
      if (!principal) {
        socket.close(1008, "unauthorized");
        return;
      }
      const raw = (request.query as { afterSeq?: string }).afterSeq ?? "0";
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        socket.close(1008, "invalid afterSeq");
        return;
      }

      const socketId = randomUUID();
      if (!presence.join(socketId, principal)) {
        socket.close(1008, "too many connections");
        return;
      }
      const sendRaw = (data: string) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      };

      let windowStart = Date.now();
      let used = 0;
      socket.on("message", (data) => {
        if (!clients.has(socketId)) return; // revoked or refused and closing: never re-joins
        const now = Date.now();
        if (now - windowStart >= rate.windowMs) {
          windowStart = now;
          used = 0;
        }
        if (++used > rate.max) return;
        let m: unknown;
        try {
          m = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof m !== "object" || m === null || (m as { type?: unknown }).type !== "presence") return;
        // A socket whose slot expired (missed heartbeats) or was dropped comes back on its next presence frame; if the
        // registry refuses it, the socket goes, as at connect.
        if (!presence.has(socketId) && !presence.join(socketId, principal)) {
          clients.delete(socketId);
          socket.close(1008, "too many connections");
          return;
        }
        const { projectId, view } = m as { projectId?: unknown; view?: unknown };
        // The registry checks both values and ignores a malformed pair.
        presence.update(socketId, { projectId: projectId as string | null, view: view as string | null });
      });

      // Each socket's copy is the principal's: a collaborator's connection entries carry no config or field names.
      const send = (e: LedgerEntry) => sendRaw(JSON.stringify(trimForRole(displayEntry(e, clean), principal)));

      // Subscribe first and buffer, so nothing appended during the backlog read is lost.
      let live = false;
      const buffered: LedgerEntry[] = [];
      const unsubscribe = ledger.onAppend((e) => (live ? send(e) : buffered.push(e)));
      socket.on("close", () => {
        unsubscribe();
        if (clients.delete(socketId)) presence.leave(socketId);
      });

      let last = Number(raw);
      for (;;) {
        const page = ledger.list({ afterSeq: last, limit: PAGE });
        for (const e of page) send(e);
        if (page.length > 0) last = page[page.length - 1]!.seq;
        if (page.length < PAGE) break;
      }
      for (const e of buffered) if (e.seq > last) send(e);
      buffered.length = 0;
      live = true;

      // The backlog read above is synchronous, so no presence change or revoke was missed while it ran. The list goes
      // once, after the backlog (a client's first message stays its first entry); this socket missed its own join's
      // broadcast on purpose.
      const client: Client = {
        send: sendRaw,
        close: (code, reason) => socket.close(code, reason),
        ping: () => {
          if (socket.readyState === socket.OPEN) socket.ping();
        },
        terminate: () => socket.terminate(),
        alive: true,
        personId: principal.personId,
        sessionHash: principal.sessionId === null ? null : hashOf(principal.sessionId),
      };
      socket.on("pong", () => (client.alive = true));
      clients.set(socketId, client);
      sendRaw(frame(presence.list()));
    });
  });
}
