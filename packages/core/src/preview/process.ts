import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { visibleControls } from "@theterminal/shared";
import { truncate } from "../agents/redact.js";

/** Lines kept for a failure's tail (stdout and stderr together). */
export const TAIL_LINES = 20;
/** Each tail line is clipped to this many characters, after cleaning. */
export const LINE_CHARS = 300;
/** An unfinished line longer than this is taken as a line, so a program that never breaks its output cannot grow it. */
const CARRY_CHARS = 65_536;
/** After the program exits, how long its output pipes may stay open (a grandchild holding them) before `exited`. */
const EXIT_GRACE_MS = 2000;
/** How long a POSIX tree gets to end after SIGTERM before it is SIGKILLed. */
const TERM_GRACE_MS = 1500;
/** How long `kill()` waits for the exit after the kill was sent. */
const KILL_WAIT_MS = 10_000;
/** Ruling 16: the readiness probe's interval. */
const PROBE_INTERVAL_MS = 500;
/** Ruling 17: the socket listing's timeout. */
const LISTING_TIMEOUT_MS = 5000;
/** The loopback hosts probed, in order (Ruling 16). */
const HOSTS = ["127.0.0.1", "::1"] as const;

/** Colour and cursor sequences (CSI), which dev servers print and which mean nothing in a stored line. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export type Exit = { code: number | null; signal: string | null };

/** The error code of a program that could not be started, never its path or message. */
function notStarted(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return `the program could not be started${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`;
}

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One preview program (a dev server or a build step) and everything it starts. Its output is read as lines, each
 * cleaned by the caller's `clean` (redaction and path scrubbing), with control characters made visible, then clipped;
 * the last `TAIL_LINES` are kept for a failure's tail. Nothing is ever written to its stdin.
 */
export class Supervised {
  readonly pid: number | undefined;
  readonly exited: Promise<Exit>;
  private readonly lines: string[] = [];
  private readonly listeners: ((line: string) => void)[] = [];
  private killing: Promise<void> | undefined;
  private done = false;
  private resolveExit!: (e: Exit) => void;

  constructor(
    private readonly child: ChildProcess | undefined,
    private readonly o: { clean: (s: string) => string; execFile: typeof nodeExecFile; platform: NodeJS.Platform },
    startError?: unknown,
  ) {
    this.exited = new Promise<Exit>((r) => (this.resolveExit = r));
    void this.exited.then(() => (this.done = true));
    this.pid = child?.pid;
    if (child === undefined) {
      this.push(notStarted(startError));
      this.resolveExit({ code: null, signal: null });
      return;
    }
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(grace);
      flushOut();
      flushErr();
      this.resolveExit({ code, signal: typeof signal === "string" ? signal : null });
    };
    const flushOut = this.read(child.stdout);
    const flushErr = this.read(child.stderr);
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
    child.on("error", (e) => {
      if (child.pid === undefined) {
        this.push(notStarted(e));
        finish(null, null); // never started: no close follows for sure
      }
    });
    child.on("exit", (code, signal) => {
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, EXIT_GRACE_MS);
      grace.unref?.();
    });
    child.on("close", (code, signal) => finish(code, signal));
  }

  /** The last lines of output (at most `TAIL_LINES`), oldest first. */
  tail(): string[] {
    return [...this.lines];
  }

  /** Called with every cleaned line from now on. */
  onLine(listener: (line: string) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Kills the whole tree and resolves once the program has exited (or after `KILL_WAIT_MS`). POSIX: SIGTERM to its
   * process group, then SIGKILL to the group after a short grace, whether or not the program itself has ended (a
   * grandchild may outlive it). Windows: `taskkill /PID <pid> /T /F`, which is asynchronous, so the exit is awaited.
   */
  kill(): Promise<void> {
    this.killing ??= this.killTree();
    return this.killing;
  }

  private async killTree(): Promise<void> {
    const child = this.child;
    const pid = child?.pid;
    if (child === undefined || pid === undefined) return;
    const bounded = (ms: number) => Promise.race([this.exited.then(() => undefined), sleepFor(ms)]);
    if (this.o.platform === "win32") {
      // An ended program's pid can belong to someone else by now: only a running one is killed.
      if (this.done || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        try {
          this.o.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, timeout: KILL_WAIT_MS }, (err) => {
            if (err && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            resolve();
          });
        } catch {
          child.kill("SIGKILL");
          resolve();
        }
      });
      await bounded(KILL_WAIT_MS);
      return;
    }
    const group = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
    };
    group("SIGTERM");
    await bounded(TERM_GRACE_MS);
    group("SIGKILL"); // whatever ignored SIGTERM, or outlived the program, in its group
    await bounded(KILL_WAIT_MS);
  }

  /** Reads a stream as lines; returns a function that takes its unfinished last line. */
  private read(stream: NodeJS.ReadableStream | null): () => void {
    if (stream === null) return () => undefined;
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const take = (text: string) => {
      carry += text;
      let at: number;
      while ((at = carry.indexOf("\n")) !== -1) {
        this.push(carry.slice(0, at).replace(/\r$/, ""));
        carry = carry.slice(at + 1);
      }
      while (carry.length > CARRY_CHARS) {
        this.push(carry.slice(0, CARRY_CHARS));
        carry = carry.slice(CARRY_CHARS);
      }
    };
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      take(decoder.end());
      if (carry.length > 0) this.push(carry);
      carry = "";
    };
    stream.on("data", (chunk: Buffer | string) => {
      if (!flushed) take(typeof chunk === "string" ? chunk : decoder.write(chunk));
    });
    stream.on("end", flush);
    stream.on("error", () => undefined);
    return flush;
  }

  /** Redact and scrub first, then make controls visible, and only then cut. */
  private push(raw: string): void {
    const line = truncate(visibleControls(this.o.clean(raw.replace(ANSI, ""))), LINE_CHARS);
    this.lines.push(line);
    if (this.lines.length > TAIL_LINES) this.lines.splice(0, this.lines.length - TAIL_LINES);
    for (const l of this.listeners) {
      try {
        l(line);
      } catch {
        // a listener's failure never stops the output being read
      }
    }
  }
}

/**
 * Starts a program with an argument array, never through a shell, with a hidden window and the given environment
 * only. POSIX: in its own process group (`detached`), so the whole tree can be killed at once.
 */
export function startSupervised(
  argv: { file: string; args: string[] },
  o: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    clean: (s: string) => string;
    spawn?: typeof nodeSpawn;
    execFile?: typeof nodeExecFile;
    platform?: NodeJS.Platform;
  },
): Supervised {
  const platform = o.platform ?? process.platform;
  const deps = { clean: o.clean, execFile: o.execFile ?? nodeExecFile, platform };
  let child: ChildProcess;
  try {
    child = (o.spawn ?? nodeSpawn)(argv.file, argv.args, {
      cwd: o.cwd,
      env: o.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: platform !== "win32",
    });
  } catch (e) {
    return new Supervised(undefined, deps, e);
  }
  return new Supervised(child, deps);
}

/** A port free on 127.0.0.1 at this moment: listen on port 0, read it, close. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

const originOf = (host: string, port: number) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

/** Whether a TCP connection to `host:port` opens within `timeoutMs`. */
function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const end = (open: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => end(false), timeoutMs);
    socket.once("connect", () => end(true));
    socket.once("error", () => end(false));
  });
}

/** `GET /` on `host:port`: the status and headers of any answer within `timeoutMs`, else null. The body is not read. */
function httpGet(host: string, port: number, timeoutMs: number): Promise<{ status: number; headers: Record<string, string> } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const end = (v: { status: number; headers: Record<string, string> } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(v);
    };
    const req = request({ host, port, path: "/", method: "GET", agent: false, headers: { accept: "text/html,*/*" } }, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      }
      res.on("error", () => undefined);
      res.resume();
      end({ status: res.statusCode ?? 0, headers });
    });
    const timer = setTimeout(() => end(null), timeoutMs);
    req.on("error", () => end(null));
    req.end();
  });
}

/**
 * Ruling 16 for one port: `127.0.0.1`, then `::1`. The first host that answers HTTP gives its origin, status and
 * headers; `"open"` when a host took the TCP connection but no HTTP answer came within the timeout; else null.
 */
export async function probe(
  port: number,
  o: { timeoutMs?: number } = {},
): Promise<{ origin: string; status: number; headers: Record<string, string> } | "open" | null> {
  const timeoutMs = o.timeoutMs ?? 2000;
  let open = false;
  for (const host of HOSTS) {
    if (!(await tcpOpen(host, port, timeoutMs))) continue;
    open = true;
    const answer = await httpGet(host, port, timeoutMs);
    if (answer !== null) return { origin: originOf(host, port), ...answer };
  }
  return open ? "open" : null;
}

/**
 * Probes `ports` in order every 500 ms until one answers `GET /` with a status under 500, the deadline passes or the
 * signal aborts. `onStage("open")` is called once, when a port first takes a connection, and `onStage("loaded")` once,
 * at readiness (after "open"). Null on the deadline or an abort.
 */
export async function waitReady(
  ports: number[],
  o: {
    deadline: number;
    signal: AbortSignal;
    onStage(stage: "open" | "loaded"): void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ origin: string; headers: Record<string, string> } | null> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepFor;
  let opened = false;
  const open = () => {
    if (!opened) {
      opened = true;
      o.onStage("open");
    }
  };
  for (;;) {
    if (o.signal.aborted) return null;
    for (const port of ports) {
      const r = await probe(port);
      if (o.signal.aborted) return null;
      if (r === null) continue;
      open();
      if (r !== "open" && r.status < 500) {
        o.onStage("loaded");
        return { origin: r.origin, headers: r.headers };
      }
    }
    if (now() >= o.deadline) return null;
    await sleep(PROBE_INTERVAL_MS);
    if (now() >= o.deadline) return null;
  }
}

/** Ruling 18: false when `X-Frame-Options` is present at all, or any `frame-ancestors` is other than `*`. */
export function frameable(headers: Record<string, string>): boolean {
  let csp = "";
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name === "x-frame-options") return false;
    if (name === "content-security-policy") csp += `${csp ? "," : ""}${v}`;
  }
  for (const policy of csp.split(",")) {
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() !== "frame-ancestors") continue;
      if (sources.length !== 1 || sources[0] !== "*") return false;
    }
  }
  return true;
}

/** Runs a listing tool; its stdout, or null on any failure (missing tool, non-zero exit, timeout). */
function listing(exec: typeof nodeExecFile, file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      exec(file, args, { timeout: LISTING_TIMEOUT_MS, shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Splits `addr:port` (an IPv6 address may be bracketed) at its last colon. */
function splitHostPort(s: string): { host: string; port: number } | null {
  const at = s.lastIndexOf(":");
  if (at <= 0) return null;
  const port = Number(s.slice(at + 1));
  if (!Number.isInteger(port)) return null;
  return { host: s.slice(0, at).replace(/^\[(.*)\]$/, "$1"), port };
}

/**
 * Ruling 17, best effort: the local addresses something listens on at `port`, from `lsof -nP -iTCP:<port>
 * -sTCP:LISTEN -Fn` (macOS and Linux) or `netstat -ano -p tcp` (Windows), 5 s timeout. A missing tool or any failure
 * gives `[]`.
 */
export async function listeningAddresses(
  port: number,
  o: { platform: NodeJS.Platform; execFile: typeof nodeExecFile },
): Promise<string[]> {
  const found: string[] = [];
  const add = (host: string) => {
    if (host && !found.includes(host)) found.push(host);
  };
  if (o.platform === "win32") {
    const out = await listing(o.execFile, "netstat", ["-ano", "-p", "tcp"]);
    for (const line of (out ?? "").split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[0]!.toUpperCase() !== "TCP") continue;
      const local = splitHostPort(cols[1]!);
      const foreign = splitHostPort(cols[2]!);
      // A listening row has foreign port 0; the state word itself is translated on some Windows languages.
      if (local?.port === port && (foreign?.port === 0 || cols[3]!.toUpperCase() === "LISTENING")) add(local.host);
    }
    return found;
  }
  const out = await listing(o.execFile, "lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
  for (const line of (out ?? "").split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const local = splitHostPort(line.slice(1).split("->")[0]!);
    if (local?.port === port) add(local.host);
  }
  return found;
}

/** Ruling 17: any listening address other than `127.0.0.1` or `::1`. */
export function isExposed(addresses: string[]): boolean {
  return addresses.some((a) => a !== "127.0.0.1" && a !== "::1");
}
