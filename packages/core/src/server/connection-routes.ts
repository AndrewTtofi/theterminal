import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONNECTION_CATALOG, CONNECTION_KINDS, CONNECTION_PROVIDERS } from "@theterminal/shared";
import type { ConnectionService } from "../connections/service.js";
import type { Db } from "../db.js";
import { workspaceCounts } from "../events/projections.js";

export type ConnectionRouteDeps = {
  db: Db;
  connections: ConnectionService;
};

const actor = { kind: "human", id: "owner" } as const;

// Shapes only: the service checks fields, values and config against the catalog.
const values = z.record(z.string());
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
    secrets: z.record(z.string().nullable()).optional(),
    private: z.record(z.string().nullable()).optional(),
  })
  .strict();

/** Connections and the workspace status. Errors are mapped by the handler in routes.ts. */
export function registerConnectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): void {
  const { db, connections } = deps;

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

  app.get("/api/status", async () => {
    const counts = workspaceCounts(db);
    return {
      runningAgents: counts.runningAgents,
      pendingDecisions: counts.pendingDecisions,
      todayCostUsd: counts.todayCostUsd,
      connections: { ...counts.connections, keychain: connections.keychainState() },
      ci: null,
    };
  });
}
