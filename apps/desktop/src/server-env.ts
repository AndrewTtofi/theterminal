import { posix } from "node:path";

const MARKER = "__TT_PATH__";
/** Printed by the login shell: its PATH between two markers, so banners and motd output around it are ignored. */
const PROBE = `printf "${MARKER}%s${MARKER}" "$PATH"`;
const PROBE_TIMEOUT_MS = 5000;
const DEFAULT_SHELL = "/bin/zsh";
const KNOWN_SHELLS = new Set(["zsh", "bash", "sh", "fish"]);
const MAC_EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * The server child's environment: only the allowlisted variables of `base` (the list agents get), so no
 * `ELECTRON_*`, `NODE_OPTIONS` or `THETERMINAL_FAKE_*` reaches it. On macOS the resolved login PATH replaces PATH,
 * because apps started from Finder get a bare PATH without Homebrew.
 */
export function serverEnv(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  allowlisted: (b: NodeJS.ProcessEnv, p: NodeJS.Platform) => NodeJS.ProcessEnv,
  loginPath: string | null,
): NodeJS.ProcessEnv {
  const env = allowlisted(base, platform);
  if (platform === "darwin" && loginPath !== null) env.PATH = loginPath;
  return env;
}

/** The PATH between the first two markers, or null when they are missing or the value is empty or malformed. */
export function parseLoginPath(stdout: string): string | null {
  const start = stdout.indexOf(MARKER);
  if (start < 0) return null;
  const from = start + MARKER.length;
  const end = stdout.indexOf(MARKER, from);
  if (end < 0) return null;
  const value = stdout.slice(from, end).trim();
  // A PATH is one line of printable text; anything else is not trusted.
  if (value === "" || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

/**
 * Asks the user's login shell for its PATH: `<shell> -ilc <probe>` with a fixed argument list and a 5 s timeout.
 * Only an absolute zsh, bash, sh or fish is run as given; anything else uses /bin/zsh. Any failure gives null.
 */
export async function loginShellPath(
  shell: string | undefined,
  run: (file: string, args: string[], opts: { timeout: number }) => Promise<string>,
): Promise<string | null> {
  const file =
    shell && posix.isAbsolute(shell) && KNOWN_SHELLS.has(posix.basename(shell)) ? shell : DEFAULT_SHELL;
  try {
    return parseLoginPath(await run(file, ["-ilc", PROBE], { timeout: PROBE_TIMEOUT_MS }));
  } catch {
    return null;
  }
}

/** The current PATH plus the Homebrew directories (Apple Silicon, then Intel), without duplicates. */
export function fallbackMacPath(path: string | undefined): string {
  const parts = (path ?? "").split(":").filter((p) => p !== "");
  for (const extra of MAC_EXTRA_PATHS) if (!parts.includes(extra)) parts.push(extra);
  return parts.join(":");
}
