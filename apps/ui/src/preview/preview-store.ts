import { DEVICE_IDS, PREVIEW_LIMITS } from "@theterminal/shared";
import type { DeviceId } from "@theterminal/shared";

/** Where the Preview tab remembers its devices; per computer and browser, like the layout. */
export const PREVIEW_KEY = "tt.preview.v1";

export type PreviewPrefs = { devices: DeviceId[]; rotated: DeviceId[] };

const DEFAULT_DEVICES: DeviceId[] = ["iphone16", "ipad", "laptop"];

const known = (v: unknown): v is DeviceId => typeof v === "string" && (DEVICE_IDS as readonly string[]).includes(v);

/** Known ids only, each once, in the fixed device order, at most four; an empty result gives the default. */
export function normalizeDevices(v: unknown): DeviceId[] {
  const picked = Array.isArray(v) ? new Set(v.filter(known)) : new Set<DeviceId>();
  const out = DEVICE_IDS.filter((d) => picked.has(d)).slice(0, PREVIEW_LIMITS.maxDevices);
  return out.length > 0 ? out : [...DEFAULT_DEVICES];
}

function normalize(v: unknown): PreviewPrefs {
  const o = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const devices = normalizeDevices(o.devices);
  const rotated = Array.isArray(o.rotated) ? new Set(o.rotated.filter(known)) : new Set<DeviceId>();
  return { devices, rotated: devices.filter((d) => rotated.has(d)) };
}

// Storage can be unavailable (private windows, blocked site data); the choice is a convenience, so fail quietly.
export function loadPreviewPrefs(): PreviewPrefs {
  try {
    const raw = localStorage.getItem(PREVIEW_KEY);
    return normalize(raw === null ? null : JSON.parse(raw));
  } catch {
    return normalize(null);
  }
}

export function savePreviewPrefs(p: PreviewPrefs): void {
  try {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(normalize(p)));
  } catch {
    // keep the choice for this session only
  }
}

/** Adds or removes a device; the last one stays, and nothing past four is added. */
export function toggleDevice(p: PreviewPrefs, id: DeviceId): PreviewPrefs {
  if (p.devices.includes(id)) {
    if (p.devices.length === 1) return p;
    return normalize({ devices: p.devices.filter((d) => d !== id), rotated: p.rotated });
  }
  if (p.devices.length >= PREVIEW_LIMITS.maxDevices) return p;
  return normalize({ devices: [...p.devices, id], rotated: p.rotated });
}

/** Rotates every picked device, or turns them all back when every one is already rotated. */
export function rotateAll(p: PreviewPrefs): PreviewPrefs {
  const all = p.devices.every((d) => p.rotated.includes(d));
  return { devices: p.devices, rotated: all ? [] : [...p.devices] };
}
