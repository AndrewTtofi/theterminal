import type { FastifyInstance } from "fastify";
import type { LinkService } from "./service.js";
import { registerHello } from "./protocol/hello.js";
import { registerPair } from "./protocol/pair.js";
import { registerCapacity, type CapacityProtocolDeps } from "./protocol/capacity.js";
import { registerRuns } from "./protocol/runs.js";
import type { LinkWorker } from "./worker.js";

/** What the `/link/v1/*` routes use; grows with pairing, capacity and runs. */
export type LinkProtocolDeps = {
  link: LinkService;
  /** What this computer tells a paired machine about itself; without it `/link/v1/capacity` is not offered. */
  capacity?: CapacityProtocolDeps;
  /** Serves runs paired machines ask this computer to execute; without it the `/link/v1/runs/*` routes are not offered. */
  worker?: LinkWorker;
};

/** Every `/link/v1/*` route, on the link listener only. Each area registers from its own module under `protocol/`. */
export function registerLinkProtocolRoutes(app: FastifyInstance, deps: LinkProtocolDeps): void {
  registerHello(app, deps);
  registerPair(app, deps);
  registerCapacity(app, deps);
  registerRuns(app, deps);
}
