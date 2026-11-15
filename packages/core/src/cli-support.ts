import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RESTRICTED_SIGNIN_ENV, domainSchema, type TlsMode } from "@theterminal/shared";
import { DataDirInUseError } from "./server/data-dir-lock.js";
import { KeyInsideDataDirError, assertKeyOutsideDataDir } from "./secrets/file-store.js";
import { SecretStoreUnavailableError } from "./secrets/store.js";
import { RemoteStartError } from "./server/remote.js";
import { CertificateError } from "./server/certs.js";
import { AcmeError } from "./server/acme.js";
import { redact, secretEnvValues } from "./agents/redact.js";
import { pathScrubber, usernameScrubber } from "./agents/scrub-paths.js";

export const USAGE =
  "Usage: theterminal start [--port N] [--data-dir PATH] [--ui-dir PATH] [--core-dir ABSOLUTE_PATH]" +
  " [--remote] [--remote-port N] [--remote-bind ADDR] [--remote-domain NAME] [--remote-tls self_signed|acme|provided]" +
  " [--tls-cert FILE] [--tls-key FILE] [--secret-store keychain|file] [--secret-key-file FILE] [--allow-key-in-data-dir]" +
  " [--allow-restricted-signin]";
export const START_FAILED = "The Terminal could not start. See the log for details.";
export const SHUTDOWN_FAILED = "The Terminal did not shut down cleanly.";
export const SHUTDOWN_TIMED_OUT = "The Terminal did not shut down in time.";
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * The one stderr line for a failed start. Console output ends up in bug reports and host logs, so only errors whose
 * messages are fixed text (no path, pid or value) are shown: the data folder in use, the key file inside the data
 * folder, an unusable secret store, the remote listener, its certificate and a refused certificate order (ACME's
 * message is fixed; its problem type stays on the error). Every other error gets a fixed line.
 */
export function startErrorLine(err: unknown): string {
  if (err instanceof KeyInsideDataDirError) return err.message;
  if (
    err instanceof DataDirInUseError ||
    err instanceof RemoteStartError ||
    err instanceof CertificateError ||
    err instanceof AcmeError ||
    err instanceof SecretStoreUnavailableError
  ) {
    return `The Terminal could not start: ${err.message}`;
  }
  return START_FAILED;
}

/** What `theterminal start` passes to createServer. */
export type StartOptions = {
  dataDir: string;
  uiDir?: string;
  port?: number;
  coreDir?: string;
  remote?: { enabled: true; port?: number; bind?: string; domain?: string; tls?: TlsMode; certFile?: string; keyFile?: string };
  secretStore?: "keychain" | "file";
  secretKeyFile?: string;
  allowKeyInDataDir?: true;
  /** The restricted sign-in switch (see createServer): `--allow-restricted-signin`, or THETERMINAL_RESTRICTED_SIGNIN=1. */
  restrictedSignIn?: true;
};

const TLS_MODES: readonly TlsMode[] = ["self_signed", "acme", "provided"];
const NEEDS_REMOTE = "--remote-port, --remote-bind, --remote-domain, --remote-tls, --tls-cert and --tls-key need --remote";
const NEEDS_FILE_STORE = "--secret-key-file and --allow-key-in-data-dir need --secret-store file";

/**
 * Reads `theterminal start`'s arguments. Every refusal is a fixed line that echoes no path or value (except a bad
 * --port, as before), so the console never carries what the operator typed.
 */
export function parseStartArgs(
  args: string[],
  defaults: { dataDir: () => string; uiDir: () => string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; options: StartOptions } | { ok: false; message: string } {
  const failed = (message: string) => ({ ok: false as const, message });
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        port: { type: "string" },
        "data-dir": { type: "string" },
        "ui-dir": { type: "string" },
        "core-dir": { type: "string" },
        remote: { type: "boolean" },
        "remote-port": { type: "string" },
        "remote-bind": { type: "string" },
        "remote-domain": { type: "string" },
        "remote-tls": { type: "string" },
        "tls-cert": { type: "string" },
        "tls-key": { type: "string" },
        "secret-store": { type: "string" },
        "secret-key-file": { type: "string" },
        "allow-key-in-data-dir": { type: "boolean" },
        "allow-restricted-signin": { type: "boolean" },
      },
    });
  } catch {
    return failed(USAGE);
  }
  const { values: v, positionals } = parsed;
  if (positionals[0] !== "start") return failed(USAGE);

  const options: StartOptions = { dataDir: v["data-dir"] ?? defaults.dataDir() };
  const uiDir = v["ui-dir"] ?? defaults.uiDir();
  if (uiDir !== undefined) options.uiDir = uiDir;
  if (v.port !== undefined) {
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return failed(`Invalid --port: ${v.port}`);
    options.port = port;
  }
  if (v["core-dir"] !== undefined) {
    if (!isAbsolute(v["core-dir"])) return failed("Invalid --core-dir: must be an absolute path");
    options.coreDir = v["core-dir"];
  }

  const remoteFlags = [v["remote-port"], v["remote-bind"], v["remote-domain"], v["remote-tls"], v["tls-cert"], v["tls-key"]];
  if (!v.remote && remoteFlags.some((f) => f !== undefined)) return failed(NEEDS_REMOTE);
  if (v.remote) {
    const remote: NonNullable<StartOptions["remote"]> = { enabled: true };
    if (v["remote-port"] !== undefined) {
      const port = Number(v["remote-port"]);
      if (!/^\d+$/.test(v["remote-port"]) || port < 1 || port > 65535) return failed("Invalid --remote-port: must be a port number");
      remote.port = port;
    }
    if (v["remote-bind"] !== undefined) {
      if (isIP(v["remote-bind"]) === 0) return failed("Invalid --remote-bind: must be an IP address");
      remote.bind = v["remote-bind"];
    }
    if (v["remote-domain"] !== undefined) {
      if (!domainSchema.safeParse(v["remote-domain"]).success) return failed("Invalid --remote-domain: must be a DNS name");
      remote.domain = v["remote-domain"].toLowerCase();
    }
    const tls = v["remote-tls"];
    if (tls !== undefined) {
      if (!(TLS_MODES as readonly string[]).includes(tls)) return failed("Invalid --remote-tls: must be self_signed, acme or provided");
      remote.tls = tls as TlsMode;
    }
    if (remote.tls === "acme" && remote.domain === undefined) return failed("--remote-tls acme needs --remote-domain");
    const certFile = v["tls-cert"];
    const keyFile = v["tls-key"];
    if (remote.tls === "provided") {
      if (certFile === undefined || keyFile === undefined) return failed("--remote-tls provided needs --tls-cert and --tls-key");
      remote.certFile = resolve(certFile);
      remote.keyFile = resolve(keyFile);
    } else if (certFile !== undefined || keyFile !== undefined) {
      return failed("--tls-cert and --tls-key need --remote-tls provided");
    }
    options.remote = remote;
  }

  const store = v["secret-store"];
  if (store !== undefined && store !== "keychain" && store !== "file") return failed("Invalid --secret-store: must be keychain or file");
  if (store !== "file" && (v["secret-key-file"] !== undefined || v["allow-key-in-data-dir"])) return failed(NEEDS_FILE_STORE);
  if (store !== undefined) options.secretStore = store;
  if (store === "file") {
    if (v["secret-key-file"] === undefined) return failed("--secret-store file needs --secret-key-file");
    options.secretKeyFile = resolve(v["secret-key-file"]);
    if (v["allow-key-in-data-dir"]) options.allowKeyInDataDir = true;
    try {
      assertKeyOutsideDataDir(options.secretKeyFile, options.dataDir, options.allowKeyInDataDir ?? false);
    } catch (e) {
      if (e instanceof KeyInsideDataDirError) return failed(e.message);
      throw e;
    }
  }
  // Exactly "1": anything else, including "true", leaves the switch off.
  if (v["allow-restricted-signin"] || env[RESTRICTED_SIGNIN_ENV] === "1") options.restrictedSignIn = true;
  return { ok: true, options };
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
