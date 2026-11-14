import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { PROVIDERS, type AuthMode, type Provider } from "@theterminal/shared";
import { buildChildEnv } from "../agents/child-env.js";
import { redact } from "../agents/redact.js";
import { pathScrubber, usernameScrubber, type Scrub } from "../agents/scrub-paths.js";

/**
 * Signing in to the Owner's own subscriptions by starting each provider's official login command. The Terminal
 * never reads, stores or relays the login: the browser talks to the provider and the CLI saves its own credentials.
 * Of what the CLI prints, only lines on an allowlist (links on the provider's own domains, device codes, status
 * words) leave this module, each after redaction and path scrubbing. Nothing is ever written to disk here.
 */

export type SignInState = "running" | "succeeded" | "failed";
export type SignInView = { state: SignInState; lines: string[] };
export type SignInStatus = "signed_in" | "signed_out" | "unknown" | "not_installed";

/** A program to run: a native binary, or Node with a script. Never run through a shell. */
export type CliCommand = { file: string; args: string[] };

/** A sign-in for this provider is already running. */
export class SignInRunningError extends Error {
  constructor() {
    super("a sign-in for this provider is already running");
    this.name = "SignInRunningError";
  }
}

/** The provider's CLI has no login that works without a terminal. */
export class TerminalRequiredError extends Error {
  constructor() {
    super("this provider signs in only in a terminal");
    this.name = "TerminalRequiredError";
  }
}

/** The provider's CLI is neither bundled nor on PATH. */
export class CliNotInstalledError extends Error {
  constructor() {
    super("the provider's CLI is not installed");
    this.name = "CliNotInstalledError";
  }
}

type ProviderSpec = {
  /** The login mode whose child environment the login runs in. */
  mode: AuthMode;
  /** The official login command, or null when the CLI signs in only in a terminal. */
  login: string[] | null;
  /** Exits 0 when signed in and 1 when not; its output is never read. Null when the CLI has no such command. */
  status: string[] | null;
  /** The domains (and their subdomains) whose https links may be shown. */
  domains: string[];
  /** Links that must not be shown although they are on the provider's domains. */
  hidden?: (url: URL) => boolean;
};

/**
 * Verified against the bundled CLIs (Claude Code 2.1.323, Codex CLI 0.169.0, Gemini CLI 0.68.0).
 * - Claude Code: `claude auth login --claudeai` opens the browser and completes through a local callback; the link
 *   it prints for a browser that did not open is the paste-the-code flow (`code=true`), which needs a terminal, so
 *   it is hidden. `claude auth status` exits 0 signed in, 1 signed out.
 * - Codex: `codex login` opens the browser and completes through a local callback; it prints the same link for a
 *   browser that did not open. `codex login status` exits 0 signed in, 1 signed out.
 * - Gemini CLI has no login or status command: it signs in only inside its interactive terminal UI.
 */
const SPECS: Record<Provider, ProviderSpec> = {
  claude: {
    mode: "subscription",
    login: ["auth", "login", "--claudeai"],
    status: ["auth", "status"],
    domains: ["claude.com", "claude.ai", "anthropic.com"],
    hidden: (url) => url.searchParams.get("code") === "true",
  },
  codex: { mode: "chatgpt", login: ["login"], status: ["login", "status"], domains: ["openai.com", "chatgpt.com"] },
  gemini: { mode: "google", login: null, status: null, domains: ["google.com"] },
};

const MAX_OUTPUT = 64 * 1024;
const MAX_LINES = 20;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 2_000;

// OSC sequences (hyperlinks: ESC ] 8 ; ; URL BEL text ESC ] 8 ; ; BEL) keep their payload as separate text.
const OSC_START = /\x1b\][0-9]*;[^;\x07\x1b]*;?/g;
const OSC_END = /\x07|\x1b\\/g;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

const DEVICE_CODE = /^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/;
const STATUS_WORDS = /^(?:successfully logged in|login successful|logged in|signed in|not logged in|login failed|login cancelled)[.!]?$/i;
// An https link as printed: host, optional path and query, and nothing that could hold an account (`@`), a
// redaction marker or a placeholder (`[`, `]`, `<`, `>`).
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+(?:[/?#][A-Za-z0-9\-._~%!$&'()*+,;=:/?#]*)?$/;

function safeUrl(provider: Provider, token: string): string | null {
  const trimmed = token.replace(/[.,;:!)]+$/, "");
  if (!SAFE_URL.test(trimmed)) return null;
  let decoded: string;
  let url: URL;
  try {
    decoded = decodeURIComponent(trimmed);
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (decoded.includes("@") || decoded.includes("REDACTED")) return null;
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const spec = SPECS[provider];
  if (!spec.domains.some((d) => host === d || host.endsWith(`.${d}`))) return null;
  if (spec.hidden?.(url)) return null;
  return trimmed;
}

/**
 * The lines of `text` that may be shown to the Owner: links on `provider`'s own https domains (the link alone,
 * never the text around it), device codes and fixed status words. Each line is passed through `clean` (redaction
 * and path scrubbing) before it is judged, so what is shown is always the cleaned form.
 */
export function signInLines(provider: Provider, text: string, clean: Scrub): string[] {
  const plain = text.replace(OSC_START, " ").replace(OSC_END, " ").replace(CSI, "").replace(/\r/g, "\n");
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const raw of plain.split("\n")) {
    const line = clean(raw.replace(CONTROL, "")).trim();
    if (line === "") continue;
    if (DEVICE_CODE.test(line) || STATUS_WORDS.test(line)) {
      add(line);
      continue;
    }
    for (const token of line.split(/\s+/)) {
      if (!token.startsWith("https://")) continue;
      const url = safeUrl(provider, token);
      if (url !== null) add(url);
    }
  }
  return out;
}

/** Test-only: under THETERMINAL_FAKE_AGENT=1, the fixture login script variable. Empty otherwise. */
export function fakeLoginEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const v = base.THETERMINAL_FAKE_LOGIN;
  return base.THETERMINAL_FAKE_AGENT === "1" && v !== undefined ? { THETERMINAL_FAKE_LOGIN: v } : {};
}

export type SignInManagerDeps = {
  /** The data directory that holds the shared empty git config (see buildChildEnv). */
  dataDir: string;
  /** Where each provider's CLI is: bundled first, then PATH. Null when it is not installed. */
  program: (p: Provider) => CliCommand | null;
  /** The CLI home folder of the provider's connection, so the login lands where runs look for it. */
  cliHome?: (p: Provider) => string | undefined;
  /** Test-only fixture variables, merged after the allowlisted environment. */
  extraEnv?: NodeJS.ProcessEnv;
  /** Extra values to redact (the server token, stored secrets). Read on every clean. */
  secrets?: () => string[];
  /** Records the outcome (`connection.signin`). Not called for a sign-in the Owner cancelled or shutdown stopped. */
  record: (provider: Provider, ok: boolean) => void;
  /** How long a sign-in may run before it is killed. Default 10 minutes. */
  timeoutMs?: number;
  newId?: () => string;
};

type Session = {
  id: string;
  provider: Provider;
  state: SignInState;
  lines: string[];
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  exited: Promise<void>;
  /** Stopped by the Owner or by shutdown: nothing is recorded. */
  cancelled: boolean;
};

/** Runs at most one login per provider, keeps the last one of each for its result, and kills them on demand. */
export class SignInManager {
  private readonly sessions = new Map<string, Session>();
  private readonly statusChildren = new Set<ChildProcess>();
  private readonly clean: Scrub;
  private shuttingDown = false;

  constructor(private readonly deps: SignInManagerDeps) {
    const scrubPaths = pathScrubber([[deps.dataDir, "<data>"], [homedir(), "~"]]);
    let username = "";
    try {
      username = userInfo().username;
    } catch {
      // No user name to scrub.
    }
    const scrubUser = usernameScrubber(username);
    this.clean = (s) => scrubUser(scrubPaths(redact(s, deps.secrets?.() ?? [])));
  }

  private env(p: Provider): NodeJS.ProcessEnv {
    const cliHome = this.deps.cliHome?.(p);
    return {
      ...buildChildEnv(p, SPECS[p].mode, { dataDir: this.deps.dataDir, ...(cliHome && { cliHome }) }),
      ...this.deps.extraEnv,
    };
  }

  /** Starts `p`'s login command. Throws when one is running, the CLI is missing, or it needs a terminal. */
  start(p: Provider): { id: string } {
    if (this.shuttingDown) throw new Error("shutting down");
    const spec = SPECS[p];
    if (spec.login === null) throw new TerminalRequiredError();
    for (const s of this.sessions.values()) {
      if (s.provider === p && s.state === "running") throw new SignInRunningError();
    }
    const program = this.deps.program(p);
    if (program === null) throw new CliNotInstalledError();
    const env = this.env(p); // throws when the shared git config was modified: nothing starts

    for (const [id, s] of this.sessions) if (s.provider === p) this.sessions.delete(id);
    const id = (this.deps.newId ?? randomUUID)();
    let resolveExited!: () => void;
    const session: Session = {
      id, provider: p, state: "running", lines: [], child: null, timer: null, cancelled: false,
      exited: new Promise((r) => (resolveExited = r)),
    };
    this.sessions.set(id, session);

    let total = 0;
    const partial = { out: "", err: "" };
    const take = (key: "out" | "err", chunk: string, final = false) => {
      if (total >= MAX_OUTPUT) return;
      const piece = chunk.slice(0, MAX_OUTPUT - total);
      total += piece.length;
      const text = partial[key] + piece;
      const cut = final ? text.length : text.lastIndexOf("\n") + 1;
      partial[key] = text.slice(cut);
      for (const line of signInLines(p, text.slice(0, cut), this.clean)) {
        if (session.lines.length < MAX_LINES && !session.lines.includes(line)) session.lines.push(line);
      }
    };

    const finish = (ok: boolean) => {
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      take("out", "", true);
      take("err", "", true);
      if (session.state === "running") session.state = ok ? "succeeded" : "failed";
      session.child = null;
      resolveExited();
      if (this.shuttingDown || session.cancelled) return;
      try {
        this.deps.record(p, session.state === "succeeded");
      } catch {
        // A read-only ledger: the outcome is still shown.
      }
    };

    let child: ChildProcess;
    try {
      child = execFile(
        program.file,
        [...program.args, ...spec.login],
        { cwd: this.deps.dataDir, env, encoding: "utf8", maxBuffer: MAX_OUTPUT, windowsHide: true, shell: false },
        (err) => finish(err === null),
      );
    } catch {
      finish(false);
      return { id };
    }
    session.child = child;
    child.stdin?.end(); // nothing is ever sent to the login
    child.stdout?.setEncoding("utf8").on("data", (c: string) => take("out", c));
    child.stderr?.setEncoding("utf8").on("data", (c: string) => take("err", c));
    session.timer = setTimeout(() => this.stop(session), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { id };
  }

  get(id: string): SignInView | null {
    const s = this.sessions.get(id);
    return s ? { state: s.state, lines: [...s.lines] } : null;
  }

  /** Kills a running sign-in; false for an unknown id. */
  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.state === "running") s.cancelled = true;
    this.stop(s);
    return true;
  }

  private stop(s: Session): void {
    if (s.state !== "running") return;
    s.state = "failed";
    kill(s.child);
  }

  /** Each provider's sign-in state, from its CLI's status command (exit code only; its output is never read). */
  async status(): Promise<Record<Provider, SignInStatus>> {
    const entries = await Promise.all(PROVIDERS.map(async (p) => [p, await this.statusOf(p)] as const));
    return Object.fromEntries(entries) as Record<Provider, SignInStatus>;
  }

  private statusOf(p: Provider): Promise<SignInStatus> {
    const program = this.deps.program(p);
    if (program === null) return Promise.resolve("not_installed");
    const args = SPECS[p].status;
    if (args === null || this.shuttingDown) return Promise.resolve("unknown");
    let env: NodeJS.ProcessEnv;
    try {
      env = this.env(p);
    } catch {
      return Promise.resolve("unknown");
    }
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = execFile(
          program.file,
          [...program.args, ...args],
          { cwd: this.deps.dataDir, env, maxBuffer: MAX_OUTPUT, timeout: STATUS_TIMEOUT_MS, windowsHide: true, shell: false },
          (err) => {
            this.statusChildren.delete(child);
            if (err === null) return resolve("signed_in");
            const code = (err as NodeJS.ErrnoException).code as unknown;
            if (code === "ENOENT") return resolve("not_installed");
            resolve(code === 1 && !err.killed ? "signed_out" : "unknown");
          },
        );
      } catch {
        return resolve("unknown");
      }
      child.stdin?.end();
      this.statusChildren.add(child);
    });
  }

  /** Kills every login and status check, and waits (briefly) for the logins to exit. Nothing more is recorded. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const waits: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (s.state === "running" || s.child) {
        this.stop(s);
        kill(s.child);
        waits.push(s.exited);
      }
    }
    for (const c of this.statusChildren) kill(c);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(waits), new Promise((r) => (timer = setTimeout(r, KILL_GRACE_MS + 500)))]);
    clearTimeout(timer);
  }
}

/** SIGTERM, then SIGKILL if the process is still there after a grace period. */
function kill(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  force.unref();
  child.once("exit", () => clearTimeout(force));
}
