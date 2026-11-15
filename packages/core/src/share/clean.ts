import { homedir, userInfo } from "node:os";
import { OWNER_ID, ROLES, requirementLabel, type ShareSnapshot } from "@theterminal/shared";
import { redact, truncate } from "../agents/redact.js";
import { pathScrubber, usernameScrubber } from "../agents/scrub-paths.js";

/** An email address. Global: use with `replace`, or reset `lastIndex` before `exec`. */
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** The share page's cleaner. */
export type ShareClean = {
  /** Cleans one free text for the page (secrets, emails, paths, the username) and caps it at `max` characters. */
  text: (s: string, max: number) => string;
  /**
   * Cleans the page's markup: secrets, email addresses and paths, never cut. The username is not scrubbed here:
   * the template's own words (`Owner`, `Open`, `root`, the CSP's `data:`) are not content, and every text from
   * the snapshot has already been through `text`.
   */
  markup: (html: string) => string;
};
export type CleanerDeps = { dataDir: string; secrets: () => string[]; username?: string; home?: string };

/** The longest any one text on a share page may be. */
export const SHARE_TEXT_MAX = 4000;

const DATA = "<data>";
const USER = "<user>";

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
 * The username scrub leaves `<user>` and `<data>` alone, so cleaning is idempotent whatever the username is.
 * The secrets are read on every call, so a connection added after the cleaner was built is still covered.
 */
export function shareCleaner(deps: CleanerDeps): ShareClean {
  const paths = pathScrubber([
    [deps.dataDir, DATA],
    [deps.home ?? homedir(), "~"],
  ]);
  const user = usernameScrubber(deps.username ?? osUsername(), { keep: [USER, DATA] });
  const emails = (s: string) => s.replace(EMAIL, "[email]");
  return {
    // Paths first, so a home directory becomes `~` rather than a path ending in `<user>`.
    text: (s, max) => {
      const secrets = deps.secrets();
      return truncate(redact(user(paths(emails(redact(s, secrets)))), secrets), max);
    },
    markup: (html) => {
      const secrets = deps.secrets();
      return redact(paths(emails(redact(html, secrets))), secrets);
    },
  };
}

/** What the page calls someone no longer on record. */
export const FORMER_COLLABORATOR = "a former collaborator";

/**
 * The words the page uses for people when no one chose them: the Owner's name until renamed, the phrase for someone
 * not on record, and each role requirement (`a reviewer or above`, `the Owner`). Fixed copy, like the labels below,
 * so a username that is one of those words never corrupts them; any other name is cleaned as free text.
 */
const FIXED_PEOPLE_WORDS: ReadonlySet<string> = new Set([
  "Owner", FORMER_COLLABORATOR, ...ROLES.map((role) => requirementLabel({ role }, () => OWNER_ID)),
]);

/**
 * A copy of the snapshot with every free-text field cleaned and capped at SHARE_TEXT_MAX: the project's name and
 * pitch, people's names (the owner, who decided, who may answer), the summary and idea, stack choices and reasons,
 * headlines, card titles, decision reasons, gate details,
 * digest summaries and items, prompts and hardware names. Enums, ids, dates, numbers and fixed labels (states,
 * stages, adapters, kinds, gate titles, adapter labels, the hidden lines) are not text anyone wrote and come out
 * exactly as they went in, so a username that is also one of those words never corrupts them.
 */
export function cleanSnapshot(s: ShareSnapshot, clean: ShareClean): ShareSnapshot {
  const t = (x: string) => clean.text(x, SHARE_TEXT_MAX);
  const opt = (x: string | null) => (x === null ? null : t(x));
  const who = (x: string) => (FIXED_PEOPLE_WORDS.has(x) ? x : t(x));
  return {
    ...s,
    project: { ...s.project, name: t(s.project.name), pitch: t(s.project.pitch) },
    owner: who(s.owner),
    summary: opt(s.summary),
    idea: opt(s.idea),
    stack: s.stack.map((r) => ({ ...r, choice: t(r.choice), why: t(r.why) })),
    waiting: s.waiting.map((w) => ({ ...w, headline: t(w.headline), cardTitle: opt(w.cardTitle), assignee: who(w.assignee) })),
    decisions: s.decisions.map((d) => ({ ...d, headline: t(d.headline), reason: opt(d.reason), by: who(d.by) })),
    readiness: s.readiness.map((r) => ({ ...r, detail: opt(r.detail), cardTitle: opt(r.cardTitle) })),
    digests: s.digests.map((d) => ({ ...d, summary: t(d.summary), items: d.items.map((i) => ({ ...i, headline: t(i.headline) })) })),
    asks: s.asks.map((a) => ({ ...a, cardTitle: opt(a.cardTitle), prompt: t(a.prompt) })),
    hardware: s.hardware === null ? null : { ...s.hardware, cpu: opt(s.hardware.cpu), gpu: opt(s.hardware.gpu) },
  };
}

export class ShareNotCleanError extends Error {
  constructor() {
    super("the share page could not be proven clean");
    this.name = "ShareNotCleanError";
  }
}

/**
 * The last check on a page: cleaning its markup again (secrets, emails, paths) must change nothing, and, when the
 * snapshot it was rendered from is given, cleaning that snapshot's free text again (the username included) must
 * change nothing either. Otherwise the page is refused. A saved page is checked by its markup alone: its snapshot
 * was checked when it was previewed.
 */
export function assertClean(html: string, clean: ShareClean, snapshot?: ShareSnapshot): void {
  if (clean.markup(html) !== html) throw new ShareNotCleanError();
  if (snapshot && JSON.stringify(cleanSnapshot(snapshot, clean)) !== JSON.stringify(snapshot)) throw new ShareNotCleanError();
}
