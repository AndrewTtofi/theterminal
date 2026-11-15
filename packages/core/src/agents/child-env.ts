import { join } from "node:path";
import type { AuthMode, Provider } from "@theterminal/shared";
import { CLOUD_ENV_ALLOWLIST } from "../connections/cloud/env.js";
import { allowlistedEnv } from "./env-allowlist.js";
import { EMPTY_GITCONFIG, assertEmptyGitconfig } from "./worktrees.js";

export { CHILD_ENV_ALLOWLIST, CHILD_ENV_ALLOWLIST_PREFIXES, WIN32_ALLOWLIST, allowlistedEnv } from "./env-allowlist.js";

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
  /**
   * Claude only: the values of the run's MCP env variables and headers, which its MCP config names as `${TT_MCP_<n>_<m>}`
   * so they never appear on Claude Code's command line. Every name must match MCP_ENV_NAME, else a TypeError is thrown
   * before anything is built.
   */
  mcpEnv?: Record<string, string>;
  /** Test-only: the platform whose variables are allowlisted. Default process.platform. */
  platform?: NodeJS.Platform;
};

/** The variables that carry MCP secrets to Claude Code: server index, then value index. */
export const MCP_ENV_NAME = /^TT_MCP_\d+_\d+$/;

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
 * The base of every child environment: a copy of the allowlisted variables in `base` (default process.env, never
 * changed), with git pinned to the empty global config, no system config and no prompts. Throws
 * SharedGitconfigModifiedError if the shared empty git config is no longer empty. Holds no provider key or
 * connection value: anything a child needs beyond this is added by its caller.
 */
export function baseChildEnv(
  dataDir: string,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = allowlistedEnv(base, platform);
  env.GIT_CONFIG_GLOBAL = join(dataDir, EMPTY_GITCONFIG);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  assertEmptyGitconfig(dataDir);
  return env;
}

/**
 * The child-process environment for a provider CLI, built from baseChildEnv (the allowlist and the git pins). Every
 * GIT_*, provider variable, NODE_OPTIONS and the like is dropped. Then in api_key mode
 * only the given key is added, then a cloud grant's allowlisted variables (`extraEnv`). Login modes pass no key, so the CLI's own stored login is used untouched.
 * Throws SharedGitconfigModifiedError if the shared empty git config is no longer empty.
 */
export function buildChildEnv(provider: Provider, mode: AuthMode, opts: ChildEnvOptions): NodeJS.ProcessEnv {
  const extra = Object.entries(opts.extraEnv ?? {});
  for (const [k] of extra) {
    if (!CLOUD_ENV_ALLOWLIST.includes(k)) throw new TypeError(`variable not allowed for a child: ${k}`);
  }
  const mcp = Object.entries(opts.mcpEnv ?? {});
  for (const [k] of mcp) {
    if (!MCP_ENV_NAME.test(k)) throw new TypeError(`variable not allowed for a child: ${k}`);
  }
  // Throws before anything is added when the shared git config was modified: the run fails before the CLI starts.
  const env = baseChildEnv(opts.dataDir, opts.base ?? process.env, opts.platform ?? process.platform);
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
  // MCP secret variables never come from `base` either (TT_MCP_* is not allowlisted), only from the run's MCP servers.
  for (const [k, v] of mcp) env[k] = v;
  return env;
}
