/**
 * The lockdown for the default session and for every web contents. Both take the Electron objects through small
 * structural types, so they can be tested with plain emitters.
 */
import { externalUrl, isAppUrl } from "./navigation.js";

type Listener = (...args: any[]) => void;
type Emitter = { on(event: string, listener: Listener): unknown };
type Preventable = { preventDefault(): void; url?: string };

export type SessionLike = Emitter & {
  setPermissionRequestHandler(handler: (wc: unknown, permission: unknown, callback: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: () => boolean): void;
};

export type ContentsLike = Emitter & {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
};

/** Denies every permission request and check, and cancels the HID, serial and USB device pickers. */
export function hardenSession(s: SessionLike): void {
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on("select-hid-device", (event: Preventable, _details: unknown, callback: () => void) => {
    event.preventDefault();
    callback();
  });
  s.on("select-serial-port", (event: Preventable, _ports: unknown, _wc: unknown, callback: (id: string) => void) => {
    event.preventDefault();
    callback("");
  });
  s.on("select-usb-device", (event: Preventable, _details: unknown, callback: () => void) => {
    event.preventDefault();
    callback();
  });
}

/**
 * Keeps a web contents on the app origin. A top-level navigation elsewhere is blocked and, when it is http(s),
 * handed to the system browser. Redirects and frame navigations elsewhere are only blocked. New windows are always
 * denied (http(s) ones go to the system browser), webviews are refused and the Bluetooth picker is cancelled.
 * Until the server's port is known, every navigation is blocked.
 */
export function hardenContents(
  c: ContentsLike,
  o: { appPort: () => number | undefined; openExternal: (url: string) => void },
): void {
  const onApp = (url: string | undefined) => {
    const port = o.appPort();
    return port !== undefined && url !== undefined && isAppUrl(url, port);
  };
  const openExternally = (url: string | undefined) => {
    const external = url === undefined ? null : externalUrl(url);
    if (external !== null) o.openExternal(external);
  };
  const guard = (openOutside: boolean) => (event: Preventable, legacyUrl?: string) => {
    const url = event.url ?? legacyUrl;
    if (onApp(url)) return;
    event.preventDefault();
    if (openOutside) openExternally(url);
  };
  c.on("will-navigate", guard(true));
  c.on("will-redirect", guard(false));
  c.on("will-frame-navigate", guard(false));
  c.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  c.on("will-attach-webview", (event: Preventable) => event.preventDefault());
  c.on("select-bluetooth-device", (event: Preventable, _devices: unknown, callback: (id: string) => void) => {
    event.preventDefault();
    callback("");
  });
}

/** Clears the history once the first app-origin page has loaded, so the bootstrap token URL is not kept in it. */
export function forgetBootstrapUrl(c: Emitter & { navigationHistory: { clear(): void } }, port: number): void {
  let done = false;
  c.on("did-navigate", (_event: unknown, url: string) => {
    if (done || !isAppUrl(url, port)) return;
    done = true;
    c.navigationHistory.clear();
  });
}

/** A failed main-frame load the user must hear about. An aborted load (-3) is a replaced or blocked navigation. */
export function isFatalLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== -3;
}
