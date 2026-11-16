import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DeviceId } from "@theterminal/shared";
import { api } from "../api";
import type { PreviewViewsBody } from "../api";
import { useOverlayOpen } from "../shell/overlay-store";

/** True in The Terminal's desktop app, whose window adds ` TheTerminalDesktop` to its user agent. */
export function isDesktop(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /(^|\s)TheTerminalDesktop(\s|$)/.test(ua);
}

/** The side bar's sash drag puts `resizing` on the body; live views hide meanwhile. */
function subscribeResizing(l: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const mo = new MutationObserver(l);
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}
const isResizing = () => document.body.classList.contains("resizing");
function useResizing(): boolean {
  return useSyncExternalStore(subscribeResizing, isResizing, () => false);
}

type Options = { previewId: string | null; frames: Map<DeviceId, HTMLElement>; rotated: readonly DeviceId[]; visible: boolean };

/**
 * Lays the desktop app's device views over the Preview tab's frames: `show` with each frame's rectangle (CSS pixels
 * of the window) on mount, on resize and on scroll (once per animation frame); `hide` while a dialog, menu or toast
 * is open, while the tab is not visible or while a sash is dragged; `close` on unmount.
 */
export function useLiveViews({ previewId, frames, rotated, visible }: Options): void {
  const overlay = useOverlayOpen();
  const resizing = useResizing();
  const hidden = overlay || !visible || resizing;

  const latest = useRef({ frames, rotated });
  latest.current = { frames, rotated };
  const lastSent = useRef<string | null>(null);

  const send = (body: PreviewViewsBody) => {
    const text = JSON.stringify(body);
    if (text === lastSent.current) return;
    lastSent.current = text;
    // A refusal (no desktop host, a stopped preview) leaves the frames empty; nothing to tell the person here.
    api.previewViews(body).catch(() => {});
  };
  const show = (id: string) => {
    const { frames: f, rotated: r } = latest.current;
    send({
      previewId: id,
      action: "show",
      devices: [...f].map(([device, el]) => {
        const box = el.getBoundingClientRect();
        return { device, rotated: r.includes(device), x: box.left, y: box.top, width: box.width, height: box.height };
      }),
    });
  };

  const signature = `${[...frames.keys()].join(",")}|${rotated.join(",")}`;

  // Show or hide whenever the frames, the rotation or anything covering them changes.
  useEffect(() => {
    if (previewId === null) return;
    if (hidden) send({ previewId, action: "hide", devices: [] });
    else show(previewId);
  }, [previewId, hidden, signature]);

  // Follow the frames while shown: resizes and scrolls, at most once per animation frame.
  useEffect(() => {
    if (previewId === null || hidden) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        show(previewId);
      });
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const el of latest.current.frames.values()) ro?.observe(el);
    ro?.observe(document.body);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [previewId, hidden, signature]);

  // Close the views of this preview when the tab goes away or follows another preview.
  useEffect(() => {
    if (previewId === null) return;
    return () => {
      lastSent.current = null;
      api.previewViews({ previewId, action: "close", devices: [] }).catch(() => {});
    };
  }, [previewId]);
}
