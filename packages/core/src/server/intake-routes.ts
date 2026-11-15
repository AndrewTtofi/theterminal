import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DECISION_IDS, QUESTION_IDS } from "@theterminal/shared";
import type { IntakeService } from "../intake/service.js";

export type IntakeRouteDeps = { intake: IntakeService };

const actor = { kind: "human", id: "owner" } as const;

// Shapes only: the service trims, checks lengths, scrubs and refuses secrets.
const startBody = z.object({ idea: z.string() }).strict();
const answerBody = z.object({ questionId: z.enum(QUESTION_IDS), answer: z.unknown() }).strict();
const decideBody = z.object({ decisionId: z.enum(DECISION_IDS), chosen: z.string(), rationale: z.string().optional() }).strict();
const reopenBody = z.object({ reason: z.string() }).strict();

type Params = { Params: { id: string } };

/** The guided intake. Behind the default-deny auth; errors are mapped by the handler in routes.ts. */
export function registerIntakeRoutes(app: FastifyInstance, deps: IntakeRouteDeps): void {
  const { intake } = deps;

  app.get<Params>("/api/projects/:id/intake", async (req, reply) => {
    const view = intake.get(req.params.id);
    return view ?? reply.code(404).send({ error: "no_intake" });
  });

  app.post<Params>("/api/projects/:id/intake", async (req, reply) => {
    const { idea } = startBody.parse(req.body);
    return reply.code(201).send(intake.start(actor, req.params.id, idea));
  });

  app.post<Params>("/api/projects/:id/intake/answers", async (req) => {
    const body = answerBody.parse(req.body);
    return intake.answer(actor, req.params.id, body.questionId, body.answer);
  });

  app.post<Params>("/api/projects/:id/intake/decisions", async (req) => {
    const body = decideBody.parse(req.body);
    return intake.decide(actor, req.params.id, body.decisionId, body.chosen, body.rationale);
  });

  // The UI sends this with no body and no content-type.
  app.post<Params>("/api/projects/:id/intake/complete", async (req) => intake.complete(actor, req.params.id));

  app.post<Params>("/api/projects/:id/intake/reopen", async (req) => {
    const { reason } = reopenBody.parse(req.body);
    return intake.reopen(actor, req.params.id, reason);
  });
}
