import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { LedgerEntry } from "@theterminal/shared";
import type { Ledger } from "../ledger/ledger.js";

const PAGE = 500;

/** WS /api/events?afterSeq=N: every entry with seq > N in order, then each new append live. */
export function registerLedgerStream(app: FastifyInstance, ledger: Ledger): void {
  app.register(websocket);
  app.register(async (scope) => {
    scope.get("/api/events", { websocket: true }, (socket, request) => {
      const raw = (request.query as { afterSeq?: string }).afterSeq ?? "0";
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        socket.close(1008, "invalid afterSeq");
        return;
      }

      const send = (e: LedgerEntry) => socket.send(JSON.stringify(e));

      // Subscribe first and buffer, so nothing appended during the backlog read is lost.
      let live = false;
      const buffered: LedgerEntry[] = [];
      const unsubscribe = ledger.onAppend((e) => (live ? send(e) : buffered.push(e)));
      socket.on("close", unsubscribe);

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
    });
  });
}
