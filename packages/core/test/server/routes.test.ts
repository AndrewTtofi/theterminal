import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase } from "../../src/db.js";
import { Ledger, type VerifyResult } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { registerRoutes } from "../../src/server/routes.js";

let app: FastifyInstance;
let ledger: Ledger;
let integrity: VerifyResult;

beforeEach(() => {
  const db = openDatabase(":memory:");
  ledger = new Ledger(db);
  const board = new BoardService(db, ledger);
  integrity = { ok: true, count: 0 };
  app = Fastify();
  registerRoutes(app, { board, ledger, getIntegrity: () => integrity });
});

async function mkProject(name = "Acme") {
  const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name, pitch: "p" } });
  return res.json() as { id: string };
}

async function mkCard(projectId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/cards`,
    payload: { title: "T", stage: "plan" },
  });
  return res.json() as { id: string };
}

describe("routes", () => {
  it("GET /api/health reports ok", async () => {
    const res = await app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, integrity: "ok", readOnly: false, headSeq: 0 });
  });

  it("GET /api/health reports the ledger head, so a client can stream only what comes next", async () => {
    await mkProject();
    await mkProject("Beta");
    const res = await app.inject({ url: "/api/health" });
    expect(res.json()).toMatchObject({ headSeq: ledger.list().at(-1)!.seq });
  });

  it("GET /api/health reports broken integrity", async () => {
    integrity = { ok: false, brokenAtSeq: 3 };
    ledger.readOnly = true;
    const res = await app.inject({ url: "/api/health" });
    expect(res.json()).toEqual({ ok: true, integrity: "broken", brokenAtSeq: 3, readOnly: true, headSeq: 0 });
  });

  it("POST/GET /api/projects", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Acme" });
    const list = await app.inject({ url: "/api/projects" });
    expect(list.json()).toHaveLength(1);
  });

  it("returns 400 for invalid project input", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    expect(res.json().issues).toBeDefined();
  });

  it("GET board, 404 for unknown project", async () => {
    const p = await mkProject();
    await mkCard(p.id);
    const res = await app.inject({ url: `/api/projects/${p.id}/board` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeTruthy();
    const missing = await app.inject({ url: "/api/projects/nope/board" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
  });

  it("POST cards returns 201", async () => {
    const p = await mkProject();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${p.id}/cards`,
      payload: { title: "T", stage: "plan" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: "T", stage: "plan" });
  });

  it("POST move and status", async () => {
    const p = await mkProject();
    const c = await mkCard(p.id);
    const mv = await app.inject({ method: "POST", url: `/api/cards/${c.id}/move`, payload: { to: "build" } });
    expect(mv.statusCode).toBe(200);
    expect(mv.json()).toMatchObject({ id: c.id, stage: "build" });
    const st = await app.inject({ method: "POST", url: `/api/cards/${c.id}/status`, payload: { to: "blocked" } });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ id: c.id, status: "blocked" });
  });

  it("404 for moving an unknown card", async () => {
    const res = await app.inject({ method: "POST", url: "/api/cards/nope/move", payload: { to: "build" } });
    expect(res.statusCode).toBe(404);
  });

  it("400 for invalid move target", async () => {
    const res = await app.inject({ method: "POST", url: "/api/cards/x/move", payload: { to: "bogus" } });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/ledger with filters", async () => {
    const p = await mkProject();
    await mkProject("B");
    const all = await app.inject({ url: "/api/ledger" });
    expect(all.json()).toHaveLength(2);
    const byProject = await app.inject({ url: `/api/ledger?projectId=${p.id}` });
    expect(byProject.json()).toHaveLength(1);
    const after = await app.inject({ url: "/api/ledger?afterSeq=1&limit=5" });
    expect(after.json()).toHaveLength(1);
  });

  it("400 for bad ledger query", async () => {
    for (const q of ["limit=0", "limit=-1", "limit=501", "afterSeq=-1", "limit=abc"]) {
      const res = await app.inject({ url: `/api/ledger?${q}` });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it("423 when ledger is read-only", async () => {
    ledger.readOnly = true;
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "X" } });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toEqual({ error: "ledger_read_only" });
  });

  it("500 without leaking internals", async () => {
    const db = openDatabase(":memory:");
    const boom = new BoardService(db, new Ledger(db));
    boom.listProjects = () => {
      throw new Error("secret detail");
    };
    const a = Fastify();
    registerRoutes(a, { board: boom, ledger, getIntegrity: () => integrity });
    const res = await a.inject({ url: "/api/projects" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });
});
