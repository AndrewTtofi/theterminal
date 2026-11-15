import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { SessionStore } from "../../src/people/sessions.js";
import { registerAuth } from "../../src/server/auth.js";
import { registerLedgerStream } from "../../src/server/events-ws.js";
import { PresenceRegistry, type PresenceEntry } from "../../src/server/presence.js";
import { SESSION_COOKIE } from "../../src/server/auth.js";
import type { Person, Role } from "@theterminal/shared";

const TOKEN = "ws-token";
let app: FastifyInstance;
let ledger: Ledger;
let port: number;
let sessions: SessionStore;
let presence: PresenceRegistry;
const sockets: WebSocket[] = [];
const people = new Map<string, Person>();
const person = (id: string, role: Role, name: string): Person => ({
  id, name, role, joinedAt: "2026-11-15T00:00:00.000Z", lastSeenAt: null, removedAt: null, credentials: 1,
});

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
  const db = openDatabase(":memory:");
  ledger = new Ledger(db);
  sessions = new SessionStore(db);
  presence = new PresenceRegistry();
  people.clear();
  people.set("owner", person("owner", "owner", "Ada"));
  people.set("p-viewer", person("p-viewer", "viewer", "Vic"));
  people.set("p-reviewer", person("p-reviewer", "reviewer", "Rae"));
  app = Fastify();
  registerAuth(app, { token: TOKEN, port: () => port, hostRule: () => null, sessions, person: (id) => people.get(id) ?? null });
  registerLedgerStream(app, ledger, undefined, { sessions, presence });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.close();
});

function connect(query = "", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, path = "/api/events") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, { headers });
  sockets.push(ws);
  const messages: { seq: number }[] = [];
  const frames: PresenceEntry[][] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { seq?: number; type?: string; people?: PresenceEntry[] };
    if ("seq" in m) messages.push(m as { seq: number });
    else if (m.type === "presence") frames.push(m.people!);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, r) => resolve({ code, reason: String(r) })));
  const latest = () => frames[frames.length - 1];
  return { ws, messages, frames, latest, closed };
}

/** A socket signed in with a fresh session of `personId`; `id` is the session id, as the sign-in routes would mint it. */
function connectAs(personId: string) {
  const { id } = sessions.create(personId, "local", "passkey");
  return { ...connect("", { cookie: `${SESSION_COOKIE}=${id}` }), sessionId: id };
}

const opened = (ws: WebSocket) => new Promise((r) => (ws.readyState === WebSocket.OPEN ? r(null) : ws.on("open", r)));

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
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  });

  it("refuses a bad Host header", async () => {
    const { ws } = connect("", { authorization: `Bearer ${TOKEN}`, host: "evil.example" });
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
  });

  it("refuses an encoded-path upgrade without the token", async () => {
    const { ws } = connect("", {}, "/%61pi/events");
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  });

  it("refuses a foreign Origin even with a valid cookie, and accepts a matching one", async () => {
    const cookie = `tt_token=${TOKEN}`;
    const bad = connect("", { cookie, origin: "http://127.0.0.1:9999" });
    const status = await new Promise<number>((resolve) => {
      bad.ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      bad.ws.on("error", () => {});
    });
    expect(status).toBe(403);
    append(1);
    const good = connect("", { cookie, origin: `http://127.0.0.1:${port}` });
    await waitFor(() => good.messages.length === 1);
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

describe("presence over the ledger stream", () => {
  const names = (people: PresenceEntry[] | undefined) => (people ?? []).map((p) => p.name).sort();

  it("sends the list once on connect and to everyone on each change, naming both people", async () => {
    const a = connectAs("p-viewer");
    await waitFor(() => names(a.latest()).join() === "Vic");
    const b = connectAs("p-reviewer");
    await waitFor(() => names(a.latest()).join() === "Rae,Vic" && names(b.latest()).join() === "Rae,Vic");
    expect(b.frames.length).toBe(1); // once on connect; its own join is not sent twice
    expect(presence.list()).toHaveLength(2);
  });

  it("carries only the plan's fields", async () => {
    const a = connectAs("p-viewer");
    await waitFor(() => a.frames.length === 1);
    expect(Object.keys(a.latest()![0]!).sort()).toEqual(["name", "personId", "projectId", "role", "since", "view"]);
    expect(a.latest()![0]).toMatchObject({ personId: "p-viewer", name: "Vic", role: "viewer", projectId: null, view: null });
  });

  it("broadcasts a well-formed update and ignores a malformed view", async () => {
    const a = connectAs("p-viewer");
    const b = connectAs("p-reviewer");
    await waitFor(() => names(a.latest()).length === 2 && names(b.latest()).length === 2);
    a.ws.send(JSON.stringify({ type: "presence", projectId: "p1", view: "board" }));
    const vic = (people: PresenceEntry[] | undefined) => people?.find((p) => p.personId === "p-viewer");
    await waitFor(() => vic(b.latest())?.view === "board");
    expect(vic(b.latest())?.projectId).toBe("p1");
    const before = b.frames.length;
    a.ws.send(JSON.stringify({ type: "presence", projectId: "p1", view: "<script>" }));
    a.ws.send("not json");
    a.ws.send(JSON.stringify({ type: "other" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(b.frames.length).toBe(before);
    expect(vic(presence.list())?.view).toBe("board");
  });

  it("removes a person whose socket closes", async () => {
    const a = connectAs("p-viewer");
    const b = connectAs("p-reviewer");
    await waitFor(() => names(b.latest()).length === 2);
    a.ws.close();
    await waitFor(() => names(b.latest()).join() === "Rae");
  });

  it("closes a revoked session's socket with 1008 within 500 ms; the person's other session stays (matched by hash)", async () => {
    const one = connectAs("p-viewer");
    const two = connectAs("p-viewer");
    const watcher = connectAs("p-reviewer");
    await Promise.all([opened(one.ws), opened(two.ws), opened(watcher.ws)]);
    await waitFor(() => names(watcher.latest()).join() === "Rae,Vic");
    const t = Date.now();
    sessions.revoke(one.sessionId);
    expect(await one.closed).toEqual({ code: 1008, reason: "revoked" });
    expect(Date.now() - t).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 50));
    expect(two.ws.readyState).toBe(WebSocket.OPEN);
    expect(watcher.ws.readyState).toBe(WebSocket.OPEN);
    expect(names(presence.list())).toEqual(["Rae", "Vic"]);
    sessions.revokeAll("p-viewer");
    expect(await two.closed).toEqual({ code: 1008, reason: "revoked" });
    await waitFor(() => names(watcher.latest()).join() === "Rae");
    expect(watcher.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("does not close a socket of the same person on another person's revoke", async () => {
    const a = connectAs("p-viewer");
    await opened(a.ws);
    sessions.revokeAll("p-reviewer");
    await new Promise((r) => setTimeout(r, 50));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes the socket when the registry refuses it", async () => {
    await app.close();
    const db = openDatabase(":memory:");
    ledger = new Ledger(db);
    app = Fastify();
    registerAuth(app, { token: TOKEN, port: () => port, hostRule: () => null, sessions: new SessionStore(db), person: () => null });
    registerLedgerStream(app, ledger, undefined, { presence: new PresenceRegistry({ maxSockets: 1 }) });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
    append(1);
    const first = connect();
    await waitFor(() => first.messages.length === 1);
    const second = connect();
    expect(await second.closed).toEqual({ code: 1008, reason: "too many connections" });
    expect(second.messages).toEqual([]);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes 1008 unauthorized when an upgrade arrives with no principal", async () => {
    await app.close();
    ledger = new Ledger(openDatabase(":memory:"));
    app = Fastify(); // no auth hook: the stream itself must refuse
    registerLedgerStream(app, ledger);
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
    append(1);
    const c = connect("", {});
    expect(await c.closed).toEqual({ code: 1008, reason: "unauthorized" });
    expect(c.messages).toEqual([]);
  });

  it("rate-limits presence frames per socket", async () => {
    const update = vi.spyOn(presence, "update");
    const a = connectAs("p-viewer");
    await opened(a.ws);
    for (let i = 0; i < 100; i++) a.ws.send(JSON.stringify({ type: "presence", projectId: null, view: "board" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(update.mock.calls.length).toBeGreaterThan(0);
    expect(update.mock.calls.length).toBeLessThanOrEqual(10);
    // Another socket has its own budget.
    const b = connectAs("p-reviewer");
    await opened(b.ws);
    const n = update.mock.calls.length;
    b.ws.send(JSON.stringify({ type: "presence", projectId: null, view: "board" }));
    await waitFor(() => update.mock.calls.length === n + 1);
  });

  it("sweeps expired sockets on an interval and stops when the server closes", async () => {
    await app.close();
    let t = Date.parse("2026-11-15T00:00:00.000Z");
    const reg = new PresenceRegistry({ now: () => new Date(t) });
    const sweep = vi.spyOn(reg, "sweep");
    const db = openDatabase(":memory:");
    ledger = new Ledger(db);
    sessions = new SessionStore(db);
    app = Fastify();
    registerAuth(app, { token: TOKEN, port: () => port, hostRule: () => null, sessions, person: (id) => people.get(id) ?? null });
    registerLedgerStream(app, ledger, undefined, { sessions, presence: reg, sweepMs: 20 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
    const quiet = connectAs("p-viewer");
    const watcher = connectAs("p-reviewer");
    await waitFor(() => names(watcher.latest()).length === 2);
    t += 4 * 60_000;
    watcher.ws.send(JSON.stringify({ type: "presence", projectId: null, view: "board" })); // the watcher's heartbeat
    await waitFor(() => watcher.latest()?.find((p) => p.personId === "p-reviewer")?.view === "board");
    t += 2 * 60_000; // the quiet socket is now past five minutes; the watcher is not
    await waitFor(() => names(watcher.latest()).join() === "Rae");
    expect(quiet.ws.readyState).toBe(WebSocket.OPEN);
    await app.close();
    const calls = sweep.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(sweep.mock.calls.length).toBe(calls);
  });

  async function restartWith(reg: PresenceRegistry) {
    await app.close();
    const db = openDatabase(":memory:");
    ledger = new Ledger(db);
    sessions = new SessionStore(db);
    app = Fastify();
    registerAuth(app, { token: TOKEN, port: () => port, hostRule: () => null, sessions, person: (id) => people.get(id) ?? null });
    registerLedgerStream(app, ledger, undefined, { sessions, presence: reg, sweepMs: 60_000 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  }

  it("re-joins an expired socket on its next presence frame", async () => {
    let t = Date.parse("2026-11-15T00:00:00.000Z");
    const reg = new PresenceRegistry({ now: () => new Date(t), ttlMs: 1000 });
    await restartWith(reg);
    const quiet = connectAs("p-viewer");
    const watcher = connectAs("p-reviewer");
    await waitFor(() => names(watcher.latest()).length === 2);
    t += 1000;
    reg.sweep(); // both expired
    expect(reg.list()).toEqual([]);
    quiet.ws.send(JSON.stringify({ type: "presence", projectId: "p1", view: "board" }));
    await waitFor(() => reg.list().some((p) => p.personId === "p-viewer" && p.view === "board"));
    watcher.ws.send(JSON.stringify({ type: "presence", projectId: null, view: null }));
    await waitFor(() => names(watcher.latest()).join() === "Rae,Vic");
    expect(quiet.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes an expired socket with 1008 when its re-join is refused", async () => {
    let t = Date.parse("2026-11-15T00:00:00.000Z");
    const reg = new PresenceRegistry({ now: () => new Date(t), ttlMs: 1000, maxSockets: 1 });
    await restartWith(reg);
    const first = connectAs("p-viewer");
    await waitFor(() => first.frames.length === 1);
    t += 1000; // first expires; a second socket takes the only place
    const second = connectAs("p-reviewer");
    await waitFor(() => second.frames.length === 1);
    first.ws.send(JSON.stringify({ type: "presence", projectId: null, view: "board" }));
    expect(await first.closed).toEqual({ code: 1008, reason: "too many connections" });
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(names(reg.list())).toEqual(["Rae"]);
  });

  it("GET /api/presence lists the same, for a viewer, from the events-ws plugin alone", async () => {
    const a = connectAs("p-reviewer");
    await waitFor(() => a.frames.length === 1);
    const { id } = sessions.create("p-viewer", "local", "passkey");
    const res = await app.inject({ method: "GET", url: "/api/presence", headers: { host: `127.0.0.1:${port}`, cookie: `${SESSION_COOKIE}=${id}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(presence.list());
    expect(res.json().map((p: PresenceEntry) => p.name)).toEqual(["Rae"]);
    const anon = await app.inject({ method: "GET", url: "/api/presence", headers: { host: `127.0.0.1:${port}` } });
    expect(anon.statusCode).toBe(401);
  });
});
