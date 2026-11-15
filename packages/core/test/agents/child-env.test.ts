import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertEmptyGitconfig, buildChildEnv, fakeAgentEnv } from "../../src/agents/child-env.js";
import { EMPTY_GITCONFIG, SharedGitconfigModifiedError } from "../../src/agents/worktrees.js";

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
    expect(keys(env, /^git_/i).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
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
    expect(env.OPENAI_API_KEY).toBeUndefined(); // other providers' variables are dropped
  });

  it("claude subscription: no key, ANTHROPIC_* gone, oauth token left alone", () => {
    const env = buildChildEnv("claude", "subscription", { dataDir: DATA_DIR, base });
    expect(keys(env, /^anthropic_/i)).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // not allowlisted: the CLI reads its own stored login
  });

  it("codex api_key: strips OPENAI_* and CODEX_*, sets exactly OPENAI_API_KEY and CODEX_API_KEY", () => {
    const env = buildChildEnv("codex", "api_key", { apiKey: "sk-NEW", dataDir: DATA_DIR, base });
    expect(keys(env, /^(openai_|codex_)/i).sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("sk-NEW");
    expect(env.CODEX_API_KEY).toBe("sk-NEW");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
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

describe("buildChildEnv allowlist", () => {
  const dirty = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    ANTHROPIC_API_KEY: "sk-ant-TESTKEY-0000000000",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NPM_TOKEN: "npm-token",
    GITHUB_TOKEN: "gh-token",
    GIT_AUTHOR_EMAIL: "someone@example.invalid",
    NODE_OPTIONS: "--require x",
    LC_ALL: "C",
    THETERMINAL_FAKE_AGENT: "1",
  } as NodeJS.ProcessEnv;

  it("keeps only allowlisted names plus what we set", () => {
    const env = buildChildEnv("gemini", "api_key", { apiKey: "gem-KEY", dataDir: DATA_DIR, base: dirty });
    expect(Object.keys(env).sort()).toEqual(
      ["PATH", "HOME", "LC_ALL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GEMINI_API_KEY"].sort(),
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("keeps the Windows system variables on win32 and drops them elsewhere", () => {
    const win = { SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", PATHEXT: ".EXE", APPDATA: "C:\\a", "ProgramFiles(x86)": "C:\\p", NPM_TOKEN: "t" } as NodeJS.ProcessEnv;
    const on = buildChildEnv("claude", "subscription", { dataDir: DATA_DIR, base: win, platform: "win32" });
    for (const k of ["SystemRoot", "ComSpec", "PATHEXT", "APPDATA", "ProgramFiles(x86)"]) expect(on[k]).toBe(win[k]);
    expect(on.NPM_TOKEN).toBeUndefined();
    const off = buildChildEnv("claude", "subscription", { dataDir: DATA_DIR, base: win, platform: "linux" });
    expect(off.SystemRoot).toBeUndefined();
  });

  it("on win32 matches names case-insensitively, keeps the original spelling, never duplicates, drops git_* in any case", () => {
    const win = { Path: "C:\\bin", SYSTEMROOT: "C:\\Windows", COMSPEC: "cmd.exe", Git_Dir: "x", NPM_TOKEN: "t" } as NodeJS.ProcessEnv;
    const env = buildChildEnv("codex", "chatgpt", { dataDir: DATA_DIR, base: win, platform: "win32" });
    expect(env.Path).toBe("C:\\bin");
    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    expect(env.COMSPEC).toBe("cmd.exe");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(Object.keys(env).filter((k) => /^git_/i.test(k)).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("fakeAgentEnv forwards only the fixture script and log variables, and only under THETERMINAL_FAKE_AGENT=1", () => {
    const b = { THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_CODEX_SCRIPT: "[]", THETERMINAL_FAKE_GEMINI_SCRIPT: "[]", THETERMINAL_FAKE_LOG: "/l", THETERMINAL_FAKE_SCRIPT: "[]", THETERMINAL_CODEX_BIN: "x", NPM_TOKEN: "t" } as NodeJS.ProcessEnv;
    expect(Object.keys(fakeAgentEnv(b)).sort()).toEqual(["THETERMINAL_FAKE_CODEX_SCRIPT", "THETERMINAL_FAKE_GEMINI_SCRIPT", "THETERMINAL_FAKE_LOG"]);
    expect(fakeAgentEnv({ ...b, THETERMINAL_FAKE_AGENT: undefined })).toEqual({});
  });

  it("cliHome sets CODEX_HOME / GEMINI_CLI_HOME in login modes only", () => {
    expect(buildChildEnv("codex", "chatgpt", { dataDir: DATA_DIR, base: dirty, cliHome: "/h" }).CODEX_HOME).toBe("/h");
    expect(buildChildEnv("gemini", "google", { dataDir: DATA_DIR, base: dirty, cliHome: "/h" }).GEMINI_CLI_HOME).toBe("/h");
    const key = buildChildEnv("codex", "api_key", { apiKey: "k", dataDir: DATA_DIR, base: dirty, cliHome: "/h" });
    expect(key.CODEX_HOME).toBeUndefined();
    const claude = buildChildEnv("claude", "subscription", { dataDir: DATA_DIR, base: dirty, cliHome: "/h" });
    expect(claude.CODEX_HOME).toBeUndefined();
    expect(claude.GEMINI_CLI_HOME).toBeUndefined();
  });

  it("googleCloudProject sets GOOGLE_CLOUD_PROJECT for gemini only", () => {
    for (const mode of ["google", "api_key"] as const) {
      const env = buildChildEnv("gemini", mode, { dataDir: DATA_DIR, base: dirty, googleCloudProject: "proj-1" });
      expect(env.GOOGLE_CLOUD_PROJECT).toBe("proj-1");
    }
    expect(buildChildEnv("codex", "chatgpt", { dataDir: DATA_DIR, base: dirty, googleCloudProject: "proj-1" }).GOOGLE_CLOUD_PROJECT).toBeUndefined();
  });
});

describe("buildChildEnv extraEnv", () => {
  const grant = { AWS_ACCESS_KEY_ID: "AKIATESTKEY000000000", AWS_SESSION_TOKEN: "t" };
  const modes = [
    ["claude", "api_key"], ["claude", "subscription"], ["codex", "api_key"], ["codex", "chatgpt"], ["gemini", "api_key"], ["gemini", "google"],
  ] as const;

  it.each(modes)("%s %s: adds the allowlisted cloud variables", (p, mode) => {
    const env = buildChildEnv(p, mode, { apiKey: "k", dataDir: DATA_DIR, base, extraEnv: grant });
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIATESTKEY000000000");
    expect(env.AWS_SESSION_TOKEN).toBe("t");
  });

  it("throws for a variable outside CLOUD_ENV_ALLOWLIST, before anything is returned", () => {
    expect(() => buildChildEnv("claude", "api_key", { apiKey: "k", dataDir: DATA_DIR, base, extraEnv: { NPM_TOKEN: "x" } })).toThrow(
      new TypeError("variable not allowed for a child: NPM_TOKEN"),
    );
  });

  it("never copies cloud variables from the base environment", () => {
    const env = buildChildEnv("claude", "api_key", {
      apiKey: "k", dataDir: DATA_DIR, base: { ...base, AWS_SECRET_ACCESS_KEY: "base-secret", AWS_PROFILE: "x" },
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
  });

  it("never overwrites a variable already set: the Gemini connection's project wins over a grant's", () => {
    const env = buildChildEnv("gemini", "google", {
      dataDir: DATA_DIR, base, googleCloudProject: "gemini-project",
      extraEnv: { GOOGLE_CLOUD_PROJECT: "grant-project", CLOUDSDK_CORE_PROJECT: "grant-project" },
    });
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("gemini-project");
    expect(env.CLOUDSDK_CORE_PROJECT).toBe("grant-project");
    const plain = buildChildEnv("gemini", "google", { dataDir: DATA_DIR, base, extraEnv: { GOOGLE_CLOUD_PROJECT: "grant-project" } });
    expect(plain.GOOGLE_CLOUD_PROJECT).toBe("grant-project");
  });
});

describe("assertEmptyGitconfig", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "gitcfg-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("accepts a missing or empty file", () =>
    withDir((dir) => {
      expect(() => assertEmptyGitconfig(dir)).not.toThrow();
      writeFileSync(join(dir, EMPTY_GITCONFIG), "");
      expect(() => assertEmptyGitconfig(dir)).not.toThrow();
    }));

  it("rejects a file with content, a directory, and (POSIX) a symlink to an empty file", () =>
    withDir((dir) => {
      const cfg = join(dir, EMPTY_GITCONFIG);
      writeFileSync(cfg, "[user]\n");
      expect(() => assertEmptyGitconfig(dir)).toThrow(SharedGitconfigModifiedError);
      rmSync(cfg);
      mkdirSync(cfg);
      expect(() => assertEmptyGitconfig(dir)).toThrow(SharedGitconfigModifiedError);
      if (process.platform !== "win32") {
        rmSync(cfg, { recursive: true });
        writeFileSync(join(dir, "elsewhere"), "");
        symlinkSync(join(dir, "elsewhere"), cfg);
        expect(() => assertEmptyGitconfig(dir)).toThrow(SharedGitconfigModifiedError);
      }
    }));
});
