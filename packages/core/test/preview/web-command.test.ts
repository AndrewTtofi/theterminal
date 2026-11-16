import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PackageManagerNotFoundError,
  PreviewRefusedError,
  contentKey,
  frameworkFlags,
  installCommand,
  parseWebCommand,
  resolvePackageManager,
  resolveWebArgv,
  webPlan,
} from "../../src/preview/web-command.js";

const refusal = (f: () => unknown): string | null => {
  try {
    f();
  } catch (e) {
    if (e instanceof PreviewRefusedError) return e.reason;
    throw e;
  }
  return null;
};

const only =
  (...found: string[]) =>
  (p: string) =>
    found.includes(p);
const same = (p: string) => p;

describe("parseWebCommand", () => {
  it("parses the allowed shapes", () => {
    expect(parseWebCommand("npm run dev")).toEqual({ manager: "npm", runner: "run", name: "dev", args: [] });
    expect(parseWebCommand("npx vite --open")).toEqual({ manager: "npm", runner: "npx", name: "vite", args: ["--open"] });
    expect(parseWebCommand("pnpm run dev:web --mode=staging")).toEqual({
      manager: "pnpm",
      runner: "run",
      name: "dev:web",
      args: ["--mode=staging"],
    });
    expect(parseWebCommand("yarn run start")).toEqual({ manager: "yarn", runner: "run", name: "start", args: [] });
    expect(parseWebCommand("npx @scope/tool")).toEqual({ manager: "npm", runner: "npx", name: "@scope/tool", args: [] });
  });

  it("refuses every other shape as program", () => {
    for (const c of [
      "npm run dev && rm -rf /",
      "node server.js",
      "npm run",
      "pnpm dlx x",
      "npm  run dev",
      " npm run dev",
      "npm run dev ",
      "npm run -dev",
      "npm run dev $(id)",
      "npm run dev `id`",
      "npm run dev a;b",
      "npm run dev 'a b'",
      "npm run dev a\"b",
      "npm run dev a|b",
      "npm run dev a>b",
      "npx ../evil",
      "npx --yes evil",
      "npm\trun dev",
      "npm exec vite",
      "yarn dev",
      "npm.cmd run dev",
      "NPM run dev",
      "npm run __proto__",
      `npm run dev ${Array.from({ length: 17 }, () => "a").join(" ")}`,
      `npm run ${"a".repeat(101)}`,
      `npm run dev ${"a".repeat(201)}`,
      "",
    ]) {
      expect(refusal(() => parseWebCommand(c)), c).toBe("program");
    }
    expect(parseWebCommand(`npm run dev ${Array.from({ length: 16 }, () => "a").join(" ")}`).args).toHaveLength(16);
  });

  it("refuses control characters, redactions and truncations with their own reasons", () => {
    expect(refusal(() => parseWebCommand("npm run dev\u0007"))).toBe("controls");
    expect(refusal(() => parseWebCommand("npm run dev\u202e"))).toBe("controls");
    expect(refusal(() => parseWebCommand("npm run [REDACTED]"))).toBe("redacted");
    expect(refusal(() => parseWebCommand(`npm run dev ${"a".repeat(489)}…`))).toBe("truncated");
    expect(refusal(() => parseWebCommand(`npm run dev ${"a".repeat(478)}…[truncated]`))).toBe("truncated");
  });
});

describe("frameworkFlags", () => {
  it("adds each framework's own port and host flags", () => {
    expect(frameworkFlags("next dev", null, 4000)).toEqual(["--port", "4000", "--hostname", "127.0.0.1"]);
    expect(frameworkFlags("vite", null, 4000)).toEqual(["--port", "4000", "--host", "127.0.0.1"]);
    expect(frameworkFlags("astro dev", null, 4000)).toEqual(["--port", "4000", "--host", "127.0.0.1"]);
    expect(frameworkFlags("nuxt dev", null, 4000)).toEqual(["--port", "4000", "--host", "127.0.0.1"]);
    expect(frameworkFlags("nuxi dev --open", null, 4000)).toEqual(["--port", "4000", "--host", "127.0.0.1"]);
    expect(frameworkFlags("tsc && node_modules/.bin/vite", null, 4000)).toEqual(["--port", "4000", "--host", "127.0.0.1"]);
    expect(frameworkFlags(null, "vite", 4000)).toEqual(["--port", "4000", "--host", "127.0.0.1"]);
    expect(frameworkFlags(null, "next dev", 4000)).toEqual(["--port", "4000", "--hostname", "127.0.0.1"]);
  });

  it("adds nothing for other tools", () => {
    expect(frameworkFlags("react-scripts start", null, 4000)).toEqual([]);
    expect(frameworkFlags("vitest", null, 4000)).toEqual([]);
    expect(frameworkFlags("next build", null, 4000)).toEqual([]);
    expect(frameworkFlags(null, null, 4000)).toEqual([]);
  });
});

describe("resolvePackageManager", () => {
  const execPath = "C:\\node\\node.exe";

  it("uses a .cmd shim's sibling JavaScript entry, never the shim", () => {
    const cjs = win32.join("C:\\n", "node_modules", "pnpm", "bin", "pnpm.cjs");
    const r = resolvePackageManager("pnpm", {
      env: { Path: "C:\\n" },
      execPath,
      platform: "win32",
      which: () => "C:\\n\\pnpm.cmd",
      realpath: same,
      isFile: only(cjs),
    });
    expect(r).toEqual({ file: execPath, args: [cjs] });
  });

  it("throws PackageManagerNotFoundError when a .cmd shim has no sibling entry", () => {
    const f = () =>
      resolvePackageManager("pnpm", {
        env: {},
        execPath,
        platform: "win32",
        which: () => "C:\\n\\pnpm.cmd",
        realpath: same,
        isFile: only("C:\\n\\pnpm.cmd"),
      });
    expect(f).toThrow(PackageManagerNotFoundError);
    try {
      f();
    } catch (e) {
      expect((e as PackageManagerNotFoundError).manager).toBe("pnpm");
    }
  });

  it("runs a PATH hit whose real path is a JavaScript file with this Node", () => {
    const r = resolvePackageManager("yarn", {
      env: {},
      execPath: "/usr/bin/node",
      platform: "linux",
      which: () => "/usr/local/bin/yarn",
      realpath: (p) => (p === "/usr/local/bin/yarn" ? "/usr/local/lib/node_modules/npm/bin/npm-cli.js" : p),
      isFile: () => true,
    });
    expect(r).toEqual({ file: "/usr/bin/node", args: ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"] });
  });

  it("prefers npm's own entry beside this Node (Windows) or under ../lib (POSIX)", () => {
    const winCli = win32.join("C:\\node", "node_modules", "npm", "bin", "npx-cli.js");
    expect(
      resolvePackageManager("npx", { env: {}, execPath, platform: "win32", which: () => null, realpath: same, isFile: only(winCli) }),
    ).toEqual({ file: execPath, args: [winCli] });
    const posixCli = posix.join("/opt/node/lib", "node_modules", "npm", "bin", "npm-cli.js");
    expect(
      resolvePackageManager("npm", {
        env: {},
        execPath: "/opt/node/bin/node",
        platform: "darwin",
        which: () => null,
        realpath: same,
        isFile: only(posixCli),
      }),
    ).toEqual({ file: "/opt/node/bin/node", args: [posixCli] });
  });

  it("runs a native executable directly", () => {
    expect(
      resolvePackageManager("yarn", {
        env: {},
        execPath,
        platform: "win32",
        which: () => "C:\\tools\\yarn.exe",
        realpath: same,
        isFile: () => true,
      }),
    ).toEqual({ file: "C:\\tools\\yarn.exe", args: [] });
    expect(
      resolvePackageManager("pnpm", {
        env: {},
        execPath: "/usr/bin/node",
        platform: "linux",
        which: () => "/usr/local/bin/pnpm",
        realpath: same,
        isFile: () => true,
        readHead: () => Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
      }),
    ).toEqual({ file: "/usr/local/bin/pnpm", args: [] });
  });

  it("never returns a .bat, .cmd or .ps1, nor a shell script", () => {
    for (const hit of ["C:\\n\\pnpm.bat", "C:\\n\\pnpm.ps1", "C:\\n\\pnpm.CMD", "C:\\n\\pnpm.Bat"]) {
      let r: unknown = null;
      try {
        r = resolvePackageManager("pnpm", { env: {}, execPath, platform: "win32", which: () => hit, realpath: same, isFile: only(hit) });
      } catch (e) {
        expect(e).toBeInstanceOf(PackageManagerNotFoundError);
      }
      expect(r).toBeNull();
    }
    // A real path that ends in .bat behind an innocent name.
    expect(() =>
      resolvePackageManager("yarn", {
        env: {},
        execPath,
        platform: "win32",
        which: () => "C:\\n\\yarn.exe",
        realpath: () => "C:\\n\\yarn.bat",
        isFile: () => true,
      }),
    ).toThrow(PackageManagerNotFoundError);
    expect(() =>
      resolvePackageManager("pnpm", {
        env: {},
        execPath: "/usr/bin/node",
        platform: "linux",
        which: () => "/usr/local/bin/pnpm",
        realpath: same,
        isFile: () => true,
        readHead: () => Buffer.from("#!/bin/sh\nexec node pnpm.cjs\n"),
      }),
    ).toThrow(PackageManagerNotFoundError);
  });

  it("runs a script with a node shebang with this Node", () => {
    expect(
      resolvePackageManager("pnpm", {
        env: {},
        execPath: "/usr/bin/node",
        platform: "linux",
        which: () => "/usr/local/bin/pnpm",
        realpath: same,
        isFile: () => true,
        readHead: () => Buffer.from("#!/usr/bin/env node\nrequire('x')\n"),
      }),
    ).toEqual({ file: "/usr/bin/node", args: ["/usr/local/bin/pnpm"] });
  });

  it("asks which on the child environment's PATH", () => {
    const seen: unknown[] = [];
    const env = { PATH: "/child/bin" };
    try {
      resolvePackageManager("yarn", {
        env,
        execPath: "/usr/bin/node",
        platform: "linux",
        which: (cmd, o) => (seen.push([cmd, o?.env, o?.platform]), null),
        realpath: same,
        isFile: () => false,
      });
    } catch {
      // not found
    }
    expect(seen).toEqual([["yarn", env, "linux"]]);
  });
});

describe("webPlan, installCommand, contentKey and resolveWebArgv", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tt-web-command-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pkg = (scripts: Record<string, string>) => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));

  it("includes the install chosen by the lockfile when node_modules is missing", () => {
    pkg({ dev: "vite" });
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const plan = webPlan(dir, "npm run dev");
    expect(plan.commands).toEqual([
      ["npm", "ci"],
      ["npm", "run", "dev"],
    ]);
    expect(plan.display).toEqual(["npm ci", "npm run dev -- --port <port> --host 127.0.0.1"]);
    expect(plan.install).toBe(true);
    expect(plan.files).toEqual(["package.json", "package-lock.json"]);
    expect(plan.script).toBe("vite");

    mkdirSync(join(dir, "node_modules"));
    const again = webPlan(dir, "npm run dev");
    expect(again.install).toBe(false);
    expect(again.commands).toEqual([["npm", "run", "dev"]]);
    expect(again.files).toEqual(["package.json"]);
  });

  it("refuses a missing script and a missing package.json", () => {
    expect(refusal(() => webPlan(dir, "npm run dev"))).toBe("no_package_json");
    writeFileSync(join(dir, "package.json"), "not json");
    expect(refusal(() => webPlan(dir, "npm run dev"))).toBe("no_package_json");
    pkg({ build: "vite build" });
    expect(refusal(() => webPlan(dir, "npm run dev"))).toBe("script_missing");
    expect(refusal(() => webPlan(dir, "npm run constructor"))).toBe("script_missing");
    expect(refusal(() => webPlan(dir, "npm run dev && x"))).toBe("program");
  });

  it("chooses the install by lockfile", () => {
    expect(installCommand(dir, "npm")).toEqual(["npm", "install"]);
    expect(installCommand(dir, "pnpm")).toEqual(["pnpm", "install"]);
    writeFileSync(join(dir, "yarn.lock"), "");
    expect(installCommand(dir, "yarn")).toEqual(["yarn", "install", "--frozen-lockfile"]);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(installCommand(dir, "pnpm")).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(installCommand(dir, "npm")).toEqual(["npm", "ci"]);
    mkdirSync(join(dir, "node_modules"));
    expect(installCommand(dir, "npm")).toBeNull();
  });

  it("changes the key with one byte of package.json, and not with the port", () => {
    pkg({ dev: "vite" });
    mkdirSync(join(dir, "node_modules"));
    const plan = webPlan(dir, "npm run dev");
    const key = contentKey(dir, "web", plan.commands, plan.files);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(contentKey(dir, "web", plan.commands, plan.files)).toBe(key);

    const o = { env: {}, execPath: "/usr/bin/node", platform: "linux" as const, which: () => null, realpath: same, isFile: () => true, scriptText: plan.script };
    const a = resolveWebArgv(plan.commands[0]!, 4000, o);
    const b = resolveWebArgv(plan.commands[0]!, 4001, o);
    expect(a.args).not.toEqual(b.args);
    expect(webPlan(dir, "npm run dev").commands).toEqual(plan.commands);
    expect(contentKey(dir, "web", webPlan(dir, "npm run dev").commands, plan.files)).toBe(key);

    pkg({ dev: "vitf" });
    expect(contentKey(dir, "web", plan.commands, plan.files)).not.toBe(key);
    expect(contentKey(dir, "android", plan.commands, plan.files)).not.toBe(key);
    expect(contentKey(dir, "web", [["npm", "run", "start"]], plan.files)).not.toBe(contentKey(dir, "web", plan.commands, plan.files));
  });

  it("hashes a missing file as null", () => {
    const missing = contentKey(dir, "web", [["npm", "run", "dev"]], ["package.json"]);
    writeFileSync(join(dir, "package.json"), "");
    expect(contentKey(dir, "web", [["npm", "run", "dev"]], ["package.json"])).not.toBe(missing);
  });

  it("resolves the argument array: entry, logical arguments, then -- (npm) and the framework flags", () => {
    const cli = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    const base = { env: {}, execPath: "/opt/node/bin/node", platform: "darwin" as const, which: () => null, realpath: same, isFile: only(cli) };
    expect(resolveWebArgv(["npm", "run", "dev"], 5173, { ...base, scriptText: "vite" })).toEqual({
      file: "/opt/node/bin/node",
      args: [cli, "run", "dev", "--", "--port", "5173", "--host", "127.0.0.1"],
    });
    expect(resolveWebArgv(["npm", "run", "dev", "--open"], 5173, { ...base, scriptText: "react-scripts start" })).toEqual({
      file: "/opt/node/bin/node",
      args: [cli, "run", "dev", "--", "--open"],
    });
    expect(resolveWebArgv(["npm", "run", "dev"], 5173, { ...base, scriptText: "react-scripts start" })).toEqual({
      file: "/opt/node/bin/node",
      args: [cli, "run", "dev"],
    });
    expect(resolveWebArgv(["npm", "ci"], 5173, { ...base, scriptText: "vite" })).toEqual({ file: "/opt/node/bin/node", args: [cli, "ci"] });

    const npx = "/opt/node/lib/node_modules/npm/bin/npx-cli.js";
    expect(resolveWebArgv(["npx", "vite", "--open"], 5173, { ...base, isFile: only(npx), scriptText: null })).toEqual({
      file: "/opt/node/bin/node",
      args: [npx, "vite", "--open", "--port", "5173", "--host", "127.0.0.1"],
    });

    const pnpm = "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs";
    expect(
      resolveWebArgv(["pnpm", "run", "dev"], 3000, {
        ...base,
        which: () => "/usr/local/bin/pnpm",
        realpath: (p) => (p === "/usr/local/bin/pnpm" ? pnpm : p),
        isFile: () => true,
        scriptText: "next dev",
      }),
    ).toEqual({ file: "/opt/node/bin/node", args: [pnpm, "run", "dev", "--port", "3000", "--hostname", "127.0.0.1"] });
  });

  it("refuses an argument array outside the grammar", () => {
    const base = { env: {}, execPath: "/n", platform: "linux" as const, which: () => null, realpath: same, isFile: () => true, scriptText: null };
    for (const cmd of [["node", "x.js"], ["npm", "exec", "x"], ["npm", "run", "dev;x"], ["npm", "install", "evil"], ["npm"], []]) {
      expect(refusal(() => resolveWebArgv(cmd, 4000, base)), cmd.join(" ")).toBe("program");
    }
  });
});
