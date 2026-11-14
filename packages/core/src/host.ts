/**
 * The entry a host process (the desktop app) imports. It must stay free of the database, the secret stores, the
 * server and every native module, so that it loads in any Node or Electron runtime.
 */
export { allowlistedEnv } from "./agents/child-env.js";
