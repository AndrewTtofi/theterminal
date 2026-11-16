import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, posix } from "node:path";
import type { NativeTools, PreviewFailure, ToolId } from "@theterminal/shared";
import { which } from "../agents/which.js";

// Phone app previews: which native tools this computer has, which app a working copy holds, and the argument-array
// plans that build and open it (spec "Phone app preview"; plan 12 Rulings 14, 15 and 24). Nothing here runs a shell.

export type { NativeTools, PreviewFailure, ToolId };

/** An iPhone simulator `xcrun simctl list devices --json` lists. */
export type Simulator = NativeTools["ios"]["simulators"][number];

/** A preview stage failed; `reason` is the fixed code shown to the person. */
export class PreviewFailedError extends Error {
  constructor(readonly reason: PreviewFailure) {
    super(`preview failed: ${reason}`);
    this.name = "PreviewFailedError";
  }
}

/**
 * Runs one native tool by its logical name (`xcrun`, `adb`, …) or an absolute path (the worktree's `gradlew`), with an
 * argument array and never a shell. `code` is null when the tool was not found, timed out or was killed.
 */
export type ToolRunner = (
  tool: string,
  args: string[],
  o: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Ruling 24's timeouts. */
export const NATIVE_TIMEOUTS = {
  detectMs: 15_000,
  buildMs: 1_200_000,
  bootMs: 300_000,
  bootPollMs: 2_000,
  installMs: 120_000,
  openMs: 60_000,
} as const;

/** Enough for a simulator listing or a build's output; a larger answer is cut and the tool killed. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The tools found on PATH. `adb` and `emulator` are found under the SDK instead. */
const PATH_TOOLS = new Set(["xcode-select", "xcrun", "xcodebuild", "plutil", "open"]);
/** Never run, whatever finds them. */
const SCRIPT_EXT = /\.(cmd|bat|ps1)$/i;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The SDK folder a child environment names (ANDROID_HOME, then ANDROID_SDK_ROOT), when absolute and a directory. */
function sdkFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const v of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (v && isAbsolute(v) && isDir(v)) return v;
  }
  return null;
}

/**
 * The file a logical tool name runs, or null: `xcode-select`, `xcrun`, `xcodebuild`, `plutil` and `open` on PATH;
 * `adb` and `emulator` under the SDK the environment names; an absolute path to an existing file as it is (the
 * worktree's `gradlew`). A `.cmd`, `.bat` or `.ps1` is never returned.
 */
export function resolveTool(tool: string, o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): string | null {
  const exe = o.platform === "win32" ? ".exe" : "";
  let file: string | null = null;
  if (PATH_TOOLS.has(tool)) file = which(tool, { env: o.env, platform: o.platform });
  else if (tool === "adb" || tool === "emulator") {
    const sdk = sdkFromEnv(o.env);
    const candidate = sdk === null ? null : join(sdk, tool === "adb" ? "platform-tools" : "emulator", tool + exe);
    file = candidate !== null && isFile(candidate) ? candidate : null;
  } else if (isAbsolute(tool) && isFile(tool)) file = tool;
  return file === null || SCRIPT_EXT.test(file) ? null : file;
}

/** A ToolRunner over the real programs (resolveTool), each run with `execFile`: an argument array, no shell. */
export function realTools(platform: NodeJS.Platform): ToolRunner {
  return (tool, args, o) =>
    new Promise((resolve) => {
      const file = resolveTool(tool, { platform, env: o.env });
      if (file === null) {
        resolve({ code: null, stdout: "", stderr: "" });
        return;
      }
      execFile(
        file,
        args,
        { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/**
 * The Android SDK folder: ANDROID_HOME, then ANDROID_SDK_ROOT, then `~/Library/Android/sdk` (macOS) or
 * `~/Android/Sdk` (Linux), the first that is an absolute existing directory. Null on Windows (Android previews are not
 * offered there in this version).
 */
export function androidSdkDir(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homedir: string }): string | null {
  if (o.platform === "win32") return null;
  const fromEnv = sdkFromEnv(o.env);
  if (fromEnv !== null) return fromEnv;
  const fallback = o.platform === "darwin" ? join(o.homedir, "Library", "Android", "sdk") : join(o.homedir, "Android", "Sdk");
  return isAbsolute(fallback) && isDir(fallback) ? fallback : null;
}

/**
 * Ruling 14 for native builds: the child environment plus ANDROID_HOME and ANDROID_SDK_ROOT (the detected SDK) and
 * JAVA_HOME from `server` when it is an existing absolute directory. `child` is copied, never changed.
 */
export function nativeEnv(child: NodeJS.ProcessEnv, o: { sdk: string | null; server?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const env = { ...child };
  if (o.sdk !== null) {
    env.ANDROID_HOME = o.sdk;
    env.ANDROID_SDK_ROOT = o.sdk;
  }
  const java = o.server?.JAVA_HOME;
  if (java && isAbsolute(java) && isDir(java)) env.JAVA_HOME = java;
  return env;
}

const clip = (s: string, n: number): string => s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, n);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/;
const AVD_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The available iPhones of `xcrun simctl list devices --json`, newest iOS runtime first. */
function parseSimulators(stdout: string): Simulator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) return [];
  const runtimes: { version: number[]; label: string; devices: unknown[] }[] = [];
  for (const [key, devices] of Object.entries(parsed.devices)) {
    const m = IOS_RUNTIME.exec(key);
    if (!m || !Array.isArray(devices)) continue;
    const version = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    runtimes.push({ version, label: `iOS ${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ""}`, devices });
  }
  runtimes.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  const out: Simulator[] = [];
  for (const r of runtimes) {
    for (const d of r.devices) {
      if (!isRecord(d) || d.isAvailable === false) continue;
      if (typeof d.udid !== "string" || !UDID.test(d.udid) || typeof d.name !== "string" || typeof d.state !== "string") continue;
      const name = clip(d.name, 100);
      if (!name.startsWith("iPhone")) continue;
      out.push({ udid: d.udid, name, state: clip(d.state, 40), runtime: r.label });
    }
  }
  return out;
}

/** Ruling 24: the booted iPhone, else the first available iPhone of the newest iOS runtime (the list's order). */
export function chooseSimulator<T extends { state: string }>(simulators: T[]): T | null {
  return simulators.find((s) => s.state === "Booted") ?? simulators[0] ?? null;
}

/**
 * What this computer has for phone app previews. iOS (macOS only): `xcode-select -p`, `xcodebuild -version` and
 * `xcrun simctl list devices --json`. Android (macOS and Linux): the SDK folder, `adb version`, `emulator -list-avds`
 * and the worktree's `gradlew` (only checked when a worktree is given). Each command gets 15 s. `env` is the
 * environment the SDK is looked up in and the tools get, with ANDROID_HOME and ANDROID_SDK_ROOT set to the SDK found.
 */
export async function detectTools(
  run: ToolRunner,
  o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homedir: string; worktree?: string },
): Promise<NativeTools> {
  const platform: NativeTools["platform"] = o.platform === "darwin" || o.platform === "win32" ? o.platform : "linux";
  const timeoutMs = NATIVE_TIMEOUTS.detectMs;
  const ok = async (tool: string, args: string[], env: NodeJS.ProcessEnv) => {
    const r = await run(tool, args, { env, timeoutMs, cwd: o.worktree });
    return r.code === 0 ? r.stdout : null;
  };

  const ios: NativeTools["ios"] = { supported: platform === "darwin", xcode: null, simulators: [], missing: [] };
  if (ios.supported) {
    const [select, version, list] = await Promise.all([
      ok("xcode-select", ["-p"], o.env),
      ok("xcodebuild", ["-version"], o.env),
      ok("xcrun", ["simctl", "list", "devices", "--json"], o.env),
    ]);
    const first = version?.split(/\r?\n/)[0]?.trim() ?? "";
    ios.xcode = /^Xcode \d{1,3}(\.\d{1,3}){0,2}$/.test(first) ? first : null;
    ios.simulators = list === null ? [] : parseSimulators(list);
    if (ios.xcode === null) ios.missing.push("xcode");
    if (select === null || select.trim() === "") ios.missing.push("xcode_cli");
    if (ios.simulators.length === 0) ios.missing.push("simulator");
  }

  const android: NativeTools["android"] = { supported: platform !== "win32", sdk: false, avds: [], missing: [] };
  if (android.supported) {
    const sdk = androidSdkDir(o);
    android.sdk = sdk !== null;
    if (sdk === null) android.missing.push("android_sdk");
    else {
      const env = nativeEnv(o.env, { sdk });
      const [adb, avds] = await Promise.all([ok("adb", ["version"], env), ok("emulator", ["-list-avds"], env)]);
      android.avds = (avds ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => AVD_NAME.test(l));
      if (adb === null) android.missing.push("adb");
      if (avds === null) android.missing.push("emulator");
      else if (android.avds.length === 0) android.missing.push("avd");
    }
    if (o.worktree !== undefined && !isFile(join(o.worktree, "gradlew"))) android.missing.push("gradle_wrapper");
  }
  return { platform, ios, android };
}

/** Folders never searched for an app: dependencies, build output and CocoaPods' own project. */
const SKIP_DIRS = new Set(["node_modules", "Pods", "build", "DerivedData"]);
const XCODE_BUNDLE = /\.(xcodeproj|xcworkspace)$/;

/** The directory names in `dir`, skipping hidden ones; [] when it cannot be read. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The Gradle build file of a folder: `build.gradle.kts` or `build.gradle`, whichever exists (the Groovy name if neither). */
function gradleFile(worktree: string, rel: string, name: "build" | "settings"): string {
  const kts = posix.join(rel, `${name}.gradle.kts`);
  return existsSync(join(worktree, kts)) ? kts : posix.join(rel, `${name}.gradle`);
}

/**
 * The app a working copy holds, when there is exactly one. iOS: the single `.xcworkspace` in the top two levels, else
 * the single `.xcodeproj` (never looking inside either). Android: the single top-level module whose
 * `build.gradle(.kts)` applies `com.android.application`. `target` is relative to the worktree, with `/`.
 */
export function findAppTarget(worktree: string, kind: "ios" | "android"): { target: string; label: string } | null {
  const top = subdirs(worktree);
  if (kind === "ios") {
    const found: string[] = [];
    for (const name of top) {
      if (XCODE_BUNDLE.test(name)) found.push(name);
      else if (!SKIP_DIRS.has(name)) for (const inner of subdirs(join(worktree, name))) if (XCODE_BUNDLE.test(inner)) found.push(posix.join(name, inner));
    }
    const workspaces = found.filter((f) => f.endsWith(".xcworkspace"));
    const projects = found.filter((f) => f.endsWith(".xcodeproj"));
    const pick = workspaces.length > 0 ? workspaces : projects;
    return pick.length === 1 ? { target: pick[0], label: posix.basename(pick[0]) } : null;
  }
  const modules = top.filter((name) => {
    if (SKIP_DIRS.has(name) || !MODULE.test(name)) return false;
    try {
      return /com\.android\.application/.test(readFileSync(join(worktree, gradleFile(worktree, name, "build")), "utf8"));
    } catch {
      return false;
    }
  });
  return modules.length === 1 ? { target: modules[0], label: modules[0] } : null;
}

/** A scheme name or a relative project path inside the worktree: no option-like or parent segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9_](?:[A-Za-z0-9 _.+-]{0,98}[A-Za-z0-9_.+-])?$/;
const MODULE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

function assertIosTarget(target: string): void {
  const parts = target.split("/");
  if (target.length > 200 || parts.some((p) => !SAFE_SEGMENT.test(p) || p === "." || p === "..")) {
    throw new TypeError("not an iOS target");
  }
  if (parts.length > 1 && !XCODE_BUNDLE.test(target)) throw new TypeError("not an iOS target");
}

/**
 * The iOS build-and-run plan, to run with the worktree as cwd (Ruling 24 and the spec's five stages):
 * `xcodebuild … build`, `xcrun simctl boot` (left out for a booted device), `open -a Simulator`, then
 * `plutil -extract CFBundleIdentifier …`, `xcrun simctl install` and `xcrun simctl launch`. `{{app}}`, `{{plist}}` and
 * `{{bundleId}}` are filled at run time (fillPlaceholders) from findIosApp and bundleIdFrom. `files` are the build files
 * the confirmation key hashes, relative with `/`.
 */
export function iosPlan(o: {
  worktree: string;
  target: string;
  simulator: { udid: string; name: string; state: string };
  derivedData: string;
}): { commands: string[][]; files: string[] } {
  assertIosTarget(o.target);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(o.simulator.udid)) throw new TypeError("not a simulator id");
  let container: string | null = XCODE_BUNDLE.test(o.target) ? o.target : null;
  const scheme = container === null ? o.target : posix.basename(container).replace(XCODE_BUNDLE, "");
  if (container === null) container = findAppTarget(o.worktree, "ios")?.target ?? null; // a scheme of the single project

  const project = container === null ? [] : [container.endsWith(".xcworkspace") ? "-workspace" : "-project", container];
  const files: string[] = [];
  if (container !== null) {
    const parent = posix.dirname(container);
    const base = posix.basename(container).replace(XCODE_BUNDLE, "");
    if (container.endsWith(".xcworkspace")) {
      const sibling = posix.join(parent, `${base}.xcodeproj`);
      const projects = subdirs(join(o.worktree, ...parent.split("/"))).filter((n) => n.endsWith(".xcodeproj"));
      const chosen = isDir(join(o.worktree, sibling)) ? sibling : projects.length === 1 ? posix.join(parent, projects[0]) : null;
      if (chosen !== null) files.push(posix.join(chosen, "project.pbxproj"));
      files.push(posix.join(container, "contents.xcworkspacedata"));
    } else files.push(posix.join(container, "project.pbxproj"));
    const podfileLock = posix.join(parent, "Podfile.lock");
    if (isFile(join(o.worktree, ...podfileLock.split("/")))) files.push(podfileLock);
  }

  const { udid, name } = o.simulator;
  const commands: string[][] = [
    ["xcodebuild", ...project, "-scheme", scheme, "-sdk", "iphonesimulator", "-destination", `platform=iOS Simulator,name=${name}`, "-derivedDataPath", o.derivedData, "build"],
  ];
  if (o.simulator.state !== "Booted") commands.push(["xcrun", "simctl", "boot", udid]);
  commands.push(
    ["open", "-a", "Simulator"],
    ["plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", "{{plist}}"],
    ["xcrun", "simctl", "install", udid, "{{app}}"],
    ["xcrun", "simctl", "launch", udid, "{{bundleId}}"],
  );
  return { commands, files };
}

/**
 * The Android build-and-run plan (macOS and Linux), to run with the worktree as cwd: the worktree's `gradlew`, run
 * directly, `:<module>:assembleDebug`; `emulator -avd <name>`; `adb wait-for-device`; `adb install -r {{apk}}`; and
 * `adb shell monkey -p {{package}} 1`. `{{apk}}` and `{{package}}` come from readAndroidOutput after the build. The
 * caller polls `adb shell getprop sys.boot_completed` between the wait and the install. `sdk` is where `adb` and
 * `emulator` are found (nativeEnv).
 */
export function androidPlan(o: { worktree: string; module: string; avd: string; sdk: string }): { commands: string[][]; files: string[] } {
  if (!MODULE.test(o.module) || o.module === "." || o.module === "..") throw new TypeError("not a module");
  if (!AVD_NAME.test(o.avd) || o.avd.startsWith("-")) throw new TypeError("not an AVD name");
  const commands = [
    [join(o.worktree, "gradlew"), `:${o.module}:assembleDebug`],
    ["emulator", "-avd", o.avd],
    ["adb", "wait-for-device"],
    ["adb", "install", "-r", "{{apk}}"],
    ["adb", "shell", "monkey", "-p", "{{package}}", "1"],
  ];
  const files = [
    gradleFile(o.worktree, "", "settings"),
    gradleFile(o.worktree, "", "build"),
    gradleFile(o.worktree, o.module, "build"),
    "gradle/wrapper/gradle-wrapper.properties",
    "gradlew",
  ];
  return { commands, files };
}

/** `cmd` with each `{{name}}` argument replaced; a TypeError when a placeholder has no value. */
export function fillPlaceholders(cmd: string[], values: Record<string, string>): string[] {
  return cmd.map((arg) => {
    const m = /^\{\{(\w+)\}\}$/.exec(arg);
    if (!m) return arg;
    const v = values[m[1]];
    if (v === undefined) throw new TypeError(`no value for ${m[1]}`);
    return v;
  });
}

/** A Java package name, as applicationId and CFBundleIdentifier are (never option-like). */
const APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)+$/;

/**
 * The APK and package a debug build wrote: `<module>/build/outputs/apk/debug/output-metadata.json`, with exactly one
 * element whose `outputFile` is a plain `.apk` file name in that folder. PreviewFailedError("build_failed") otherwise.
 */
export function readAndroidOutput(worktree: string, module: string): { apk: string; applicationId: string } {
  const fail = () => new PreviewFailedError("build_failed");
  if (!MODULE.test(module)) throw fail();
  const dir = join(worktree, module, "build", "outputs", "apk", "debug");
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(dir, "output-metadata.json"), "utf8"));
  } catch {
    throw fail();
  }
  if (!isRecord(meta) || !Array.isArray(meta.elements) || meta.elements.length !== 1) throw fail();
  const element: unknown = meta.elements[0];
  const outputFile = isRecord(element) ? element.outputFile : undefined;
  const applicationId = meta.applicationId;
  if (typeof outputFile !== "string" || basename(outputFile) !== outputFile || extname(outputFile) !== ".apk" || outputFile.includes("\\")) throw fail();
  if (typeof applicationId !== "string" || applicationId.length > 200 || !APP_ID.test(applicationId)) throw fail();
  const apk = join(dir, outputFile);
  if (!isFile(apk)) throw fail();
  return { apk, applicationId };
}

/** The single `*.app` under `<derivedData>/Build/Products/Debug-iphonesimulator`; PreviewFailedError("build_failed") otherwise. */
export function findIosApp(derivedData: string): string {
  const products = join(derivedData, "Build", "Products", "Debug-iphonesimulator");
  const apps = subdirs(products).filter((n) => n.endsWith(".app"));
  if (apps.length !== 1) throw new PreviewFailedError("build_failed");
  return join(products, apps[0]);
}

/** The bundle id `plutil -extract CFBundleIdentifier raw -o - …` printed; PreviewFailedError("build_failed") unless it is one. */
export function bundleIdFrom(stdout: string): string {
  const id = stdout.trim();
  if (id.length > 200 || !APP_ID.test(id)) throw new PreviewFailedError("build_failed");
  return id;
}

/** A build tool's own `[ N/M]` count at the start of a line (Ruling 15), or null. */
export function buildCount(line: string): { n: number; m: number } | null {
  const match = /^\s*\[\s*(\d+)\s*\/\s*(\d+)\s*\]/.exec(line);
  if (!match) return null;
  const n = Number(match[1]);
  const m = Number(match[2]);
  return m >= 1 && n <= m && Number.isSafeInteger(m) ? { n, m } : null;
}
