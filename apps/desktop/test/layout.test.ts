import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataDir } from "@theterminal/core/dist/paths.js";
import { desktopDataDir, devLayout, packagedLayout, profileDir, restrictedSignInRequested, serverArgs, serverLogFile } from "../src/layout.js";

const R = join("res", "Resources");
const root = join("work", "repo");

describe("packagedLayout", () => {
  it("puts Node, core and the UI under Resources on macOS", () => {
    expect(packagedLayout(R, "darwin")).toEqual({
      nodeFile: join(R, "node", "node"),
      cliFile: join(R, "core", "dist", "cli.js"),
      coreDir: join(R, "core"),
      uiDir: join(R, "ui"),
    });
  });

  it("uses node.exe on Windows", () => {
    expect(packagedLayout(R, "win32").nodeFile).toBe(join(R, "node", "node.exe"));
  });
});

describe("devLayout", () => {
  it("points at the built core and UI in the repository and Node on PATH", () => {
    expect(devLayout(join(root, "apps", "desktop"))).toEqual({
      nodeFile: "node",
      cliFile: join(root, "packages", "core", "dist", "cli.js"),
      coreDir: join(root, "packages", "core"),
      uiDir: join(root, "apps", "ui", "dist"),
    });
  });
});

describe("data folder", () => {
  it("is TheTerminal under appData, or the override", () => {
    const a = join("app", "data");
    expect(desktopDataDir(a)).toBe(join(a, "TheTerminal"));
    expect(desktopDataDir(a, join("elsewhere", "d"))).toBe(join("elsewhere", "d"));
  });

  it.runIf(process.platform === "darwin")("equals core's default data folder on macOS", () => {
    expect(desktopDataDir("/Users/a/Library/Application Support")).toBe(defaultDataDir("darwin", { HOME: "/Users/a" }));
  });

  it("keeps the Chromium profile and the server log in <dataDir>/desktop", () => {
    const d = join("x", "TheTerminal");
    expect(profileDir(d)).toBe(join(d, "desktop"));
    expect(serverLogFile(d)).toBe(join(d, "desktop", "server.log"));
  });
});

describe("serverArgs", () => {
  const L = packagedLayout(R, "darwin");
  const d = join("x", "TheTerminal");

  it("passes the data, UI and core folders and the port", () => {
    expect(serverArgs(L, d, 0)).toEqual(["start", "--data-dir", d, "--ui-dir", L.uiDir, "--core-dir", L.coreDir, "--port", "0"]);
  });

  it("leaves the port to core when none is given", () => {
    expect(serverArgs(L, d)).toEqual(["start", "--data-dir", d, "--ui-dir", L.uiDir, "--core-dir", L.coreDir]);
  });

  it("passes the restricted sign-in switch on only when asked", () => {
    expect(serverArgs(L, d, undefined, { restrictedSignIn: true })).toEqual([
      "start", "--data-dir", d, "--ui-dir", L.uiDir, "--core-dir", L.coreDir, "--allow-restricted-signin",
    ]);
    expect(serverArgs(L, d, 0, { restrictedSignIn: false })).toEqual(["start", "--data-dir", d, "--ui-dir", L.uiDir, "--core-dir", L.coreDir, "--port", "0"]);
  });
});

describe("restrictedSignInRequested", () => {
  it("is on only for THETERMINAL_RESTRICTED_SIGNIN=1", () => {
    expect(restrictedSignInRequested({ THETERMINAL_RESTRICTED_SIGNIN: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"]) expect(restrictedSignInRequested({ THETERMINAL_RESTRICTED_SIGNIN: value })).toBe(false);
  });
});
