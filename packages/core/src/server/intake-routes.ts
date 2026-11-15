import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DECISION_IDS, QUESTION_IDS } from "@theterminal/shared";
import type { IntakeService } from "../intake/service.js";
import { actorOf, needs } from "./auth.js";

export type IntakeRouteDeps = { intake: IntakeService };

// Shapes only: the service trims, checks lengths, scrubs and refuses secrets.
const startBody = z.object({ idea: z.string() }).strict();
const answerBody = z.object({ questionId: z.enum(QUESTION_IDS), answer: z.unknown() }).strict();
const decideBody = z.object({ decisionId: z.enum(DECISION_IDS), chosen: z.string(), rationale: z.string().optional() }).strict();
const reopenBody = z.object({ reason: z.string() }).strict();

type Params = { Params: { id: string } };

/** The guided intake. Behind the default-deny auth; errors are mapped by the handler in routes.ts. */
export function registerIntakeRoutes(app: FastifyInstance, deps: IntakeRouteDeps): void {
  const { intake } = deps;

  app.get<Params>("/api/projects/:id/intake", needs("viewer"), async (req, reply) => {
    const view = intake.get(req.params.id);
    return view ?? reply.code(404).send({ error: "no_intake" });
  });

  app.post<Params>("/api/projects/:id/intake", needs("maintainer"), async (req, reply) => {
    const { idea } = startBody.parse(req.body);
    return reply.code(201).send(intake.start(actorOf(req), req.params.id, idea));
  });

  app.post<Params>("/api/projects/:id/intake/answers", needs("maintainer"), async (req) => {
    const body = answerBody.parse(req.body);
    return intake.answer(actorOf(req), req.params.id, body.questionId, body.answer);
  });

  // Plan decisions are a reviewer's: the decision is recorded as theirs.
  app.post<Params>("/api/projects/:id/intake/decisions", needs("reviewer"), async (req) => {
    const body = decideBody.parse(req.body);
    return intake.decide(actorOf(req), req.params.id, body.decisionId, body.chosen, body.rationale);
  });

  // The UI sends this with no body and no content-type.
  app.post<Params>("/api/projects/:id/intake/complete", needs("reviewer"), async (req) => intake.complete(actorOf(req), req.params.id));

  app.post<Params>("/api/projects/:id/intake/reopen", needs("maintainer"), async (req) => {
    const { reason } = reopenBody.parse(req.body);
    return intake.reopen(actorOf(req), req.params.id, reason);
  });
}
