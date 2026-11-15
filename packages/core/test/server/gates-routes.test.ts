import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { NewLedgerEntry, Role } from "@theterminal/shared";
import { commitEvents } from "../../src/events/commit.js";
import { GateRequirementError, GateService, type Signer } from "../../src/gates/service.js";
import { registerGateRoutes } from "../../src/server/gates-routes.js";
import { human, world, type World } from "../gates/setup.js";

let w: World;
let app: FastifyInstance;
let gates: GateService;

/** The test's principal comes from a header: `<personId>:<role>`; none means no principal. */
const principalOf = (req: FastifyRequest): Signer | null => {
  const h = req.headers["x-test-principal"];
  if (typeof h !== "string") return null;
  const [personId, role] = h.split(":");
  return { personId: personId!, role: role as Role };
};

beforeEach(async () => {
  w = world();
  gates = new GateService({ db: w.db, ledger: w.ledger });
  commitEvents(w.db, w.ledger, () => ({
    events: [
      { projectId: null, actor: human, type: "person.invited", payload: { inviteId: "i1", role: "maintainer", codeHash: "c".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" } },
      {
        projectId: null, actor: { kind: "human", id: "m1" }, type: "person.joined",
        payload: { personId: "m1", inviteId: "i1", name: "Maintainer One", role: "maintainer", credential: { kind: "key", credentialId: "key-m1", publicKey: "TESTKEYm1", label: "CLI" } },
      },
    ] as NewLedgerEntry[],
    result: () => undefined,
  }));
  app = Fastify();
  registerGateRoutes(app, { gates, principal: principalOf });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const put = (body: unknown, who: string | null = "owner:owner", projectId = w.planned, gateId = "ready_to_ship") =>
  app.inject({
    method: "PUT", url: `/api/projects/${projectId}/gates/${gateId}/requirement`, payload: body as object,
    headers: who === null ? {} : { "x-test-principal": who },
  });

describe("PUT /api/projects/:id/gates/:gateId/requirement", () => {
  it("a maintainer is refused 403 forbidden and nothing is recorded; no principal is 401", async () => {
    const head = w.ledger.headSeq();
    const res = await put({ requirement: { personId: "m1" } }, "m1:maintainer");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", required: "owner" });
    expect((await put({ requirement: { personId: "m1" } }, null)).statusCode).toBe(401);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("the Owner sets a person, then the default: 200 with the requirement now in force, recorded as the Owner's", async () => {
    const res = await put({ requirement: { personId: "m1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gateId: "ready_to_ship", requirement: { personId: "m1" } });
    const last = w.ledger.list().at(-1)!;
    expect(last).toMatchObject({ type: "gate.requirement_set", projectId: w.planned, actor: { kind: "human", id: "owner" } });

    const back = await put({ requirement: null });
    expect(back.json()).toEqual({ gateId: "ready_to_ship", requirement: { role: "reviewer" } });
    expect(w.ledger.list().at(-1)!.payload).toEqual({ gateId: "ready_to_ship", requirement: null });
  });

  it("maps an unknown person or project to 404, and a bad gate or body to 400", async () => {
    expect((await put({ requirement: { personId: "nobody" } })).statusCode).toBe(404);
    expect((await put({ requirement: { personId: "nobody" } })).json()).toEqual({ error: "not_found" });
    expect((await put({ requirement: { role: "owner" } }, "owner:owner", "nope")).statusCode).toBe(404);
    expect((await put({ requirement: { role: "owner" } }, "owner:owner", w.planned, "nowhere")).statusCode).toBe(400);
    expect((await put({ requirement: { role: "boss" } })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ requirement: null, extra: 1 })).statusCode).toBe(400);
  });
});

describe("sendGateError", () => {
  it("maps GateRequirementError to 403 gate_requires with the gate and the requirement only", async () => {
    const { sendGateError } = await import("../../src/server/gates-routes.js");
    const probe = Fastify();
    probe.get("/x", async () => {
      throw new GateRequirementError("go_live", { role: "owner" });
    });
    probe.setErrorHandler((err, _req, reply) => sendGateError(err, reply) ?? reply.code(500).send({ error: "internal" }));
    const res = await probe.inject({ url: "/x" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "gate_requires", gateId: "go_live", requirement: { role: "owner" } });
    await probe.close();
  });
});
