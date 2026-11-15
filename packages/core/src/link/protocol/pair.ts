import type { TLSSocket } from "node:tls";
import type { FastifyInstance } from "fastify";
import type { LinkProtocolDeps } from "../protocol-routes.js";
import { PAIR_PATH } from "../listener.js";

/** The client certificate's SPKI DER, or null. */
function clientSpki(socket: TLSSocket): Buffer | null {
  try {
    const cert = socket.getPeerX509Certificate();
    return cert ? cert.publicKey.export({ type: "spki", format: "der" }) : null;
  } catch {
    return null;
  }
}

/**
 * `POST /link/v1/pair`: the one route an unknown key may reach, and only while this computer shows a code.
 * 200 with this side's proof | 404 `no_pairing` | 403 `pairing_rejected` | 400 `self_pairing` or `invalid_input`.
 */
export function registerPair(app: FastifyInstance, deps: LinkProtocolDeps): void {
  app.post(PAIR_PATH, async (request, reply) => {
    const socket = request.raw.socket as TLSSocket;
    const peerSpki = clientSpki(socket);
    if (peerSpki === null) return reply.code(403).send({ error: "unknown_machine" });
    const out = deps.link.acceptPair({ body: request.body, socket, peerSpki });
    return reply.code(out.status).send(out.body);
  });
}
