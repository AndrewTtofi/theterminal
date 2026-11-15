import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { forgetBootstrapUrl, hardenContents, hardenSession, isFatalLoadFailure } from "../src/harden.js";

const APP = "http://theterminal.localhost:4317/";

function event(url?: string) {
  return { url, preventDefault: vi.fn(), defaultPrevented: false };
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
    navigationHistory: { clear: ReturnType<typeof vi.fn> };
  };
  c.setWindowOpenHandler = (h) => (c.openHandler = h);
  c.navigationHistory = { clear: vi.fn() };
  return c;
}

describe("hardenSession", () => {
  it("denies every permission request and check", () => {
    const s = fakeSession();
    hardenSession(s);
    const cb = vi.fn();
    s.request?.({}, "media", cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(s.check?.({}, "clipboard-read", APP, {})).toBe(false);
  });

  it("cancels HID, serial and USB device pickers", () => {
    const s = fakeSession();
    hardenSession(s);
    const hid = { e: event(), cb: vi.fn() };
    s.emit("select-hid-device", hid.e, { deviceList: [{ deviceId: "d" }] }, hid.cb);
    expect(hid.e.preventDefault).toHaveBeenCalled();
    expect(hid.cb).toHaveBeenCalledWith();
    const serial = { e: event(), cb: vi.fn() };
    s.emit("select-serial-port", serial.e, [{ portId: "p" }], {}, serial.cb);
    expect(serial.e.preventDefault).toHaveBeenCalled();
    expect(serial.cb).toHaveBeenCalledWith("");
    const usb = { e: event(), cb: vi.fn() };
    s.emit("select-usb-device", usb.e, { deviceList: [{ deviceId: "u" }] }, usb.cb);
    expect(usb.e.preventDefault).toHaveBeenCalled();
    expect(usb.cb).toHaveBeenCalledWith();
  });
});

describe("hardenContents", () => {
  const setup = (port: number | undefined) => {
    const c = fakeContents();
    const openExternal = vi.fn();
    hardenContents(c, { appPort: () => port, openExternal });
    return { c, openExternal };
  };

  it("lets will-navigate stay on the app origin", () => {
    const { c, openExternal } = setup(4317);
    const e = event(`${APP}x`);
    c.emit("will-navigate", e, e.url);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("blocks will-navigate elsewhere and sends only http(s) to the system browser", () => {
    const { c, openExternal } = setup(4317);
    const web = event("https://example.com/a");
    c.emit("will-navigate", web, web.url);
    expect(web.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
    const file = event("file:///etc/hosts");
    c.emit("will-navigate", file, file.url);
    expect(file.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it.each(["will-redirect", "will-frame-navigate"])("guards %s without opening anything", (name) => {
    const { c, openExternal } = setup(4317);
    const away = event("https://example.com/");
    c.emit(name, away, away.url);
    expect(away.preventDefault).toHaveBeenCalled();
    const home = event(`${APP}y`);
    c.emit(name, home, home.url);
    expect(home.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("blocks every navigation before the server's port is known", () => {
    const { c } = setup(undefined);
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      const e = event(APP);
      c.emit(name, e, e.url);
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it("denies new windows, opening http(s) ones in the system browser", () => {
    const { c, openExternal } = setup(4317);
    expect(c.openHandler?.({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(c.openHandler?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(c.openHandler?.({ url: APP })).toEqual({ action: "deny" });
    expect(openExternal.mock.calls).toEqual([["https://example.com/"], [APP]]);
  });

  it("refuses webviews and cancels the Bluetooth picker", () => {
    const { c } = setup(4317);
    const wv = event();
    c.emit("will-attach-webview", wv, {}, {});
    expect(wv.preventDefault).toHaveBeenCalled();
    const bt = { e: event(), cb: vi.fn() };
    c.emit("select-bluetooth-device", bt.e, [{ deviceId: "b" }], bt.cb);
    expect(bt.e.preventDefault).toHaveBeenCalled();
    expect(bt.cb).toHaveBeenCalledWith("");
  });
});

describe("forgetBootstrapUrl", () => {
  it("clears history once, after the first app-origin navigation", () => {
    const c = fakeContents();
    forgetBootstrapUrl(c, 4317);
    c.emit("did-navigate", event(), "about:blank");
    expect(c.navigationHistory.clear).not.toHaveBeenCalled();
    c.emit("did-navigate", event(), `${APP}?token=abc`);
    c.emit("did-navigate", event(), `${APP}later`);
    expect(c.navigationHistory.clear).toHaveBeenCalledTimes(1);
  });
});

describe("isFatalLoadFailure", () => {
  it("is a main-frame failure other than an aborted load", () => {
    expect(isFatalLoadFailure(-102, true)).toBe(true);
    expect(isFatalLoadFailure(-102, false)).toBe(false);
    expect(isFatalLoadFailure(-3, true)).toBe(false);
  });
});
