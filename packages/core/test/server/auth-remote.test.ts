import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Person, Role } from "@theterminal/shared";
import { SessionStore } from "../../src/people/sessions.js";
import { APP_HOST, PUBLIC_ROUTE, SESSION_COOKIE, TOKEN_COOKIE, registerAuth } from "../../src/server/auth.js";
import { registerLedgerStream } from "../../src/server/events-ws.js";
import { closeAll, harness, pinnedRequest, type Harness } from "../fixtures/remote-harness.js";

const OWNER: Actor = { kind: "human", id: "owner" };
const TOKEN = "secret-token-TESTKEY";

const person = (id: string, role: Role): Person => ({
  id, name: `${role} person`, role, joinedAt: "2026-11-15T00:00:00.000Z", lastSeenAt: null, removedAt: null, credentials: 1,
});
const PEOPLE = new Map<string, Person>([
  ["owner", { ...person("owner", "owner"), name: "Owner" }],
  ["p-viewer", person("p-viewer", "viewer")],
  ["p-maintainer", person("p-maintainer", "maintainer")],
]);

afterEach(closeAll);

type Remote = { h: Harness; port: number; fp: string; sessions: SessionStore };

/** The harness with the real auth hook, its TLS listener on, and `GET /api/me` reporting the principal. */
async function remoteWithAuth(): Promise<Remote> {
  let sessions: SessionStore | null = null;
  const h = await harness({
    auth: (app, { hostRule, db, ledger }) => {
      sessions = new SessionStore(db);
      registerAuth(app, {
        token: TOKEN,
        port: () => (app.server.address() as AddressInfo).port,
        hostRule,
        sessions,
        person: (id) => PEOPLE.get(id) ?? null,
      });
      registerLedgerStream(app, ledger);
      app.get("/api/me", async (request) => ({ principal: request.principal, listener: request.listener, ip: request.ip }));
      app.get("/", { config: PUBLIC_ROUTE }, async () => "ui");
    },
  });
  const state = await h.remote.enable(OWNER, { port: 0, bind: "127.0.0.1" });
  return { h, port: state.port, fp: state.fingerprint!, sessions: sessions! };
}

const cookie = (r: Remote, personId: string, on: "local" | "remote"): string =>
  `${SESSION_COOKIE}=${r.sessions.create(personId, on, "passkey").id}`;

/** One plain-HTTP request to the local listener, on the app hostname (where alone a local session is honoured). */
function localRequest(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `${APP_HOST}:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A WebSocket upgrade over TLS: the status line of the answer (101 or a refusal) and whether the socket was closed. */
function upgradeOverTls(port: number, headers: Record<string, string>): Promise<{ status: number; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5000);
    let data = "";
    let status = 0;
    socket.once("secureConnect", () => {
      const head = Object.entries({
        host: `127.0.0.1:${port}`, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"), ...headers,
      })
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(`GET /api/events HTTP/1.1\r\n${head}\r\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (m && status === 0) {
        status = Number(m[1]);
        if (status === 101) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ status, closed: false });
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ status, closed: true });
    });
  });
}

describe("the auth hook over a real TLS listener", { timeout: 20_000 }, () => {
  it("refuses the Owner's bearer and the token cookie over TLS, while the plain listener takes them", async () => {
    const r = await remoteWithAuth();
    const bearer = await pinnedRequest(r.port, r.fp, { path: "/api/me", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.status).toBe(401);
    expect(JSON.parse(bearer.body)).toEqual({ error: "unauthorized" });
    const viaCookie = await pinnedRequest(r.port, r.fp, { path: "/api/me", headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
    expect(viaCookie.status).toBe(401);
    const local = await localRequest(r.h.localPort, "/api/me", { authorization: `Bearer ${TOKEN}` });
    expect(local.status).toBe(200);
    expect(JSON.parse(local.body)).toMatchObject({ listener: "local", principal: { personId: "owner", method: "token" } });
  });

  it("refuses GET /?token= over TLS with 401, no redirect and no cookie", async () => {
    const r = await remoteWithAuth();
    const res = await pinnedRequest(r.port, r.fp, { path: `/?token=${TOKEN}` });
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a remote session works over TLS only, and a local session over the plain listener only", async () => {
    const r = await remoteWithAuth();
    const remote = cookie(r, "p-maintainer", "remote");
    const local = cookie(r, "p-maintainer", "local");
    const ok = await pinnedRequest(r.port, r.fp, { path: "/api/me", headers: { cookie: remote } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({
      listener: "remote", ip: "127.0.0.1", principal: { personId: "p-maintainer", role: "maintainer", listener: "remote", method: "passkey" },
    });
    expect((await pinnedRequest(r.port, r.fp, { path: "/api/me", headers: { cookie: local } })).status).toBe(401);
    expect((await localRequest(r.h.localPort, "/api/me", { cookie: remote })).status).toBe(401);
    expect((await localRequest(r.h.localPort, "/api/me", { cookie: local })).status).toBe(200);
  });

  it("applies the Host rule and the role table over TLS", async () => {
    const r = await remoteWithAuth();
    const viewer = cookie(r, "p-viewer", "remote");
    const evil = await pinnedRequest(r.port, r.fp, { path: "/api/me", host: `evil.example.org:${r.port}`, headers: { cookie: viewer } });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body)).toEqual({ error: "bad_host" });
    expect((await pinnedRequest(r.port, r.fp, { path: "/healthz", host: `evil.example.org:${r.port}` })).status).toBe(200);
    const me = await pinnedRequest(r.port, r.fp, { path: "/api/me", host: `tt-test.local:${r.port}`, headers: { cookie: viewer } });
    expect(me.status).toBe(200);
    const remote = await pinnedRequest(r.port, r.fp, { path: "/api/remote", headers: { cookie: viewer } });
    expect(remote.status).toBe(200);
    expect(JSON.parse(remote.body)).toEqual({ enabled: true, listening: true });
    const put = await pinnedRequest(r.port, r.fp, { method: "PUT", path: "/api/remote", headers: { cookie: viewer }, body: JSON.stringify({ enabled: false }) });
    expect(put.status).toBe(403);
    expect(JSON.parse(put.body)).toEqual({ error: "forbidden", required: "owner" });
  });

  it("the WebSocket Origin over TLS: https for the Host is 101, http is 403 and the socket is closed", async () => {
    const r = await remoteWithAuth();
    const viewer = cookie(r, "p-viewer", "remote");
    const good = await upgradeOverTls(r.port, { origin: `https://127.0.0.1:${r.port}`, cookie: viewer });
    expect(good.status).toBe(101);
    const bad = await upgradeOverTls(r.port, { origin: `http://127.0.0.1:${r.port}`, cookie: viewer });
    expect(bad.status).toBe(403);
    expect(bad.closed).toBe(true);
    const anonymous = await upgradeOverTls(r.port, { origin: `https://127.0.0.1:${r.port}` });
    expect(anonymous.status).toBe(401);
    expect(anonymous.closed).toBe(true);
  });
});
