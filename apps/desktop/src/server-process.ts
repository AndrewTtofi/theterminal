import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { HostMessage, ReadyMessage } from "@theterminal/core/dist/host.js";

const STDERR_TAIL = 4000;
const TIMED_OUT = "timed out waiting for the server";
const KILL_GRACE_MS = 5000;
/** After `exit`, how long `close` may take to drain stdio. A grandchild that inherited the pipes can hold them open. */
const CLOSE_FLUSH_MS = 500;

/** The server child exited, failed to spawn or timed out before it sent its ready message. */
export class ServerStartError extends Error {
  /** The child's exit code, or null when it was killed by a signal, never spawned, or timed out. */
  readonly exitCode: number | null;
  /** The last 4000 characters of the child's stderr, the spawn error, or `timed out waiting for the server`. */
  readonly detail: string;

  constructor(exitCode: number | null, detail: string) {
    super(exitCode === null ? `The server did not start: ${detail}` : `The server exited with code ${exitCode}`);
    this.name = "ServerStartError";
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export type ServerHandle = {
  ready: Promise<ReadyMessage>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
  pid: number | undefined;
};

/** The part of a ChildProcess that terminateChild needs. */
export type KillableChild = {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
};

const hasExited = (c: KillableChild) => c.exitCode !== null || c.signalCode !== null;

/** True once the child has exited, false when `ms` passes first. */
function waitForExit(child: KillableChild, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    child.once("exit", onExit);
  });
}

/**
 * Ends a child: `kill()` (SIGTERM), then, if it is still alive after `graceMs`, SIGKILL on POSIX, or on win32
 * `taskkill /PID <pid> /T /F` for the whole process tree. `run` takes a fixed argument list, never a shell.
 */
export async function terminateChild(
  child: KillableChild,
  o: { graceMs: number; platform: NodeJS.Platform; run: (file: string, args: string[]) => void },
): Promise<void> {
  if (hasExited(child) || child.pid === undefined) return;
  child.kill();
  if (await waitForExit(child, o.graceMs)) return;
  if (o.platform === "win32") o.run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  else child.kill("SIGKILL");
}

function runDetached(file: string, args: string[]): void {
  execFile(file, args, { windowsHide: true, shell: false }, () => {});
}

/** The part of a writable stream that createLogSink needs. */
export type LogStream = {
  readonly writableNeedDrain: boolean;
  readonly destroyed?: boolean;
  write(chunk: Buffer | string): unknown;
  end(cb?: () => void): unknown;
};

export type LogSink = { write(chunk: Buffer): void; close(): Promise<void> };

/**
 * A log writer that never buffers without bound: chunks that arrive while the stream needs a drain are dropped,
 * and their total size is noted in one line when the log is closed.
 */
export function createLogSink(stream: LogStream): LogSink {
  let dropped = 0;
  let closed = false;
  return {
    write(chunk) {
      if (closed || stream.destroyed) return;
      if (stream.writableNeedDrain) dropped += chunk.length;
      else stream.write(chunk);
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      if (stream.destroyed) return Promise.resolve();
      if (dropped > 0) stream.write(`[The Terminal] dropped ${dropped} bytes of server output while the log was busy\n`);
      return new Promise((resolve) => stream.end(() => resolve()));
    },
  };
}

function openLog(logFile: string | undefined): LogSink | null {
  if (!logFile) return null;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    // Truncated at every start, so the log holds only the current run.
    const stream = createWriteStream("", { fd: openSync(logFile, "w") });
    stream.on("error", () => {});
    return createLogSink(stream);
  } catch {
    return null;
  }
}

function isReadyMessage(m: unknown): m is ReadyMessage {
  const r = m as Partial<ReadyMessage> | null;
  return r?.type === "ready" && typeof r.url === "string" && Number.isInteger(r.port);
}

/**
 * Starts the server child (`<nodeFile> <cliFile> ...args`) with an IPC channel and exactly the given environment,
 * never through a shell. Its stdout and stderr go to `logFile`. `ready` settles once: with the first valid ready
 * message, or with a ServerStartError when the child exits, fails to spawn or `readyTimeoutMs` passes first (the
 * child is then terminated). `stop()` asks for a shutdown over IPC and terminates the child after `stopTimeoutMs`.
 * Termination is SIGTERM, then after `killGraceMs` SIGKILL (POSIX) or `taskkill /T /F` (win32).
 */
export function startServer(o: {
  nodeFile: string;
  cliFile: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFile?: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  killGraceMs?: number;
}): ServerHandle {
  const readyTimeoutMs = o.readyTimeoutMs ?? 60_000;
  const stopTimeoutMs = o.stopTimeoutMs ?? 10_000;
  const killGraceMs = o.killGraceMs ?? KILL_GRACE_MS;
  const log = openLog(o.logFile);
  const child = spawn(o.nodeFile, [o.cliFile, ...o.args], {
    env: o.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    shell: false,
  });
  const terminate = () => terminateChild(child, { graceMs: killGraceMs, platform: process.platform, run: runDetached });

  let stderrTail = "";
  child.stdout?.on("data", (chunk: Buffer) => log?.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    log?.write(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
  });

  let settled = false;
  let resolveReady!: (m: ReadyMessage) => void;
  let rejectReady!: (e: ServerStartError) => void;
  const ready = new Promise<ReadyMessage>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller that stops the server during startup need not handle the resulting rejection.
  ready.catch(() => {});
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(readyTimer);
    fn();
  };
  const readyTimer = setTimeout(() => {
    settle(() => rejectReady(new ServerStartError(null, TIMED_OUT)));
    void terminate();
  }, readyTimeoutMs);

  child.on("message", (message: unknown) => {
    if (isReadyMessage(message)) settle(() => resolveReady(message));
  });
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    if (child.pid === undefined) spawnError = err;
  });

  let exitSeen = false;
  let finished = false;
  let flushTimer: NodeJS.Timeout | undefined;
  let resolveExited!: (r: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (resolveExited = r));
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(flushTimer);
    // Release the pipes even if a grandchild still holds their other end.
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.pid === undefined) {
      // Never spawned: there is no exit code, only the reason.
      const reason = (spawnError as Error | null)?.message ?? "could not start the server process";
      settle(() => rejectReady(new ServerStartError(null, reason)));
      code = null;
      signal = null;
    } else {
      settle(() => rejectReady(new ServerStartError(code, stderrTail)));
    }
    const result = { code, signal };
    if (log) void log.close().then(() => resolveExited(result));
    else resolveExited(result);
  };
  child.on("exit", (code, signal) => {
    exitSeen = true;
    // `close` normally follows at once, after any message still in the channel; it gets a bounded wait.
    flushTimer = setTimeout(() => finish(code, signal), CLOSE_FLUSH_MS);
  });
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

  const stop = async () => {
    if (!finished && !exitSeen && child.pid !== undefined) {
      if (child.connected) {
        const shutdown: HostMessage = { type: "shutdown" };
        try {
          child.send(shutdown, () => {});
        } catch {
          // The channel is closing; the timeout below terminates the child.
        }
      }
      if (!(await waitForExit(child, stopTimeoutMs))) await terminate();
    }
    await exited;
  };

  return { ready, exited, stop, pid: child.pid };
}
