import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { DataDirInUseError } from "./server/data-dir-lock.js";
import { redact, secretEnvValues } from "./agents/redact.js";
import { pathScrubber, usernameScrubber } from "./agents/scrub-paths.js";

export const USAGE = "Usage: theterminal start [--port N] [--data-dir PATH] [--ui-dir PATH] [--core-dir ABSOLUTE_PATH]";
export const START_FAILED = "The Terminal could not start. See the log for details.";
export const SHUTDOWN_FAILED = "The Terminal did not shut down cleanly.";
export const SHUTDOWN_TIMED_OUT = "The Terminal did not shut down in time.";
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * The one stderr line for a failed start. Console output ends up in bug reports and host logs, so only the
 * data-folder-in-use message (fixed text, no path or pid) is shown; every other error gets a fixed line.
 */
export function startErrorLine(err: unknown): string {
  return err instanceof DataDirInUseError ? `The Terminal could not start: ${err.message}` : START_FAILED;
}

function osUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function readToken(dataDir: string): string[] {
  try {
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    return token ? [token] : [];
  } catch {
    return [];
  }
}

/**
 * Writes a failed start's detail to `<dataDir>/logs/server-start.log` (mode 0600), replacing the previous one. Paths
 * are scrubbed (`<data>`, `~`, `<user>`) and secrets redacted, including the session token. Never throws.
 */
export function writeStartLog(dataDir: string, err: unknown, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    const scrubUser = usernameScrubber(osUsername());
    const scrubPaths = pathScrubber([
      [dataDir, "<data>"],
      [homedir(), "~"],
    ]);
    const text = redact(scrubUser(scrubPaths(detail)), [...secretEnvValues(env), ...readToken(dataDir)]);
    const dir = join(dataDir, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "server-start.log");
    writeFileSync(file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
    chmodSync(file, 0o600); // an existing file keeps its old mode on write
  } catch {
    // Best effort: the stderr line has already told the user the start failed.
  }
}

/** Sets the exit code, then exits once the message has reached stderr (pipe writes are asynchronous on macOS). */
export function failAndExit(message: string): void {
  process.exitCode = 1;
  process.stderr.write(`${message}\n`, () => process.exit(1));
}

/**
 * An idempotent shutdown: closes the server and exits 0, or fails with a fixed line (no stack) when close rejects.
 * If close has not settled after `timeoutMs`, the data folder lock is released as a best effort and it fails. The
 * timer is unref'd, so it never keeps the process alive on its own.
 */
export function createShutdown(deps: {
  close(): Promise<void>;
  releaseLock(): void;
  exit(code: number): void;
  fail(message: string): void;
  timeoutMs?: number;
}): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      try {
        deps.releaseLock();
      } catch {
        // Best effort.
      }
      deps.fail(SHUTDOWN_TIMED_OUT);
    }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    deps.close().then(
      () => {
        clearTimeout(timer);
        deps.exit(0);
      },
      () => {
        clearTimeout(timer);
        deps.fail(SHUTDOWN_FAILED);
      },
    );
  };
}
