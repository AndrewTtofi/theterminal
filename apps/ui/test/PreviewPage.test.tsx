import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewView } from "@theterminal/shared";
import { api } from "../src/api";
import { PreviewPage } from "../src/preview/PreviewPage";

const view = (over: Partial<PreviewView> = {}): PreviewView => ({
  id: "pv1", runId: "r1", projectId: "p1", kind: "web", state: "ready",
  progress: { steps: ["Starting the site"], done: [1], current: null }, percent: 100,
  origin: "http://127.0.0.1:5173", frameable: true, exposed: false, error: null, tail: [], liveCount: null, startedAt: "",
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("PreviewPage", () => {
  it("frames the site once per device, sandboxed, on the preview's own origin", async () => {
    vi.spyOn(api, "getPreview").mockResolvedValue(view());
    render(<PreviewPage id="pv1" search="?d=iphone16,ipad,laptop&r=ipad&k=0" />);
    expect(await screen.findByText("iPhone 16 · 393×852")).toBeTruthy();
    expect(screen.getByText("iPad · 1180×820")).toBeTruthy();
    expect(screen.getByText("Laptop · 1440×900")).toBeTruthy();
    const frames = [...document.querySelectorAll("iframe")];
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(f.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin");
      expect(f.getAttribute("src")).toBe("http://127.0.0.1:5173");
    }
    expect(frames.map((f) => [f.getAttribute("width"), f.getAttribute("height")])).toEqual([["393", "852"], ["1180", "820"], ["1440", "900"]]);
  });

  it("drops unknown devices and falls back to the defaults", async () => {
    vi.spyOn(api, "getPreview").mockResolvedValue(view());
    render(<PreviewPage id="pv1" search="?d=nope&r=&k=x" />);
    await screen.findByText("iPhone 16 · 393×852");
    expect(document.querySelectorAll("iframe")).toHaveLength(3);
  });

  it("says when the site refuses to be framed, with a link to open it", async () => {
    vi.spyOn(api, "getPreview").mockResolvedValue(view({ frameable: false }));
    render(<PreviewPage id="pv1" search="?d=iphone16,ipad,laptop&r=&k=0" />);
    expect((await screen.findAllByText("This site can't be shown inside another page")).length).toBeGreaterThan(0);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    const link = screen.getAllByRole("link", { name: /Open in my browser/ })[0]!;
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:5173");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("frames nothing while the preview has no origin", async () => {
    vi.spyOn(api, "getPreview").mockResolvedValue(view({ state: "stopped", origin: null }));
    render(<PreviewPage id="pv1" search="" />);
    expect(await screen.findByText("This preview is not running.")).toBeTruthy();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
