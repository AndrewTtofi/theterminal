import { join } from "node:path";
import type { AuthMode, Provider } from "@theterminal/shared";
import { EMPTY_GITCONFIG } from "./worktrees.js";

/** Inherited git variables (identity, repository, config) would override what the worktree is set up with. */
const INHERITED_GIT_ENV = /^GIT_/i;
/** Per provider: inherited variables that could send requests elsewhere or authenticate differently than we choose. */
const INHERITED_PROVIDER_ENV: Record<Provider, RegExp> = {
  claude: /^(?:ANTHROPIC_|CLAUDE_CODE_USE_)/i,
  codex: /^(?:OPENAI_|CODEX_)/i,
  gemini: /^(?:GEMINI_|GOOGLE_|VERTEX)/i,
};

/**
 * The child-process environment for a provider CLI. A copy: `base` (default process.env) is never changed.
 * Strips inherited git and provider variables, points git at the empty global config, and in api_key mode
 * re-adds only the given key. Login modes pass no key, so the user's own CLI login is used untouched.
 */
export function buildChildEnv(
  provider: Provider,
  mode: AuthMode,
  opts: { apiKey?: string; dataDir: string; base?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.base ?? process.env) };
  for (const k of Object.keys(env)) {
    if (INHERITED_PROVIDER_ENV[provider].test(k) || INHERITED_GIT_ENV.test(k)) delete env[k];
  }
  env.GIT_CONFIG_GLOBAL = join(opts.dataDir, EMPTY_GITCONFIG);
  env.GIT_CONFIG_NOSYSTEM = "1";
  if (provider === "claude") {
    // Keep the shell in the worktree root after every command, so relative paths resolve where the gate judged them.
    env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
    if (mode === "api_key") delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (mode === "api_key" && opts.apiKey) {
    if (provider === "claude") env.ANTHROPIC_API_KEY = opts.apiKey;
    else if (provider === "codex") env.OPENAI_API_KEY = env.CODEX_API_KEY = opts.apiKey;
    else env.GEMINI_API_KEY = opts.apiKey;
  }
  return env;
}
