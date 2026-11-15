import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import net from "node:net";
import type { Listener, Person, Role } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { registerRoutes } from "../../src/server/routes.js";
import { GateService } from "../../src/gates/service.js";
import { SessionStore } from "../../src/people/sessions.js";
import type { HostRule } from "../../src/server/remote.js";
import {
  APP_HOST,
  PUBLIC_ROUTE,
  PUBLIC_ROUTES,
  ROUTE_ROLES,
  SESSION_COOKIE,
  TOKEN_COOKIE,
  actorOf,
  assertRoutesHaveRoles,
  clientKey,
  registerAuth,
  requireRole,
  routeKey,
  sessionCookieOptions,
} from "../../src/server/auth.js";

const TOKEN = "secret-token-123";
const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
const APP = `${APP_HOST}:${PORT}`;
const REMOTE_PORT = 4318;
const REMOTE_HOST = `tt-test.local:${REMOTE_PORT}`;

const person = (id: string, role: Role, extra: Partial<Person> = {}): Person => ({
  id, name: `${role} person`, role, joinedAt: "2026-11-15T00:00:00.000Z", lastSeenAt: null, removedAt: null, credentials: 1, ...extra,
});

let app: FastifyInstance;
let sessions: SessionStore;
let listener: Listener;
let hostRule: HostRule;
const people = new Map<string, Person>();

/** A session cookie for `personId` on `on`, as the sign-in routes would mint it. */
const sessionCookie = (personId: string, on: Listener = listener): string =>
  `${SESSION_COOKIE}=${sessions.create(personId, on, "passkey").id}`;

beforeEach(async () => {
  const db = openDatabase(":memory:");
  const ledger = new Ledger(db);
  const board = new BoardService(db, ledger);
  sessions = new SessionStore(db);
  listener = "local";
  hostRule = { port: REMOTE_PORT, domain: null, names: ["tt-test.local", "192.168.1.10", "::1"] };
  people.clear();
  people.set("owner", person("owner", "owner", { name: "Owner" }));
  people.set("p-viewer", person("p-viewer", "viewer"));
  people.set("p-reviewer", person("p-reviewer", "reviewer"));
  people.set("p-maintainer", person("p-maintainer", "maintainer"));
  people.set("p-gone", person("p-gone", "maintainer", { removedAt: "2026-11-15T01:00:00.000Z" }));
  app = Fastify();
  registerAuth(app, {
    token: TOKEN,
    port: () => PORT,
    hostRule: () => hostRule,
    sessions,
    person: (id) => people.get(id) ?? null,
    listenerOf: () => listener,
  });
  app.get("/", { config: PUBLIC_ROUTE }, async () => "ui");
  // The pages and the routes that mint a session, as static-ui and the people routes register them.
  app.get("/sign-in", { config: PUBLIC_ROUTE }, async () => "page");
  app.get("/join/*", { config: PUBLIC_ROUTE }, async () => "page");
  app.post("/api/auth/key/verify", async () => ({ minted: true }));
  app.post("/api/join/:code/key", async () => ({ minted: true }));
  app.get("/private", async () => "secret");
  // Routes from the role table that no route file registers yet, so the hook's decisions can be read back.
  app.get("/api/me", async (request) => ({ principal: request.principal, listener: request.listener, ip: request.ip }));
  app.get("/api/people/invites", async () => []);
  app.get("/api/ledger/export", async () => "seq,type\n");
  app.post("/api/me/sign-out", { preHandler: requireRole("maintainer") }, async (request) => actorOf(request));
  app.post("/api/me/credentials/passkey/verify", async (request, reply) => {
    reply.setCookie(SESSION_COOKIE, "x".repeat(43), sessionCookieOptions(request.listener));
    return {};
  });
  registerRoutes(app, { board, gates: new GateService({ db, ledger }), ledger, getIntegrity: () => ({ ok: true, count: 0 }) });
});

const bearer = { host: HOST, authorization: `Bearer ${TOKEN}` };

describe("auth guard (local listener)", () => {
  it("rejects /api without a token", async () => {
    const res = await app.inject({ url: "/api/projects", headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects the gate routes without a token", async () => {
    const get = await app.inject({ url: "/api/cards/c1/gates?to=ship", headers: { host: HOST } });
    expect(get.statusCode).toBe(401);
    const move = await app.inject({ method: "POST", url: "/api/cards/c1/move", headers: { host: HOST }, payload: { to: "ship", gates: [] } });
    expect(move.statusCode).toBe(401);
  });

  it("accepts the bearer token", async () => {
    const res = await app.inject({ url: "/api/projects", headers: bearer });
    expect(res.statusCode).toBe(200);
  });

  it("accepts localhost host and is case-insensitive on hostname", async () => {
    for (const host of [`localhost:${PORT}`, `LocalHost:${PORT}`]) {
      const res = await app.inject({ url: "/api/projects", headers: { ...bearer, host } });
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects a wrong bearer token and a different-length token", async () => {
    for (const t of ["nope", `${TOKEN}x`, ""]) {
      const res = await app.inject({ url: "/api/projects", headers: { host: HOST, authorization: `Bearer ${t}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("rejects bad Host headers with a valid token", async () => {
    for (const host of [`evil.example:${PORT}`, "127.0.0.1:9999", "127.0.0.1", `127.0.0.1.evil.com:${PORT}`, REMOTE_HOST]) {
      const res = await app.inject({ url: "/api/projects", headers: { ...bearer, host } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "bad_host" });
    }
  });

  it("rejects bad Host on GET / too", async () => {
    const res = await app.inject({ url: "/", headers: { host: "evil.example:4321" } });
    expect(res.statusCode).toBe(403);
  });

  it("serves GET / without a token", async () => {
    const res = await app.inject({ url: "/", headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
  });

  it("GET /?token= sets an HttpOnly SameSite=Strict cookie, redirects, and the cookie then authenticates", async () => {
    const res = await app.inject({ url: `/?token=${TOKEN}`, headers: { host: APP } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${TOKEN_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain("Domain");

    const follow = await app.inject({
      url: "/api/projects",
      headers: { host: APP, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
    });
    expect(follow.statusCode).toBe(200);
  });

  it("GET /?token= on a loopback Host redirects to the app hostname and sets no cookie", async () => {
    for (const host of [HOST, `localhost:${PORT}`]) {
      const res = await app.inject({ url: `/?token=${TOKEN}`, headers: { host } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`http://${APP}/?token=${TOKEN}`);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("accepts the app hostname, case-insensitively, and rejects look-alikes", async () => {
    for (const host of [APP, `TheTerminal.LocalHost:${PORT}`]) {
      expect((await app.inject({ url: "/api/projects", headers: { ...bearer, host } })).statusCode).toBe(200);
    }
    for (const host of [`evil.${APP}`, APP_HOST, `${APP_HOST}:9999`]) {
      const res = await app.inject({ url: "/api/projects", headers: { ...bearer, host } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "bad_host" });
    }
  });

  it("accepts the app origin with the cookie", async () => {
    const res = await app.inject({
      url: "/api/projects",
      headers: { host: APP, origin: `http://${APP}`, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("wrong token in the query on / is not accepted and sets no cookie", async () => {
    const res = await app.inject({ url: "/?token=wrong", headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("?token= does not authenticate on any other path", async () => {
    const res = await app.inject({ url: `/api/projects?token=${TOKEN}`, headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("is default-deny: only public routes skip the token, and an unknown path is 401 without one", async () => {
    expect((await app.inject({ url: "/private", headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/nope", headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/nope", headers: bearer })).statusCode).toBe(404);
  });

  it("fails closed: a route with no role entry answers 500 internal even to the Owner", async () => {
    const res = await app.inject({ url: "/private", headers: bearer });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });

  it("does not let an encoded path bypass the token", async () => {
    const res = await app.inject({ url: "/%61pi/projects", headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    const ok = await app.inject({ url: "/%61pi/projects", headers: bearer });
    expect(ok.statusCode).toBe(200);
  });

  it("does not let an absolute-form request line bypass the token", async () => {
    const real = Fastify();
    let realPort = 0;
    registerAuth(real, {
      token: TOKEN, port: () => realPort, hostRule: () => null, sessions, person: (id) => people.get(id) ?? null,
    });
    real.get("/api/projects", async () => []);
    await real.listen({ port: 0, host: "127.0.0.1" });
    realPort = (real.server.address() as net.AddressInfo).port;
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(realPort, "127.0.0.1", () =>
          sock.write(
            `GET http://127.0.0.1:${realPort}/api/projects HTTP/1.1\r\nHost: 127.0.0.1:${realPort}\r\nConnection: close\r\n\r\n`,
          ),
        );
        let data = "";
        sock.on("data", (d) => (data += d));
        sock.on("end", () => resolve(data));
        sock.on("error", reject);
      });
      expect(raw.split("\r\n")[0]).toContain("401");
    } finally {
      await real.close();
    }
  });

  it("rejects a foreign Origin even with a valid token or cookie", async () => {
    for (const origin of ["http://127.0.0.1:9999", "http://evil.example", `http://127.0.0.1.evil.com:${PORT}`, `https://${HOST}`]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "X" },
        headers: { host: HOST, origin, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "bad_origin" });
    }
  });

  it("allows a matching Origin and an absent Origin", async () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) {
      const res = await app.inject({ url: "/api/projects", headers: { ...bearer, origin } });
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects a wrong cookie", async () => {
    const res = await app.inject({ url: "/api/projects", headers: { host: APP, cookie: `${TOKEN_COOKIE}=bad` } });
    expect(res.statusCode).toBe(401);
  });

  it("keeps request.ip as the socket peer: X-Forwarded-For is not trusted", async () => {
    const res = await app.inject({ url: "/api/me", headers: { ...bearer, "x-forwarded-for": "203.0.113.9" }, remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ip).toBe("127.0.0.1");
  });
});

describe("principals", () => {
  it("the local bearer is the Owner by token, with no session", async () => {
    const res = await app.inject({ url: "/api/me", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      listener: "local",
      principal: { personId: "owner", name: "Owner", role: "owner", method: "token", listener: "local", sessionId: null },
    });
  });

  it("the local token cookie is the Owner by token too", async () => {
    const res = await app.inject({ url: "/api/me", headers: { host: APP, cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
    expect(res.json().principal).toMatchObject({ personId: "owner", method: "token" });
  });

  it("a session created on local gives a principal with the person's current name and role", async () => {
    const cookie = sessionCookie("p-reviewer");
    const first = await app.inject({ url: "/api/me", headers: { host: APP, cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json().principal).toMatchObject({
      personId: "p-reviewer", name: "reviewer person", role: "reviewer", method: "passkey", listener: "local",
    });
    expect(first.json().principal.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A rename and a role change show on the next request: the principal reads the person, not the session.
    people.set("p-reviewer", person("p-reviewer", "maintainer", { name: "Renamed" }));
    const second = await app.inject({ url: "/api/me", headers: { host: APP, cookie } });
    expect(second.json().principal).toMatchObject({ name: "Renamed", role: "maintainer" });
  });

  it("a session is bound to its listener: a local session is 401 on remote and a remote one 401 on local", async () => {
    const local = sessionCookie("p-reviewer", "local");
    const remote = sessionCookie("p-reviewer", "remote");
    listener = "remote";
    expect((await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, cookie: local } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, cookie: remote } })).statusCode).toBe(200);
    listener = "local";
    expect((await app.inject({ url: "/api/me", headers: { host: APP, cookie: remote } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/me", headers: { host: APP, cookie: local } })).statusCode).toBe(200);
  });

  it("a removed person's live session is 401, and so is a session of nobody", async () => {
    const gone = sessionCookie("p-gone");
    const res = await app.inject({ url: "/api/me", headers: { host: APP, cookie: gone } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    const nobody = sessionCookie("p-unknown");
    expect((await app.inject({ url: "/api/me", headers: { host: APP, cookie: nobody } })).statusCode).toBe(401);
  });

  it("a revoked, malformed or unknown session cookie is 401", async () => {
    const { id } = sessions.create("p-viewer", "local", "passkey");
    sessions.revoke(id);
    for (const cookie of [`${SESSION_COOKIE}=${id}`, `${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=${"A".repeat(43)}`]) {
      expect((await app.inject({ url: "/api/me", headers: { host: APP, cookie } })).statusCode).toBe(401);
    }
  });

  it("a public route has no principal, even with a token", async () => {
    const res = await app.inject({ url: "/", headers: bearer });
    expect(res.statusCode).toBe(200);
  });

  it("actorOf is the signed-in person", async () => {
    const res = await app.inject({ method: "POST", url: "/api/me/sign-out", headers: { host: APP, cookie: sessionCookie("p-maintainer") } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: "human", id: "p-maintainer" });
  });
});

describe("local sessions live on the app hostname alone", () => {
  // Browsers do not separate cookies by port: a tt_session on 127.0.0.1 or localhost would reach every other local
  // server. So the session is minted and honoured on APP_HOST only, and the pages that sign people in are bounced there.
  it("a session cookie is honoured on the app hostname and 401 on a loopback Host", async () => {
    const cookie = sessionCookie("p-reviewer");
    expect((await app.inject({ url: "/api/me", headers: { host: APP, cookie } })).statusCode).toBe(200);
    for (const host of [HOST, `localhost:${PORT}`, `LocalHost:${PORT}`]) {
      const res = await app.inject({ url: "/api/me", headers: { host, cookie } });
      expect(res.statusCode, host).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
    // The token is not a session: it still works on loopback, as before.
    expect((await app.inject({ url: "/api/me", headers: bearer })).statusCode).toBe(200);
  });

  it("GET /sign-in and /join/<code> on a loopback Host redirect to the app hostname, keeping the path and query", async () => {
    for (const host of [HOST, `localhost:${PORT}`]) {
      for (const url of ["/sign-in", "/join/abc_-123", "/join/abc?x=1"]) {
        const res = await app.inject({ url, headers: { host } });
        expect(res.statusCode, `${host}${url}`).toBe(302);
        expect(res.headers.location, `${host}${url}`).toBe(`http://${APP}${url}`);
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
    }
    for (const url of ["/sign-in", "/join/abc_-123"]) {
      const res = await app.inject({ url, headers: { host: APP } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe("page");
    }
    // Other public pages are untouched, and a bad Host is still refused before any redirect.
    expect((await app.inject({ url: "/", headers: { host: HOST } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/sign-in", headers: { host: `evil.example:${PORT}` } })).statusCode).toBe(403);
  });

  it("the routes that mint a session are 403 bad_host on a loopback Host and run on the app hostname", async () => {
    for (const url of ["/api/auth/key/verify", "/api/join/abc/key"]) {
      for (const host of [HOST, `localhost:${PORT}`]) {
        const res = await app.inject({ method: "POST", url, headers: { host }, payload: {} });
        expect(res.statusCode, `${host}${url}`).toBe(403);
        expect(res.json()).toEqual({ error: "bad_host" });
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      const ok = await app.inject({ method: "POST", url, headers: { host: APP }, payload: {} });
      expect(ok.statusCode, url).toBe(200);
      expect(ok.json()).toEqual({ minted: true });
    }
  });
});

describe("remote listener", () => {
  beforeEach(() => {
    listener = "remote";
  });

  it("refuses a bearer token 401, whatever the route", async () => {
    for (const url of ["/api/me", "/api/projects", "/"]) {
      const res = await app.inject({ url, headers: { host: REMOTE_HOST, authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("refuses GET /?token= 401 with no redirect and no cookie, before the local bootstrap code", async () => {
    const res = await app.inject({ url: `/?token=${TOKEN}`, headers: { host: REMOTE_HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("never compares the token cookie off the local listener", async () => {
    const res = await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the listener's own names with its port, and refuses other hosts and ports", async () => {
    const cookie = sessionCookie("p-viewer");
    for (const host of [REMOTE_HOST, `192.168.1.10:${REMOTE_PORT}`, `[::1]:${REMOTE_PORT}`, `TT-Test.local:${REMOTE_PORT}`]) {
      const res = await app.inject({ url: "/api/me", headers: { host, cookie } });
      expect(res.statusCode, host).toBe(200);
    }
    for (const host of [`evil.example.org:${REMOTE_PORT}`, `tt-test.local:${REMOTE_PORT - 1}`, `[::1]:${REMOTE_PORT - 1}`, HOST, APP, "tt-test.local"]) {
      const res = await app.inject({ url: "/api/me", headers: { host, cookie } });
      expect(res.statusCode, host).toBe(403);
      expect(res.json()).toEqual({ error: "bad_host" });
    }
  });

  it("with a domain, accepts only the domain (on 443 or the port), and /healthz with any Host", async () => {
    hostRule = { ...hostRule, domain: "work.example.org" };
    app.get("/healthz", { config: PUBLIC_ROUTE }, async () => ({ ok: true }));
    const cookie = sessionCookie("p-viewer");
    for (const host of ["work.example.org", "work.example.org:443", `work.example.org:${REMOTE_PORT}`]) {
      expect((await app.inject({ url: "/api/me", headers: { host, cookie } })).statusCode, host).toBe(200);
    }
    for (const host of [REMOTE_HOST, `127.0.0.1:${REMOTE_PORT}`, `evil.work.example.org:${REMOTE_PORT}`]) {
      expect((await app.inject({ url: "/api/me", headers: { host, cookie } })).statusCode, host).toBe(403);
    }
    const probe = await app.inject({ url: "/healthz", headers: { host: `127.0.0.1:${REMOTE_PORT}` } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ ok: true });
  });

  it("without a remote listener (no host rule) every remote request is 403 bad_host", async () => {
    const closed = Fastify();
    registerAuth(closed, {
      token: TOKEN, port: () => PORT, hostRule: () => null, sessions, person: (id) => people.get(id) ?? null, listenerOf: () => "remote",
    });
    closed.get("/api/me", async () => ({}));
    const res = await closed.inject({ url: "/api/me", headers: { host: REMOTE_HOST, cookie: sessionCookie("p-viewer", "remote") } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "bad_host" });
  });

  it("accepts only an https Origin for the Host header", async () => {
    const cookie = sessionCookie("p-viewer");
    const ok = await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, origin: `https://${REMOTE_HOST}`, cookie } });
    expect(ok.statusCode).toBe(200);
    const upper = await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, origin: `https://TT-TEST.local:${REMOTE_PORT}`, cookie } });
    expect(upper.statusCode).toBe(200);
    for (const origin of [`http://${REMOTE_HOST}`, `https://192.168.1.10:${REMOTE_PORT}`, `https://evil.example.org`, `https://${REMOTE_HOST}.evil.org`]) {
      const res = await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, origin, cookie } });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json()).toEqual({ error: "bad_origin" });
    }
  });

  it("a WebSocket upgrade with an http Origin is 403 and the connection is closed", async () => {
    const res = await app.inject({
      url: "/api/events",
      headers: { host: REMOTE_HOST, origin: `http://${REMOTE_HOST}`, upgrade: "websocket", connection: "Upgrade", cookie: sessionCookie("p-viewer") },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers.connection).toBe("close");
  });

  it("a session created on remote works on remote", async () => {
    const res = await app.inject({ url: "/api/me", headers: { host: REMOTE_HOST, cookie: sessionCookie("p-maintainer") } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ listener: "remote", principal: { personId: "p-maintainer", listener: "remote", method: "passkey" } });
  });

  it("a public route passes with no principal, with no Origin check", async () => {
    const res = await app.inject({ url: "/", headers: { host: REMOTE_HOST, origin: "http://elsewhere.example" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("roles", () => {
  it("requireRole: 403 with the required role for a rank below, pass at or above", async () => {
    const forbidden = await app.inject({ method: "POST", url: "/api/me/sign-out", headers: { host: APP, cookie: sessionCookie("p-reviewer") } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "forbidden", required: "maintainer" });
    for (const id of ["p-maintainer", "owner"]) {
      const ok = await app.inject({ method: "POST", url: "/api/me/sign-out", headers: { host: APP, cookie: sessionCookie(id) } });
      expect(ok.statusCode).toBe(200);
    }
  });

  it("the table decides on every request: a viewer reads the board and may not export the ledger or create a project", async () => {
    const cookie = sessionCookie("p-viewer");
    expect((await app.inject({ url: "/api/projects", headers: { host: APP, cookie } })).statusCode).toBe(200);
    const exp = await app.inject({ url: "/api/ledger/export", headers: { host: APP, cookie } });
    expect(exp.statusCode).toBe(403);
    expect(exp.json()).toEqual({ error: "forbidden", required: "reviewer" });
    const create = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "X" }, headers: { host: APP, cookie } });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toEqual({ error: "forbidden", required: "maintainer" });
    const invites = await app.inject({ url: "/api/people/invites", headers: { host: APP, cookie: sessionCookie("p-maintainer") } });
    expect(invites.statusCode).toBe(403);
    expect(invites.json()).toEqual({ error: "forbidden", required: "owner" });
  });

  it("a reviewer exports the ledger and the Owner reads the invites", async () => {
    expect((await app.inject({ url: "/api/ledger/export", headers: { host: APP, cookie: sessionCookie("p-reviewer") } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/people/invites", headers: bearer })).statusCode).toBe(200);
  });

  it("HEAD takes its GET's role", async () => {
    const viewer = await app.inject({ method: "HEAD", url: "/api/ledger/export", headers: { host: APP, cookie: sessionCookie("p-viewer") } });
    expect(viewer.statusCode).toBe(403);
    const reviewer = await app.inject({ method: "HEAD", url: "/api/ledger/export", headers: { host: APP, cookie: sessionCookie("p-reviewer") } });
    expect(reviewer.statusCode).toBe(200);
    expect(routeKey("HEAD", "/api/ledger/export")).toBe("GET /api/ledger/export");
    expect(routeKey("post", "/api/projects")).toBe("POST /api/projects");
  });

  it("the role table and the public set never overlap, and the table holds only known roles", () => {
    for (const key of PUBLIC_ROUTES) expect(ROUTE_ROLES[key], key).toBeUndefined();
    for (const [key, role] of Object.entries(ROUTE_ROLES)) {
      expect(["viewer", "reviewer", "maintainer", "owner"], key).toContain(role);
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
    }
    expect(PUBLIC_ROUTES.has("GET /healthz")).toBe(true);
    expect(PUBLIC_ROUTES.has("GET /")).toBe(true);
  });

  it("keeps the rulings on the branch's routes", () => {
    const owner = [
      "GET /api/link", "GET /api/link/machines", "GET /api/link/machines/:id/capacity", "GET /api/share/addresses", "POST /api/link/pair",
      "POST /api/projects/:id/share/confirm", "POST /api/share/snapshots/:id/links", "DELETE /api/share/links/:id", "PUT /api/remote",
      "GET /api/connections/:id", "POST /api/connections",
    ];
    for (const key of owner) expect(ROUTE_ROLES[key], key).toBe("owner");
    const reviewer = ["GET /api/link/verify", "GET /api/ledger/export", "GET /api/runs/:id/file", "GET /api/runs/:id/diff", "GET /api/runs/:id/changes", "GET /api/runs/:id/files"];
    for (const key of reviewer) expect(ROUTE_ROLES[key], key).toBe("reviewer");
    const viewer = ["GET /api/health", "GET /api/share/snapshots/:id", "GET /api/share/links", "GET /api/projects/:id/digests", "GET /api/events", "GET /api/remote", "GET /api/capacity"];
    for (const key of viewer) expect(ROUTE_ROLES[key], key).toBe("viewer");
  });
});

describe("assertRoutesHaveRoles", () => {
  it("lists routes with no entry, each method of a multi-method route, and skips HEAD twins and public routes", async () => {
    app.route({ method: ["GET", "POST"], url: "/multi", handler: async () => ({}) });
    app.get("/pub", { config: PUBLIC_ROUTE }, async () => ({}));
    app.get("/healthz", { config: PUBLIC_ROUTE }, async () => ({ ok: true }));
    await app.ready();
    const missing = assertRoutesHaveRoles(app);
    expect(missing).toEqual(["GET /private", "GET /multi", "POST /multi"]);
    expect(missing.some((k) => k.startsWith("HEAD "))).toBe(false);
  });

  it("returns [] for an app whose routes are all in the table or public", async () => {
    const clean = Fastify();
    registerAuth(clean, { token: TOKEN, port: () => PORT, hostRule: () => null, sessions, person: () => null });
    clean.get("/", { config: PUBLIC_ROUTE }, async () => "ui");
    clean.get("/api/me", async () => ({}));
    clean.register(async (scope) => {
      scope.post("/api/me/sign-out", async () => ({}));
    });
    await clean.ready();
    expect(assertRoutesHaveRoles(clean)).toEqual([]);
  });

  it("refuses to judge an app without the auth hook", async () => {
    const bare = Fastify();
    bare.get("/x", async () => ({}));
    await bare.ready();
    expect(() => assertRoutesHaveRoles(bare)).toThrow(/registerAuth/);
  });
});

describe("session cookie and client key", () => {
  it("the session cookie is HttpOnly, SameSite=Strict, Path=/, and Secure only on remote", async () => {
    const local = await app.inject({ method: "POST", url: "/api/me/credentials/passkey/verify", headers: { host: APP, cookie: sessionCookie("p-viewer") } });
    expect(local.statusCode).toBe(200);
    const localCookie = String(local.headers["set-cookie"]);
    expect(localCookie).toContain(`${SESSION_COOKIE}=`);
    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).toContain("SameSite=Strict");
    expect(localCookie).toContain("Path=/");
    expect(localCookie).not.toContain("Secure");
    expect(localCookie).not.toContain("Domain");
    listener = "remote";
    const remote = await app.inject({
      method: "POST", url: "/api/me/credentials/passkey/verify", headers: { host: REMOTE_HOST, cookie: sessionCookie("p-viewer") },
    });
    expect(remote.statusCode).toBe(200);
    expect(String(remote.headers["set-cookie"])).toContain("Secure");
    expect(sessionCookieOptions("remote")).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/", secure: true });
    expect(sessionCookieOptions("local")).not.toHaveProperty("secure");
  });

  it("keys IPv4 clients by address and IPv6 clients by /64", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:ffff::")).toBe(clientKey("2001:db8:1:2::1"));
    expect(clientKey("2001:db8:1:3::1")).not.toBe(clientKey("2001:db8:1:2::1"));
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(clientKey("::ffff:192.0.2.128")).toBe("192.0.2.128");
    expect(clientKey("")).toBe("");
    expect(clientKey("not an address")).toBe("not an address");
  });
});
