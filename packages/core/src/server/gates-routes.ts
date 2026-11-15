import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { gatePayloadSchemas } from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import { GateRequirementError, type GateService, type Signer } from "../gates/service.js";
import { sendError } from "./routes.js";

export type GateRouteDeps = {
  gates: GateService;
  /** Who is asking (the auth hook's principal), or null when nobody signed in. */
  principal: (request: FastifyRequest) => Signer | null;
};

// The body's shape; the gate and the requirement are then parsed as the ledger entry's payload, and the service
// checks that the project exists and that a named person is current.
const requirementBody = z.object({ requirement: z.unknown() }).strict();
const requirementInput = gatePayloadSchemas["gate.requirement_set"];

type Params = { Params: { id: string; gateId: string } };

/**
 * The errors this plugin's routes and the move route raise over requirements: fixed codes, the gate and its
 * requirement only (a person id at most, never a name). Null for any other error.
 */
export function sendGateError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (err instanceof GateRequirementError) {
    return reply.code(403).send({ error: "gate_requires", gateId: err.gateId, requirement: err.requirement });
  }
  if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
  return null;
}

/**
 * Gate requirements: the Owner says who may sign a project's gate. An encapsulated plugin with its own error
 * handler, so routes.ts's map stays as it is; the auth hook's role table applies as to every route, and the
 * handler checks the Owner again itself.
 */
export function registerGateRoutes(app: FastifyInstance, deps: GateRouteDeps): void {
  const { gates, principal } = deps;
  void app.register(async (scope) => {
    scope.setErrorHandler((err, _req, reply) => sendGateError(err, reply) ?? sendError(err, reply, scope.log));

    scope.put<Params>("/api/projects/:id/gates/:gateId/requirement", async (req, reply) => {
      const who = principal(req);
      if (who === null) return reply.code(401).send({ error: "unauthorized" });
      if (who.role !== "owner") return reply.code(403).send({ error: "forbidden", required: "owner" });
      const body = requirementBody.parse(req.body);
      // A missing `requirement` (undefined) is refused here, like any shape the payload does not know.
      const { gateId, requirement } = requirementInput.parse({ gateId: req.params.gateId, requirement: body.requirement });
      const inForce = gates.setRequirement({ kind: "human", id: who.personId }, req.params.id, gateId, requirement);
      return { gateId, requirement: inForce };
    });
  });
}
