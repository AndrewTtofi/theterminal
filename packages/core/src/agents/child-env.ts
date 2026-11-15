import { join } from "node:path";
import type { AuthMode, Provider } from "@theterminal/shared";
import { CLOUD_ENV_ALLOWLIST } from "../connections/cloud/env.js";
import { EMPTY_GITCONFIG, assertEmptyGitconfig } from "./worktrees.js";

/** Throws SharedGitconfigModifiedError when the shared empty git config has content (see worktrees.ts). */
export { assertEmptyGitconfig };

export type ChildEnvOptions = {
  /** api_key mode only. */
  apiKey?: string;
  dataDir: string;
  /** Default process.env. */
  base?: NodeJS.ProcessEnv;
  /** Login modes only: CODEX_HOME (codex) / GEMINI_CLI_HOME (gemini). Ignored for claude and in api_key mode. */
  cliHome?: string;
  /** Gemini only: GOOGLE_CLOUD_PROJECT. */
  googleCloudProject?: string;
  /**
   * A cloud grant's variables. Every name must be in CLOUD_ENV_ALLOWLIST, else a TypeError is thrown before anything
   * is built. A variable this function already set (the Gemini connection's GOOGLE_CLOUD_PROJECT) is never replaced.
   */
  extraEnv?: Record<string, string>;
  /** Test-only: the platform whose variables are allowlisted. Default process.platform. */
  platform?: NodeJS.Platform;
};

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
 * Test-only: under THETERMINAL_FAKE_AGENT=1, the THETERMINAL_FAKE_* variables the fixture CLIs read their scripts
 * from. Adapters merge these after buildChildEnv; outside the fake mode this is always empty.
 */
export function fakeAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (base.THETERMINAL_FAKE_AGENT !== "1") return out;
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && /^THETERMINAL_FAKE_(?:CODEX_SCRIPT|GEMINI_SCRIPT|LOG)$/.test(k)) out[k] = v;
  }
  return out;
}

/**
 * The child-process environment for a provider CLI, built from an allowlist: a copy of the allowlisted
 * variables in `base` (default process.env), which is never changed. Every GIT_*, provider variable,
 * NODE_OPTIONS and the like is dropped. Then git is pinned to the empty global config, and in api_key mode
 * only the given key is added, then a cloud grant's allowlisted variables (`extraEnv`). Login modes pass no key, so the CLI's own stored login is used untouched.
 * Throws SharedGitconfigModifiedError if the shared empty git config is no longer empty.
 */
export function buildChildEnv(provider: Provider, mode: AuthMode, opts: ChildEnvOptions): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env;
  const extra = Object.entries(opts.extraEnv ?? {});
  for (const [k] of extra) {
    if (!CLOUD_ENV_ALLOWLIST.includes(k)) throw new TypeError(`variable not allowed for a child: ${k}`);
  }
  const win = (opts.platform ?? process.platform) === "win32";
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
  env.GIT_CONFIG_GLOBAL = join(opts.dataDir, EMPTY_GITCONFIG);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  // Keep the shell in the worktree root after every command, so relative paths resolve where the gate judged them.
  if (provider === "claude") env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
  if (mode === "api_key" && opts.apiKey) {
    if (provider === "claude") env.ANTHROPIC_API_KEY = opts.apiKey;
    else if (provider === "codex") env.OPENAI_API_KEY = env.CODEX_API_KEY = opts.apiKey;
    else env.GEMINI_API_KEY = opts.apiKey;
  }
  if (opts.cliHome) {
    if (provider === "codex" && mode === "chatgpt") env.CODEX_HOME = opts.cliHome;
    else if (provider === "gemini" && mode === "google") env.GEMINI_CLI_HOME = opts.cliHome;
  }
  if (provider === "gemini" && opts.googleCloudProject) env.GOOGLE_CLOUD_PROJECT = opts.googleCloudProject;
  // Cloud variables never come from `base`, only from a grant; what the CLI itself needs is never moved.
  for (const [k, v] of extra) if (env[k] === undefined) env[k] = v;
  assertEmptyGitconfig(opts.dataDir); // a modified shared config fails the run before the CLI starts
  return env;
}
