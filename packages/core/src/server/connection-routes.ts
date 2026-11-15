import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONNECTION_CATALOG, CONNECTION_KINDS, CONNECTION_PROVIDERS, PROVIDERS, type CiStatus } from "@theterminal/shared";
import type { ConnectionService } from "../connections/service.js";
import { CliNotInstalledError, InvalidCliHomeError, SignInRunningError, TerminalRequiredError, type SignInManager } from "../connections/signin.js";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { workspaceCounts } from "../events/projections.js";
import type { IntakeService } from "../intake/service.js";

export type ConnectionRouteDeps = {
  db: Db;
  connections: ConnectionService;
  signin: SignInManager;
  ledger: Ledger;
  /** The CI status for the status bar without waiting on the network; null when GitHub is not connected. */
  ci: () => CiStatus | null;
  intake: IntakeService;
  /** Share links being served right now: the live listeners, never the projection's rows. */
  shareLinks: () => number;
};

const actor = { kind: "human", id: "owner" } as const;

// Shapes only: the service checks fields, values and config against the catalog.
const values = z.record(z.string(), z.string());
const addBody = z
  .object({
    kind: z.enum(CONNECTION_KINDS),
    provider: z.enum(CONNECTION_PROVIDERS),
    name: z.string(),
    config: values.optional(),
    secrets: values.optional(),
    private: values.optional(),
  })
  .strict();
const patchBody = z
  .object({
    name: z.string().optional(),
    config: values.optional(),
    enabled: z.boolean().optional(),
    secrets: z.record(z.string(), z.string().nullable()).optional(),
    private: z.record(z.string(), z.string().nullable()).optional(),
  })
  .strict();

/** Connections and the workspace status. Errors are mapped by the handler in routes.ts. */
export function registerConnectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): void {
  const { db, connections, signin, ledger, ci, intake, shareLinks } = deps;

  app.get("/api/connections/catalog", async () => CONNECTION_CATALOG);

  app.get("/api/connections", async () => connections.list());

  app.post("/api/connections", async (req, reply) => {
    const body = addBody.parse(req.body);
    const added = await connections.add(actor, {
      kind: body.kind,
      provider: body.provider,
      name: body.name,
      ...(body.config !== undefined && { config: body.config }),
      ...(body.secrets !== undefined && { secrets: body.secrets }),
      ...(body.private !== undefined && { private: body.private }),
    });
    return reply.code(201).send(added);
  });

  app.patch<{ Params: { id: string } }>("/api/connections/:id", async (req) => {
    const body = patchBody.parse(req.body);
    return connections.update(actor, req.params.id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.config !== undefined && { config: body.config }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.secrets !== undefined && { secrets: body.secrets }),
      ...(body.private !== undefined && { private: body.private }),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (req, reply) => {
    await connections.remove(actor, req.params.id);
    return reply.code(204).send();
  });

  // The UI sends this with no body and no content-type.
  app.post<{ Params: { id: string } }>("/api/connections/:id/test", async (req) => connections.test(actor, req.params.id));

  // Sign-in to the Owner's own subscriptions: the provider's official login command, never its credentials.
  app.get("/api/connections/signin-status", async () => signin.status());

  // The UI sends this with no body and no content-type.
  app.post<{ Params: { provider: string } }>("/api/connections/signin/:provider", async (req, reply) => {
    const provider = z.enum(PROVIDERS).parse(req.params.provider);
    if (ledger.readOnly) return reply.code(423).send({ error: "ledger_read_only" });
    try {
      return reply.code(202).send(signin.start(provider));
    } catch (e) {
      if (e instanceof SignInRunningError) return reply.code(409).send({ error: "signin_running" });
      if (e instanceof CliNotInstalledError) return reply.code(422).send({ error: "not_installed" });
      if (e instanceof TerminalRequiredError) return reply.code(422).send({ error: "terminal_required" });
      if (e instanceof InvalidCliHomeError) return reply.code(422).send({ error: "invalid_cli_home" });
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>("/api/connections/signin/:id", async (req, reply) => {
    const view = signin.get(req.params.id);
    return view ?? reply.code(404).send({ error: "not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/connections/signin/:id", async (req, reply) =>
    signin.cancel(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" }),
  );

  app.get("/api/status", async () => {
    // Started, never awaited: a hung keychain must not hold up the status bar. A later read sees the outcome.
    void connections.retryIfUnavailable().catch(() => undefined);
    const counts = workspaceCounts(db);
    const intakeProjects = intake.openDecisionsByProject();
    const budgets = connections.budgets().flatMap((b) => (b.monthlyBudgetUsd === null ? [] : [b.monthlyBudgetUsd]));
    return {
      runningAgents: counts.runningAgents,
      pendingDecisions: counts.pendingDecisions,
      todayCostUsd: counts.todayCostUsd,
      monthCostUsd: counts.monthCostUsd,
      // The sum of the enabled model connections' budgets; null when none has one.
      monthlyBudgetUsd: budgets.length === 0 ? null : budgets.reduce((a, b) => a + b, 0),
      connections: { ...counts.connections, keychain: connections.keychainState() },
      ci: ci(),
      // Undecided plan decisions over every open intake, and the projects they belong to.
      intakeDecisions: intakeProjects.reduce((a, p) => a + p.decisions, 0),
      intakeProjects,
      shareLinks: shareLinks(),
    };
  });
}
