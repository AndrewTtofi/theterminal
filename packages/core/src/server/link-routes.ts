import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LINK_DEFAULT_PORT } from "@theterminal/shared";
import { IdentityUnavailableError, type LinkService } from "../link/service.js";
import type { LinkCapacity } from "../link/capacity.js";

export type LinkRouteDeps = {
  link: LinkService;
  /** The linked machines' capacity (see LinkCapacity). */
  capacity: LinkCapacity;
  /** The port the listener asks for when the Owner enables linking (the next 20 are tried). Default 4418. */
  port?: number;
};

const actor = { kind: "human", id: "owner" } as const;
const nameBody = z.object({ name: z.string() }).strict();
const enableBody = z.object({ acknowledgement: z.string() }).strict();
const pairBody = z.object({ address: z.string(), code: z.string() }).strict();
const idParams = z.object({ id: z.string().min(1).max(200) });

/**
 * Linked machines, for the Owner's workspace only: these sit behind registerAuth like every /api route (session and
 * Host checks). Errors are mapped in routes.ts.
 */
export function registerLinkRoutes(app: FastifyInstance, deps: LinkRouteDeps): void {
  const { link } = deps;
  const port = deps.port ?? LINK_DEFAULT_PORT;
  /** This computer, or 503 identity_unavailable. */
  const self = () => {
    const s = link.self();
    if (!s) throw new IdentityUnavailableError();
    return s;
  };

  app.get("/api/link", async () => {
    const ok = link.identityState() === "ok";
    // Each paired machine is asked once (3 s at most, all at once; answers are kept 15 s) before the rows are read.
    if (ok) await Promise.all(link.machines().map((m) => link.hello(m.id)));
    return {
      identity: link.identityState(),
      self: link.self(),
      machines: link.presence(),
      discovered: ok ? link.discovered() : [],
    };
  });

  app.post("/api/link/name", async (req) => {
    const { name } = nameBody.parse(req.body);
    self();
    await link.setName(actor, name);
    return self();
  });

  app.post("/api/link/enable", async (req) => {
    const { acknowledgement } = enableBody.parse(req.body);
    await link.enableLinking(actor, acknowledgement, port);
    return self();
  });

  // The UI sends this with no body and no content-type.
  app.post("/api/link/disable", async () => {
    self();
    await link.disableLinking(actor);
    return self();
  });

  app.post("/api/link/code", async () => {
    self();
    return link.showCode();
  });

  app.delete("/api/link/code", async (_req, reply) => {
    link.cancelCode();
    return reply.code(204).send();
  });

  app.post("/api/link/pair", async (req, reply) => {
    const { address, code } = pairBody.parse(req.body);
    const machine = await link.pair(actor, address, code);
    return reply.code(201).send(machine);
  });

  app.delete("/api/link/machines/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await link.unpair(actor, id);
    return reply.code(204).send();
  });

  // Asked again now, bypassing the 30 s cache. A machine that does not answer, refuses or sends something unreadable
  // is `online: false` with the values it last sent; nothing from its reply reaches this answer.
  app.get("/api/link/machines/:id/capacity", async (req) => {
    const { id } = idParams.parse(req.params);
    return deps.capacity.capacityOf(id, { fresh: true });
  });
}
