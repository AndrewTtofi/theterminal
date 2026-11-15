// The share view's public surface. Tasks that add share modules add their export lines here, not to core's index.
export {
  EMAIL, SHARE_TEXT_MAX, ShareNotCleanError, assertClean, cleanSnapshot, shareCleaner,
} from "./clean.js";
export type { CleanerDeps, ShareClean } from "./clean.js";
export { PROGRAM_LABELS, techStack } from "./stack.js";
export type { StackDeps } from "./stack.js";
export { SHARE_LIMITS, buildSnapshot, evidenceOf } from "./snapshot.js";
export type { SnapshotDeps } from "./snapshot.js";
export {
  countActiveShareLinks, getShareSnapshot, listProjectGateDecisions, listShareLinks, listShareSnapshots,
} from "../events/projections.js";
export * from "./render.js";
export * from "./errors.js";
export { MAX_PREVIEWS, MAX_SHARE_BYTES, PREVIEW_TTL_MS, ShareService } from "./service.js";
export type { Preview, ShareServiceDeps } from "./service.js";
export { projectDigests } from "./digests.js";
export * from "./link-server.js";
