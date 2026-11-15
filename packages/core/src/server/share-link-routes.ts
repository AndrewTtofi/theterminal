import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ShareAddress, ShareLinkManager } from "../share/link-server.js";
import { actorOf, needs } from "./auth.js";

export type ShareLinkRouteDeps = {
  links: ShareLinkManager;
  /** The addresses a link may bind, offered fresh on each request (interfaces come and go). */
  addresses: () => ShareAddress[];
};

// Shapes only: the manager checks the address against what is offered and the duration against TTL_MINUTES.
const createBody = z.object({ address: z.string().min(1).max(64), ttlMinutes: z.number().int() }).strict();
const listQuery = z.object({ projectId: z.string().min(1).max(200).optional() }).strict();

type Params = { Params: { id: string } };

/**
 * The share links: the addresses on offer, creating a link for a confirmed snapshot, listing and revoking links.
 * Behind the default-deny auth (session and host); errors are mapped by the handler in routes.ts. The link's url,
 * which holds its token, is returned once by the create and never again.
 */
export function registerShareLinkRoutes(app: FastifyInstance, deps: ShareLinkRouteDeps): void {
  const { links, addresses } = deps;

  // The addresses are LAN detail and creating or revoking a link is what leaves the machine: the Owner's.
  app.get("/api/share/addresses", needs("owner"), async () => addresses());

  app.post<Params>("/api/share/snapshots/:id/links", needs("owner"), async (req, reply) => {
    const { address, ttlMinutes } = createBody.parse(req.body);
    const { link, url } = await links.create(actorOf(req), req.params.id, address, ttlMinutes);
    return reply.code(201).send({ link, url });
  });

  app.get("/api/share/links", needs("viewer"), async (req) => links.list(listQuery.parse(req.query).projectId));

  app.delete<Params>("/api/share/links/:id", needs("owner"), async (req, reply) => {
    await links.revoke(actorOf(req), req.params.id);
    return reply.code(204).send();
  });
}
