/**
 * The entry a host process (the desktop app) imports. It must stay free of the database, the secret stores, the
 * server and every native module, so that it loads in any Node or Electron runtime.
 */
export { allowlistedEnv } from "./agents/child-env.js";

/** The first IPC message a server child sends its host once it listens. `url` carries the bootstrap token. */
export type ReadyMessage = { type: "ready"; url: string; loopbackUrl: string; port: number };

/**
 * The server child asks its host to show the system folder picker (Owner only, on the local listener). The host
 * answers with a `picked_folder` carrying the same `id`. `id` is 1–64 letters, digits, `-` or `_`.
 */
export type PickFolderMessage = { type: "pick_folder"; id: string };

/** The messages a server child sends its host. */
export type ChildMessage = ReadyMessage | PickFolderMessage;

/**
 * The host's answer to a `pick_folder`: the chosen folder's absolute path, or null when the person canceled, there is
 * no window, or the dialog failed.
 */
export type PickedFolderMessage = { type: "picked_folder"; id: string; path: string | null };

/** The messages a host sends its server child. */
export type HostMessage = { type: "shutdown" } | PickedFolderMessage;
