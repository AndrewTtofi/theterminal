import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OverrideService } from "../override/service.js";

export type OverrideRouteDeps = { overrides: OverrideService };

const actor = { kind: "human", id: "owner" } as const;

// Shapes only: the service checks lengths, refuses secrets and scrubs what it records.
const commandBody = z
  .object({ program: z.string(), args: z.array(z.string()).optional(), cwd: z.string().optional(), reason: z.string() })
  .strict();
const discardBody = z.object({ reason: z.string() }).strict();

type Params = { Params: { id: string } };

/**
 * The emergency override on a run's working copy. Behind the default-deny auth; errors are mapped by the handler in
 * routes.ts (409 `run_active` / `override_busy`, 400 `program_not_found` / `program_not_allowed` / `secret_in_text`).
 */
export function registerOverrideRoutes(app: FastifyInstance, deps: OverrideRouteDeps): void {
  const { overrides } = deps;

  app.post<Params>("/api/runs/:id/override/command", async (req, reply) => {
    const body = commandBody.parse(req.body);
    const result = await overrides.command(actor, req.params.id, {
      program: body.program,
      args: body.args ?? [],
      ...(body.cwd !== undefined && { cwd: body.cwd }),
      reason: body.reason,
    });
    return reply.code(201).send(result);
  });

  app.post<Params>("/api/runs/:id/override/discard", async (req) => {
    const { reason } = discardBody.parse(req.body);
    return overrides.discard(actor, req.params.id, reason);
  });
}
