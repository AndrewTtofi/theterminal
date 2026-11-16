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

/**
 * One device view of a website preview: its rectangle in CSS pixels of the app window (main multiplies it by the
 * window's zoom factor), the emulated viewport and scale, and the user agent to set, if any.
 */
export type PreviewDeviceView = {
  device: string;
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  scale: number;
  mobile: boolean;
  userAgent: string | null;
};

/**
 * The server child asks its host to show, hide, reload or close the device views of one preview, laid over the
 * Preview tab's frames. The host answers with a `preview_views_done` carrying the same `id`. `origin` is the
 * preview's own loopback origin (`http://127.0.0.1:<port>` or `http://[::1]:<port>`), and there are at most 4 views.
 */
export type PreviewViewsMessage = {
  type: "preview_views";
  id: string;
  previewId: string;
  origin: string;
  action: "show" | "hide" | "reload" | "close";
  views: PreviewDeviceView[];
};

/** The server child asks its host for a PNG screenshot of each device view of one preview (`preview_captured`). */
export type PreviewCaptureMessage = { type: "preview_capture"; id: string; previewId: string };

/** The messages a server child sends its host. */
export type ChildMessage = ReadyMessage | PickFolderMessage | PreviewViewsMessage | PreviewCaptureMessage;

/**
 * The host's answer to a `pick_folder`: the chosen folder's absolute path, or null when the person canceled, there is
 * no window, or the dialog failed.
 */
export type PickedFolderMessage = { type: "picked_folder"; id: string; path: string | null };

/** The host's answer to a `preview_views`: whether it applied the change. */
export type PreviewViewsDoneMessage = { type: "preview_views_done"; id: string; ok: boolean };

/** The host's answer to a `preview_capture`: one base64 PNG per device view (none when there is no view). */
export type PreviewCapturedMessage = { type: "preview_captured"; id: string; shots: { device: string; png: string }[] };

/** The messages a host sends its server child. */
export type HostMessage = { type: "shutdown" } | PickedFolderMessage | PreviewViewsDoneMessage | PreviewCapturedMessage;
