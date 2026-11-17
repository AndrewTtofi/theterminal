import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import type { LedgerEntry, PreviewView, Screenshot } from "@theterminal/shared";
import { api } from "../src/api";
import { PreviewsBlock } from "../src/home/PreviewsBlock";
import { homeModel, homeRun, renderInShell } from "./home-fixtures";

afterEach(() => vi.restoreAllMocks());

const shot = (sha: string, device: string, at: string, runId = "r1"): Screenshot => ({
  sha256: sha.repeat(64), runId, previewId: "pv1", device, width: 393, height: 852, bytes: 100, at,
});

describe("PreviewsBlock", () => {
  it("shows the latest screenshots with their device", () => {
    const shots = [shot("a", "iphone16", "2026-11-16T10:00:00.000Z"), shot("b", "laptop", "2026-11-16T11:00:00.000Z")];
    renderInShell(<PreviewsBlock />, homeModel({}, { working: [homeRun("r1", {}, { screenshots: shots })], finishedToday: [] }));
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(2);
    // Newest first.
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([api.screenshotUrl(shots[1]!), api.screenshotUrl(shots[0]!)]);
    expect(imgs[0]!.getAttribute("alt")).toBe("Screenshot on Laptop");
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
    expect(screen.getByText("iPhone 16")).toBeTruthy();
  });

  it("keeps at most 8, and only the selected project's", () => {
    const many = Array.from({ length: 3 }, (_, i) => shot(String(i), "iphone16", `2026-11-16T0${i}:00:00.000Z`));
    const more = Array.from({ length: 3 }, (_, i) => shot(String(i + 3), "ipad", `2026-11-16T1${i}:00:00.000Z`, "r2"));
    const rest = Array.from({ length: 3 }, (_, i) => shot(String(i + 6), "laptop", `2026-11-15T1${i}:00:00.000Z`, "r3"));
    const other = homeRun("r9", { projectId: "p2" }, { screenshots: [shot("f", "laptop", "2026-11-16T23:00:00.000Z", "r9")] });
    renderInShell(
      <PreviewsBlock />,
      homeModel({}, {
        working: [homeRun("r1", {}, { screenshots: many }), other],
        finishedToday: [homeRun("r2", { status: "completed" }, { screenshots: more }), homeRun("r3", { status: "completed" }, { screenshots: rest })],
      }),
    );
    const srcs = screen.getAllByRole("img").map((i) => i.getAttribute("src"));
    expect(srcs).toHaveLength(8);
    expect(srcs.some((s) => s?.includes("f".repeat(64)))).toBe(false);
  });

  it("lists a live preview with its state, and Open opens its tab", async () => {
    const live: PreviewView = {
      id: "pv1", runId: "r1", projectId: "p1", kind: "web", state: "ready", progress: { steps: ["Starting the site"], done: [1], current: null },
      percent: 100, origin: "http://127.0.0.1:5173", frameable: true, exposed: false, error: null, tail: [], liveCount: null, startedAt: "",
    };
    vi.spyOn(api, "getPreview").mockResolvedValue(live);
    const openPreview = vi.fn();
    renderInShell(<PreviewsBlock />, homeModel({ openPreview }, { working: [homeRun("r1", {}, { title: "Fix the contact form", livePreviewId: "pv1" })], finishedToday: [] }));
    const row = screen.getByText("Fix the contact form").closest("li")!;
    await waitFor(() => expect(within(row).getByText("Website · ready")).toBeTruthy());
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    expect(openPreview).toHaveBeenCalledWith("r1", "Fix the contact form");
  });

  it("reads a live preview again when its ledger entries arrive", async () => {
    const view = (state: PreviewView["state"], over: Partial<PreviewView> = {}): PreviewView => ({
      id: "pv1", runId: "r1", projectId: "p1", kind: "web", state, progress: { steps: ["Starting the site"], done: [], current: 1 },
      percent: 0, origin: null, frameable: null, exposed: null, error: null, tail: [], liveCount: null, startedAt: "", ...over,
    }) as PreviewView;
    const get = vi.spyOn(api, "getPreview").mockResolvedValueOnce(view("starting")).mockResolvedValue(view("ready", { percent: 100 }));
    const listeners: ((e: LedgerEntry) => void)[] = [];
    const subscribeEntries = (l: (e: LedgerEntry) => void) => {
      listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    };
    renderInShell(<PreviewsBlock />, homeModel({ subscribeEntries }, { working: [homeRun("r1", {}, { title: "Fix the contact form", livePreviewId: "pv1" })], finishedToday: [] }));
    const row = screen.getByText("Fix the contact form").closest("li")!;
    await waitFor(() => expect(within(row).getByText("Website · starting")).toBeTruthy());
    const entry = (previewId: string) =>
      ({ seq: 1, id: "e1", ts: "", projectId: "p1", actor: { kind: "system", id: "s" }, type: "preview.ready", payload: { previewId }, prevHash: "", hash: "" }) as unknown as LedgerEntry;
    act(() => {
      for (const l of [...listeners]) l(entry("other"));
    });
    expect(get).toHaveBeenCalledTimes(1); // another preview's entry
    act(() => {
      for (const l of [...listeners]) l(entry("pv1"));
    });
    await waitFor(() => expect(within(row).getByText("Website · ready")).toBeTruthy());
  });

  it("says what it is for when there is nothing yet", () => {
    renderInShell(<PreviewsBlock />, homeModel({}, { working: [homeRun("r1")], finishedToday: [] }));
    expect(screen.getByText("No previews yet. When an agent builds a website or an app, you can preview it here.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
