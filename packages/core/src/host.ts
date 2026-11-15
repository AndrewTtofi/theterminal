/**
 * The entry a host process (the desktop app) imports. It must stay free of the database, the secret stores, the
 * server and every native module, so that it loads in any Node or Electron runtime.
 */
export { allowlistedEnv } from "./agents/child-env.js";

/** The first IPC message a server child sends its host once it listens. `url` carries the bootstrap token. */
export type ReadyMessage = { type: "ready"; url: string; loopbackUrl: string; port: number };

/** The messages a host sends its server child. */
export type HostMessage = { type: "shutdown" };
