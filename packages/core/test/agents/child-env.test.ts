import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/agents/child-env.js";

const DATA_DIR = "/data/theterminal";
const base = {
  PATH: "/usr/bin",
  HOME: "/home/alice",
  GIT_AUTHOR_NAME: "x",
  git_dir: "/elsewhere",
  ANTHROPIC_API_KEY: "sk-ant-OLD",
  ANTHROPIC_BASE_URL: "https://example.com",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-old",
  OPENAI_API_KEY: "sk-OLD",
  OPENAI_BASE_URL: "https://example.com",
  CODEX_HOME: "/codex",
  CODEX_API_KEY: "codex-old",
  GEMINI_API_KEY: "gem-old",
  GOOGLE_API_KEY: "goog-old",
  GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
  VERTEX_PROJECT: "p",
  VERTEXAI_LOCATION: "l",
} as NodeJS.ProcessEnv;

const keys = (env: NodeJS.ProcessEnv, re: RegExp) => Object.keys(env).filter((k) => re.test(k));

describe("buildChildEnv", () => {
  it.each(["claude", "codex", "gemini"] as const)("%s: strips GIT_* and pins git config; leaves the caller's env untouched", (p) => {
    const snapshot = { ...base };
    const env = buildChildEnv(p, "api_key", { apiKey: "k", dataDir: DATA_DIR, base });
    expect(base).toEqual(snapshot);
    expect(keys(env, /^git_/i).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
    expect(env.GIT_CONFIG_GLOBAL).toMatch(/theterminal[\\/].+/);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/alice");
  });

  it("claude api_key: strips ANTHROPIC_*, CLAUDE_CODE_USE_* and the oauth token, re-adds exactly one key", () => {
    const env = buildChildEnv("claude", "api_key", { apiKey: "sk-ant-NEW", dataDir: DATA_DIR, base });
    expect(keys(env, /^anthropic_/i)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-NEW");
    expect(keys(env, /^claude_code_use_/i)).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(env.OPENAI_API_KEY).toBe("sk-OLD"); // other providers' variables are not this provider's business
  });

  it("claude subscription: no key, ANTHROPIC_* gone, oauth token left alone", () => {
    const env = buildChildEnv("claude", "subscription", { dataDir: DATA_DIR, base });
    expect(keys(env, /^anthropic_/i)).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-old");
  });

  it("codex api_key: strips OPENAI_* and CODEX_*, sets exactly OPENAI_API_KEY and CODEX_API_KEY", () => {
    const env = buildChildEnv("codex", "api_key", { apiKey: "sk-NEW", dataDir: DATA_DIR, base });
    expect(keys(env, /^(openai_|codex_)/i).sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("sk-NEW");
    expect(env.CODEX_API_KEY).toBe("sk-NEW");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-OLD");
  });

  it("codex chatgpt: sets no key", () => {
    const env = buildChildEnv("codex", "chatgpt", { dataDir: DATA_DIR, base });
    expect(keys(env, /^(openai_|codex_)/i)).toEqual([]);
  });

  it("gemini api_key: strips GEMINI_*, GOOGLE_* and VERTEX*, sets exactly GEMINI_API_KEY", () => {
    const env = buildChildEnv("gemini", "api_key", { apiKey: "gem-NEW", dataDir: DATA_DIR, base });
    expect(keys(env, /^(gemini_|google_|vertex)/i)).toEqual(["GEMINI_API_KEY"]);
    expect(env.GEMINI_API_KEY).toBe("gem-NEW");
  });

  it("gemini google: sets no key", () => {
    const env = buildChildEnv("gemini", "google", { dataDir: DATA_DIR, base });
    expect(keys(env, /^(gemini_|google_|vertex)/i)).toEqual([]);
  });

  it("api_key mode without a key sets none", () => {
    const env = buildChildEnv("codex", "api_key", { dataDir: DATA_DIR, base });
    expect(keys(env, /^(openai_|codex_)/i)).toEqual([]);
  });
});
