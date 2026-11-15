/** The environment variables a child process (an agent CLI, git over a run's worktree) may inherit. */

/** Exact names copied from the base environment when present. Everything else is dropped. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TEMP", "TMP", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  // Proxy settings are kept although they may carry credentials (user:pass@host): the plan requires them, and
  // redaction covers URL userinfo in everything the agent reports.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];
export const CHILD_ENV_ALLOWLIST_PREFIXES: readonly string[] = ["LC_"];
/** Additionally allowlisted on Windows. */
export const WIN32_ALLOWLIST: readonly string[] = [
  "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "USERNAME", "USERDOMAIN", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

/**
 * A copy of the allowlisted variables in `base` (never changed): the exact names above, every LC_*, and the Windows
 * names on win32. Everything else (NODE_OPTIONS, ELECTRON_*, provider keys, GIT_*) is dropped.
 */
export function allowlistedEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const win = platform === "win32";
  // Windows environment names are case-insensitive (`Path`, MSYS's `SYSTEMROOT`): compare upper-cased, keep the
  // original spelling, and keep only the first spelling of a name.
  const fold = (k: string) => (win ? k.toUpperCase() : k);
  const names = new Set([...CHILD_ENV_ALLOWLIST, ...(win ? WIN32_ALLOWLIST : [])].map(fold));
  const prefixes = CHILD_ENV_ALLOWLIST_PREFIXES.map(fold);
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const f = fold(k);
    if (seen.has(f)) continue;
    if (names.has(f) || prefixes.some((p) => f.startsWith(p))) {
      env[k] = v;
      seen.add(f);
    }
  }
  return env;
}
