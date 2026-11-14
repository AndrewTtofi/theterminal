import { join } from "node:path";
import type { AuthMode, Provider } from "@theterminal/shared";
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
  /** Test-only: the platform whose variables are allowlisted. Default process.platform. */
  platform?: NodeJS.Platform;
};

/** Exact names copied from the base environment when present. Everything else is dropped. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TEMP", "TMP", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];
export const CHILD_ENV_ALLOWLIST_PREFIXES: readonly string[] = ["LC_"];
/** Additionally allowlisted on Windows. */
const WIN32_ALLOWLIST: readonly string[] = [
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
    if (k.startsWith("THETERMINAL_FAKE_") && k !== "THETERMINAL_FAKE_AGENT" && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The child-process environment for a provider CLI, built from an allowlist: a copy of the allowlisted
 * variables in `base` (default process.env), which is never changed. Every GIT_*, provider variable,
 * NODE_OPTIONS and the like is dropped. Then git is pinned to the empty global config, and in api_key mode
 * only the given key is added. Login modes pass no key, so the CLI's own stored login is used untouched.
 * Throws SharedGitconfigModifiedError if the shared empty git config is no longer empty.
 */
export function buildChildEnv(provider: Provider, mode: AuthMode, opts: ChildEnvOptions): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env;
  const names = new Set(CHILD_ENV_ALLOWLIST);
  if ((opts.platform ?? process.platform) === "win32") for (const n of WIN32_ALLOWLIST) names.add(n);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (names.has(k) || CHILD_ENV_ALLOWLIST_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
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
  assertEmptyGitconfig(opts.dataDir); // a modified shared config fails the run before the CLI starts
  return env;
}
