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

export type LedgerStreamOptions = {
  /** Sockets are closed with 1008 "revoked" when their session (by id hash) or their person is revoked. */
  sessions?: Pick<SessionStore, "onRevoke">;
  /** Who is here; one registry per server. */
  presence?: PresenceRegistry;
  /** How often expired presence is swept and announced. Default 30 s. */
  sweepMs?: number;
  /** Client presence frames each socket may send per window; the rest are dropped. Default 10 per 10 s. */
  presenceRate?: { max: number; windowMs: number };
};

type Client = { send: (data: string) => void; close: (code: number, reason: string) => void; personId: string; sessionHash: string | null };

const hashOf = (id: string): string => createHash("sha256").update(id).digest("hex");

/**
 * WS /api/events?afterSeq=N: every entry with seq > N in order, then each new append live. A linked machine's mirrored
 * entries are sent through `clean`, this machine's own redaction.
 *
 * The same socket carries presence: the server sends { type: "presence", people } once on connect and on every change
 * (an entry always has "seq", a presence frame never does), and the client sends { type: "presence", projectId, view }.
 * The principal is required; each socket keeps only sha256(sessionId), so a single-session revoke closes exactly that
 * session's sockets. GET /api/presence answers the same list.
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
  const stopRevoke = opts.sessions?.onRevoke((personId, sessionIdHash) => {
    for (const [id, c] of clients) {
      if (c.personId !== personId) continue;
      if (sessionIdHash !== null && c.sessionHash !== sessionIdHash) continue;
      clients.delete(id);
      presence.leave(id);
      c.close(1008, "revoked");
    }
  });
  const sweeper = setInterval(() => presence.sweep(), opts.sweepMs ?? 30_000);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    stopPresence();
    stopRevoke?.();
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
      clients.set(socketId, {
        send: sendRaw,
        close: (code, reason) => socket.close(code, reason),
        personId: principal.personId,
        sessionHash: principal.sessionId === null ? null : hashOf(principal.sessionId),
      });
      sendRaw(frame(presence.list()));
    });
  });
}
