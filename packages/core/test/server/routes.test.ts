import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { openDatabase } from "../../src/db.js";
import { Ledger, type VerifyResult } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { registerRoutes } from "../../src/server/routes.js";
import { GateService } from "../../src/gates/service.js";
import { IntakeService } from "../../src/intake/service.js";
import { GATES, type GateEvaluation, type GateId, type NewLedgerEntry } from "@theterminal/shared";
import { commitEvents } from "../../src/events/commit.js";
import { completeIntake, type World } from "../gates/setup.js";
import { asNobody, asPrincipal, fakeAuth } from "../fixtures/principal.js";

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;
let ledger: Ledger;
let board: BoardService;
let gates: GateService;
let integrity: VerifyResult;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  board = new BoardService(db, ledger);
  gates = new GateService({ db, ledger });
  integrity = { ok: true, count: 0 };
  app = Fastify();
  fakeAuth(app); // the Owner unless a test names someone else
  registerRoutes(app, { board, gates, ledger, getIntegrity: () => integrity });
});

/** A reviewer the gates can look up: unknown people may sign nothing. */
function seedReviewer(id = "r1", name = "Reviewer One"): void {
  commitEvents(db, ledger, () => ({
    events: [
      { projectId: null, actor: { kind: "human", id: "owner" }, type: "person.invited", payload: { inviteId: `i-${id}`, role: "reviewer", codeHash: "c".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" } },
      {
        projectId: null, actor: { kind: "human", id }, type: "person.joined",
        payload: { personId: id, inviteId: `i-${id}`, name, role: "reviewer", credential: { kind: "key", credentialId: `key-${id}`, publicKey: "TESTKEYr1", label: "CLI" } },
      },
    ] as NewLedgerEntry[],
    result: () => undefined,
  }));
}

async function mkProject(name = "Acme") {
  const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name, pitch: "p" } });
  return res.json() as { id: string };
}

async function mkCardRes(projectId: string, stage: string) {
  return app.inject({ method: "POST", url: `/api/projects/${projectId}/cards`, payload: { title: "T", stage } });
}

async function mkCard(projectId: string, stage = "plan") {
  const res = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/cards`,
    payload: { title: "T", stage },
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

  it("answers any issue code it does not list with a fixed message, never one that quotes the input", async () => {
    const secret = "sk-ant-TESTKEY-2222222222";
    // A union whose error function quotes the input: an unlisted code (invalid_union) must not pass it through.
    const schema = z.object({
      value: z.union([z.literal("a"), z.number()], { error: (iss) => `got ${String(iss.input)}` }),
    });
    app.post("/test/union", async (req) => schema.parse(req.body));
    const res = await app.inject({ method: "POST", url: "/test/union", payload: { value: secret } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);
    expect(res.json()).toEqual({
      error: "invalid_input",
      issues: [{ path: ["value"], code: "invalid_union", message: "Invalid input" }],
    });
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
    const c = await mkCard(p.id, "design");
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

  describe("gates", () => {
    const SHIP_GATES: GateId[] = ["ready_to_ship", "network_exposure", "payments", "personal_data"];
    const signOff = (gateId: GateId) => ({
      gateId, decision: "sign_off", acknowledgement: GATES.find((g) => g.id === gateId)!.acknowledgement,
    });
    async function plannedCard() {
      const p = await mkProject("Book Club");
      const intake = new IntakeService({ db, ledger, username: "clubuser" });
      completeIntake({ db, ledger, board, intake } as World, p.id);
      return mkCard(p.id, "build");
    }

    it("a move a gate stops is 409 gate_blocked with every evaluation and its conditions", async () => {
      const c = await plannedCard();
      const res = await app.inject({ method: "POST", url: `/api/cards/${c.id}/move`, payload: { to: "ship" } });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; gates: GateEvaluation[] };
      expect(body.error).toBe("gate_blocked");
      expect(body.gates.map((g) => g.id)).toEqual(SHIP_GATES);
      for (const g of body.gates) expect(g.conditions.length).toBeGreaterThan(0);
      expect(ledger.list().at(-1)!.type).toBe("gate.blocked");
    });

    it("with the decisions it is 200 and the card is in Ship", async () => {
      const c = await plannedCard();
      const res = await app.inject({
        method: "POST", url: `/api/cards/${c.id}/move`, payload: { to: "ship", gates: SHIP_GATES.map(signOff) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: c.id, stage: "ship" });
    });

    it("a reviewer signing go_live is 403 gate_requires naming the gate and the Owner, and nothing is recorded", async () => {
      seedReviewer();
      const c = await plannedCard();
      const head = ledger.headSeq();
      const raised = (await app.inject({ url: `/api/cards/${c.id}/gates?to=operate` })).json() as GateEvaluation[];
      expect(raised.map((g) => g.id)).toContain("go_live");
      const res = await app.inject({
        method: "POST", url: `/api/cards/${c.id}/move`, headers: asPrincipal("r1", "reviewer"),
        payload: { to: "operate", gates: raised.map((g) => signOff(g.id)) },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "gate_requires", gateId: "go_live", requirement: { role: "owner" } });
      expect(ledger.headSeq()).toBe(head);
    });

    it("GET /api/cards/:id/gates judges signable for the person asking", async () => {
      seedReviewer();
      const c = await plannedCard();
      const forOwner = (await app.inject({ url: `/api/cards/${c.id}/gates?to=operate` })).json() as GateEvaluation[];
      const forReviewer = (await app.inject({ url: `/api/cards/${c.id}/gates?to=operate`, headers: asPrincipal("r1", "reviewer") })).json() as GateEvaluation[];
      expect(forOwner.find((g) => g.id === "go_live")!.signable).toBe(true);
      expect(forReviewer.find((g) => g.id === "go_live")!.signable).toBe(false);
      const ship = (await app.inject({ url: `/api/cards/${c.id}/gates?to=ship`, headers: asPrincipal("r1", "reviewer") })).json() as GateEvaluation[];
      expect(ship.find((g) => g.id === "ready_to_ship")!.signable).toBe(true);
    });

    it("a sign-off whose conditions do not hold is 409 gate_not_met naming the gate and the unmet conditions", async () => {
      const p = await mkProject();
      const c = await mkCard(p.id, "build");
      const res = await app.inject({
        method: "POST", url: `/api/cards/${c.id}/move`, payload: { to: "ship", gates: [signOff("ready_to_ship")] },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "gate_not_met", gateId: "ready_to_ship", unmet: ["intake_completed"] });
    });

    it("refuses more than ten decisions, unknown keys, and a secret in a waiver reason", async () => {
      const c = await plannedCard();
      const url = `/api/cards/${c.id}/move`;
      const many = await app.inject({ method: "POST", url, payload: { to: "ship", gates: Array.from({ length: 11 }, () => signOff("payments")) } });
      expect(many.statusCode).toBe(400);
      const extra = await app.inject({ method: "POST", url, payload: { to: "ship", other: 1 } });
      expect(extra.statusCode).toBe(400);
      const waiver = { gateId: "ready_to_ship", decision: "waive", reason: "demo sk-ant-TESTKEY-0000000000", acknowledgement: GATES.find((g) => g.id === "ready_to_ship")!.acknowledgement };
      const secret = await app.inject({ method: "POST", url, payload: { to: "ship", gates: [waiver] } });
      expect(secret.statusCode).toBe(400);
      expect(secret.json()).toEqual({ error: "secret_in_text" });
    });

    it("refuses a new card straight into a stage with entry gates, so it cannot skip them", async () => {
      const p = await mkProject();
      const head = ledger.headSeq();
      for (const stage of ["ship", "operate"]) {
        const res = await app.inject({ method: "POST", url: `/api/projects/${p.id}/cards`, payload: { title: "T", stage } });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: "stage_gated", message: "Add the card to an earlier stage, then move it, so its readiness checks run.",
        });
      }
      expect(ledger.headSeq()).toBe(head);
      for (const stage of ["plan", "design", "build"]) expect((await mkCardRes(p.id, stage)).statusCode).toBe(201);
    });

    it("refuses a secret in a project name or a card title with secret_in_text", async () => {
      const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Club sk-ant-TESTKEY-0000000000" } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "secret_in_text" });
      const p = await mkProject();
      const head = ledger.headSeq();
      const card = await app.inject({
        method: "POST", url: `/api/projects/${p.id}/cards`, payload: { title: "Use sk-ant-TESTKEY-0000000000", stage: "build" },
      });
      expect(card.statusCode).toBe(400);
      expect(card.json()).toEqual({ error: "secret_in_text" });
      expect(ledger.headSeq()).toBe(head);
    });

    it("an approved plan still creates its Ship and Operate cards: the approval is a recorded human decision", async () => {
      const c = await plannedCard();
      const projectId = (ledger.list().find((e) => e.type === "card.created" && (e.payload as { cardId: string }).cardId === c.id)!).projectId!;
      const board = (await app.inject({ url: `/api/projects/${projectId}/board` })).json() as { columns: Record<string, { title: string }[]> };
      expect(board.columns.ship!.map((x) => x.title)).toContain("Payments readiness review");
      expect(board.columns.operate!.map((x) => x.title)).toEqual(["Monitoring and health checks"]);
    });

    it("GET /api/cards/:id/gates?to= returns the evaluations without recording anything", async () => {
      const c = await plannedCard();
      const head = ledger.headSeq();
      const res = await app.inject({ url: `/api/cards/${c.id}/gates?to=ship` });
      expect(res.statusCode).toBe(200);
      expect((res.json() as GateEvaluation[]).map((g) => [g.id, g.outcome])).toEqual(SHIP_GATES.map((g) => [g, "needs_sign_off"]));
      expect(ledger.headSeq()).toBe(head);
      expect((await app.inject({ url: `/api/cards/${c.id}/gates?to=nowhere` })).statusCode).toBe(400);
      expect((await app.inject({ url: `/api/cards/${c.id}/gates` })).statusCode).toBe(400);
      expect((await app.inject({ url: "/api/cards/nope/gates?to=ship" })).statusCode).toBe(404);
    });
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
    fakeAuth(a);
    registerRoutes(a, { board: boom, gates, ledger, getIntegrity: () => integrity });
    const res = await a.inject({ url: "/api/projects" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });
});

describe("who acts", () => {
  it("every write is recorded as the person who made it, through the principal", async () => {
    const owners = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme" } });
    expect(owners.statusCode).toBe(201);
    expect(ledger.list().at(-1)).toMatchObject({ type: "project.created", actor: { kind: "human", id: "owner" } });

    const theirs = await app.inject({ method: "POST", url: "/api/projects", headers: asPrincipal("m1", "maintainer"), payload: { name: "Beta" } });
    expect(theirs.statusCode).toBe(201);
    expect(ledger.list().at(-1)).toMatchObject({ type: "project.created", actor: { kind: "human", id: "m1" } });

    const card = await app.inject({
      method: "POST", url: `/api/projects/${(theirs.json() as { id: string }).id}/cards`, headers: asPrincipal("m1", "maintainer"),
      payload: { title: "T", stage: "plan" },
    });
    expect(card.statusCode).toBe(201);
    expect(ledger.list().at(-1)).toMatchObject({ type: "card.created", actor: { kind: "human", id: "m1" } });
  });

  it("the route checks the role itself: a viewer's write is 403 and nobody's is 401, with no auth hook in front", async () => {
    const head = ledger.headSeq();
    const viewer = await app.inject({ method: "POST", url: "/api/projects", headers: asPrincipal("v1", "viewer"), payload: { name: "Acme" } });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toEqual({ error: "forbidden", required: "maintainer" });
    const nobody = await app.inject({ method: "POST", url: "/api/projects", headers: asNobody, payload: { name: "Acme" } });
    expect(nobody.statusCode).toBe(401);
    const read = await app.inject({ url: "/api/projects", headers: asNobody });
    expect(read.statusCode).toBe(401);
    expect(ledger.headSeq()).toBe(head);
  });

  it("no route file keeps an Owner constant: the only `id: \"owner\"` literal under server/ is auth's", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "..", "src", "server");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "auth.ts")
      .filter((f) => /id:\s*"owner"/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
