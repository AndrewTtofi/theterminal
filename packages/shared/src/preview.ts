import { z } from "zod";
import { PROGRESS_LIMITS, type RunProgress } from "./agents.js";

export type DeviceId = "iphone16" | "pixel9" | "ipad" | "laptop";
export const DEVICE_IDS: readonly DeviceId[] = ["iphone16", "pixel9", "ipad", "laptop"];

export const DEVICES: Record<
  DeviceId,
  { label: string; width: number; height: number; scale: number; mobile: boolean; userAgent: string | null }
> = {
  iphone16: {
    label: "iPhone 16",
    width: 393,
    height: 852,
    scale: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  pixel9: {
    label: "Pixel 9",
    width: 412,
    height: 915,
    scale: 2.625,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    label: "iPad",
    width: 820,
    height: 1180,
    scale: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  laptop: { label: "Laptop", width: 1440, height: 900, scale: 2, mobile: false, userAgent: null },
};

/** The device's CSS size, sides swapped when rotated. */
export function viewport(id: DeviceId, rotated: boolean): { width: number; height: number } {
  const d = DEVICES[id];
  return rotated ? { width: d.height, height: d.width } : { width: d.width, height: d.height };
}

export const PREVIEW_LIMITS = {
  maxDevices: 4,
  startTimeoutMs: 180_000,
  installTimeoutMs: 600_000,
  idleMs: 1_800_000,
  tailLines: 20,
  tailLineChars: 300,
  screenshotBytes: 16_777_216,
  webPreviews: 4,
  nativeBuilds: 1,
} as const;

export type PreviewKind = "web" | "ios" | "android";

export const WEB_STEPS: readonly string[] = ["Starting the site", "Waiting for the port", "Loading the first page"];
export const WEB_INSTALL_STEP = "Installing packages";
export const IOS_STEPS: readonly string[] = [
  "Check the tools",
  "Build the app",
  "Start the simulator",
  "Install the app",
  "Open the app",
];
export const ANDROID_STEPS: readonly string[] = [
  "Check the tools",
  "Build the app",
  "Start the emulator",
  "Install the app",
  "Open the app",
];

export type PreviewState = "requested" | "starting" | "ready" | "failed" | "stopped";

export type PreviewFailure =
  | "timed_out"
  | "exited"
  | "install_failed"
  | "build_failed"
  | "boot_failed"
  | "install_app_failed"
  | "launch_failed"
  | "start_failed";

export type PreviewView = {
  id: string;
  runId: string;
  projectId: string;
  kind: PreviewKind;
  state: PreviewState;
  progress: RunProgress;
  percent: number;
  origin: string | null;
  frameable: boolean | null;
  exposed: boolean;
  error: PreviewFailure | null;
  tail: string[];
  liveCount: { n: number; m: number } | null;
  startedAt: string;
};

export type PreviewPlan = {
  kind: PreviewKind;
  commands: string[][];
  display: string[];
  key: string;
  confirmedEarlier: boolean;
  install: boolean;
  target: { source: "marker" | "detected"; label: string };
};

export type Screenshot = {
  sha256: string;
  runId: string;
  previewId: string;
  device: string;
  width: number;
  height: number;
  bytes: number;
  at: string;
};

export type ToolId =
  | "xcode"
  | "xcode_cli"
  | "simulator"
  | "android_sdk"
  | "adb"
  | "emulator"
  | "avd"
  | "gradle_wrapper";

const APPLE = "https://developer.apple.com/xcode/";
const ANDROID = "https://developer.android.com/studio";

export const TOOL_HELP: Record<ToolId, { title: string; steps: string[]; url: string }> = {
  xcode: {
    title: "Xcode",
    steps: ["Install Xcode from the App Store.", "Open it once and accept the licence."],
    url: APPLE,
  },
  xcode_cli: {
    title: "Xcode command line tools",
    steps: ["Run xcode-select --install in a terminal.", "Choose Install and wait for it to finish."],
    url: APPLE,
  },
  simulator: {
    title: "iOS Simulator",
    steps: ["Open Xcode, then Settings, then Platforms.", "Download an iOS platform."],
    url: APPLE,
  },
  android_sdk: {
    title: "Android SDK",
    steps: ["Install Android Studio.", "Open it once so it installs the SDK."],
    url: ANDROID,
  },
  adb: {
    title: "Android platform tools (adb)",
    steps: ["In Android Studio open SDK Manager.", "Install Android SDK Platform-Tools."],
    url: ANDROID,
  },
  emulator: {
    title: "Android Emulator",
    steps: ["In Android Studio open SDK Manager.", "Install Android Emulator."],
    url: ANDROID,
  },
  avd: {
    title: "An Android virtual device",
    steps: ["In Android Studio open Device Manager.", "Create a virtual device, for example a Pixel."],
    url: ANDROID,
  },
  gradle_wrapper: {
    title: "The project's Gradle wrapper",
    steps: ["The project needs a gradlew file in its root.", "Ask Claude to add the Gradle wrapper."],
    url: ANDROID,
  },
};

export type NativeTools = {
  platform: "darwin" | "win32" | "linux";
  ios: {
    supported: boolean;
    xcode: string | null;
    simulators: { udid: string; name: string; state: string; runtime: string }[];
    missing: ToolId[];
  };
  android: { supported: boolean; sdk: boolean; avds: string[]; missing: ToolId[] };
};

const FAILURES: Record<PreviewFailure, { web: string; native: string }> = {
  timed_out: { web: "The site did not answer within 3 minutes.", native: "The app did not start within 3 minutes." },
  exited: { web: "The site stopped by itself.", native: "The app stopped by itself." },
  install_failed: { web: "Installing the packages failed.", native: "Installing the packages failed." },
  build_failed: { web: "The build failed.", native: "The build failed." },
  boot_failed: { web: "The device did not start.", native: "The device did not start." },
  install_app_failed: { web: "The app could not be installed.", native: "The app could not be installed." },
  launch_failed: { web: "The app could not be opened.", native: "The app could not be opened." },
  start_failed: { web: "The site could not be started.", native: "The app could not be started." },
};

/** One plain sentence for why a preview failed. */
export function failureSentence(f: PreviewFailure, kind: PreviewKind): string {
  return FAILURES[f][kind === "web" ? "web" : "native"];
}

const id = z.string().min(1).max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const port = z.number().int().min(1).max(65535);
const kind = z.enum(["web", "ios", "android"]);
const failure = z.enum([
  "timed_out",
  "exited",
  "install_failed",
  "build_failed",
  "boot_failed",
  "install_app_failed",
  "launch_failed",
  "start_failed",
]);

export const previewPayloadSchemas = {
  "preview.offered": z
    .object({
      runId: id,
      kind,
      command: z.string().min(1).max(500).optional(),
      port: port.optional(),
      target: z.string().min(1).max(200).optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.kind === "web") {
        if (v.command === undefined) ctx.addIssue({ code: "custom", path: ["command"], message: "a website offer needs a command" });
        if (v.port === undefined) ctx.addIssue({ code: "custom", path: ["port"], message: "a website offer needs a port" });
      } else if (v.target === undefined) {
        ctx.addIssue({ code: "custom", path: ["target"], message: "an app offer needs a target" });
      }
    }),
  "preview.requested": z
    .object({
      previewId: id,
      runId: id,
      kind,
      commands: z.array(z.array(z.string().min(1).max(1000)).min(1).max(64)).min(1).max(8),
      key: sha256,
      install: z.boolean(),
      target: z.string().min(1).max(200),
    })
    .strict(),
  "preview.started": z.object({ previewId: id, port: port.optional() }).strict(),
  "preview.progress": z
    .object({
      previewId: id,
      steps: z.array(z.string().min(1).max(80)).min(1).max(6),
      done: z.array(z.number().int().min(1).max(PROGRESS_LIMITS.maxSteps)),
      current: z.number().int().min(1).max(PROGRESS_LIMITS.maxSteps).nullable(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const n = v.steps.length;
      if (v.done.some((d, i) => d > n || (i > 0 && d <= v.done[i - 1]!))) {
        ctx.addIssue({ code: "custom", path: ["done"], message: "must be unique, ascending and within the steps" });
      }
      if (v.current !== null && v.current > n) {
        ctx.addIssue({ code: "custom", path: ["current"], message: "must be within the steps" });
      }
    }),
  "preview.ready": z
    .object({
      previewId: id,
      origin: z.string().regex(/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/).optional(),
      frameable: z.boolean().optional(),
      exposed: z.boolean().optional(),
    })
    .strict(),
  "preview.failed": z
    .object({
      previewId: id,
      reason: failure,
      tail: z.array(z.string().max(PREVIEW_LIMITS.tailLineChars)).max(PREVIEW_LIMITS.tailLines),
    })
    .strict(),
  "preview.stopped": z
    .object({ previewId: id, reason: z.enum(["person", "tab_closed", "idle", "shutdown", "restarted"]) })
    .strict(),
  "preview.screenshot": z
    .object({
      previewId: id,
      runId: id,
      device: z.string().min(1).max(60),
      sha256,
      bytes: z.number().int().min(1).max(PREVIEW_LIMITS.screenshotBytes),
      width: z.number().int().min(1).max(20000),
      height: z.number().int().min(1).max(20000),
    })
    .strict(),
} as const;

export type PreviewEventType = keyof typeof previewPayloadSchemas;
