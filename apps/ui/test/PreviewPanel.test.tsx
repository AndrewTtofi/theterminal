import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, Role, HomeRuns, LedgerEntry, PreviewPlan, PreviewView } from "@theterminal/shared";
import { ApiError, api } from "../src/api";
import { PreviewPanel } from "../src/preview/PreviewPanel";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { shellNav } from "./connections-harness";

const run: AgentRun = {
  id: "r1", projectId: "p1", cardId: null, adapter: "claude", authMode: "api_key", prompt: "Fix the contact form", status: "running",
  worktree: "w/r1", base: null, costUsd: null, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null, machineId: null,
} as AgentRun;

const plan = (over: Partial<PreviewPlan> = {}): PreviewPlan => ({
  kind: "web",
  commands: [["npm", "ci"], ["npm", "run", "dev"]],
  display: ["npm ci", "npm run dev -- --port <port> --host 127.0.0.1"],
  key: "k1",
  confirmedEarlier: false,
  install: true,
  target: { source: "marker", label: "npm run dev" },
  ...over,
});

const view = (over: Partial<PreviewView> = {}): PreviewView => ({
  id: "pv1",
  runId: "r1",
  projectId: "p1",
  kind: "web",
  state: "starting",
  progress: { steps: ["Installing packages", "Starting the site", "Waiting for the port", "Loading the first page"], done: [1], current: 2 },
  percent: 25,
  origin: null,
  frameable: null,
  exposed: false,
  error: null,
  tail: [],
  liveCount: null,
  startedAt: "",
  ...over,
});
const ready = (over: Partial<PreviewView> = {}) =>
  view({ state: "ready", origin: "http://127.0.0.1:5173", frameable: true, percent: 100, progress: { steps: ["Starting the site"], done: [1], current: null }, ...over });

let listeners: Set<(e: LedgerEntry) => void>;
function setup(home: HomeRuns | null = null, role: Role = "owner") {
  listeners = new Set();
  const model = {
    me: { personId: "p1", name: "P", role, listener: "local", method: "token", credentials: [], sessions: [] },
    runs: [run],
    home: { data: home, error: null, scope: "project", setScope: vi.fn(), refresh: vi.fn() },
    subscribeEntries: (cb: (e: LedgerEntry) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WorkbenchModel;
  return render(
    <ShellContext.Provider value={{ model, dock: () => null, ...shellNav() }}>
      <PreviewPanel id="preview:r1" />
    </ShellContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, "previewSeen").mockResolvedValue(undefined);
  vi.spyOn(api, "stopPreview").mockResolvedValue(undefined);
  vi.spyOn(api, "previewViews").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PreviewPanel, who may run it", () => {
  const sentence = "Only the Owner or the person who started this job can run its preview.";
  it.each(["reviewer", "viewer"] as const)("a %s sees the sentence and no Preview, Screenshot or Stop", async (role) => {
    vi.spyOn(api, "getPreview").mockResolvedValue(ready());
    setup(null, role);
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });
  it.each(["owner", "maintainer"] as const)("a %s sees Preview", (role) => {
    setup(null, role);
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.queryByText(sentence)).toBeNull();
  });
  it("preview_not_allowed shows the plain sentence", async () => {
    vi.spyOn(api, "previewPlan").mockRejectedValue(new ApiError(403, "preview_not_allowed"));
    setup(null, "maintainer");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
  });
});

describe("PreviewPanel", () => {
  it("names the job and shows Preview before anything started", () => {
    setup();
    expect(screen.getByText(/PREVIEW ·/).textContent).toContain("Fix the contact form");
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
  });

  it("shows the exact commands before starting, and starts once on Start", async () => {
    const loadPlan = vi.spyOn(api, "previewPlan").mockResolvedValue(plan());
    const start = vi.spyOn(api, "startPreview").mockResolvedValue(view());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog");
    expect(loadPlan).toHaveBeenCalledWith("r1", "web");
    expect(within(dialog).getByText("Start the website preview")).toBeTruthy();
    const codes = [...dialog.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toEqual(["npm ci", "npm run dev -- --port <port> --host 127.0.0.1"]);
    expect(within(dialog).getByText("This runs the project's own code on this computer.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("r1", { kind: "web", key: "k1" });
    // Starting: the stage checklist, the percentage and Stop.
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText(/Waiting for the port/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.stopPreview).toHaveBeenCalledWith("pv1", "person"));
  });

  it("Cancel starts nothing", async () => {
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan());
    const start = vi.spyOn(api, "startPreview").mockResolvedValue(view());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).not.toHaveBeenCalled();
  });

  it("starts at once, with no dialog, when the same commands were confirmed earlier", async () => {
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    const start = vi.spyOn(api, "startPreview").mockResolvedValue(view());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("r1", { kind: "web", key: "k1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reloads the plan and asks again when the agent changed what will run", async () => {
    const loadPlan = vi.spyOn(api, "previewPlan").mockResolvedValueOnce(plan()).mockResolvedValueOnce(plan({ key: "k2", display: ["npm run start"] }));
    const start = vi.spyOn(api, "startPreview").mockRejectedValueOnce(new ApiError(409, "preview_changed")).mockResolvedValueOnce(view());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(loadPlan).toHaveBeenCalledTimes(2));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect([...dialog.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["npm run start"]));
    expect(within(dialog).getByText(/The agent changed what will run/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenLastCalledWith("r1", { kind: "web", key: "k2" }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("shows the server's sentence when the plan is refused", async () => {
    vi.spyOn(api, "previewPlan").mockRejectedValue(new ApiError(409, "package_manager_not_found", { manager: "pnpm" }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toBe("pnpm isn't installed on this computer.");
  });

  it("in a browser, frames the preview page and reloads it", async () => {
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    vi.spyOn(api, "startPreview").mockResolvedValue(ready());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const host = await screen.findByTitle("Device previews");
    expect(host.tagName).toBe("IFRAME");
    expect(host.className).toBe("preview-host");
    expect(host.getAttribute("src")).toBe("/preview/pv1?d=iphone16,ipad,laptop&r=&k=0");
    fireEvent.click(screen.getByRole("button", { name: /Reload/ }));
    expect(screen.getByTitle("Device previews").getAttribute("src")).toBe("/preview/pv1?d=iphone16,ipad,laptop&r=&k=1");
    // The origin line, the browser link and the screenshot sentence.
    expect(document.querySelector(".preview-origin")?.textContent).toBe("● live · from “Fix the contact form” (Claude)");
    const open = screen.getByRole("link", { name: /Open in my browser/ });
    expect(open.getAttribute("href")).toBe("http://127.0.0.1:5173");
    expect(open.getAttribute("rel")).toBe("noreferrer noopener");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("Screenshots need the desktop app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Screenshot all/ })).toBeNull();
    expect(screen.queryByText("This site may be reachable from other devices on your network")).toBeNull();
  });

  it("picks up to four devices, and Rotate turns every picked one", async () => {
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    vi.spyOn(api, "startPreview").mockResolvedValue(ready());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByTitle("Device previews");
    const group = screen.getByRole("group", { name: "Devices" });
    const pressed = () => within(group).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
    expect(pressed()).toEqual(["iPhone 16", "iPad", "Laptop"]);
    fireEvent.click(within(group).getByRole("button", { name: "Pixel 9" }));
    expect(pressed()).toEqual(["iPhone 16", "Pixel 9", "iPad", "Laptop"]);
    // Four is the limit: no toggle is left that could add a fifth.
    expect(within(group).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "false" && !(b as HTMLButtonElement).disabled)).toEqual([]);
    expect(screen.getByTitle("Device previews").getAttribute("src")).toBe("/preview/pv1?d=iphone16,pixel9,ipad,laptop&r=&k=0");
    fireEvent.click(screen.getByRole("button", { name: /Rotate/ }));
    expect(screen.getByTitle("Device previews").getAttribute("src")).toBe("/preview/pv1?d=iphone16,pixel9,ipad,laptop&r=iphone16,pixel9,ipad,laptop&k=0");
    expect(JSON.parse(localStorage.getItem("tt.preview.v1")!)).toEqual({ devices: ["iphone16", "pixel9", "ipad", "laptop"], rotated: ["iphone16", "pixel9", "ipad", "laptop"] });
  });

  it("warns when the site may be reachable from the network", async () => {
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    vi.spyOn(api, "startPreview").mockResolvedValue(ready({ exposed: true }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("This site may be reachable from other devices on your network")).toBeTruthy();
  });

  it("explains a failure with the redacted tail, and Try again asks for the plan again", async () => {
    const loadPlan = vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    vi.spyOn(api, "startPreview").mockResolvedValue(view({ state: "failed", error: "timed_out", tail: ["Error: boom", "key [redacted]"] }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("The site did not answer within 3 minutes.")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toBe("Error: boom\nkey [redacted]");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(loadPlan).toHaveBeenCalledTimes(2));
  });

  it("follows a live preview of the run, refreshing on its ledger entries", async () => {
    const get = vi.spyOn(api, "getPreview").mockResolvedValueOnce(view()).mockResolvedValue(ready());
    const home: HomeRuns = {
      working: [{ run, projectName: "Site", title: "Fix the contact form", percent: null, now: null, summary: null, waiting: false, reason: null, livePreviewId: "pv1" }],
      finishedToday: [],
    };
    setup(home);
    await waitFor(() => expect(get).toHaveBeenCalledWith("pv1"));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    act(() => {
      for (const l of listeners) l({ seq: 1, id: "e1", ts: "", projectId: "p1", actor: { kind: "system", id: "s" }, type: "preview.ready", payload: { previewId: "pv1" }, prevHash: "", hash: "" } as unknown as LedgerEntry);
    });
    expect(await screen.findByTitle("Device previews")).toBeTruthy();
  });

  it("says it is seen every minute, and closing the tab stops the preview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    vi.spyOn(api, "startPreview").mockResolvedValue(ready());
    const r = setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByTitle("Device previews");
    // Let the passive effects run, so the minute's interval exists before it is counted from.
    await act(async () => {});
    const seenBefore = vi.mocked(api.previewSeen).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.mocked(api.previewSeen).mock.calls.length).toBe(seenBefore + 1);
    expect(api.previewSeen).toHaveBeenLastCalledWith("pv1");
    r.unmount();
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(api.stopPreview).toHaveBeenCalledWith("pv1", "tab_closed");
  });

  it("names a website's fixed stages, not the agent's report", async () => {
    vi.spyOn(api, "previewPlan").mockResolvedValue(plan({ confirmedEarlier: true }));
    vi.spyOn(api, "startPreview").mockResolvedValue(view());
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("stage 2 of 4")).toBeTruthy();
    expect(screen.queryByText("as the agent reports it")).toBeNull();
  });

  it("has no switch when the run offered no app", () => {
    const home: HomeRuns = {
      working: [{ run, projectName: "Website", title: "Fix the contact form", percent: null, now: null, summary: null, waiting: false, reason: null, offers: ["web"] }],
      finishedToday: [],
    };
    setup(home);
    expect(screen.queryByRole("group", { name: "What to preview" })).toBeNull();
  });

  it("switches between the website, iOS and Android when the run offered an app", async () => {
    vi.spyOn(api, "runScreenshots").mockResolvedValue({ screenshots: [] });
    const home: HomeRuns = {
      working: [{ run, projectName: "Website", title: "Fix the contact form", percent: null, now: null, summary: null, waiting: false, reason: null, offers: ["web", "ios"] }],
      finishedToday: [],
    };
    setup(home);
    const group = screen.getByRole("group", { name: "What to preview" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Website", "iOS", "Android"]);
    expect(within(group).getByRole("button", { name: "Website" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "iOS" }));
    expect(within(group).getByRole("button", { name: "iOS" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Run the app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.getByText(/PREVIEW ·/).textContent).toContain("Phone app");
  });

  it("opens on the app when the run offered only an app", () => {
    vi.spyOn(api, "runScreenshots").mockResolvedValue({ screenshots: [] });
    const home: HomeRuns = {
      working: [{ run, projectName: "Website", title: "Fix the contact form", percent: null, now: null, summary: null, waiting: false, reason: null, offers: ["android"] }],
      finishedToday: [],
    };
    setup(home);
    const group = screen.getByRole("group", { name: "What to preview" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["iOS", "Android"]);
    expect(within(group).getByRole("button", { name: "Android" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Run the app" })).toBeTruthy();
  });
});
