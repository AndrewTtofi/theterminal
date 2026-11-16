import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PreviewFailedError, androidPlan, androidSdkDir, bundleIdFrom, buildCount, chooseSimulator, detectTools, fillPlaceholders,
  findAppTarget, findIosApp, iosPlan, readAndroidOutput, realTools, type ToolRunner,
} from "../../src/preview/native.js";

// Windows CI starts node slowly; detection runs a handful of fake programs.
vi.setConfig({ testTimeout: process.platform === "win32" ? 40_000 : 15_000 });

const FAKE = fileURLToPath(new URL("../fixtures/fake-native.mjs", import.meta.url));
const UDID = "0B0E0C2A-1D2F-4E8A-9C3B-5A6D7E8F9012";

/** A ToolRunner over fake-native.mjs, scripted with `script`; `tools` records each call. */
function fakeRunner(script: Record<string, unknown> = {}, calls: { tool: string; args: string[]; env: NodeJS.ProcessEnv }[] = []): ToolRunner {
  return (tool, args, o) =>
    new Promise((resolve) => {
      calls.push({ tool, args, env: o.env });
      const name = tool.endsWith("gradlew") ? "gradlew" : tool;
      execFile(
        process.execPath,
        [FAKE, name, ...args],
        { cwd: o.cwd, env: { ...o.env, THETERMINAL_FAKE_NATIVE: JSON.stringify(script) }, timeout: o.timeoutMs, windowsHide: true, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
}

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-native-"));
  home = mkdtempSync(join(tmpdir(), "tt-native-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "" });

describe("detectTools", () => {
  it("finds Xcode 17 and one booted iPhone 16 on macOS", async () => {
    const calls: { tool: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const tools = await detectTools(fakeRunner({}, calls), { platform: "darwin", env: baseEnv(), homedir: home });
    expect(tools.platform).toBe("darwin");
    expect(tools.ios.supported).toBe(true);
    expect(tools.ios.xcode).toBe("Xcode 17.0");
    expect(tools.ios.simulators).toEqual([{ udid: UDID, name: "iPhone 16", state: "Booted", runtime: "iOS 18.0" }]);
    expect(tools.ios.missing).toEqual([]);
    expect(calls.map((c) => [c.tool, ...c.args].join(" "))).toEqual(
      expect.arrayContaining(["xcode-select -p", "xcrun simctl list devices --json", "xcodebuild -version"]),
    );
  });

  it("names the command line tools as missing when xcode-select fails", async () => {
    const tools = await detectTools(fakeRunner({ fail: ["xcode-select"] }), { platform: "darwin", env: baseEnv(), homedir: home });
    expect(tools.ios.missing).toEqual(["xcode_cli"]);
  });

  it("names Xcode and the simulator as missing when they fail or none is available", async () => {
    const tools = await detectTools(fakeRunner({ fail: ["xcodebuild", "xcrun simctl"] }), { platform: "darwin", env: baseEnv(), homedir: home });
    expect(tools.ios.xcode).toBeNull();
    expect(tools.ios.missing).toEqual(["xcode", "simulator"]);
  });

  it("lists only available iPhones, newest runtime first", async () => {
    const devices = {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "11111111-1111-1111-1111-111111111111", name: "iPhone 15", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { udid: "22222222-2222-2222-2222-222222222222", name: "iPhone 16 Pro", state: "Shutdown", isAvailable: true },
        { udid: "33333333-3333-3333-3333-333333333333", name: "iPad Air", state: "Shutdown", isAvailable: true },
        { udid: "44444444-4444-4444-4444-444444444444", name: "iPhone 16", state: "Shutdown", isAvailable: false },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "55555555-5555-5555-5555-555555555555", name: "Apple Watch", state: "Shutdown", isAvailable: true }],
    };
    const tools = await detectTools(fakeRunner({ devices }), { platform: "darwin", env: baseEnv(), homedir: home });
    expect(tools.ios.simulators.map((s) => [s.name, s.runtime])).toEqual([["iPhone 16 Pro", "iOS 18.2"], ["iPhone 15", "iOS 17.5"]]);
    expect(chooseSimulator(tools.ios.simulators)?.name).toBe("iPhone 16 Pro");
    expect(chooseSimulator([
      { udid: "a", name: "iPhone 16 Pro", state: "Shutdown", runtime: "iOS 18.2" },
      { udid: "b", name: "iPhone 15", state: "Booted", runtime: "iOS 17.5" },
    ])?.udid).toBe("b");
    expect(chooseSimulator([])).toBeNull();
  });

  it("names the Android SDK as missing with no SDK folder and no ANDROID_HOME", async () => {
    const tools = await detectTools(fakeRunner(), { platform: "darwin", env: baseEnv(), homedir: home });
    expect(tools.android.supported).toBe(true);
    expect(tools.android.sdk).toBe(false);
    expect(tools.android.missing).toContain("android_sdk");
  });

  it("lists the AVDs of a found SDK and gives the tools ANDROID_HOME", async () => {
    const sdk = join(home, "Library", "Android", "sdk");
    mkdirSync(sdk, { recursive: true });
    const calls: { tool: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const tools = await detectTools(fakeRunner({ avds: ["Pixel_9_API_35"] }, calls), { platform: "darwin", env: baseEnv(), homedir: home });
    expect(tools.android.sdk).toBe(true);
    expect(tools.android.avds).toEqual(["Pixel_9_API_35"]);
    expect(tools.android.missing).toEqual([]);
    const listing = calls.find((c) => c.tool === "emulator");
    expect(listing?.args).toEqual(["-list-avds"]);
    expect(listing?.env.ANDROID_HOME).toBe(sdk);
    expect(listing?.env.ANDROID_SDK_ROOT).toBe(sdk);
  });

  it("prefers ANDROID_HOME, and names a missing AVD and Gradle wrapper", async () => {
    const sdk = join(dir, "sdk");
    mkdirSync(sdk);
    const worktree = join(dir, "wt");
    mkdirSync(worktree);
    const tools = await detectTools(fakeRunner({ avds: [] }), { platform: "linux", env: { ...baseEnv(), ANDROID_HOME: sdk }, homedir: home, worktree });
    expect(tools.android.sdk).toBe(true);
    expect(tools.android.missing).toEqual(["avd", "gradle_wrapper"]);
    expect(tools.ios.supported).toBe(false);
    expect(tools.ios.missing).toEqual([]);
  });

  it("supports neither iOS nor Android on Windows, and runs nothing", async () => {
    const calls: { tool: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const tools = await detectTools(fakeRunner({}, calls), { platform: "win32", env: baseEnv(), homedir: home });
    expect(tools.platform).toBe("win32");
    expect(tools.ios.supported).toBe(false);
    expect(tools.android.supported).toBe(false);
    expect(calls).toEqual([]);
  });

  it("finds the default SDK folder per platform, and ignores a relative ANDROID_HOME", () => {
    const linuxSdk = join(home, "Android", "Sdk");
    mkdirSync(linuxSdk, { recursive: true });
    expect(androidSdkDir({ platform: "linux", env: {}, homedir: home })).toBe(linuxSdk);
    expect(androidSdkDir({ platform: "darwin", env: {}, homedir: home })).toBeNull();
    expect(androidSdkDir({ platform: "linux", env: { ANDROID_HOME: "relative/sdk" }, homedir: home })).toBe(linuxSdk);
    expect(androidSdkDir({ platform: "win32", env: {}, homedir: home })).toBeNull();
  });
});

describe("findAppTarget", () => {
  it("finds a single Xcode project", () => {
    mkdirSync(join(dir, "Trips.xcodeproj"));
    expect(findAppTarget(dir, "ios")).toEqual({ target: "Trips.xcodeproj", label: "Trips.xcodeproj" });
  });

  it("gives null for two projects", () => {
    mkdirSync(join(dir, "Trips.xcodeproj"));
    mkdirSync(join(dir, "Other.xcodeproj"));
    expect(findAppTarget(dir, "ios")).toBeNull();
  });

  it("prefers a workspace one level down, and ignores the one inside the project and Pods", () => {
    mkdirSync(join(dir, "ios", "Trips.xcodeproj", "project.xcworkspace"), { recursive: true });
    mkdirSync(join(dir, "ios", "Trips.xcworkspace"), { recursive: true });
    mkdirSync(join(dir, "ios", "Pods", "Pods.xcodeproj"), { recursive: true });
    expect(findAppTarget(dir, "ios")).toEqual({ target: "ios/Trips.xcworkspace", label: "Trips.xcworkspace" });
  });

  it("finds the single Android application module", () => {
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "build.gradle.kts"), 'plugins {\n  id("com.android.application")\n}\n');
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "build.gradle"), "plugins { id 'com.android.library' }\n");
    expect(findAppTarget(dir, "android")).toEqual({ target: "app", label: "app" });
    mkdirSync(join(dir, "wear"));
    writeFileSync(join(dir, "wear", "build.gradle"), "apply plugin: 'com.android.application'\n");
    expect(findAppTarget(dir, "android")).toBeNull();
  });

  it("gives null for an empty folder", () => {
    expect(findAppTarget(dir, "ios")).toBeNull();
    expect(findAppTarget(dir, "android")).toBeNull();
  });
});

describe("iosPlan", () => {
  const derivedData = () => join(dir, "data", "build", "run-1");

  it("leaves out the boot for a booted device and builds with separate arguments", () => {
    mkdirSync(join(dir, "Trips.xcodeproj"));
    const plan = iosPlan({ worktree: dir, target: "Trips.xcodeproj", simulator: { udid: UDID, name: "iPhone 16", state: "Booted" }, derivedData: derivedData() });
    expect(plan.commands[0]).toEqual([
      "xcodebuild", "-project", "Trips.xcodeproj", "-scheme", "Trips", "-sdk", "iphonesimulator",
      "-destination", "platform=iOS Simulator,name=iPhone 16", "-derivedDataPath", derivedData(), "build",
    ]);
    expect(plan.commands.slice(-2).length).toBe(2);
    expect(plan.commands.some((c) => c.includes("boot"))).toBe(false);
    expect(plan.commands).toContainEqual(["open", "-a", "Simulator"]);
    const plutil = plan.commands.findIndex((c) => c[0] === "plutil");
    const install = plan.commands.findIndex((c) => c.join(" ").startsWith("xcrun simctl install"));
    expect(plutil).toBeGreaterThan(0);
    expect(plutil).toBeLessThan(install);
    expect(plan.commands[install]).toEqual(["xcrun", "simctl", "install", UDID, "{{app}}"]);
    expect(plan.commands.at(-1)).toEqual(["xcrun", "simctl", "launch", UDID, "{{bundleId}}"]);
    expect(plan.files).toEqual(["Trips.xcodeproj/project.pbxproj"]);
  });

  it("boots a shut-down device, and uses a workspace's scheme and its build files", () => {
    mkdirSync(join(dir, "ios", "Trips.xcworkspace"), { recursive: true });
    mkdirSync(join(dir, "ios", "Trips.xcodeproj"), { recursive: true });
    writeFileSync(join(dir, "ios", "Podfile.lock"), "PODFILE CHECKSUM: x\n");
    const plan = iosPlan({ worktree: dir, target: "ios/Trips.xcworkspace", simulator: { udid: UDID, name: "iPhone 16", state: "Shutdown" }, derivedData: derivedData() });
    expect(plan.commands[0].slice(0, 5)).toEqual(["xcodebuild", "-workspace", "ios/Trips.xcworkspace", "-scheme", "Trips"]);
    expect(plan.commands[1]).toEqual(["xcrun", "simctl", "boot", UDID]);
    expect(plan.files).toEqual(["ios/Trips.xcodeproj/project.pbxproj", "ios/Trips.xcworkspace/contents.xcworkspacedata", "ios/Podfile.lock"]);
  });

  it("uses any other target as a scheme of the single project", () => {
    mkdirSync(join(dir, "Trips.xcodeproj"));
    const plan = iosPlan({ worktree: dir, target: "TripsDev", simulator: { udid: UDID, name: "iPhone 16", state: "Booted" }, derivedData: derivedData() });
    expect(plan.commands[0].slice(0, 5)).toEqual(["xcodebuild", "-project", "Trips.xcodeproj", "-scheme", "TripsDev"]);
  });

  it("refuses a target that reads as an option or leaves the working copy", () => {
    const sim = { udid: UDID, name: "iPhone 16", state: "Booted" };
    expect(() => iosPlan({ worktree: dir, target: "-exportArchive", simulator: sim, derivedData: derivedData() })).toThrow(TypeError);
    expect(() => iosPlan({ worktree: dir, target: "../x/Trips.xcodeproj", simulator: sim, derivedData: derivedData() })).toThrow(TypeError);
  });
});

describe("androidPlan", () => {
  it("runs the worktree's gradlew directly, then the emulator, install and launch", () => {
    const plan = androidPlan({ worktree: dir, module: "app", avd: "Pixel_9_API_35", sdk: join(dir, "sdk") });
    expect(plan.commands).toEqual([
      [join(dir, "gradlew"), ":app:assembleDebug"],
      ["emulator", "-avd", "Pixel_9_API_35"],
      ["adb", "wait-for-device"],
      ["adb", "install", "-r", "{{apk}}"],
      ["adb", "shell", "monkey", "-p", "{{package}}", "1"],
    ]);
    expect(plan.files).toEqual(["settings.gradle", "build.gradle", "app/build.gradle", "gradle/wrapper/gradle-wrapper.properties", "gradlew"]);
  });

  it("names the Kotlin build files when they are the ones present, and refuses a bad module", () => {
    writeFileSync(join(dir, "settings.gradle.kts"), "");
    writeFileSync(join(dir, "build.gradle.kts"), "");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "build.gradle.kts"), "");
    const plan = androidPlan({ worktree: dir, module: "app", avd: "Pixel_9_API_35", sdk: join(dir, "sdk") });
    expect(plan.files.slice(0, 3)).toEqual(["settings.gradle.kts", "build.gradle.kts", "app/build.gradle.kts"]);
    expect(() => androidPlan({ worktree: dir, module: "../app", avd: "Pixel_9_API_35", sdk: "" })).toThrow(TypeError);
    expect(() => androidPlan({ worktree: dir, module: "app", avd: "-wipe-data", sdk: "" })).toThrow(TypeError);
  });

  it("fills the package from readAndroidOutput after a fake build", async () => {
    const plan = androidPlan({ worktree: dir, module: "app", avd: "Pixel_9_API_35", sdk: join(dir, "sdk") });
    const run = fakeRunner({ applicationId: "com.example.trips" });
    const [file, ...args] = plan.commands[0];
    expect((await run(file, args, { cwd: dir, env: baseEnv(), timeoutMs: 10_000 })).code).toBe(0);
    const out = readAndroidOutput(dir, "app");
    expect(out).toEqual({ apk: join(dir, "app", "build", "outputs", "apk", "debug", "app-debug.apk"), applicationId: "com.example.trips" });
    expect(fillPlaceholders(plan.commands[4], { package: out.applicationId })).toEqual(["adb", "shell", "monkey", "-p", "com.example.trips", "1"]);
    expect(fillPlaceholders(plan.commands[3], { apk: out.apk })).toEqual(["adb", "install", "-r", out.apk]);
    expect(() => fillPlaceholders(plan.commands[4], {})).toThrow(TypeError);
  });

  it("fails the build when the output is missing, ambiguous or points outside", () => {
    expect(() => readAndroidOutput(dir, "app")).toThrow(PreviewFailedError);
    const out = join(dir, "app", "build", "outputs", "apk", "debug");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "a.apk"), "x");
    writeFileSync(join(out, "b.apk"), "x");
    const meta = (elements: unknown[], applicationId = "com.example.trips") => writeFileSync(join(out, "output-metadata.json"), JSON.stringify({ applicationId, elements }));
    meta([{ outputFile: "a.apk" }, { outputFile: "b.apk" }]);
    expect(() => readAndroidOutput(dir, "app")).toThrow(PreviewFailedError);
    meta([{ outputFile: "../../../../../evil.apk" }]);
    expect(() => readAndroidOutput(dir, "app")).toThrow(PreviewFailedError);
    meta([{ outputFile: "a.apk" }], "-n com.x/.Evil");
    expect(() => readAndroidOutput(dir, "app")).toThrow(PreviewFailedError);
    meta([{ outputFile: "a.apk" }]);
    expect(readAndroidOutput(dir, "app").apk).toBe(join(out, "a.apk"));
    try {
      meta([]);
      readAndroidOutput(dir, "app");
    } catch (e) {
      expect((e as PreviewFailedError).reason).toBe("build_failed");
    }
  });
});

describe("findIosApp and the bundle id", () => {
  it("finds the one app a fake build wrote, and reads its bundle id with plutil", async () => {
    mkdirSync(join(dir, "Trips.xcodeproj"));
    const derivedData = join(dir, "dd");
    const plan = iosPlan({ worktree: dir, target: "Trips.xcodeproj", simulator: { udid: UDID, name: "iPhone 16", state: "Booted" }, derivedData });
    const run = fakeRunner({ bundleId: "com.example.trips" });
    const [tool, ...args] = plan.commands[0];
    expect((await run(tool, args, { cwd: dir, env: baseEnv(), timeoutMs: 10_000 })).code).toBe(0);
    const app = findIosApp(derivedData);
    expect(app).toBe(join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Trips.app"));
    const plutil = plan.commands.find((c) => c[0] === "plutil")!;
    const filled = fillPlaceholders(plutil, { app, plist: join(app, "Info.plist") });
    const r = await run(filled[0], filled.slice(1), { cwd: dir, env: baseEnv(), timeoutMs: 10_000 });
    expect(bundleIdFrom(r.stdout)).toBe("com.example.trips");
  });

  it("fails the build for no app or two, and refuses a bundle id that is not one", () => {
    expect(() => findIosApp(join(dir, "dd"))).toThrow(PreviewFailedError);
    const products = join(dir, "dd", "Build", "Products", "Debug-iphonesimulator");
    mkdirSync(join(products, "A.app"), { recursive: true });
    mkdirSync(join(products, "B.app"), { recursive: true });
    expect(() => findIosApp(join(dir, "dd"))).toThrow(PreviewFailedError);
    expect(() => bundleIdFrom("--console\n")).toThrow(PreviewFailedError);
    expect(() => bundleIdFrom("")).toThrow(PreviewFailedError);
  });
});

describe("buildCount", () => {
  it("reads the build tool's own N of M counts", () => {
    expect(buildCount("[ 12/80] Compiling")).toEqual({ n: 12, m: 80 });
    expect(buildCount("  [3 / 7] Linking")).toEqual({ n: 3, m: 7 });
    expect(buildCount("12 of 80")).toBeNull();
    expect(buildCount("[9/0] nothing")).toBeNull();
    expect(buildCount("[90/80] past the end")).toBeNull();
  });
});

describe("realTools", () => {
  it("never finds a program that is not on its list, nor a .cmd", async () => {
    const run = realTools("darwin");
    const r = await run("rm", ["-rf", dir], { env: baseEnv(), timeoutMs: 5_000 });
    expect(r.code).toBeNull();
    expect(readFileSync(FAKE, "utf8").length).toBeGreaterThan(0);
    const cmd = await realTools("win32")(join(dir, "gradlew.cmd"), [], { env: baseEnv(), timeoutMs: 5_000 });
    expect(cmd.code).toBeNull();
  });
});
