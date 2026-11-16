/**
 * The locks for website preview views: the session of each device view's in-memory partition, and its web contents.
 * They are separate from The Terminal's own window (`harden.ts`), which keeps its own policy unchanged. Everything
 * here takes the Electron objects through small structural types, so it can be tested with plain emitters.
 */
import type { PreviewCaptureMessage, PreviewDeviceView, PreviewViewsMessage } from "@theterminal/core/dist/host.js";
import { hardenSession, type ContentsLike, type SessionLike } from "./harden.js";
import { externalUrl } from "./navigation.js";

type Listener = (...args: any[]) => void;
type Preventable = { preventDefault(): void; url?: string; isMainFrame?: boolean };

const ORIGIN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/;

/** Exactly `http://127.0.0.1:<1-65535>` or `http://[::1]:<1-65535>`: the only origins a preview view may show. */
export function isPreviewOrigin(origin: string): boolean {
  if (typeof origin !== "string") return false;
  const m = ORIGIN.exec(origin);
  return m !== null && Number(m[1]) <= 65_535;
}

/** Which policy a new web contents gets: a preview session's contents the preview policy, every other the app's. */
export function policyFor(isPreview: boolean): "preview" | "app" {
  return isPreview ? "preview" : "app";
}

/** The app session's hardening (every permission refused, device pickers cancelled), and every download refused. */
export function hardenPreviewSession(s: SessionLike): void {
  hardenSession(s);
  s.on("will-download", (event: Preventable) => event.preventDefault());
}

function sameOrigin(url: string | undefined, origin: string): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Keeps a preview view on its own origin. A main-frame navigation elsewhere is prevented and, when it is http(s) and
 * the person confirms, opened in their browser. A main-frame redirect elsewhere is only prevented. Sub-frame
 * navigations and sub-resources are allowed, so ordinary sites work. New windows are always denied (http(s) ones may
 * open outside after a confirmation). Webviews are refused and the Bluetooth picker is cancelled. One confirmation is
 * open at a time; anything the page asks for meanwhile is only prevented, so a page cannot stack dialogs.
 */
export function hardenPreviewContents(
  c: ContentsLike,
  o: { origin: string; confirmOpen: (url: string) => Promise<boolean>; openExternal: (url: string) => void },
): void {
  let asking = false;
  const offerOutside = (url: string | undefined) => {
    const external = url === undefined ? null : externalUrl(url);
    if (external === null || asking) return;
    asking = true;
    let answer: Promise<boolean>;
    try {
      answer = Promise.resolve(o.confirmOpen(external));
    } catch {
      answer = Promise.resolve(false);
    }
    void answer
      .then(
        (yes) => yes === true,
        () => false,
      )
      .then((yes) => {
        asking = false;
        if (yes) o.openExternal(external);
      });
  };
  // A frame event that does not say which frame counts as the main frame.
  const guard = (offer: boolean) => (event: Preventable, legacyUrl?: string) => {
    if (event.isMainFrame === false) return;
    const url = event.url ?? legacyUrl;
    if (sameOrigin(url, o.origin)) return;
    event.preventDefault();
    if (offer) offerOutside(url);
  };
  // A main-frame navigation can raise both events; the one-question rule keeps it to a single confirmation.
  c.on("will-navigate", guard(true) as Listener);
  c.on("will-frame-navigate", guard(true) as Listener);
  c.on("will-redirect", guard(false) as Listener);
  c.setWindowOpenHandler(({ url }) => {
    offerOutside(url);
    return { action: "deny" };
  });
  c.on("will-attach-webview", (event: Preventable) => event.preventDefault());
  c.on("select-bluetooth-device", (event: Preventable, _devices: unknown, callback: (id: string) => void) => {
    event.preventDefault();
    callback("");
  });
}

/** A request id: 1–64 letters, digits, `-` or `_`, as for `pick_folder`. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREVIEW_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;
// Printable ASCII only.
const USER_AGENT = /^[\x20-\x7e]+$/;
const MAX_VIEWS = 4;
const MAX_COORD = 20_000;
const MAX_SCALE = 10;
const MAX_USER_AGENT = 1024;
const ACTIONS = new Set<string>(["show", "hide", "reload", "close"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const coord = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_COORD;
const str = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);

function parseView(v: unknown): PreviewDeviceView | null {
  if (!isObject(v) || !isObject(v.viewport)) return null;
  const { device, x, y, width, height, scale, mobile, userAgent } = v;
  const vw = v.viewport.width;
  const vh = v.viewport.height;
  if (!str(device, DEVICE_ID) || !coord(x) || !coord(y) || !coord(width) || !coord(height) || !coord(vw) || !coord(vh)) return null;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > MAX_SCALE) return null;
  if (typeof mobile !== "boolean") return null;
  if (userAgent !== null && !(typeof userAgent === "string" && userAgent.length <= MAX_USER_AGENT && USER_AGENT.test(userAgent))) return null;
  return { device, x, y, width, height, viewport: { width: vw, height: vh }, scale, mobile, userAgent };
}

/**
 * A clean copy of a `preview_views` or `preview_capture` request from the server child, or null when it breaks any
 * limit: an id like `pick_folder`'s, a preview id of 1–100 letters, digits, `-` or `_`, an origin `isPreviewOrigin`
 * accepts, a known action, at most 4 views, every number finite in 0..20000 and the scale in (0, 10], a device id like
 * the preview id, and a user agent of at most 1024 printable ASCII characters or null.
 */
export function parsePreviewMessage(m: unknown): PreviewViewsMessage | PreviewCaptureMessage | null {
  if (!isObject(m) || !str(m.id, REQUEST_ID) || !str(m.previewId, PREVIEW_ID)) return null;
  if (m.type === "preview_capture") return { type: "preview_capture", id: m.id, previewId: m.previewId };
  if (m.type !== "preview_views") return null;
  if (!str(m.origin, ORIGIN) || !isPreviewOrigin(m.origin)) return null;
  if (typeof m.action !== "string" || !ACTIONS.has(m.action)) return null;
  if (!Array.isArray(m.views) || m.views.length > MAX_VIEWS) return null;
  const views: PreviewDeviceView[] = [];
  for (const v of m.views) {
    const view = parseView(v);
    if (view === null) return null;
    views.push(view);
  }
  return {
    type: "preview_views",
    id: m.id,
    previewId: m.previewId,
    origin: m.origin,
    action: m.action as PreviewViewsMessage["action"],
    views,
  };
}
