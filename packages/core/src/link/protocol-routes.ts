import type { FastifyInstance } from "fastify";
import type { LinkService } from "./service.js";
import { registerHello } from "./protocol/hello.js";

/** What the `/link/v1/*` routes use; grows with pairing, capacity and runs. */
export type LinkProtocolDeps = { link: LinkService };

/** Every `/link/v1/*` route, on the link listener only. Each area registers from its own module under `protocol/`. */
export function registerLinkProtocolRoutes(app: FastifyInstance, deps: LinkProtocolDeps): void {
  registerHello(app, deps);
}
