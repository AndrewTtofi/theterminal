import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ADAPTERS, CLAUDE_SUBSCRIPTION_ACK, agentPayloadSchemas, type AdapterId } from "@theterminal/shared";
import type { AgentRunner } from "../agents/runner.js";
import type { ClaudeSettings } from "../agents/settings.js";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import { listPendingActions } from "../events/projections.js";

export type AgentRouteDeps = {
  db: Db;
  runner: AgentRunner;
  settings: ClaudeSettings;
  /** The adapters registered in this server, in ADAPTERS order. */
  adapters: AdapterId[];
};

const actor = { kind: "human", id: "owner" } as const;

const startBody = z.object({
  adapter: z.enum(ADAPTERS),
  prompt: agentPayloadSchemas["agent.started"].shape.prompt, // same bounds as the recorded event
  cardId: z.string().min(1).max(200).nullable().optional(),
});
const decisionBody = z.object({ decision: z.enum(["allow", "deny"]), reason: z.string().optional() });
const authBody = z.object({ mode: z.enum(["api_key", "subscription"]), acknowledgement: z.string().optional() });

/** Agent runs, decisions and the Claude auth setting. Errors are mapped by the handler in routes.ts. */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { db, runner, settings, adapters } = deps;

  const requireProject = (id: string) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new NotFoundError("project", id);
  };

  app.get("/api/agents", async () => ({
    adapters,
    claudeAuthMode: settings.getMode(),
    subscriptionAck: CLAUDE_SUBSCRIPTION_ACK,
  }));

  app.post("/api/settings/claude-auth", async (req) => {
    const body = authBody.parse(req.body);
    settings.setMode(actor, body.mode, body.acknowledgement);
    return { mode: settings.getMode() };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/runs", async (req, reply) => {
    const body = startBody.parse(req.body);
    const run = await runner.start(actor, {
      projectId: req.params.id,
      adapter: body.adapter,
      prompt: body.prompt,
      ...(body.cardId !== undefined && { cardId: body.cardId }),
    });
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/runs", async (req) => {
    requireProject(req.params.id);
    return runner.listRuns(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/pending-actions", async (req) => {
    requireProject(req.params.id);
    return listPendingActions(db, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => runner.getRun(req.params.id));

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (req) => {
    runner.stop(actor, req.params.id);
    return runner.getRun(req.params.id).run;
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/decision", async (req) => {
    const body = decisionBody.parse(req.body);
    return runner.decide(actor, req.params.id, body.decision, body.reason);
  });
}
