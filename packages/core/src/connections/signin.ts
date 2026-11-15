import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { PROVIDERS, isRestrictedMode, type Actor, type AuthMode, type Provider } from "@theterminal/shared";
import { buildChildEnv } from "../agents/child-env.js";
import { RestrictedSignInError } from "../agents/settings.js";
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

/** The connection's CLI home folder is not an absolute path (the service refuses one too; this is a second check). */
export class InvalidCliHomeError extends Error {
  constructor() {
    super("The CLI home folder must be an absolute path");
    this.name = "InvalidCliHomeError";
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
  /**
   * Records the outcome (`connection.signin`) as the person who started the login. Not called for a sign-in the Owner
   * cancelled or shutdown stopped.
   */
  record: (provider: Provider, ok: boolean, actor: Actor) => void;
  /**
   * The restricted sign-in switch (see ProviderSettings). Off by default: a login whose mode is restricted (Claude's
   * subscription, Gemini's Google sign-in) is refused with RestrictedSignInError before anything starts.
   */
  restrictedSignIn?: boolean;
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
  /** Who started it: the outcome is recorded as theirs. */
  actor: Actor;
};

/** Runs at most one login per provider, keeps the last one of each for its result, and kills them on demand. */
export class SignInManager {
  private readonly sessions = new Map<string, Session>();
  private readonly statusChildren = new Set<ChildProcess>();
  /** The status check under way per provider, shared by concurrent requests. */
  private readonly statusChecks = new Map<Provider, Promise<SignInStatus>>();
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
    // A relative folder would resolve against our working directory: refuse it rather than guess.
    if (cliHome !== undefined && cliHome !== "" && !isAbsolute(cliHome)) throw new InvalidCliHomeError();
    return {
      ...buildChildEnv(p, SPECS[p].mode, { dataDir: this.deps.dataDir, ...(cliHome && { cliHome }) }),
      ...this.deps.extraEnv,
    };
  }

  /**
   * Starts `p`'s login command for `actor`. Throws when its mode is restricted and the switch is off, one is running,
   * the CLI is missing, or it needs a terminal.
   */
  start(p: Provider, actor: Actor): { id: string } {
    if (this.shuttingDown) throw new Error("shutting down");
    const spec = SPECS[p];
    if (this.deps.restrictedSignIn !== true && isRestrictedMode(p, spec.mode)) throw new RestrictedSignInError(p);
    if (spec.login === null) throw new TerminalRequiredError();
    for (const s of this.sessions.values()) {
      if (s.provider === p && s.state === "running") throw new SignInRunningError();
    }
    const program = this.deps.program(p);
    if (program === null) throw new CliNotInstalledError();
    const env = this.env(p); // throws for a relative CLI home or a modified shared git config: nothing starts

    // A succeeded sign-in stays readable (a panel may still be polling it) until this one has finished.
    for (const [id, s] of this.sessions) if (s.provider === p && s.state !== "succeeded") this.sessions.delete(id);
    const id = (this.deps.newId ?? randomUUID)();
    let resolveExited!: () => void;
    const session: Session = {
      id, provider: p, state: "running", lines: [], child: null, timer: null, cancelled: false, actor,
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
      this.dropOthers(session);
      resolveExited();
      if (this.shuttingDown || session.cancelled) return;
      try {
        this.deps.record(p, session.state === "succeeded", session.actor);
      } catch {
        // A read-only ledger: the outcome is still shown.
      }
    };

    const child = run(program, spec.login, this.deps.dataDir, env, (code) => finish(code === 0));
    if (child === null) return { id };
    session.child = child;
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
    this.dropOthers(s);
    kill(s.child);
  }

  /** `finished` has its result; the provider's earlier sessions (a succeeded one kept for polling) are replaced by it. */
  private dropOthers(finished: Session): void {
    for (const [id, s] of this.sessions) if (s.provider === finished.provider && s !== finished) this.sessions.delete(id);
  }

  /** Each provider's sign-in state, from its CLI's status command (exit code only; its output is never read). */
  async status(): Promise<Record<Provider, SignInStatus>> {
    const entries = await Promise.all(PROVIDERS.map(async (p) => [p, await this.statusOf(p)] as const));
    return Object.fromEntries(entries) as Record<Provider, SignInStatus>;
  }

  private statusOf(p: Provider): Promise<SignInStatus> {
    const running = this.statusChecks.get(p);
    if (running) return running;
    const check = this.checkStatus(p).finally(() => this.statusChecks.delete(p));
    this.statusChecks.set(p, check);
    return check;
  }

  private checkStatus(p: Provider): Promise<SignInStatus> {
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
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const child = run(program, args, this.deps.dataDir, env, (code) => {
        clearTimeout(timer);
        if (child) this.statusChildren.delete(child);
        if (code === "ENOENT") return resolve("not_installed");
        resolve(timedOut ? "unknown" : code === 0 ? "signed_in" : code === 1 ? "signed_out" : "unknown");
      });
      if (child === null) return;
      // Its output is never read: drained and dropped.
      child.stdout?.resume();
      child.stderr?.resume();
      this.statusChildren.add(child);
      timer = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, STATUS_TIMEOUT_MS);
    });
  }

  /** Kills every login and status check, and waits (briefly) for the logins to exit. Nothing more is recorded. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const waits: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (s.state === "running" || s.child) {
        if (s.state === "running") this.stop(s);
        else kill(s.child); // stopped already but not yet exited
        waits.push(s.exited);
      }
    }
    for (const c of this.statusChildren) kill(c);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(waits), new Promise((r) => (timer = setTimeout(r, KILL_GRACE_MS + 500)))]);
    clearTimeout(timer);
  }
}

/** On POSIX each login runs in its own process group (detached), so its helpers get the SIGTERM with it. */
const GROUPS = process.platform !== "win32";

/**
 * Starts `program` with `args`: no shell, stdin closed (nothing is ever sent), and on POSIX in its own process group.
 * `done` gets the exit code, null for a signal, "ENOENT" when the program is missing, or "error" for another spawn
 * failure. Returns null when the spawn threw (then `done` has already been called).
 */
function run(
  program: CliCommand,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  done: (code: number | null | "ENOENT" | "error") => void,
): ChildProcess | null {
  let settled = false;
  const once = (code: number | null | "ENOENT" | "error") => {
    if (settled) return;
    settled = true;
    done(code);
  };
  let child: ChildProcess;
  try {
    child = spawn(program.file, [...program.args, ...args], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, detached: GROUPS,
    });
  } catch {
    once("error");
    return null;
  }
  child.once("error", (e: NodeJS.ErrnoException) => once(e.code === "ENOENT" ? "ENOENT" : "error"));
  child.once("close", (code) => once(code));
  return child;
}

/** Signals the child's whole process group on POSIX, else the child itself. False when nothing was there. */
function signal(child: ChildProcess, sig: NodeJS.Signals): boolean {
  try {
    if (GROUPS && child.pid !== undefined) {
      process.kill(-child.pid, sig);
      return true;
    }
    return child.kill(sig);
  } catch {
    return false; // the group is already gone
  }
}

/**
 * SIGTERM to the login's whole process group (on POSIX), then, after a grace period, SIGKILL to the login itself if
 * it is still running. Only the login is ever killed outright: a browser the login opened (through xdg-open) is in
 * the same group, and it is the Owner's to close.
 */
function kill(child: ChildProcess | null): void {
  if (!child) return;
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!running() || !signal(child, "SIGTERM")) return;
  const force = setTimeout(() => {
    if (!running()) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, KILL_GRACE_MS);
  force.unref();
}
