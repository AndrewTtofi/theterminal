import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectTools, realTools } from "../../src/preview/native.js";

// Opt-in checks against the real Xcode and Android SDK of this computer. CI never sets these; it uses fake-native.mjs.
const LIVE_IOS = process.env.THETERMINAL_LIVE_IOS === "1";
const LIVE_ANDROID = process.env.THETERMINAL_LIVE_ANDROID === "1";
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT });

describe.skipIf(!LIVE_IOS)("the real Xcode (THETERMINAL_LIVE_IOS=1)", () => {
  it("finds Xcode and at least one iPhone simulator", async () => {
    const tools = await detectTools(realTools(process.platform), { platform: process.platform, env: env(), homedir: homedir() });
    expect(tools.ios.supported).toBe(true);
    expect(tools.ios.xcode).toMatch(/^Xcode \d+/);
    expect(tools.ios.missing).toEqual([]);
  }, 60_000);
});

describe.skipIf(!LIVE_ANDROID)("the real Android SDK (THETERMINAL_LIVE_ANDROID=1)", () => {
  it("finds the SDK, adb, the emulator and an AVD", async () => {
    const tools = await detectTools(realTools(process.platform), { platform: process.platform, env: env(), homedir: homedir() });
    expect(tools.android.supported).toBe(true);
    expect(tools.android.sdk).toBe(true);
    expect(tools.android.missing).toEqual([]);
  }, 60_000);
});
