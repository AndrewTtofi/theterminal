import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { registerRoutes } from "../../src/server/routes.js";
import net from "node:net";
import { registerAuth, TOKEN_COOKIE, PUBLIC_ROUTE } from "../../src/server/auth.js";

const TOKEN = "secret-token-123";
const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
let app: FastifyInstance;

beforeEach(async () => {
  const db = openDatabase(":memory:");
  const ledger = new Ledger(db);
  const board = new BoardService(db, ledger);
  app = Fastify();
  await registerAuth(app, { token: TOKEN, port: () => PORT });
  app.get("/", { config: PUBLIC_ROUTE }, async () => "ui");
  app.get("/private", async () => "secret");
  registerRoutes(app, { board, ledger, getIntegrity: () => ({ ok: true, count: 0 }) });
});

const bearer = { host: HOST, authorization: `Bearer ${TOKEN}` };

describe("auth guard", () => {
  it("rejects /api without a token", async () => {
    const res = await app.inject({ url: "/api/projects", headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
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
    for (const host of [`evil.example:${PORT}`, "127.0.0.1:9999", "127.0.0.1", `127.0.0.1.evil.com:${PORT}`]) {
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
    const res = await app.inject({ url: `/?token=${TOKEN}`, headers: { host: HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${TOKEN_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");

    const follow = await app.inject({
      url: "/api/projects",
      headers: { host: HOST, cookie: `${TOKEN_COOKIE}=${TOKEN}` },
    });
    expect(follow.statusCode).toBe(200);
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

  it("is default-deny: only config.public routes skip the token", async () => {
    expect((await app.inject({ url: "/private", headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/private", headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ url: "/nope", headers: { host: HOST } })).statusCode).toBe(401);
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
    registerAuth(real, { token: TOKEN, port: () => realPort });
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
    for (const origin of ["http://127.0.0.1:9999", "http://evil.example", `http://127.0.0.1.evil.com:${PORT}`]) {
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
    const res = await app.inject({ url: "/api/projects", headers: { host: HOST, cookie: `${TOKEN_COOKIE}=bad` } });
    expect(res.statusCode).toBe(401);
  });
});
