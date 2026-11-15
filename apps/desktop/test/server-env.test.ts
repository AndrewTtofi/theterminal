import { describe, expect, it } from "vitest";
import { allowlistedEnv } from "@theterminal/core/dist/host.js";
import { fallbackMacPath, loginShellPath, parseLoginPath, serverEnv } from "../src/server-env.js";

const PROBE = 'printf "__TT_PATH__%s__TT_PATH__" "$PATH"';

describe("serverEnv", () => {
  it("serverEnv keeps only allowlisted variables", () => {
    const base = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      NODE_OPTIONS: "--inspect",
      ELECTRON_RUN_AS_NODE: "1",
      THETERMINAL_FAKE_AGENT: "1",
      ANTHROPIC_API_KEY: "sk-test-placeholder",
    };
    const env = serverEnv(base, "linux", allowlistedEnv, null);
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/someone" });
  });

  it("on darwin the login PATH replaces PATH; elsewhere it is ignored", () => {
    const base = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };
    expect(serverEnv(base, "darwin", allowlistedEnv, "/opt/homebrew/bin:/usr/bin").PATH).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
    expect(serverEnv(base, "darwin", allowlistedEnv, null).PATH).toBe("/usr/bin:/bin");
    expect(serverEnv(base, "linux", allowlistedEnv, "/opt/homebrew/bin").PATH).toBe("/usr/bin:/bin");
    expect(serverEnv(base, "win32", allowlistedEnv, "/opt/homebrew/bin").PATH).toBe("/usr/bin:/bin");
  });

  it("does not change its input", () => {
    const base = { PATH: "/usr/bin", NODE_OPTIONS: "--inspect" };
    serverEnv(base, "darwin", allowlistedEnv, "/opt/homebrew/bin");
    expect(base).toEqual({ PATH: "/usr/bin", NODE_OPTIONS: "--inspect" });
  });
});

describe("parseLoginPath", () => {
  it("extracts the PATH between the markers", () => {
    expect(parseLoginPath("motd\n__TT_PATH__/opt/homebrew/bin:/usr/bin__TT_PATH__\n")).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  it("returns null with no markers or an empty value", () => {
    expect(parseLoginPath("")).toBeNull();
    expect(parseLoginPath("just a banner\n")).toBeNull();
    expect(parseLoginPath("__TT_PATH__/usr/bin")).toBeNull();
    expect(parseLoginPath("__TT_PATH____TT_PATH__")).toBeNull();
    expect(parseLoginPath("__TT_PATH__   __TT_PATH__")).toBeNull();
  });
});

describe("loginShellPath", () => {
  type Call = [string, string[], { timeout: number }];
  const recorder = (out: string) => {
    const calls: Call[] = [];
    const run = async (file: string, args: string[], opts: { timeout: number }) => {
      calls.push([file, args, opts]);
      return out;
    };
    return { calls, run };
  };

  it("loginShellPath runs the shell with -ilc and a 5 s timeout", async () => {
    const { calls, run } = recorder("__TT_PATH__/opt/homebrew/bin:/usr/bin__TT_PATH__");
    expect(await loginShellPath("/bin/zsh", run)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(calls).toEqual([["/bin/zsh", ["-ilc", PROBE], { timeout: 5000 }]]);
  });

  it("uses an absolute zsh, bash, sh or fish as given", async () => {
    for (const shell of ["/usr/local/bin/bash", "/bin/sh", "/opt/homebrew/bin/fish"]) {
      const { calls, run } = recorder("__TT_PATH__/usr/bin__TT_PATH__");
      await loginShellPath(shell, run);
      expect(calls[0]?.[0]).toBe(shell);
    }
  });

  it("falls back to /bin/zsh for a missing, relative or unknown shell", async () => {
    for (const shell of [undefined, "", "zsh", "bin/bash", "/usr/bin/python3", "/tmp/evil"]) {
      const { calls, run } = recorder("__TT_PATH__/usr/bin__TT_PATH__");
      await loginShellPath(shell, run);
      expect(calls[0]?.[0]).toBe("/bin/zsh");
    }
  });

  it("returns null when the shell fails or prints no markers", async () => {
    expect(await loginShellPath("/bin/zsh", async () => Promise.reject(new Error("timed out")))).toBeNull();
    expect(await loginShellPath("/bin/zsh", async () => "no markers here")).toBeNull();
  });
});

describe("fallbackMacPath", () => {
  it("appends the Homebrew directories", () => {
    expect(fallbackMacPath("/usr/bin:/bin")).toBe("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  it("adds no duplicates", () => {
    expect(fallbackMacPath("/usr/local/bin:/usr/bin:/opt/homebrew/bin")).toBe(
      "/usr/local/bin:/usr/bin:/opt/homebrew/bin",
    );
  });

  it("handles a missing PATH", () => {
    expect(fallbackMacPath(undefined)).toBe("/opt/homebrew/bin:/usr/local/bin");
  });
});
