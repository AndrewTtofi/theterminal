import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CONNECTION_CATALOG, CONNECTION_KINDS, CONNECTION_PROVIDERS, OWNER_ID, PROVIDERS, connectionSummary, type CiStatus,
} from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import type { ConnectionService } from "../connections/service.js";
import { CliNotInstalledError, InvalidCliHomeError, SignInRunningError, TerminalRequiredError, type SignInManager } from "../connections/signin.js";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { workspaceCounts } from "../events/projections.js";
import type { IntakeService } from "../intake/service.js";
import type { NetworkState } from "../network.js";
import { actorOf, needs } from "./auth.js";

export type ConnectionRouteDeps = {
  db: Db;
  connections: ConnectionService;
  signin: SignInManager;
  ledger: Ledger;
  /** The CI status for the status bar without waiting on the network; null when GitHub is not connected. */
  ci: () => CiStatus | null;
  intake: IntakeService;
  /** Paired machines, how many answered their last check and how many met another key; never makes a new check. */
  machines: () => { linked: number; online: number; keyChanged: number };
  /** The network state inferred from the Owner's own outgoing calls; never makes a call. */
  network: () => NetworkState;
  /** Share links being served right now: the live listeners, never the projection's rows. */
  shareLinks: () => number;
};

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
  const { db, connections, signin, ledger, ci, intake, machines, network, shareLinks } = deps;

  app.get("/api/connections/catalog", needs("owner"), async () => CONNECTION_CATALOG);

  // The Owner sees each connection's config, private values and the names of its secret fields; anyone else sees
  // what it is and whether it works (ConnectionSummary), enough to give a run access to it by name.
  app.get("/api/connections", needs("viewer"), async (req) => {
    const list = connections.list();
    return req.principal?.personId === OWNER_ID ? list : list.map(connectionSummary);
  });

  app.post("/api/connections", needs("owner"), async (req, reply) => {
    const body = addBody.parse(req.body);
    const added = await connections.add(actorOf(req), {
      kind: body.kind,
      provider: body.provider,
      name: body.name,
      ...(body.config !== undefined && { config: body.config }),
      ...(body.secrets !== undefined && { secrets: body.secrets }),
      ...(body.private !== undefined && { private: body.private }),
    });
    return reply.code(201).send(added);
  });

  app.get<{ Params: { id: string } }>("/api/connections/:id", needs("owner"), async (req) => {
    const found = connections.list().find((c) => c.id === req.params.id);
    if (!found) throw new NotFoundError("connection", req.params.id);
    return found;
  });

  app.patch<{ Params: { id: string } }>("/api/connections/:id", needs("owner"), async (req) => {
    const body = patchBody.parse(req.body);
    return connections.update(actorOf(req), req.params.id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.config !== undefined && { config: body.config }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.secrets !== undefined && { secrets: body.secrets }),
      ...(body.private !== undefined && { private: body.private }),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/connections/:id", needs("owner"), async (req, reply) => {
    await connections.remove(actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  // The UI sends this with no body and no content-type.
  app.post<{ Params: { id: string } }>("/api/connections/:id/test", needs("owner"), async (req) => connections.test(actorOf(req), req.params.id));

  // Sign-in to the Owner's own subscriptions: the provider's official login command, never its credentials.
  app.get("/api/connections/signin-status", needs("owner"), async () => signin.status());

  // The UI sends this with no body and no content-type.
  app.post<{ Params: { provider: string } }>("/api/connections/signin/:provider", needs("owner"), async (req, reply) => {
    const provider = z.enum(PROVIDERS).parse(req.params.provider);
    if (ledger.readOnly) return reply.code(423).send({ error: "ledger_read_only" });
    try {
      return reply.code(202).send(signin.start(provider, actorOf(req)));
    } catch (e) {
      if (e instanceof SignInRunningError) return reply.code(409).send({ error: "signin_running" });
      if (e instanceof CliNotInstalledError) return reply.code(422).send({ error: "not_installed" });
      if (e instanceof TerminalRequiredError) return reply.code(422).send({ error: "terminal_required" });
      if (e instanceof InvalidCliHomeError) return reply.code(422).send({ error: "invalid_cli_home" });
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>("/api/connections/signin/:id", needs("owner"), async (req, reply) => {
    const view = signin.get(req.params.id);
    return view ?? reply.code(404).send({ error: "not_found" });
  });

  app.delete<{ Params: { id: string } }>("/api/connections/signin/:id", needs("owner"), async (req, reply) =>
    signin.cancel(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" }),
  );

  // The status bar. A collaborator gets the counts and states only: the keychain, and anything added for the Owner
  // later (remote access, say), stays out of their copy, which is built from this fixed list of fields.
  app.get("/api/status", needs("viewer"), async (req) => {
    // Started, never awaited: a hung keychain must not hold up the status bar. A later read sees the outcome.
    void connections.retryIfUnavailable().catch(() => undefined);
    const counts = workspaceCounts(db);
    const intakeProjects = intake.openDecisionsByProject();
    const budgets = connections.budgets().flatMap((b) => (b.monthlyBudgetUsd === null ? [] : [b.monthlyBudgetUsd]));
    const shared = {
      runningAgents: counts.runningAgents,
      pendingDecisions: counts.pendingDecisions,
      todayCostUsd: counts.todayCostUsd,
      monthCostUsd: counts.monthCostUsd,
      // The sum of the enabled model connections' budgets; null when none has one.
      monthlyBudgetUsd: budgets.length === 0 ? null : budgets.reduce((a, b) => a + b, 0),
      connections: { enabled: counts.connections.enabled, failed: counts.connections.failed },
      ci: ci(),
      // Undecided plan decisions over every open intake, and the projects they belong to.
      intakeDecisions: intakeProjects.reduce((a, p) => a + p.decisions, 0),
      intakeProjects,
      machines: machines(),
      // Only the fixed fields: the state, when it began and the system code that made it offline. No URL or message.
      network: network(),
      shareLinks: shareLinks(),
    };
    if (req.principal?.personId !== OWNER_ID) return shared;
    return { ...shared, connections: { ...shared.connections, keychain: connections.keychainState() } };
  });
}
