import { describe, expect, it, vi } from "vitest";
import type { PreviewDeviceView, PreviewViewsMessage } from "@theterminal/core/dist/host.js";
import { createPreviewViews } from "../src/preview-views.js";

const ORIGIN = "http://127.0.0.1:5173";

function fakeView(partition: string) {
  const dbg = {
    attach: vi.fn((_version?: string) => {}),
    detach: vi.fn(() => {}),
    sendCommand: vi.fn(async (_method: string, _params?: object): Promise<unknown> => ({ data: "iVBORw0KGgo=" })),
  };
  const view = {
    partition,
    bounds: null as null | { x: number; y: number; width: number; height: number },
    visible: true,
    setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
      view.bounds = b;
    }),
    setVisible: vi.fn((v: boolean) => {
      view.visible = v;
    }),
    webContents: {
      destroyed: false,
      loadURL: vi.fn(async (_url: string) => {}),
      reload: vi.fn(),
      close: vi.fn(() => {
        view.webContents.destroyed = true;
      }),
      isDestroyed: () => view.webContents.destroyed,
      enableDeviceEmulation: vi.fn(),
      setUserAgent: vi.fn(),
      debugger: dbg,
    },
  };
  return view;
}

type FakeView = ReturnType<typeof fakeView>;

function setup(o: { zoom?: number; noWindow?: boolean } = {}) {
  const made: FakeView[] = [];
  const children = new Set<FakeView>();
  const marked: { session: unknown; origin: string }[] = [];
  const window = {
    destroyed: false,
    isDestroyed: () => window.destroyed,
    webContents: { getZoomFactor: () => o.zoom ?? 1 },
    contentView: {
      addChildView: vi.fn((v: FakeView) => children.add(v)),
      removeChildView: vi.fn((v: FakeView) => children.delete(v)),
    },
  };
  const views = createPreviewViews({
    window: () => (o.noWindow ? null : window),
    makeView: (partition: string) => {
      const v = fakeView(partition);
      made.push(v);
      return v;
    },
    fromPartition: (p: string) => ({ partition: p }),
    markPreviewSession: (session: unknown, origin: string) => marked.push({ session, origin }),
    confirmOpen: async () => false,
    openExternal: () => {},
  });
  return { views, made, children, marked, window };
}

const iphone: PreviewDeviceView = {
  device: "iphone16",
  x: 10,
  y: 20,
  width: 196.5,
  height: 426,
  viewport: { width: 393, height: 852 },
  scale: 3,
  mobile: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
};
const laptop: PreviewDeviceView = {
  device: "laptop",
  x: 300,
  y: 20,
  width: 720,
  height: 450,
  viewport: { width: 1440, height: 900 },
  scale: 2,
  mobile: false,
  userAgent: null,
};

const msg = (action: PreviewViewsMessage["action"], views: PreviewDeviceView[], previewId = "p1"): PreviewViewsMessage => ({
  type: "preview_views",
  id: "m1",
  previewId,
  origin: ORIGIN,
  action,
  views,
});

describe("createPreviewViews", () => {
  it("shows one in-memory, locked-down view per device", () => {
    const { views, made, children, marked } = setup({ zoom: 1.25 });
    expect(views.apply(msg("show", [iphone, laptop]))).toBe(true);
    expect(made.map((v) => v.partition)).toEqual(["preview-p1-iphone16", "preview-p1-laptop"]);
    for (const v of made) expect(v.partition.startsWith("persist:")).toBe(false);
    expect(children.size).toBe(2);
    // Each session is marked as a preview session, with its origin, before its view exists.
    expect(marked).toEqual([
      { session: { partition: "preview-p1-iphone16" }, origin: ORIGIN },
      { session: { partition: "preview-p1-laptop" }, origin: ORIGIN },
    ]);
    const [phone, wide] = made as [FakeView, FakeView];
    expect(phone.webContents.loadURL).toHaveBeenCalledWith(ORIGIN);
    // The rectangle is in CSS pixels of the window; main multiplies by the zoom factor and rounds.
    expect(phone.bounds).toEqual({ x: 13, y: 25, width: 246, height: 533 });
    expect(wide.bounds).toEqual({ x: 375, y: 25, width: 900, height: 563 });
    expect(phone.webContents.enableDeviceEmulation).toHaveBeenCalledWith({
      screenPosition: "mobile",
      screenSize: { width: 393, height: 852 },
      viewSize: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      viewPosition: { x: 0, y: 0 },
      scale: (196.5 * 1.25) / 393,
    });
    expect(wide.webContents.enableDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ screenPosition: "desktop", deviceScaleFactor: 2, scale: (720 * 1.25) / 1440 }),
    );
    expect(phone.webContents.setUserAgent).toHaveBeenCalledWith(iphone.userAgent);
    expect(wide.webContents.setUserAgent).not.toHaveBeenCalled();
    expect(phone.visible).toBe(true);
  });

  it("uses the plain width / viewport.width as the emulation scale at zoom 1", () => {
    const { views, made } = setup();
    views.apply(msg("show", [laptop]));
    expect(made[0]!.webContents.enableDeviceEmulation).toHaveBeenCalledWith(expect.objectContaining({ scale: 720 / 1440 }));
    expect(made[0]!.bounds).toEqual({ x: 300, y: 20, width: 720, height: 450 });
  });

  it("loads the origin once, and moves, re-emulates and shows the views on a later show", () => {
    const { views, made } = setup();
    views.apply(msg("show", [iphone, laptop]));
    views.apply(msg("hide", []));
    expect(made.every((v) => v.visible === false)).toBe(true);
    const rotated = { ...iphone, x: 50, viewport: { width: 852, height: 393 }, width: 426, height: 196.5 };
    views.apply(msg("show", [rotated, laptop]));
    expect(made).toHaveLength(2);
    expect(made[0]!.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(made[0]!.bounds).toEqual({ x: 50, y: 20, width: 426, height: 197 });
    expect(made[0]!.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(
      expect.objectContaining({ screenSize: { width: 852, height: 393 }, viewSize: { width: 852, height: 393 } }),
    );
    expect(made.every((v) => v.visible)).toBe(true);
  });

  it("removes the views of devices no longer listed", () => {
    const { views, made, children } = setup();
    views.apply(msg("show", [iphone, laptop]));
    views.apply(msg("show", [iphone]));
    expect(children.size).toBe(1);
    expect(made[1]!.webContents.close).toHaveBeenCalled();
    expect(made[0]!.webContents.close).not.toHaveBeenCalled();
  });

  it("reloads each view, and close removes and destroys them all", () => {
    const { views, made, children } = setup();
    views.apply(msg("show", [iphone, laptop]));
    expect(views.apply(msg("reload", []))).toBe(true);
    for (const v of made) expect(v.webContents.reload).toHaveBeenCalledTimes(1);
    expect(views.apply(msg("close", []))).toBe(true);
    expect(children.size).toBe(0);
    for (const v of made) expect(v.webContents.close).toHaveBeenCalled();
    // A later show starts fresh.
    views.apply(msg("show", [iphone]));
    expect(made).toHaveLength(3);
  });

  it("acts only on the views of the named preview", () => {
    const { views, made } = setup();
    views.apply(msg("show", [iphone], "p1"));
    views.apply(msg("show", [iphone], "p2"));
    expect(made.map((v) => v.partition)).toEqual(["preview-p1-iphone16", "preview-p2-iphone16"]);
    views.apply(msg("close", [], "p2"));
    expect(made[0]!.webContents.close).not.toHaveBeenCalled();
    expect(made[1]!.webContents.close).toHaveBeenCalled();
  });

  it("starts over when a preview's origin changes", () => {
    const { views, made } = setup();
    views.apply(msg("show", [iphone]));
    views.apply({ ...msg("show", [iphone]), origin: "http://127.0.0.1:5174" });
    expect(made).toHaveLength(2);
    expect(made[0]!.webContents.close).toHaveBeenCalled();
    expect(made[1]!.webContents.loadURL).toHaveBeenCalledWith("http://127.0.0.1:5174");
  });

  it("refuses to show without a window, and closeAll destroys everything", () => {
    const none = setup({ noWindow: true });
    expect(none.views.apply(msg("show", [iphone]))).toBe(false);
    expect(none.made).toHaveLength(0);
    const { views, made, children } = setup();
    views.apply(msg("show", [iphone], "p1"));
    views.apply(msg("show", [laptop], "p2"));
    views.closeAll();
    expect(children.size).toBe(0);
    for (const v of made) expect(v.webContents.close).toHaveBeenCalled();
  });

  it("refuses an origin that is not a preview origin", () => {
    const { views, made } = setup();
    expect(views.apply({ ...msg("show", [iphone]), origin: "http://theterminal.localhost:4317" })).toBe(false);
    expect(made).toHaveLength(0);
  });

  it("captures each device through CDP Page.captureScreenshot at its emulated viewport", async () => {
    const { views, made } = setup();
    views.apply(msg("show", [iphone, laptop]));
    const shots = await views.capture("p1");
    expect(shots).toEqual([
      { device: "iphone16", png: "iVBORw0KGgo=" },
      { device: "laptop", png: "iVBORw0KGgo=" },
    ]);
    const dbg = made[0]!.webContents.debugger;
    expect(dbg.attach).toHaveBeenCalledWith("1.3");
    expect(dbg.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: 393, height: 852, scale: 1 },
      captureBeyondViewport: true,
    });
    expect(dbg.detach).toHaveBeenCalled();
    expect(await views.capture("other")).toEqual([]);
  });

  it("skips a device whose capture fails or gives no image, and still detaches", async () => {
    const { views, made } = setup();
    views.apply(msg("show", [iphone, laptop]));
    made[0]!.webContents.debugger.sendCommand.mockRejectedValueOnce(new Error("gone"));
    made[1]!.webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 42 });
    expect(await views.capture("p1")).toEqual([]);
    expect(made[0]!.webContents.debugger.detach).toHaveBeenCalled();
  });
});
