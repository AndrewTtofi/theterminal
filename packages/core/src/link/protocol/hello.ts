import type { FastifyInstance } from "fastify";
import { LINK_PROTOCOL_VERSION, helloResponseSchema } from "@theterminal/shared";
import type { LinkProtocolDeps } from "../protocol-routes.js";

/** `GET /link/v1/hello`: who this computer is, to a paired machine only. */
export function registerHello(app: FastifyInstance, deps: LinkProtocolDeps): void {
  app.get("/link/v1/hello", async (request, reply) => {
    // The listener's hook already refused an unknown key; checked again so this route never answers one.
    if (request.linkPeer === null) return reply.code(403).send({ error: "unknown_machine" });
    const self = deps.link.self();
    if (self === null) return reply.code(503).send({ error: "identity_unavailable" });
    return helloResponseSchema.parse({ v: LINK_PROTOCOL_VERSION, machineId: self.machineId, name: self.name, linking: true });
  });
}
