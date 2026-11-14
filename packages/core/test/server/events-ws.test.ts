import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { registerAuth } from "../../src/server/auth.js";
import { registerLedgerStream } from "../../src/server/events-ws.js";

const TOKEN = "ws-token";
let app: FastifyInstance;
let ledger: Ledger;
let port: number;
const sockets: WebSocket[] = [];
const rawSockets = new Set<import("node:net").Socket>();

function append(n: number) {
  for (let i = 0; i < n; i++) {
    ledger.append({
      projectId: null,
      actor: { kind: "human", id: "owner" },
      type: "project.created",
      payload: { projectId: `p${i}`, name: "n", pitch: "p" },
    });
  }
}

beforeEach(async () => {
  ledger = new Ledger(openDatabase(":memory:"));
  app = Fastify();
  await registerAuth(app, { token: TOKEN, port: () => port });
  await registerLedgerStream(app, ledger);
  app.server.on("connection", (c) => rawSockets.add(c));
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const c of rawSockets) c.destroy();
  rawSockets.clear();
  await app.close();
});

function connect(query = "", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events${query}`, { headers });
  sockets.push(ws);
  const messages: { seq: number }[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  return { ws, messages };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe("ledger websocket", () => {
  it("sends backlog then live appends", async () => {
    append(2);
    const { messages } = connect("?afterSeq=0");
    await waitFor(() => messages.length === 2);
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    append(1);
    await waitFor(() => messages.length === 3);
    expect(messages[2]!.seq).toBe(3);
  });

  it("honours afterSeq and defaults to 0", async () => {
    append(3);
    const a = connect("?afterSeq=2");
    const b = connect();
    await waitFor(() => a.messages.length === 1 && b.messages.length === 3);
    expect(a.messages[0]!.seq).toBe(3);
  });

  it("pages through backlogs larger than one list page", async () => {
    append(520);
    const { messages } = connect();
    await waitFor(() => messages.length === 520);
    expect(messages.map((m) => m.seq)).toEqual(Array.from({ length: 520 }, (_, i) => i + 1));
  });

  it("refuses a connection without the token", async () => {
    const { ws } = connect("", {});
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  });

  it("refuses a bad Host header", async () => {
    const { ws } = connect("", { authorization: `Bearer ${TOKEN}`, host: "evil.example" });
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
  });

  it("closes with 1008 on an invalid afterSeq", async () => {
    for (const q of ["?afterSeq=abc", "?afterSeq=-1", "?afterSeq=1.5"]) {
      const { ws } = connect(q);
      const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
      expect(code).toBe(1008);
    }
  });

  it("unsubscribes from the ledger when the socket closes", async () => {
    const { ws } = connect();
    await new Promise((r) => ws.on("open", r));
    const before = (ledger as unknown as { listeners: Set<unknown> }).listeners.size;
    expect(before).toBe(1);
    ws.close();
    await waitFor(() => (ledger as unknown as { listeners: Set<unknown> }).listeners.size === 0);
  });
});
