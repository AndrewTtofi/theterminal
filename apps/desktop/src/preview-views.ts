/**
 * The device views of website previews, laid over the Preview tab's frames in The Terminal's window. Each device is a
 * `WebContentsView` in its own in-memory partition (`preview-<previewId>-<device>`, never `persist:`), with sandbox
 * and context isolation on, no node and no preload. Its session is marked as a preview session before the view is
 * made, so `web-contents-created` gives it the preview policy (`preview-policy.ts`). Electron is reached only through
 * the small structural types below, so this can be tested with fakes.
 */
import type { PreviewDeviceView, PreviewViewsMessage } from "@theterminal/core/dist/host.js";
import { isPreviewOrigin } from "./preview-policy.js";

type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

export type ViewLike = {
  setBounds(bounds: Rect): void;
  setVisible(visible: boolean): void;
  webContents: {
    loadURL(url: string): Promise<unknown>;
    reload(): void;
    close(): void;
    isDestroyed(): boolean;
    enableDeviceEmulation(p: {
      screenPosition: "desktop" | "mobile";
      screenSize: Size;
      viewSize: Size;
      deviceScaleFactor: number;
      viewPosition: { x: number; y: number };
      scale: number;
    }): void;
    setUserAgent(userAgent: string): void;
    debugger: {
      attach(protocolVersion?: string): void;
      detach(): void;
      sendCommand(method: string, params?: object): Promise<unknown>;
    };
  };
};

export type WindowLike = {
  isDestroyed(): boolean;
  webContents: { getZoomFactor(): number };
  contentView: { addChildView(view: any): void; removeChildView(view: any): void };
};

export type PreviewViewsDeps<S> = {
  /** The Terminal's window, or null when there is none (headless, or closed on macOS). */
  window: () => WindowLike | null;
  /** Makes a view with the locked web preferences on this partition. */
  makeView: (partition: string) => ViewLike;
  fromPartition: (partition: string) => S;
  /** Hardens the session and records it as a preview session showing `origin`. Called before its view is made. */
  markPreviewSession: (session: S, origin: string) => void;
  confirmOpen: (url: string) => Promise<boolean>;
  openExternal: (url: string) => void;
};

export type PreviewShot = { device: string; png: string };

type Entry = { view: ViewLike; viewport: Size };
type Preview = { origin: string; window: WindowLike; devices: Map<string, Entry> };

const MAX_SHOTS = 4;

export function previewPartition(previewId: string, device: string): string {
  return `preview-${previewId}-${device}`;
}

/**
 * Applies the server child's `preview_views` requests and captures screenshots.
 * - `show` makes a view per listed device on first use and loads the origin once; every `show` sets the emulation
 *   (viewport, device scale factor, mobile, and a scale that fits the viewport into the view), the user agent when
 *   given, and the bounds (the rectangle times the window's zoom factor, rounded), and makes the view visible. Views of
 *   devices no longer listed are removed. A new origin for the same preview starts over.
 * - `hide` hides the preview's views, `reload` reloads them, `close` removes and destroys them.
 * - `capture` takes a PNG of each view through CDP `Page.captureScreenshot` at its emulated viewport.
 */
export function createPreviewViews<S>(deps: PreviewViewsDeps<S>): {
  apply(m: PreviewViewsMessage): boolean;
  capture(previewId: string): Promise<PreviewShot[]>;
  closeAll(): void;
} {
  const previews = new Map<string, Preview>();

  const destroy = (p: Preview, device: string) => {
    const entry = p.devices.get(device);
    if (!entry) return;
    p.devices.delete(device);
    try {
      if (!p.window.isDestroyed()) p.window.contentView.removeChildView(entry.view);
    } catch {
      // The window is going away with its views.
    }
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    } catch {
      // Already gone.
    }
  };
  const close = (previewId: string) => {
    const p = previews.get(previewId);
    if (!p) return;
    for (const device of [...p.devices.keys()]) destroy(p, device);
    previews.delete(previewId);
  };

  const place = (entry: Entry, v: PreviewDeviceView, zoom: number) => {
    const { view } = entry;
    const width = v.width * zoom;
    view.webContents.enableDeviceEmulation({
      screenPosition: v.mobile ? "mobile" : "desktop",
      screenSize: { ...v.viewport },
      viewSize: { ...v.viewport },
      deviceScaleFactor: v.scale,
      viewPosition: { x: 0, y: 0 },
      scale: v.viewport.width > 0 ? width / v.viewport.width : 1,
    });
    if (v.userAgent !== null) view.webContents.setUserAgent(v.userAgent);
    view.setBounds({
      x: Math.round(v.x * zoom),
      y: Math.round(v.y * zoom),
      width: Math.round(width),
      height: Math.round(v.height * zoom),
    });
    view.setVisible(true);
    entry.viewport = { ...v.viewport };
  };

  const show = (m: PreviewViewsMessage): boolean => {
    if (!isPreviewOrigin(m.origin)) return false;
    const window = deps.window();
    if (!window || window.isDestroyed()) return false;
    let p = previews.get(m.previewId);
    if (p && (p.origin !== m.origin || p.window !== window)) {
      close(m.previewId);
      p = undefined;
    }
    if (!p) {
      p = { origin: m.origin, window, devices: new Map() };
      previews.set(m.previewId, p);
    }
    const listed = new Set(m.views.map((v) => v.device));
    for (const device of [...p.devices.keys()]) if (!listed.has(device)) destroy(p, device);
    let zoom = window.webContents.getZoomFactor();
    if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;
    for (const v of m.views) {
      let entry = p.devices.get(v.device);
      if (!entry) {
        const partition = previewPartition(m.previewId, v.device);
        // The session is hardened and marked first, so the view's contents get the preview policy when created.
        deps.markPreviewSession(deps.fromPartition(partition), m.origin);
        const view = deps.makeView(partition);
        entry = { view, viewport: { ...v.viewport } };
        p.devices.set(v.device, entry);
        window.contentView.addChildView(view);
        view.webContents.loadURL(m.origin).catch(() => {
          // A failed load shows Chromium's error page in the view; the person can reload.
        });
      }
      place(entry, v, zoom);
    }
    return true;
  };

  return {
    apply(m) {
      try {
        switch (m.action) {
          case "show":
            return show(m);
          case "hide":
            for (const e of previews.get(m.previewId)?.devices.values() ?? []) e.view.setVisible(false);
            return true;
          case "reload":
            for (const e of previews.get(m.previewId)?.devices.values() ?? []) e.view.webContents.reload();
            return true;
          case "close":
            close(m.previewId);
            return true;
          default:
            return false;
        }
      } catch {
        return false;
      }
    },

    async capture(previewId) {
      const p = previews.get(previewId);
      if (!p) return [];
      const shots: PreviewShot[] = [];
      for (const [device, { view, viewport }] of [...p.devices].slice(0, MAX_SHOTS)) {
        if (view.webContents.isDestroyed()) continue;
        const dbg = view.webContents.debugger;
        let attached = false;
        try {
          dbg.attach("1.3");
          attached = true;
          const result = (await dbg.sendCommand("Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
            captureBeyondViewport: true,
          })) as { data?: unknown } | null;
          const data = result?.data;
          if (typeof data === "string" && data.length > 0) shots.push({ device, png: data });
        } catch {
          // This device gives no shot; the others still do.
        } finally {
          if (attached) {
            try {
              dbg.detach();
            } catch {
              // Already detached.
            }
          }
        }
      }
      return shots;
    },

    closeAll() {
      for (const previewId of [...previews.keys()]) close(previewId);
    },
  };
}
