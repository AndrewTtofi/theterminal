import { createElement } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId } from "@theterminal/shared";
import { api } from "../src/api";
import type { PreviewViewsBody } from "../src/api";
import { Modal } from "../src/components/Modal";
import { fitScale } from "../src/preview/DeviceStage";
import { isDesktop, useLiveViews } from "../src/preview/live-views";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.classList.remove("resizing");
});

function frames(ids: DeviceId[]): Map<DeviceId, HTMLElement> {
  const m = new Map<DeviceId, HTMLElement>();
  ids.forEach((id, i) => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ x: 10 + i * 100, y: 20, left: 10 + i * 100, top: 20, width: 90, height: 180, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
    m.set(id, el);
  });
  return m;
}

function spy() {
  const calls: PreviewViewsBody[] = [];
  vi.spyOn(api, "previewViews").mockImplementation((b) => {
    calls.push(b);
    return Promise.resolve();
  });
  return calls;
}

describe("isDesktop", () => {
  it("is true only for the desktop app's user agent", () => {
    expect(isDesktop("Mozilla/5.0 Chrome/130 Electron/33 TheTerminalDesktop")).toBe(true);
    expect(isDesktop("Mozilla/5.0 Chrome/130")).toBe(false);
  });
});

describe("fitScale", () => {
  it("fits the viewport in the box and never enlarges it", () => {
    expect(fitScale({ width: 1440, height: 900 }, { width: 360, height: 400 })).toBe(0.25);
    expect(fitScale({ width: 393, height: 852 }, { width: 2000, height: 2000 })).toBe(1);
    expect(fitScale({ width: 393, height: 852 }, { width: 0, height: 0 })).toBe(0);
  });
});

describe("useLiveViews", () => {
  it("shows the frames on mount, hides under a dialog, shows again after, and closes on unmount", async () => {
    const calls = spy();
    const f = frames(["iphone16", "ipad", "laptop"]);
    const hook = renderHook(() => useLiveViews({ previewId: "p1", frames: f, rotated: ["ipad"], visible: true }));
    expect(calls.at(-1)).toEqual({
      previewId: "p1",
      action: "show",
      devices: [
        { device: "iphone16", rotated: false, x: 10, y: 20, width: 90, height: 180 },
        { device: "ipad", rotated: true, x: 110, y: 20, width: 90, height: 180 },
        { device: "laptop", rotated: false, x: 210, y: 20, width: 90, height: 180 },
      ],
    });
    const dialog = render(createElement(Modal, { labelledBy: "t", onClose: () => {}, children: createElement("h2", { id: "t" }, "Title") }));
    expect(calls.at(-1)?.action).toBe("hide");
    dialog.unmount();
    expect(calls.at(-1)?.action).toBe("show");
    expect(calls.at(-1)?.devices).toHaveLength(3);
    hook.unmount();
    expect(calls.at(-1)).toEqual({ previewId: "p1", action: "close", devices: [] });
  });

  it("hides while the tab is not visible and while a sash is dragged", async () => {
    const calls = spy();
    const f = frames(["laptop"]);
    const hook = renderHook((p: { visible: boolean }) => useLiveViews({ previewId: "p1", frames: f, rotated: [], visible: p.visible }), {
      initialProps: { visible: false },
    });
    expect(calls.at(-1)?.action).toBe("hide");
    expect(calls.some((c) => c.action === "show")).toBe(false);
    hook.rerender({ visible: true });
    expect(calls.at(-1)?.action).toBe("show");
    act(() => document.body.classList.add("resizing"));
    await waitFor(() => expect(calls.at(-1)?.action).toBe("hide"));
    act(() => document.body.classList.remove("resizing"));
    await waitFor(() => expect(calls.at(-1)?.action).toBe("show"));
  });

  it("sends nothing without a preview", () => {
    const calls = spy();
    const hook = renderHook(() => useLiveViews({ previewId: null, frames: frames(["laptop"]), rotated: [], visible: true }));
    hook.unmount();
    expect(calls).toEqual([]);
  });
});
