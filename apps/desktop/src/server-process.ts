import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { HostMessage, ReadyMessage } from "@theterminal/core/dist/host.js";

const STDERR_TAIL = 4000;
const TIMED_OUT = "timed out waiting for the server";

/** The server child exited, failed to spawn or timed out before it sent its ready message. */
export class ServerStartError extends Error {
  readonly exitCode: number | null;
  /** The last 4000 characters of the child's stderr, or `timed out waiting for the server`. */
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

function openLog(logFile: string | undefined): WriteStream | null {
  if (!logFile) return null;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    // Truncated at every start, so the log holds only the current run.
    const stream = createWriteStream("", { fd: openSync(logFile, "w") });
    stream.on("error", () => {});
    return stream;
  } catch {
    return null;
  }
}

/**
 * Starts the server child (`<nodeFile> <cliFile> ...args`) with an IPC channel and the given environment, never
 * through a shell. Its stdout and stderr go to `logFile`. `ready` settles once: with the first ready message, or
 * with a ServerStartError when the child exits or `readyTimeoutMs` passes first (the child is then killed).
 */
export function startServer(o: {
  nodeFile: string;
  cliFile: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFile?: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}): ServerHandle {
  const readyTimeoutMs = o.readyTimeoutMs ?? 60_000;
  const stopTimeoutMs = o.stopTimeoutMs ?? 10_000;
  const log = openLog(o.logFile);
  const child = spawn(o.nodeFile, [o.cliFile, ...o.args], {
    env: o.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    shell: false,
  });

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
    clearTimeout(timer);
    fn();
  };
  const timer = setTimeout(() => {
    settle(() => rejectReady(new ServerStartError(null, TIMED_OUT)));
    child.kill();
  }, readyTimeoutMs);

  child.on("message", (message: unknown) => {
    const m = message as Partial<ReadyMessage> | null;
    if (m?.type === "ready") settle(() => resolveReady(m as ReadyMessage));
  });
  child.on("error", (err) => {
    stderrTail = (stderrTail + err.message).slice(-STDERR_TAIL);
  });

  let hasExited = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // `close` comes after stdio and the IPC channel are drained, so a ready message sent just before exit still counts.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      hasExited = true;
      settle(() => rejectReady(new ServerStartError(code, stderrTail)));
      const done = () => resolve({ code, signal });
      if (log) log.end(done);
      else done();
    });
  });

  const stop = async () => {
    if (hasExited) return exited.then(() => undefined);
    if (child.connected) {
      const shutdown: HostMessage = { type: "shutdown" };
      try {
        child.send(shutdown, (err) => {
          if (err) child.kill();
        });
      } catch {
        child.kill();
      }
    }
    let stopTimer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        stopTimer = setTimeout(() => resolve(true), stopTimeoutMs);
      }),
    ]);
    clearTimeout(stopTimer);
    if (timedOut) child.kill();
    await exited;
  };

  return { ready, exited, stop, pid: child.pid };
}
