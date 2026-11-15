import { homedir, userInfo } from "node:os";
import { z } from "zod";
import { redact } from "../agents/redact.js";
import { pathScrubber, usernameScrubber, type Scrub } from "../agents/scrub-paths.js";

/**
 * Never carries the text. `explanation` is a fixed sentence naming the field to change, set when the secret sits in
 * something already recorded (the project name, an earlier answer) rather than in the text just sent.
 */
export class SecretInTextError extends Error {
  constructor(public readonly explanation?: string) {
    super(explanation ?? "text contains a secret");
    this.name = "SecretInTextError";
  }
}

/** How free text the Owner writes is made fit for the permanent ledger. */
export type RecordedTextDeps = {
  /** Scrubbed to `<data>` in recorded text when given. */
  dataDir?: string;
  /** The OS username scrubbed to `<user>`; defaults to the current user's. */
  username?: string;
  /** Extra values refused as secrets (the session token, stored connection secrets), read on every check. */
  secrets?: () => string[];
};

function osUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return ""; // no passwd entry: nothing to scrub
  }
}

/**
 * Free text bound for the ledger: scrubbed of local paths and the username, and refused when it holds a secret.
 * Shared by every service that records what the Owner writes (the intake, gate waivers).
 */
export class RecordedText {
  readonly scrub: Scrub;
  private readonly secrets: () => string[];

  constructor(deps: RecordedTextDeps = {}) {
    const dirs: [string, string][] = [[homedir(), "~"]];
    if (deps.dataDir !== undefined) dirs.unshift([deps.dataDir, "<data>"]);
    const paths = pathScrubber(dirs);
    const user = usernameScrubber(deps.username ?? osUsername());
    // Paths first, so a home directory becomes `~` rather than a path ending in `<user>`.
    this.scrub = (s) => user(paths(s));
    this.secrets = deps.secrets ?? (() => []);
  }

  /** Scrubbed, then refused when redaction would change it. The error never carries the text. */
  clean(text: string): string {
    if (!this.passes(text)) throw new SecretInTextError();
    return this.scrub(text);
  }

  /**
   * True when neither the text as given nor its scrubbed form holds a secret. Both are checked, as the runner does:
   * a secret containing the username or a home path would be rewritten by the scrubber and then miss the exact match.
   */
  passes(text: string): boolean {
    const secrets = this.secrets();
    const scrubbed = this.scrub(text);
    return redact(text, secrets) === text && redact(scrubbed, secrets) === scrubbed;
  }

  /** The text with every secret replaced, for showing what could not be recorded. */
  redacted(text: string): string {
    return redact(text, this.secrets());
  }

  /** A free text trimmed, length-checked as given, then cleaned and checked again (a placeholder may lengthen it). */
  text(field: string, value: string, limits: { min: number; max: number }): string {
    const schema = z.object({ [field]: z.string().trim().min(limits.min).max(limits.max) });
    const trimmed = schema.parse({ [field]: value })[field] as string;
    return schema.parse({ [field]: this.clean(trimmed) })[field] as string;
  }
}
