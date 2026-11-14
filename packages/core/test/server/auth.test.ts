import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { registerRoutes } from "../../src/server/routes.js";
import { registerAuth, TOKEN_COOKIE } from "../../src/server/auth.js";

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
  app.get("/", async () => "ui");
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

  it("rejects a wrong cookie", async () => {
    const res = await app.inject({ url: "/api/projects", headers: { host: HOST, cookie: `${TOKEN_COOKIE}=bad` } });
    expect(res.statusCode).toBe(401);
  });
});
