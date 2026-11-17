import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
  HostMessage,
  PickFolderMessage,
  PreviewCaptureMessage,
  PreviewViewsMessage,
  ReadyMessage,
} from "@theterminal/core/dist/host.js";
import { isPickablePath } from "./folder-pick.js";
import { parsePreviewMessage } from "./preview-policy.js";

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
 * Ends a child. On POSIX: `kill()` (SIGTERM), then SIGKILL if it is still alive after `graceMs`. On win32, where
 * `kill()` is TerminateProcess on the child alone and would orphan the agents it started: `taskkill /PID <pid> /T /F`
 * first, for the whole process tree, and `kill()` as the fallback when taskkill fails or the child outlives it by
 * `graceMs`. `run` takes a fixed argument list, never a shell, and rejects when the program fails.
 */
export async function terminateChild(
  child: KillableChild,
  o: { graceMs: number; platform: NodeJS.Platform; run: (file: string, args: string[]) => Promise<void> },
): Promise<void> {
  if (hasExited(child) || child.pid === undefined) return;
  if (o.platform === "win32") {
    const treeKilled = await o.run("taskkill", ["/PID", String(child.pid), "/T", "/F"]).then(
      () => true,
      () => false,
    );
    if (treeKilled && (await waitForExit(child, o.graceMs))) return;
    if (!hasExited(child)) child.kill();
    return;
  }
  child.kill();
  if (await waitForExit(child, o.graceMs)) return;
  child.kill("SIGKILL");
}

/** Runs a program with a fixed argument list and no shell; rejects when it cannot run or exits non-zero. */
function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, shell: false, timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
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

/** A pick id: 1–64 letters, digits, `-` or `_` (the server child uses a UUID). */
const PICK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isPickFolderMessage(m: unknown): m is PickFolderMessage {
  const r = m as Partial<PickFolderMessage> | null;
  return typeof r === "object" && r !== null && r.type === "pick_folder" && typeof r.id === "string" && PICK_ID.test(r.id);
}

/** A preview request from the server child, already checked by `parsePreviewMessage`. */
export type PreviewRequest = PreviewViewsMessage | PreviewCaptureMessage;

const MAX_SHOTS = 4;
/** The base64 length of the largest screenshot file (16 MiB), as the server child accepts. */
const MAX_PNG_BASE64 = Math.ceil(16_777_216 / 3) * 4;
const SHOT_DEVICE = /^[A-Za-z0-9_-]{1,100}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The well-formed shots of a capture answer, at most 4; anything else is dropped. */
function cleanShots(shots: unknown): { device: string; png: string }[] {
  if (!Array.isArray(shots)) return [];
  const out: { device: string; png: string }[] = [];
  for (const s of shots) {
    if (out.length === MAX_SHOTS) break;
    const r = s as { device?: unknown; png?: unknown } | null;
    if (typeof r !== "object" || r === null) continue;
    if (typeof r.device !== "string" || !SHOT_DEVICE.test(r.device)) continue;
    const png = r.png;
    if (typeof png !== "string" || png.length === 0 || png.length > MAX_PNG_BASE64 || !BASE64.test(png)) continue;
    out.push({ device: r.device, png });
  }
  return out;
}

/**
 * Starts the server child (`<nodeFile> <cliFile> ...args`) with an IPC channel and exactly the given environment,
 * never through a shell. Its stdout and stderr go to `logFile`. `ready` settles once: with the first valid ready
 * message, or with a ServerStartError when the child exits, fails to spawn or `readyTimeoutMs` passes first (the
 * child is then terminated). `stop()` asks for a shutdown over IPC and terminates the child after `stopTimeoutMs`.
 * Termination is SIGTERM, then after `killGraceMs` SIGKILL (POSIX); on win32 `taskkill /T /F` on the process tree, then
 * `kill()` after `killGraceMs` if that did not end the child.
 *
 * A valid `pick_folder` request from the child calls `onPickFolder` (the native folder dialog) and answers the child,
 * and only the child, with `picked_folder` and the same id. One dialog runs at a time: a request while one is open is
 * answered null at once. The path is null when there is no `onPickFolder`, it fails, or it gives anything but an
 * absolute path of at most 4096 characters. Malformed requests are ignored.
 *
 * A `preview_views` or `preview_capture` request that `parsePreviewMessage` accepts calls `onPreview` with its clean
 * copy and answers the child with `preview_views_done` (ok only when `onPreview` gives exactly true) or
 * `preview_captured` (its well-formed shots, at most 4) and the same id. Without `onPreview`, or when it fails, the
 * answer is a refusal (false, or no shots). Anything else is ignored.
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
  onPickFolder?: () => Promise<string | null>;
  onPreview?: (m: PreviewRequest) => Promise<unknown>;
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
  const terminate = () => terminateChild(child, { graceMs: killGraceMs, platform: process.platform, run });

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

  const answerPick = (id: string, path: string | null) => {
    if (!child.connected) return;
    const answer: HostMessage = { type: "picked_folder", id, path };
    try {
      child.send(answer, () => {});
    } catch {
      // The channel is closing; the child's own pick times out.
    }
  };
  let picking = false;
  const pickFolder = (id: string) => {
    if (picking || !o.onPickFolder) return answerPick(id, null);
    picking = true;
    void Promise.resolve()
      .then(() => o.onPickFolder!())
      .then(
        (path) => (isPickablePath(path) ? path : null),
        () => null,
      )
      .then((path) => {
        picking = false;
        answerPick(id, path);
      });
  };

  const answer = (m: HostMessage) => {
    if (!child.connected) return;
    try {
      child.send(m, () => {});
    } catch {
      // The channel is closing; the child's own request times out.
    }
  };
  const preview = (m: PreviewRequest) => {
    void Promise.resolve()
      .then(() => (o.onPreview ? o.onPreview(m) : null))
      .catch(() => null)
      .then((result) =>
        answer(
          m.type === "preview_views"
            ? { type: "preview_views_done", id: m.id, ok: result === true }
            : { type: "preview_captured", id: m.id, shots: cleanShots(result) },
        ),
      );
  };

  child.on("message", (message: unknown) => {
    if (isReadyMessage(message)) settle(() => resolveReady(message));
    else if (isPickFolderMessage(message)) pickFolder(message.id);
    else {
      const request = parsePreviewMessage(message);
      if (request !== null) preview(request);
    }
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
