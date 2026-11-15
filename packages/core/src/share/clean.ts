import { homedir, userInfo } from "node:os";
import type { ShareSnapshot } from "@theterminal/shared";
import { redact, truncate } from "../agents/redact.js";
import { pathScrubber, usernameScrubber } from "../agents/scrub-paths.js";

/** An email address. Global: use with `replace`, or reset `lastIndex` before `exec`. */
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Cleans one text for a share page and caps it at `max` characters. */
export type ShareClean = (s: string, max: number) => string;
export type CleanerDeps = { dataDir: string; secrets: () => string[]; username?: string; home?: string };

/** The longest any one text on a share page may be. */
export const SHARE_TEXT_MAX = 4000;

function osUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return ""; // no passwd entry: nothing to scrub
  }
}

/**
 * The share page's cleaner: secrets redacted, email addresses replaced with `[email]` (before the username scrub,
 * so an address whose local part is the username goes whole, domain included), the data folder and the home
 * directory scrubbed to `<data>` and `~`, the username to `<user>`, redacted again (a scrub can reveal a secret
 * pattern), then cut at `max`. Redaction always runs before the cut, so a secret is never left half-present.
 * The secrets are read on every call, so a connection added after the cleaner was built is still covered.
 */
export function shareCleaner(deps: CleanerDeps): ShareClean {
  const paths = pathScrubber([
    [deps.dataDir, "<data>"],
    [deps.home ?? homedir(), "~"],
  ]);
  const user = usernameScrubber(deps.username ?? osUsername());
  // Paths first, so a home directory becomes `~` rather than a path ending in `<user>`.
  const scrub = (s: string) => user(paths(s));
  const emails = (s: string) => s.replace(EMAIL, "[email]");
  return (s, max) => {
    const secrets = deps.secrets();
    return truncate(redact(scrub(emails(redact(s, secrets))), secrets), max);
  };
}

function walk(value: unknown, clean: ShareClean): unknown {
  if (typeof value === "string") return clean(value, SHARE_TEXT_MAX);
  if (Array.isArray(value)) return value.map((v) => walk(v, clean));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, clean);
    return out;
  }
  return value;
}

/**
 * A copy of the snapshot with every string (object field or array element, depth first) cleaned and capped at
 * SHARE_TEXT_MAX. Keys are left as they are; numbers, booleans and nulls are untouched. Ids, dates, `day`, `time`
 * and `hash12` are strings too and come out unchanged, since they hold nothing the cleaner rewrites.
 */
export function cleanSnapshot(s: ShareSnapshot, clean: ShareClean): ShareSnapshot {
  return walk(s, clean) as ShareSnapshot;
}

export class ShareNotCleanError extends Error {
  constructor() {
    super("the share page could not be proven clean");
    this.name = "ShareNotCleanError";
  }
}

/** The last check on the page's bytes: cleaning it again must change nothing; otherwise it is refused. */
export function assertClean(html: string, clean: ShareClean): void {
  if (clean(html, Infinity) !== html) throw new ShareNotCleanError();
}
