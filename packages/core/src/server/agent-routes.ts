import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ADAPTERS,
  MACHINE_ID,
  OWNER_ID,
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
import { getRun, listAllPendingActions, listPendingActions } from "../events/projections.js";
import { remoteDisplay } from "../link/mirrored.js";
import type { RemoteRunService } from "../link/remote-runs.js";
import { actorOf, needs } from "./auth.js";

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
  /**
   * Runs on linked machines: a start with `machineId`, and the stop and decisions of a run that has one, go here and
   * never to the local runner. Without it a `machineId` names no machine (404).
   */
  remoteRuns?: RemoteRunService;
};

export type ApiKeySource = "connection" | "environment" | "none";

const startBody = z.object({
  adapter: z.enum(ADAPTERS),
  prompt: agentPayloadSchemas["agent.started"].shape.prompt, // same bounds as the recorded event
  cardId: z.string().min(1).max(200).nullable().optional(),
  /** Cloud and MCP connections given to this run, by id: a maintainer sees their names and may name them too. */
  connectionIds: z.array(z.string().min(1).max(200)).max(10).optional(),
  /** A paired machine to run on (its connections are the ones given); absent runs here. */
  machineId: z.string().regex(MACHINE_ID).optional(),
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
  const { db, runner, settings, adapters, available, apiKey, remoteRuns } = deps;
  const shown = remoteDisplay(db, deps.clean);

  const requireProject = (id: string) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new NotFoundError("project", id);
  };

  // The Owner learns how they sign in to each provider, where its key would come from, whether its own-plan mode can
  // be chosen on this server (the restricted sign-in switch) and reads the acknowledgements; a collaborator learns only
  // which agents exist and whether their programs are there. How the Owner signs in (a subscription, a ChatGPT or
  // Google login) is theirs alone, as it is in capacity.
  app.get("/api/agents", needs("viewer"), async (req) => {
    const owner = req.principal?.personId === OWNER_ID;
    return {
      adapters,
      providers: Object.fromEntries(
        PROVIDERS.map((p) => [
          p,
          { available: available(p), ...(owner && { mode: settings.getMode(p), apiKey: apiKey(p), ownModeAvailable: settings.ownModeAvailable(p) }) },
        ]),
      ) as Record<Provider, { available: boolean; mode?: AuthMode; apiKey?: ApiKeySource; ownModeAvailable?: boolean }>,
      ...(owner && { acks: PROVIDER_ACKS }),
    };
  });

  app.post("/api/settings/provider-auth", needs("owner"), async (req) => {
    const body = providerAuthBody.parse(req.body);
    settings.setMode(actorOf(req), body.provider, body.mode, body.acknowledgement);
    return { provider: body.provider, mode: settings.getMode(body.provider) };
  });

  // Alias of provider-auth for provider "claude", kept for compatibility.
  app.post("/api/settings/claude-auth", needs("owner"), async (req) => {
    const body = authBody.parse(req.body);
    settings.setMode(actorOf(req), "claude", body.mode, body.acknowledgement);
    return { mode: settings.getMode("claude") };
  });

  // Anyone but the Owner runs on an API key, here and on a linked machine: never on the Owner's logins.
  app.post<{ Params: { id: string } }>("/api/projects/:id/runs", needs("maintainer"), async (req, reply) => {
    const body = startBody.parse(req.body);
    const actor = actorOf(req);
    const forceApiKey = actor.id !== OWNER_ID;
    if (body.machineId !== undefined) {
      if (!remoteRuns) throw new NotFoundError("machine", body.machineId);
      const run = await remoteRuns.start(actor, {
        projectId: req.params.id,
        machineId: body.machineId,
        adapter: body.adapter,
        prompt: body.prompt,
        ...(body.cardId !== undefined && { cardId: body.cardId }),
        ...(body.connectionIds !== undefined && { connectionIds: body.connectionIds }),
        forceApiKey,
      });
      return reply.code(201).send(shown.run(run));
    }
    const run = await runner.start(actor, {
      projectId: req.params.id,
      adapter: body.adapter,
      prompt: body.prompt,
      ...(body.cardId !== undefined && { cardId: body.cardId }),
      ...(body.connectionIds !== undefined && { connectionIds: body.connectionIds }),
      forceApiKey,
    });
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/runs", needs("viewer"), async (req) => {
    requireProject(req.params.id);
    return runner.listRuns(req.params.id).map(shown.run);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/pending-actions", needs("viewer"), async (req) => {
    requireProject(req.params.id);
    return listPendingActions(db, req.params.id).map(shown.action);
  });

  app.get("/api/pending-actions", needs("viewer"), async () => listAllPendingActions(db).map(shown.action));

  app.get<{ Params: { id: string } }>("/api/runs/:id", needs("viewer"), async (req) => {
    const { run, actions } = runner.getRun(req.params.id);
    return { run: shown.run(run), actions: actions.map(shown.action) };
  });

  // A run on a linked machine is stopped and decided there: the request goes to the worker, and nothing is recorded
  // here until its entries arrive. The local runner refuses such a run itself (RemoteRunError), as a last guard.
  // The same role is needed for a run wherever it executes, and the person asking is the one recorded.
  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", needs("maintainer"), async (req) => {
    const actor = actorOf(req);
    const run = getRun(db, req.params.id);
    if (run && run.machineId !== null && remoteRuns) return shown.run(await remoteRuns.stop(actor, run));
    runner.stop(actor, req.params.id);
    return shown.run(runner.getRun(req.params.id).run);
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/decision", needs("reviewer"), async (req) => {
    const body = decisionBody.parse(req.body);
    const actor = actorOf(req);
    const owner = db.prepare("SELECT run_id FROM agent_actions WHERE id = ?").get(req.params.id) as { run_id: string } | undefined;
    const run = owner ? getRun(db, owner.run_id) : null;
    if (run && run.machineId !== null && remoteRuns) {
      return shown.action(await remoteRuns.decide(actor, run, req.params.id, body.decision, body.reason ?? ""));
    }
    return shown.action(runner.decide(actor, req.params.id, body.decision, body.reason));
  });
}
