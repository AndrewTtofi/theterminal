import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ADAPTERS,
  PROVIDER_ACKS,
  PROVIDERS,
  agentPayloadSchemas,
  type AdapterId,
  type AuthMode,
  type Provider,
} from "@theterminal/shared";
import type { AgentRunner } from "../agents/runner.js";
import type { ProviderSettings } from "../agents/settings.js";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import { listAllPendingActions, listPendingActions } from "../events/projections.js";
import { remoteDisplay } from "../link/mirrored.js";

export type AgentRouteDeps = {
  db: Db;
  runner: AgentRunner;
  settings: ProviderSettings;
  /** The adapters registered in this server, in ADAPTERS order. */
  adapters: AdapterId[];
  /** Whether a run can locate a provider's program (bundled, else on PATH). Asked on every listing. */
  available: (p: Provider) => boolean;
  /** Where a run's API key would come from right now: a connection wins over the server's environment variable. */
  apiKey: (p: Provider) => ApiKeySource;
  /** This machine's redaction, for runs on a linked machine. Default: the built-in patterns. */
  clean?: (s: string) => string;
};

export type ApiKeySource = "connection" | "environment" | "none";

const actor = { kind: "human", id: "owner" } as const;

const startBody = z.object({
  adapter: z.enum(ADAPTERS),
  prompt: agentPayloadSchemas["agent.started"].shape.prompt, // same bounds as the recorded event
  cardId: z.string().min(1).max(200).nullable().optional(),
  /** Cloud and MCP connections the Owner gives this run. */
  connectionIds: z.array(z.string().min(1).max(200)).max(10).optional(),
});
const decisionBody = z.object({ decision: z.enum(["allow", "deny"]), reason: z.string().optional() });
const authBody = z.object({ mode: z.enum(["api_key", "subscription"]), acknowledgement: z.string().optional() });
const providerAuthBody = z.object({
  provider: z.enum(PROVIDERS),
  mode: z.enum(["api_key", "subscription", "chatgpt", "google"]), // which suit the provider: ProviderSettings checks
  acknowledgement: z.string().optional(),
}).strict();

/** Agent runs, decisions and the per-provider auth settings. Errors are mapped by the handler in routes.ts. */
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { db, runner, settings, adapters, available, apiKey } = deps;
  const shown = remoteDisplay(db, deps.clean);

  const requireProject = (id: string) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new NotFoundError("project", id);
  };

  app.get("/api/agents", async () => ({
    adapters,
    providers: Object.fromEntries(
      PROVIDERS.map((p) => [p, { mode: settings.getMode(p), available: available(p), apiKey: apiKey(p) }]),
    ) as Record<Provider, { mode: AuthMode; available: boolean; apiKey: ApiKeySource }>,
    acks: PROVIDER_ACKS,
  }));

  app.post("/api/settings/provider-auth", async (req) => {
    const body = providerAuthBody.parse(req.body);
    settings.setMode(actor, body.provider, body.mode, body.acknowledgement);
    return { provider: body.provider, mode: settings.getMode(body.provider) };
  });

  // Alias of provider-auth for provider "claude", kept for compatibility.
  app.post("/api/settings/claude-auth", async (req) => {
    const body = authBody.parse(req.body);
    settings.setMode(actor, "claude", body.mode, body.acknowledgement);
    return { mode: settings.getMode("claude") };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/runs", async (req, reply) => {
    const body = startBody.parse(req.body);
    const run = await runner.start(actor, {
      projectId: req.params.id,
      adapter: body.adapter,
      prompt: body.prompt,
      ...(body.cardId !== undefined && { cardId: body.cardId }),
      ...(body.connectionIds !== undefined && { connectionIds: body.connectionIds }),
    });
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/runs", async (req) => {
    requireProject(req.params.id);
    return runner.listRuns(req.params.id).map(shown.run);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/pending-actions", async (req) => {
    requireProject(req.params.id);
    return listPendingActions(db, req.params.id).map(shown.action);
  });

  app.get("/api/pending-actions", async () => listAllPendingActions(db).map(shown.action));

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => {
    const { run, actions } = runner.getRun(req.params.id);
    return { run: shown.run(run), actions: actions.map(shown.action) };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (req) => {
    runner.stop(actor, req.params.id);
    return runner.getRun(req.params.id).run;
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/decision", async (req) => {
    const body = decisionBody.parse(req.body);
    return runner.decide(actor, req.params.id, body.decision, body.reason);
  });
}
