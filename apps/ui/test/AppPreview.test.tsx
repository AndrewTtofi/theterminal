import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry, Role, NativeTools, PreviewPlan, PreviewView } from "@theterminal/shared";
import { ApiError, api } from "../src/api";
import { AppPreview } from "../src/preview/AppPreview";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { OWNER_ME } from "./as-owner";
import { shellNav } from "./connections-harness";

const plan = (over: Partial<PreviewPlan> = {}): PreviewPlan => ({
  kind: "ios",
  commands: [["xcodebuild", "-scheme", "Trips", "build"], ["xcrun", "simctl", "boot", "U1"]],
  display: ["xcodebuild -scheme Trips build", "xcrun simctl boot U1"],
  key: "k1",
  confirmedEarlier: false,
  install: false,
  target: { source: "marker", label: "Trips" },
  ...over,
});

const STEPS = ["Check the tools", "Build the app", "Start the simulator", "Install the app", "Open the app"];
const view = (over: Partial<PreviewView> = {}): PreviewView => ({
  id: "pv1",
  runId: "r1",
  projectId: "p1",
  kind: "ios",
  state: "starting",
  progress: { steps: STEPS, done: [1, 2], current: 3 },
  percent: 40,
  origin: null,
  frameable: null,
  exposed: false,
  error: null,
  tail: [],
  liveCount: null,
  startedAt: "",
  ...over,
});

export const tools = (over: Partial<NativeTools> = {}): NativeTools => ({
  platform: "darwin",
  ios: { supported: true, xcode: "Xcode 17.0", simulators: [], missing: [] },
  android: { supported: true, sdk: false, avds: [], missing: ["android_sdk"] },
  ...over,
});

let listeners: Set<(e: LedgerEntry) => void>;
function setup(props: Partial<Parameters<typeof AppPreview>[0]> = {}, role: Role = "owner") {
  listeners = new Set();
  const model = {
    me: { ...OWNER_ME, role },
    runs: [],
    home: { data: null, error: null, scope: "project", setScope: vi.fn(), refresh: vi.fn() },
    subscribeEntries: (cb: (e: LedgerEntry) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WorkbenchModel;
  return render(
    <ShellContext.Provider value={{ model, dock: () => null, ...shellNav() }}>
      <AppPreview runId="r1" kind="ios" tools={tools()} {...props} />
    </ShellContext.Provider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, "previewSeen").mockResolvedValue(undefined);
  vi.spyOn(api, "stopPreview").mockResolvedValue(undefined);
  vi.spyOn(api, "runScreenshots").mockResolvedValue({ screenshots: [] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startWith(v: PreviewView) {
  vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
  vi.spyOn(api, "startPreview").mockResolvedValue(v);
  fireEvent.click(screen.getByRole("button", { name: "Run the app" }));
  await screen.findByRole("progressbar");
}

describe("AppPreview, who may run it", () => {
  const sentence = "Only the Owner or the person who started this job can run its preview.";
  it.each(["reviewer", "viewer"] as const)("a %s sees the sentence and no Run, Screenshot or Stop", (role) => {
    setup({ follow: view({ state: "ready" }) }, role);
    expect(screen.getByText(sentence)).toBeTruthy();
    for (const name of ["Run the app", "Screenshot", "Stop", "Try again"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
  it.each(["owner", "maintainer"] as const)("a %s sees Screenshot and Stop on a live app, and no sentence", (role) => {
    setup({ follow: view({ state: "ready" }) }, role);
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByText(sentence)).toBeNull();
  });
  it("a maintainer sees Run the app", () => {
    setup({}, "maintainer");
    expect(screen.getByRole("button", { name: "Run the app" })).toBeTruthy();
  });
  it("preview_not_allowed shows the plain sentence", async () => {
    vi.spyOn(api, "previewPlan").mockRejectedValue(new ApiError(403, "preview_not_allowed"));
    setup({}, "maintainer");
    fireEvent.click(screen.getByRole("button", { name: "Run the app" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Only the Owner or the person who started this job can run its preview.");
  });
});

describe("AppPreview", () => {
  it("says the app runs in the simulator's own window, and offers Run the app", () => {
    setup();
    expect(screen.getByText("You use the app in the simulator's own window.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run the app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("lists every command before running, and starts once on Start", async () => {
    const loadPlan = vi.spyOn(api, "previewPlan").mockResolvedValue(plan());
    const start = vi.spyOn(api, "startPreview").mockResolvedValue(view());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Run the app" }));
    const dialog = await screen.findByRole("dialog");
    expect(loadPlan).toHaveBeenCalledWith("r1", "ios");
    expect([...dialog.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["xcodebuild -scheme Trips build", "xcrun simctl boot U1"]);
    expect(within(dialog).queryByText("Start the website preview")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("r1", { kind: "ios", key: "k1" });
  });

  it("shows the real stage progress: 40%, two done, the third starting, the build tool's own count", async () => {
    setup();
    await startWith(view({ liveCount: { n: 12, m: 80 } }));
    expect(screen.getByText(/Getting it running · 40%/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText("stage 3 of 5")).toBeTruthy();
    expect(screen.queryByText("as the agent reports it")).toBeNull();
    const rows = screen.getAllByRole("listitem").filter((li) => li.closest(".app-stages"));
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.textContent?.includes("✓"))).toHaveLength(2);
    expect(rows[2]!.textContent).toContain("❯ starting…");
    expect(rows[2]!.textContent).toContain("12 of 80");
    expect(rows[2]!.getAttribute("aria-current")).toBe("step");
    expect(rows[3]!.textContent).toContain("○");
    expect(rows[4]!.textContent).toContain("○");
  });

  it("shows a stage's duration only when this tab saw it start and finish", async () => {
    // Only the poll and the clock are fake, so the readings and the durations are exact.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const get = vi.spyOn(api, "getPreview");
    setup();
    // Stage 2 was already under way when the tab first saw it.
    await startWith(view({ progress: { steps: STEPS, done: [1], current: 2 }, percent: 20 }));
    get.mockResolvedValue(view({ progress: { steps: STEPS, done: [1, 2], current: 3 }, percent: 40 }));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText(/Getting it running · 40%/)).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(70_000));
    get.mockResolvedValue(view({ progress: { steps: STEPS, done: [1, 2, 3], current: 4 }, percent: 60 }));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText(/Getting it running · 60%/)).toBeTruthy();
    const rows = screen.getAllByRole("listitem").filter((li) => li.closest(".app-stages"));
    expect(rows[2]!.textContent).toContain("✓ 1m 12s");
    // Stages 1 and 2 began before the tab saw them: no made-up duration.
    expect(rows[0]!.textContent).not.toMatch(/\ds/);
    expect(rows[1]!.textContent).not.toMatch(/\ds/);
  });

  it("Screenshot saves one and Stop stops it", async () => {
    const take = vi.spyOn(api, "takeScreenshots").mockResolvedValue({
      screenshots: [{ sha256: "a".repeat(64), runId: "r1", previewId: "pv1", device: "iPhone 16", width: 1179, height: 2556, bytes: 10, at: "" }],
    });
    setup();
    await startWith(view({ state: "ready", progress: { steps: STEPS, done: [1, 2, 3, 4, 5], current: null }, percent: 100 }));
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    await waitFor(() => expect(take).toHaveBeenCalledWith("pv1"));
    expect(await screen.findByText("Saved 1 screenshot on the job.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.stopPreview).toHaveBeenCalledWith("pv1", "person"));
  });

  it("follows its ledger entries", async () => {
    setup();
    await startWith(view());
    const get = vi.spyOn(api, "getPreview").mockResolvedValue(view({ state: "failed", error: "build_failed", tail: ["error: [redacted]"] }));
    act(() => listeners.forEach((l) => l({ type: "preview.failed", payload: { previewId: "pv1" } } as unknown as LedgerEntry)));
    await waitFor(() => expect(get).toHaveBeenCalledWith("pv1"));
    expect(await screen.findByText("The build failed.")).toBeTruthy();
    expect(screen.getByText("error: [redacted]").tagName).toBe("PRE");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows the Android sentence when the platform can't build it", async () => {
    vi.spyOn(api, "previewPlan").mockRejectedValue(new ApiError(409, "platform_unsupported", { kind: "android" }));
    setup({ kind: "android" });
    fireEvent.click(screen.getByRole("button", { name: "Run the app" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Android apps can't be built on Windows in this version.");
  });

  it("shows what the Mac needs beside the progress, and the run's latest screenshots", async () => {
    vi.mocked(api.runScreenshots).mockResolvedValue({
      screenshots: [{ sha256: "b".repeat(64), runId: "r1", previewId: "pv1", device: "iPhone 16", width: 1179, height: 2556, bytes: 10, at: "" }],
    });
    setup();
    expect(screen.getByRole("heading", { name: "What you need on this computer" })).toBeTruthy();
    const img = await screen.findByAltText("Screenshot on iPhone 16");
    expect(img.getAttribute("src")).toBe(api.screenshotUrl({ sha256: "b".repeat(64), runId: "r1" }));
  });

  it("closing the tab stops a live app", async () => {
    const { unmount } = setup();
    await startWith(view());
    unmount();
    await waitFor(() => expect(api.stopPreview).toHaveBeenCalledWith("pv1", "tab_closed"));
  });
});
