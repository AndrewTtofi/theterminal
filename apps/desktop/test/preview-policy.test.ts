import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  hardenPreviewContents,
  hardenPreviewSession,
  isPreviewOrigin,
  parsePreviewMessage,
  policyFor,
} from "../src/preview-policy.js";

const ORIGIN = "http://127.0.0.1:5173";

function event(url?: string, isMainFrame?: boolean) {
  return { url, isMainFrame, preventDefault: vi.fn() };
}

function fakeSession() {
  const s = new EventEmitter() as EventEmitter & {
    request?: (wc: unknown, permission: string, cb: (granted: boolean) => void) => void;
    check?: (...args: unknown[]) => boolean;
    setPermissionRequestHandler(h: NonNullable<typeof s.request>): void;
    setPermissionCheckHandler(h: NonNullable<typeof s.check>): void;
  };
  s.setPermissionRequestHandler = (h) => (s.request = h);
  s.setPermissionCheckHandler = (h) => (s.check = h);
  return s;
}

function fakeContents() {
  const c = new EventEmitter() as EventEmitter & {
    openHandler?: (d: { url: string }) => { action: string };
    setWindowOpenHandler(h: NonNullable<typeof c.openHandler>): void;
  };
  c.setWindowOpenHandler = (h) => (c.openHandler = h);
  return c;
}

/** Lets pending confirmations settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("isPreviewOrigin", () => {
  it("accepts exactly a loopback http origin with a port of 1-65535", () => {
    expect(isPreviewOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isPreviewOrigin("http://[::1]:5173")).toBe(true);
    expect(isPreviewOrigin("http://127.0.0.1:65535")).toBe(true);
    expect(isPreviewOrigin("http://127.0.0.1:1")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const o of [
      "http://localhost:5173",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:05173",
      "http://127.0.0.1",
      "http://127.0.0.1:5173/",
      "https://127.0.0.1:5173",
      "http://127.0.0.2:5173",
      "http://theterminal.localhost:4317",
      "http://example.com",
      "http://user@127.0.0.1:5173",
      " http://127.0.0.1:5173",
    ]) {
      expect(isPreviewOrigin(o), o).toBe(false);
    }
    expect(isPreviewOrigin(42 as unknown as string)).toBe(false);
  });
});

describe("policyFor", () => {
  it("gives the preview policy only to preview sessions; everything else keeps the app policy", () => {
    expect(policyFor(true)).toBe("preview");
    expect(policyFor(false)).toBe("app");
  });
});

describe("hardenPreviewSession", () => {
  it("refuses every permission request and check", () => {
    const s = fakeSession();
    hardenPreviewSession(s);
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "midi", "fullscreen"]) {
      const cb = vi.fn();
      s.request?.({}, permission, cb);
      expect(cb).toHaveBeenCalledWith(false);
    }
    expect(s.check?.({}, "media", ORIGIN, {})).toBe(false);
  });

  it("prevents every download", () => {
    const s = fakeSession();
    hardenPreviewSession(s);
    const e = event();
    s.emit("will-download", e, { getURL: () => `${ORIGIN}/file.zip` }, {});
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("cancels the HID, serial and USB pickers as the app session does", () => {
    const s = fakeSession();
    hardenPreviewSession(s);
    const hid = { e: event(), cb: vi.fn() };
    s.emit("select-hid-device", hid.e, {}, hid.cb);
    expect(hid.e.preventDefault).toHaveBeenCalled();
    const usb = { e: event(), cb: vi.fn() };
    s.emit("select-usb-device", usb.e, {}, usb.cb);
    expect(usb.e.preventDefault).toHaveBeenCalled();
  });
});

describe("hardenPreviewContents", () => {
  const setup = (answer: boolean | "reject" = true) => {
    const c = fakeContents();
    const openExternal = vi.fn();
    const confirmOpen = vi.fn((_url: string) => (answer === "reject" ? Promise.reject(new Error("no")) : Promise.resolve(answer)));
    hardenPreviewContents(c, { origin: ORIGIN, confirmOpen, openExternal });
    return { c, openExternal, confirmOpen };
  };

  it("allows a main-frame navigation within the preview's origin", async () => {
    const { c, openExternal, confirmOpen } = setup();
    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
      const e = event(`${ORIGIN}/about`, true);
      c.emit(name, e, e.url);
      expect(e.preventDefault, name).not.toHaveBeenCalled();
    }
    await settle();
    expect(confirmOpen).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("works for the ::1 origin too", () => {
    const c = fakeContents();
    hardenPreviewContents(c, { origin: "http://[::1]:3000", confirmOpen: vi.fn(), openExternal: vi.fn() });
    const ok = event("http://[::1]:3000/x", true);
    c.emit("will-navigate", ok, ok.url);
    expect(ok.preventDefault).not.toHaveBeenCalled();
    const other = event("http://[::1]:3001/x", true);
    c.emit("will-navigate", other, other.url);
    expect(other.preventDefault).toHaveBeenCalled();
  });

  it("prevents a main-frame navigation elsewhere and opens it outside once the person confirms", async () => {
    const { c, openExternal, confirmOpen } = setup(true);
    const e = event("https://example.com/", true);
    c.emit("will-navigate", e, e.url);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    await settle();
    expect(confirmOpen).toHaveBeenCalledWith("https://example.com/");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("opens nothing when the person declines, or the confirmation fails", async () => {
    for (const answer of [false, "reject"] as const) {
      const { c, openExternal, confirmOpen } = setup(answer);
      const e = event("https://example.com/", true);
      c.emit("will-frame-navigate", e);
      expect(e.preventDefault).toHaveBeenCalled();
      await settle();
      expect(confirmOpen).toHaveBeenCalledTimes(1);
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it("prevents a navigation to The Terminal's own origin", async () => {
    const { c } = setup(false);
    const e = event("http://theterminal.localhost:4000/", true);
    c.emit("will-navigate", e, e.url);
    expect(e.preventDefault).toHaveBeenCalled();
    const f = event("http://theterminal.localhost:4000/api/projects", true);
    c.emit("will-frame-navigate", f);
    expect(f.preventDefault).toHaveBeenCalled();
  });

  it("allows sub-frame navigations anywhere, so embedded content works", async () => {
    const { c, confirmOpen } = setup();
    const e = event("https://youtube.com/embed/x", false);
    c.emit("will-frame-navigate", e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    const r = event("https://youtube.com/embed/y", false);
    c.emit("will-redirect", r);
    expect(r.preventDefault).not.toHaveBeenCalled();
    await settle();
    expect(confirmOpen).not.toHaveBeenCalled();
  });

  it("treats a frame navigation that does not say which frame as the main frame", () => {
    const { c } = setup();
    const e = event("https://example.com/");
    c.emit("will-frame-navigate", e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("prevents a main-frame redirect elsewhere without asking", async () => {
    const { c, confirmOpen, openExternal } = setup();
    const e = event("https://example.com/", true);
    c.emit("will-redirect", e, e.url, false, true);
    expect(e.preventDefault).toHaveBeenCalled();
    await settle();
    expect(confirmOpen).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("never sends a file:, data: or javascript: URL outside, and never asks about it", async () => {
    const { c, confirmOpen, openExternal } = setup(true);
    for (const url of ["file:///etc/hosts", "data:text/html,hi", "javascript:alert(1)", "not a url"]) {
      const e = event(url, true);
      c.emit("will-navigate", e, url);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(c.openHandler?.({ url })).toEqual({ action: "deny" });
    }
    await settle();
    expect(confirmOpen).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("always denies window.open, opening an http(s) one outside after a confirmation", async () => {
    const { c, confirmOpen, openExternal } = setup(true);
    expect(c.openHandler?.({ url: "https://example.com/new" })).toEqual({ action: "deny" });
    await settle();
    expect(c.openHandler?.({ url: `${ORIGIN}/popup` })).toEqual({ action: "deny" });
    await settle();
    expect(confirmOpen).toHaveBeenCalledTimes(2);
    expect(openExternal.mock.calls).toEqual([["https://example.com/new"], [`${ORIGIN}/popup`]]);
  });

  it("asks one question at a time: a page cannot stack confirmations", async () => {
    const c = fakeContents();
    let answer!: (v: boolean) => void;
    const confirmOpen = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const openExternal = vi.fn();
    hardenPreviewContents(c, { origin: ORIGIN, confirmOpen, openExternal });
    for (let i = 0; i < 5; i += 1) {
      const e = event(`https://example.com/${i}`, true);
      c.emit("will-navigate", e, e.url);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(c.openHandler?.({ url: `https://example.com/w${i}` })).toEqual({ action: "deny" });
    }
    expect(confirmOpen).toHaveBeenCalledTimes(1);
    answer(true);
    await settle();
    expect(openExternal.mock.calls).toEqual([["https://example.com/0"]]);
    const later = event("https://example.com/later", true);
    c.emit("will-navigate", later, later.url);
    expect(confirmOpen).toHaveBeenCalledTimes(2);
  });

  it("refuses webviews and cancels the Bluetooth picker as for the app window", () => {
    const { c } = setup();
    const wv = event();
    c.emit("will-attach-webview", wv, {}, {});
    expect(wv.preventDefault).toHaveBeenCalled();
    const bt = { e: event(), cb: vi.fn() };
    c.emit("select-bluetooth-device", bt.e, [{ deviceId: "b" }], bt.cb);
    expect(bt.e.preventDefault).toHaveBeenCalled();
    expect(bt.cb).toHaveBeenCalledWith("");
  });
});

describe("parsePreviewMessage", () => {
  const view = (device = "iphone16") => ({
    device,
    x: 10,
    y: 20,
    width: 196.5,
    height: 426,
    viewport: { width: 393, height: 852 },
    scale: 3,
    mobile: true,
    userAgent: "Mozilla/5.0 (iPhone)",
  });
  const views = (over: Record<string, unknown> = {}) => ({
    type: "preview_views",
    id: "0b6f3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    previewId: "p1",
    origin: ORIGIN,
    action: "show",
    views: [view()],
    ...over,
  });

  it("accepts a valid preview_views and returns a clean copy", () => {
    const m = { ...views(), extra: "dropped" };
    const parsed = parsePreviewMessage(m);
    expect(parsed).toEqual(views());
    expect(parsed).not.toHaveProperty("extra");
  });

  it("accepts every action and an empty views list", () => {
    for (const action of ["show", "hide", "reload", "close"]) {
      expect(parsePreviewMessage(views({ action, views: [] }))).not.toBeNull();
    }
  });

  it("accepts a valid preview_capture", () => {
    expect(parsePreviewMessage({ type: "preview_capture", id: "c1", previewId: "p1" })).toEqual({
      type: "preview_capture",
      id: "c1",
      previewId: "p1",
    });
  });

  it("ignores anything outside the limits", () => {
    const bad: unknown[] = [
      null,
      "preview_views",
      [],
      { type: "pick_folder", id: "p1" },
      views({ id: "" }),
      views({ id: "x".repeat(65) }),
      views({ id: "../p1" }),
      views({ id: 7 }),
      views({ previewId: "" }),
      views({ previewId: "p".repeat(101) }),
      views({ previewId: "p/1" }),
      views({ origin: "http://example.com" }),
      views({ origin: "http://localhost:5173" }),
      views({ origin: "http://127.0.0.1:0" }),
      views({ action: "navigate" }),
      views({ views: "x" }),
      views({ views: [view("a"), view("b"), view("c"), view("d"), view("e")] }),
      views({ views: [{ ...view(), x: -1 }] }),
      views({ views: [{ ...view(), width: 20_001 }] }),
      views({ views: [{ ...view(), y: Number.NaN }] }),
      views({ views: [{ ...view(), height: Number.POSITIVE_INFINITY }] }),
      views({ views: [{ ...view(), height: "1" }] }),
      views({ views: [{ ...view(), viewport: { width: 393 } }] }),
      views({ views: [{ ...view(), viewport: { width: 393, height: 30_000 } }] }),
      views({ views: [{ ...view(), viewport: null }] }),
      views({ views: [{ ...view(), scale: 0 }] }),
      views({ views: [{ ...view(), scale: 10.5 }] }),
      views({ views: [{ ...view(), scale: -1 }] }),
      views({ views: [{ ...view(), mobile: "yes" }] }),
      views({ views: [{ ...view(), device: "" }] }),
      views({ views: [{ ...view(), device: "a b" }] }),
      views({ views: [{ ...view(), userAgent: "bad\nagent" }] }),
      views({ views: [{ ...view(), userAgent: "x".repeat(1025) }] }),
      views({ views: [{ ...view(), userAgent: 5 }] }),
      views({ views: [null] }),
      { type: "preview_capture", id: "c1" },
      { type: "preview_capture", id: "c 1", previewId: "p1" },
      { type: "preview_capture", id: "c1", previewId: "p$1" },
    ];
    for (const m of bad) expect(parsePreviewMessage(m), JSON.stringify(m)).toBeNull();
  });

  it("keeps a scale of exactly 10 and coordinates of exactly 0 and 20000", () => {
    const edge = { ...view(), x: 0, y: 20_000, scale: 10, userAgent: null };
    expect(parsePreviewMessage(views({ views: [edge] }))).toEqual(views({ views: [edge] }));
  });
});
