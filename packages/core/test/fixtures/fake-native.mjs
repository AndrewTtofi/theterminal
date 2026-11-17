#!/usr/bin/env node
// A scripted fake of the native tools a phone app preview runs, with no dependencies, so CI never needs Xcode or the
// Android SDK. Run as `node fake-native.mjs <tool> <args…>`; <tool> is one of xcode-select, xcrun, xcodebuild, plutil,
// open, adb, emulator or gradlew.
//
// THETERMINAL_FAKE_NATIVE: JSON, every field optional:
//   fail:          string[]  // "<tool>" or "<tool> <first argument>" (e.g. "xcrun simctl", "adb install"): exit 1
//   hang:          string[]  // "<tool> <first> <second argument>" (e.g. "xcrun simctl terminate"): never answers
//   xcode:         string    // the version `xcodebuild -version` prints (default "17.0")
//   developerDir:  string    // what `xcode-select -p` prints
//   devices:       object    // `xcrun simctl list devices --json`'s "devices" map (default: one booted iPhone 16, iOS 18.0)
//   avds:          string[]  // what `emulator -list-avds` prints, one per line (default none)
//   bundleId:      string    // CFBundleIdentifier of the .app xcodebuild writes (default "com.example.trips")
//   applicationId: string    // applicationId in the output-metadata.json gradlew writes (default "com.example.trips")
//   buildLines:    string[]  // printed by a build, before it finishes
//   log:           string    // a file that gets one JSON line { tool, args, cwd } per call
//   adbDevices:    string[]  // the "<serial>\t<state>" lines `adb devices` lists (default none)
//   emulatorState: string    // a file `emulator -avd` writes once it runs; while it exists, `adb devices` also lists
//                            // "emulator-5556\tdevice" (the emulator this fake booted)
//
// An adb call may name its device first (`adb -s <serial> …`); the fake reads the rest as it would without it.
//
// A build writes what a real one would: xcodebuild `build` writes
// <derivedDataPath>/Build/Products/Debug-iphonesimulator/<scheme>.app/Info.plist, and gradlew `:<m>:assembleDebug`
// writes <cwd>/<m>/build/outputs/apk/debug/<m>-debug.apk and output-metadata.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tool, ...given] = process.argv.slice(2);
const args = tool === "adb" && given[0] === "-s" ? given.slice(2) : given;
const script = JSON.parse(process.env.THETERMINAL_FAKE_NATIVE || "{}");

if (script.log) appendFileSync(script.log, JSON.stringify({ tool, args: given, cwd: process.cwd() }) + "\n");

const fail = script.fail ?? [];
if (fail.includes(tool) || fail.includes(`${tool} ${args[0] ?? ""}`)) {
  process.stderr.write(`${tool}: fake failure\n`);
  process.exit(1);
}

if ((script.hang ?? []).includes(`${tool} ${args[0] ?? ""} ${args[1] ?? ""}`)) {
  // A tool that never answers, until it is killed.
  await new Promise(() => setInterval(() => undefined, 1000));
}

/** A 1×1 PNG, as a screenshot. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082",
  "hex",
);

const DEFAULT_DEVICES = {
  "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
    { udid: "0B0E0C2A-1D2F-4E8A-9C3B-5A6D7E8F9012", name: "iPhone 16", state: "Booted", isAvailable: true },
  ],
};

const out = (s) => process.stdout.write(s);
const after = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const done = (code = 0) => process.exit(code);
const unknown = () => {
  process.stderr.write(`fake-native: no fake for ${tool} ${args.join(" ")}\n`);
  process.exit(127);
};

function printBuildLines() {
  for (const line of script.buildLines ?? []) out(line + "\n");
}

switch (tool) {
  case "xcode-select":
    if (args[0] === "-p") out((script.developerDir ?? "/Applications/Xcode.app/Contents/Developer") + "\n");
    else unknown();
    done();
    break;
  case "xcodebuild": {
    if (args[0] === "-version") {
      out(`Xcode ${script.xcode ?? "17.0"}\nBuild version 17A324\n`);
      done();
    }
    if (args.at(-1) !== "build") unknown();
    printBuildLines();
    const derived = after("-derivedDataPath");
    const scheme = after("-scheme");
    if (!derived || !scheme) unknown();
    const app = join(derived, "Build", "Products", "Debug-iphonesimulator", `${scheme}.app`);
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${script.bundleId ?? "com.example.trips"}</string>\n</dict>\n</plist>\n`,
    );
    out("** BUILD SUCCEEDED **\n");
    done();
    break;
  }
  case "plutil": {
    // plutil -extract CFBundleIdentifier raw -o - <file>
    if (args[0] !== "-extract" || args[2] !== "raw") unknown();
    const text = readFileSync(args.at(-1), "utf8");
    const m = new RegExp(`<key>${args[1]}</key>\\s*<string>([^<]*)</string>`).exec(text);
    if (!m) {
      process.stderr.write(`Could not extract value\n`);
      done(1);
    }
    out(m[1] + "\n");
    done();
    break;
  }
  case "xcrun": {
    if (args[0] !== "simctl") unknown();
    const sub = args[1];
    if (sub === "list") {
      out(JSON.stringify({ devices: script.devices ?? DEFAULT_DEVICES }, null, 2) + "\n");
      done();
    }
    if (sub === "io" && args[3] === "screenshot") {
      writeFileSync(args[4], PNG);
      out("Wrote screenshot\n");
      done();
    }
    if (sub === "launch") out(`${args[3]}: 4242\n`);
    if (["boot", "install", "launch", "terminate", "shutdown"].includes(sub)) done();
    unknown();
    break;
  }
  case "open":
    if (args[0] === "-a") done();
    unknown();
    break;
  case "adb": {
    const sub = args[0];
    if (sub === "version") {
      out("Android Debug Bridge version 1.0.41\n");
      done();
    }
    if (sub === "devices") {
      out("List of devices attached\n");
      for (const line of script.adbDevices ?? []) out(line + "\n");
      if (script.emulatorState && existsSync(script.emulatorState)) out("emulator-5556\tdevice\n");
      out("\n");
      done();
    }
    if (sub === "wait-for-device") done();
    if (sub === "install") {
      out("Performing Streamed Install\nSuccess\n");
      done();
    }
    if (sub === "shell" && args[1] === "getprop") {
      out("1\n");
      done();
    }
    if (sub === "shell" && (args[1] === "monkey" || args[1] === "am")) {
      out("Events injected: 1\n");
      done();
    }
    if (sub === "exec-out" && args[1] === "screencap") {
      process.stdout.write(PNG, () => done());
      break;
    }
    if (sub === "emu" && args[1] === "kill") done();
    unknown();
    break;
  }
  case "emulator": {
    if (args[0] === "-list-avds") {
      for (const a of script.avds ?? []) out(a + "\n");
      done();
    }
    if (args[0] === "-avd") {
      // A real emulator keeps running; this one waits to be killed, for a minute at most.
      out(`INFO    | Booting ${args[1]}\n`);
      if (script.emulatorState) writeFileSync(script.emulatorState, "booted");
      setTimeout(() => done(), 60_000);
      break;
    }
    unknown();
    break;
  }
  case "gradlew": {
    const m = /^:([A-Za-z0-9_.-]+):assembleDebug$/.exec(args[0] ?? "");
    if (!m) unknown();
    printBuildLines();
    const module = m[1];
    const dir = join(process.cwd(), module, "build", "outputs", "apk", "debug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${module}-debug.apk`), "fake apk");
    writeFileSync(
      join(dir, "output-metadata.json"),
      JSON.stringify({
        version: 3,
        artifactType: { type: "APK", kind: "Directory" },
        applicationId: script.applicationId ?? "com.example.trips",
        variantName: "debug",
        elements: [{ type: "SINGLE", filters: [], versionCode: 1, versionName: "1.0", outputFile: `${module}-debug.apk` }],
        elementType: "File",
      }),
    );
    out("BUILD SUCCESSFUL in 1s\n");
    done();
    break;
  }
  default:
    unknown();
}
