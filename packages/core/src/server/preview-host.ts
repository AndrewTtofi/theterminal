import { randomUUID } from "node:crypto";
import type {
  PreviewCaptureMessage,
  PreviewCapturedMessage,
  PreviewDeviceView,
  PreviewViewsDoneMessage,
  PreviewViewsMessage,
} from "../host.js";

/** Asks the host (the desktop app's main process) to lay device views over the Preview tab and to capture them. */
export type PreviewHost = {
  /** Resolves true only when the host answers that it applied the change; false on a refusal, timeout or bad input. */
  views(m: Omit<PreviewViewsMessage, "type" | "id">): Promise<boolean>;
  /** Resolves one PNG per device view, at most 4; [] on a timeout, a bad answer or a bad preview id. */
  capture(previewId: string): Promise<{ device: string; png: Buffer }[]>;
};

/** The part of the host IPC channel the preview host uses (`process.send` and `process.on("message")` under a host). */
export type PreviewHostIo = {
  send(message: PreviewViewsMessage | PreviewCaptureMessage): void;
  on(listener: (message: unknown) => void): void;
};

const DEFAULT_VIEWS_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const MAX_VIEWS = 4;
const MAX_SHOTS = 4;
/** The base64 length of the largest screenshot file (16 MiB). */
const MAX_PNG_BASE64 = Math.ceil(16_777_216 / 3) * 4;
const MAX_COORD = 20_000;
const MAX_SCALE = 10;
const MAX_USER_AGENT = 1024;

const PREVIEW_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ORIGIN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Printable ASCII only: a user agent with control or non-ASCII characters is refused.
const USER_AGENT = /^[\x20-\x7e]+$/;
const ACTIONS = new Set(["show", "hide", "reload", "close"]);
const VIEW_KEYS = ["device", "height", "mobile", "scale", "userAgent", "viewport", "width", "x", "y"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join() === keys.join();
const coord = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_COORD;

/** `http://127.0.0.1:<1-65535>` or `http://[::1]:<1-65535>`, exactly. */
function validOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  const m = ORIGIN.exec(origin);
  return m !== null && Number(m[1]) <= 65_535;
}

function validView(v: unknown): v is PreviewDeviceView {
  if (!isObject(v) || !sameKeys(v, VIEW_KEYS)) return false;
  const vp = v.viewport;
  return (
    typeof v.device === "string" &&
    DEVICE_ID.test(v.device) &&
    coord(v.x) &&
    coord(v.y) &&
    coord(v.width) &&
    coord(v.height) &&
    isObject(vp) &&
    sameKeys(vp, ["height", "width"]) &&
    coord(vp.width) &&
    coord(vp.height) &&
    typeof v.scale === "number" &&
    Number.isFinite(v.scale) &&
    v.scale > 0 &&
    v.scale <= MAX_SCALE &&
    typeof v.mobile === "boolean" &&
    (v.userAgent === null ||
      (typeof v.userAgent === "string" && v.userAgent.length <= MAX_USER_AGENT && USER_AGENT.test(v.userAgent)))
  );
}

function validViewsRequest(m: Omit<PreviewViewsMessage, "type" | "id">): boolean {
  return (
    isObject(m) &&
    typeof m.previewId === "string" &&
    PREVIEW_ID.test(m.previewId) &&
    validOrigin(m.origin) &&
    typeof m.action === "string" &&
    ACTIONS.has(m.action) &&
    Array.isArray(m.views) &&
    m.views.length <= MAX_VIEWS &&
    m.views.every(validView)
  );
}

/** The usable shots of an answer: the first 4 entries, each kept only with a valid device and a bounded base64 PNG. */
function decodeShots(shots: unknown): { device: string; png: Buffer }[] {
  if (!Array.isArray(shots)) return [];
  const out: { device: string; png: Buffer }[] = [];
  for (const s of shots.slice(0, MAX_SHOTS)) {
    if (!isObject(s) || typeof s.device !== "string" || !DEVICE_ID.test(s.device)) continue;
    const b64 = s.png;
    if (typeof b64 !== "string" || b64.length === 0 || b64.length > MAX_PNG_BASE64 || !BASE64.test(b64)) continue;
    out.push({ device: s.device, png: Buffer.from(b64, "base64") });
  }
  return out;
}

/**
 * Talks to the host's preview views over the server child's existing IPC channel, beside the folder picker. Every
 * request is checked before it is sent (a bad one is never sent and settles as a refusal), and calls may overlap, each
 * settled only by an answer of its own type and id. Anything else on the channel is ignored. `views` resolves false
 * after `viewsTimeoutMs` (default 5 s) and `capture` resolves [] after `captureTimeoutMs` (default 30 s).
 */
export function createPreviewHost(
  io: PreviewHostIo,
  opts: { viewsTimeoutMs?: number; captureTimeoutMs?: number; newId?: () => string } = {},
): PreviewHost {
  const viewsTimeoutMs = opts.viewsTimeoutMs ?? DEFAULT_VIEWS_TIMEOUT_MS;
  const captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const newId = opts.newId ?? randomUUID;
  const pendingViews = new Map<string, (ok: boolean) => void>();
  const pendingCaptures = new Map<string, (shots: { device: string; png: Buffer }[]) => void>();

  io.on((message) => {
    if (!isObject(message) || typeof message.id !== "string") return;
    if (message.type === "preview_views_done") {
      const m = message as Partial<PreviewViewsDoneMessage>;
      pendingViews.get(message.id)?.(m.ok === true);
    } else if (message.type === "preview_captured") {
      const m = message as Partial<PreviewCapturedMessage>;
      pendingCaptures.get(message.id)?.(decodeShots(m.shots));
    }
  });

  function ask<T>(
    pending: Map<string, (value: T) => void>,
    message: (id: string) => PreviewViewsMessage | PreviewCaptureMessage,
    timeoutMs: number,
    fallback: T,
  ): Promise<T> {
    const id = newId();
    return new Promise<T>((resolve) => {
      const finish = (value: T) => {
        if (pending.get(id) !== finish) return;
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), timeoutMs);
      timer.unref?.();
      pending.set(id, finish);
      try {
        io.send(message(id));
      } catch {
        finish(fallback);
      }
    });
  }

  return {
    views(m) {
      if (!validViewsRequest(m)) return Promise.resolve(false);
      const { previewId, origin, action, views } = m;
      return ask(
        pendingViews,
        (id) => ({ type: "preview_views", id, previewId, origin, action, views }),
        viewsTimeoutMs,
        false,
      );
    },
    capture(previewId) {
      if (typeof previewId !== "string" || !PREVIEW_ID.test(previewId)) return Promise.resolve([]);
      return ask(pendingCaptures, (id) => ({ type: "preview_capture", id, previewId }), captureTimeoutMs, []);
    },
  };
}
