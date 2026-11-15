import { z } from "zod";

export const THEME_KEYS = [
  "bg", "fg", "fg-strong", "muted", "line", "line-strong", "panel", "input", "activity", "activity-fg", "activity-active",
  "accent", "accent-hover", "on-accent", "focus", "hover", "selected", "glow",
  "status", "status-fg", "status-hover", "badge", "badge-fg",
  "attention", "on-attention", "danger", "danger-hover", "ok", "override", "idle", "running",
  "error-bg", "error-fg", "warning-bg", "warning-fg", "warning-line", "diff-add", "diff-del", "diff-hunk",
] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export const THEME_MAX_BYTES = 8 * 1024;
export const DEFAULT_THEME_ID = "ice";

export type Theme = {
  version: 1;
  id: string;
  name: string;
  base: "dark" | "light";
  colors: Partial<Record<ThemeKey, string>>;
  fonts?: { ui?: string; mono?: string };
};

/**
 * The only keys that may be translucent (`#rrggbbaa`): overlays drawn over another colour. Every other key is used
 * as a solid text or background colour, and contrast is measured on it as written, so alpha could make a safety
 * colour invisible while it still "passes".
 */
export const ALPHA_KEYS: readonly ThemeKey[] = ["glow", "status-hover", "diff-add", "diff-del", "diff-hunk"];

const SOLID_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ALPHA_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT = /^[A-Za-z0-9 -]{1,64}$/;
const solidColor = z.string().regex(SOLID_HEX, "a colour must be #rgb or #rrggbb");
const alphaColor = z.string().regex(ALPHA_HEX, "a colour must be #rgb, #rrggbb or #rrggbbaa");
const colorFor = (k: ThemeKey) => (ALPHA_KEYS.includes(k) ? alphaColor : solidColor);

/** Whether `value` is an allowed colour for `key`: alpha only on the overlay keys. */
export function isThemeColor(key: ThemeKey, value: string): boolean {
  return (ALPHA_KEYS.includes(key) ? ALPHA_HEX : SOLID_HEX).test(value);
}
const font = z.string().regex(FONT, "a font name may use letters, digits, spaces and hyphens (up to 64)");

export const themeSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, "the id must be 1 to 40 characters: a-z, 0-9 and hyphens"),
  name: z.string().trim().min(1, "the name is required").max(40, "the name is at most 40 characters"),
  base: z.enum(["dark", "light"]),
  colors: z.strictObject(
    Object.fromEntries(THEME_KEYS.map((k) => [k, colorFor(k).optional()])) as Record<ThemeKey, z.ZodOptional<typeof solidColor>>,
  ),
  fonts: z.strictObject({ ui: font.optional(), mono: font.optional() }).optional(),
});

export type ParseThemeResult = { ok: true; theme: Theme } | { ok: false; error: string };

/** Never throws. Enforces the size limit before parsing. */
export function parseTheme(json: string): ParseThemeResult {
  try {
    if (typeof json !== "string") return { ok: false, error: "That is not a theme file." };
    if (new TextEncoder().encode(json).length > THEME_MAX_BYTES) return { ok: false, error: "That theme file is too large (the limit is 8 KB)." };
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return { ok: false, error: "That file is not valid JSON." };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "That is not a theme file." };
    if (hasProtoKey(raw)) return { ok: false, error: "That theme contains a key that is not allowed." };
    const r = themeSchema.safeParse(raw);
    if (!r.success) {
      const i = r.error.issues[0];
      const where = i?.path.length ? `${i.path.join(".")}: ` : "";
      return { ok: false, error: `That theme is not valid. ${where}${i?.message ?? "unknown problem"}` };
    }
    return { ok: true, theme: r.data as Theme };
  } catch {
    return { ok: false, error: "That theme could not be read." };
  }
}

function hasProtoKey(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  for (const k of Object.keys(v)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return true;
    if (hasProtoKey((v as Record<string, unknown>)[k])) return true;
  }
  return false;
}

// --- Contrast (WCAG 2.x) ---

function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio. Alpha is ignored: only overlay keys may carry it, and they are never measured. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const READABILITY: { pair: string; fg: ThemeKey; bg: ThemeKey; min: number }[] = [
  { pair: "fg on bg", fg: "fg", bg: "bg", min: 4.5 },
  { pair: "accent on bg", fg: "accent", bg: "bg", min: 3 },
  { pair: "attention on bg", fg: "attention", bg: "bg", min: 3 },
  { pair: "danger on bg", fg: "danger", bg: "bg", min: 3 },
  { pair: "on-accent on accent", fg: "on-accent", bg: "accent", min: 4.5 },
  // Needs-you items in the status bar, the over-budget figure and the layout-save error are all this pair.
  { pair: "on-attention on attention", fg: "on-attention", bg: "attention", min: 4.5 },
  { pair: "status-fg on status", fg: "status-fg", bg: "status", min: 4.5 },
  { pair: "badge-fg on badge", fg: "badge-fg", bg: "badge", min: 4.5 },
  // The emergency banner.
  { pair: "badge-fg on danger", fg: "badge-fg", bg: "danger", min: 4.5 },
];

export function readabilityIssues(colors: Record<ThemeKey, string>): { pair: string; ratio: number; min: number }[] {
  const out: { pair: string; ratio: number; min: number }[] = [];
  for (const r of READABILITY) {
    const ratio = contrastRatio(colors[r.fg], colors[r.bg]);
    if (ratio < r.min) out.push({ pair: r.pair, ratio, min: r.min });
  }
  return out;
}

// --- Built-in themes ---

const ERR_DARK = { "error-bg": "#3a1519", "error-fg": "#f5c6cb", "warning-bg": "#33290f", "warning-fg": "#f1deb0", "warning-line": "#7a6320" };

const ice: Theme = {
  version: 1, id: "ice", name: "Ice", base: "dark",
  colors: {
    bg: "#0d1016", fg: "#cdd3df", "fg-strong": "#e8ecf3", muted: "#8a93a6", line: "#1f2533", "line-strong": "#2b3344", panel: "#121620",
    input: "#1a1f2b", activity: "#090b10", "activity-fg": "#6f7a8f", "activity-active": "#e8ecf3",
    accent: "#4fc3d9", "accent-hover": "#6fd0e2", "on-accent": "#041217", focus: "#4fc3d9", hover: "#171c27", selected: "#1d2433", glow: "#4fc3d966",
    status: "#12303a", "status-fg": "#d7f3f9", "status-hover": "#ffffff1f", badge: "#4fc3d9", "badge-fg": "#041217",
    attention: "#e3a33b", "on-attention": "#1a1000", danger: "#e5534b", "danger-hover": "#f06b63", ok: "#3fb97f", override: "#ff5c5c", idle: "#5c6578", running: "#4fc3d9",
    ...ERR_DARK, "diff-add": "#3fb97f26", "diff-del": "#e5534b26", "diff-hunk": "#4fc3d914",
  },
};

const phosphor: Theme = {
  version: 1, id: "phosphor", name: "Phosphor", base: "dark",
  colors: {
    bg: "#0b0f14", fg: "#c9d3d0", "fg-strong": "#e6efec", muted: "#86948f", line: "#1b252b", "line-strong": "#27343c", panel: "#10161d",
    input: "#17202a", activity: "#080b0f", "activity-fg": "#6d7e79", "activity-active": "#e6efec",
    accent: "#4cc38a", "accent-hover": "#6bd0a0", "on-accent": "#04140c", focus: "#4cc38a", hover: "#151d25", selected: "#1b2630", glow: "#4cc38a66",
    status: "#11301f", "status-fg": "#d6f5e5", "status-hover": "#ffffff1f", badge: "#4cc38a", "badge-fg": "#04140c",
    attention: "#e3a33b", "on-attention": "#1a1000", danger: "#e5534b", "danger-hover": "#f06b63", ok: "#3fb97f", override: "#ff5c5c", idle: "#5c6b66", running: "#4aa8e0",
    ...ERR_DARK, "diff-add": "#4cc38a26", "diff-del": "#e5534b26", "diff-hunk": "#4cc38a14",
  },
};

const amber: Theme = {
  version: 1, id: "amber", name: "Amber", base: "dark",
  colors: {
    bg: "#0f0d0a", fg: "#d6cdbf", "fg-strong": "#f1ebe0", muted: "#9a8f7d", line: "#231f18", "line-strong": "#322c22", panel: "#15120e",
    input: "#1e1a14", activity: "#0a0907", "activity-fg": "#7d7363", "activity-active": "#f1ebe0",
    accent: "#f0a43a", "accent-hover": "#f5b85e", "on-accent": "#1a0f00", focus: "#f0a43a", hover: "#1a1612", selected: "#251f17", glow: "#f0a43a66",
    status: "#3a2a0e", "status-fg": "#fbe7c4", "status-hover": "#ffffff1f", badge: "#f0a43a", "badge-fg": "#1a0f00",
    attention: "#e8d04a", "on-attention": "#1a1400", danger: "#e5534b", "danger-hover": "#f06b63", ok: "#6fbf5f", override: "#ff5c5c", idle: "#6b6254", running: "#5fb0e0",
    ...ERR_DARK, "diff-add": "#6fbf5f26", "diff-del": "#e5534b26", "diff-hunk": "#f0a43a14",
  },
};

const classic: Theme = {
  version: 1, id: "classic", name: "Classic", base: "dark",
  colors: {
    bg: "#1e1e1e", fg: "#cccccc", "fg-strong": "#e7e7e7", muted: "#8b8b8b", line: "#2b2b2b", "line-strong": "#3c3c3c", panel: "#252526",
    input: "#313131", activity: "#181818", "activity-fg": "#858585", "activity-active": "#e7e7e7",
    accent: "#0078d4", "accent-hover": "#026ec1", "on-accent": "#ffffff", focus: "#0078d4", hover: "#2a2d2e", selected: "#37373d", glow: "#0078d466",
    status: "#007acc", "status-fg": "#ffffff", "status-hover": "#ffffff1f", badge: "#0078d4", "badge-fg": "#ffffff",
    attention: "#cc6d00", "on-attention": "#000000", danger: "#c74e39", "danger-hover": "#b3412e", ok: "#2ea043", override: "#f14c4c", idle: "#6e6e6e", running: "#3794ff",
    "error-bg": "#4a1d22", "error-fg": "#f5c6cb", "warning-bg": "#3d3112", "warning-fg": "#f1deb0", "warning-line": "#7a6320",
    "diff-add": "#2ea04326", "diff-del": "#c74e3926", "diff-hunk": "#0078d414",
  },
};

const light: Theme = {
  version: 1, id: "light", name: "Light", base: "light",
  colors: {
    bg: "#f6f8fa", fg: "#1f2933", "fg-strong": "#0b1218", muted: "#5b6675", line: "#d8dee6", "line-strong": "#c3ccd6", panel: "#ffffff",
    input: "#ffffff", activity: "#e9eef3", "activity-fg": "#5b6675", "activity-active": "#0b1218",
    accent: "#0a7ea4", "accent-hover": "#086785", "on-accent": "#ffffff", focus: "#0a7ea4", hover: "#edf1f5", selected: "#dde6ee", glow: "#0a7ea44d",
    status: "#0a7ea4", "status-fg": "#ffffff", "status-hover": "#ffffff2e", badge: "#0a7ea4", "badge-fg": "#ffffff",
    attention: "#9a5b00", "on-attention": "#ffffff", danger: "#c0392b", "danger-hover": "#a02f23", ok: "#1f7a4d", override: "#d1242f", idle: "#6b7585", running: "#0a7ea4",
    "error-bg": "#fde7e9", "error-fg": "#6b1a21", "warning-bg": "#fff4d6", "warning-fg": "#5c4306", "warning-line": "#e0c46c",
    "diff-add": "#1f7a4d26", "diff-del": "#c0392b26", "diff-hunk": "#0a7ea414",
  },
};

const highContrast: Theme = {
  version: 1, id: "high-contrast", name: "High contrast", base: "dark",
  colors: {
    bg: "#000000", fg: "#ffffff", "fg-strong": "#ffffff", muted: "#c8c8c8", line: "#7a7a7a", "line-strong": "#ffffff", panel: "#000000",
    input: "#000000", activity: "#000000", "activity-fg": "#d0d0d0", "activity-active": "#ffd400",
    accent: "#ffd400", "accent-hover": "#ffe14d", "on-accent": "#000000", focus: "#ffffff", hover: "#1a1a1a", selected: "#2b2b2b", glow: "#ffd40080",
    status: "#ffd400", "status-fg": "#000000", "status-hover": "#00000033", badge: "#ffd400", "badge-fg": "#000000",
    attention: "#ff9f1a", "on-attention": "#000000", danger: "#ff5555", "danger-hover": "#ff7777", ok: "#4ade80", override: "#ff4040", idle: "#a0a0a0", running: "#4db8ff",
    "error-bg": "#330000", "error-fg": "#ffd0d0", "warning-bg": "#2b2100", "warning-fg": "#ffe9a8", "warning-line": "#ffd400",
    "diff-add": "#4ade8040", "diff-del": "#ff555540", "diff-hunk": "#ffd40026",
  },
};

export const BUILTIN_THEMES: readonly Theme[] = [ice, phosphor, amber, classic, light, highContrast];

const SAFETY_KEYS: readonly ThemeKey[] = ["attention", "danger", "override"];
/** Text drawn on a safety colour: it falls back together with that colour when either is unreadable. */
const SAFETY_TEXT: Partial<Record<ThemeKey, ThemeKey>> = { attention: "on-attention" };

function baseColors(t: Theme): Record<ThemeKey, string> {
  return (t.base === "light" ? light : ice).colors as Record<ThemeKey, string>;
}

function fill(t: Theme): Record<ThemeKey, string> {
  const b = baseColors(t);
  const out = {} as Record<ThemeKey, string>;
  for (const k of THEME_KEYS) {
    const v = Object.prototype.hasOwnProperty.call(t.colors, k) ? t.colors[k] : undefined;
    out[k] = v ?? b[k];
  }
  return out;
}

/**
 * Safety colours (attention, danger, override) under 3:1 against bg are replaced by the base theme's value. Attention
 * and its text (on-attention) are replaced together when either check fails, including on-attention under 4.5:1 on
 * attention, so a Needs-you item is never unreadable.
 */
export function safetyFallbacks(t: Theme): ThemeKey[] {
  const c = fill(t);
  const out: ThemeKey[] = [];
  for (const k of SAFETY_KEYS) {
    const text = SAFETY_TEXT[k];
    const bad = contrastRatio(c[k], c.bg) < 3 || (text !== undefined && contrastRatio(c[text], c[k]) < 4.5);
    if (bad) out.push(k, ...(text !== undefined ? [text] : []));
  }
  return out;
}

export function resolveColors(t: Theme): Record<ThemeKey, string> {
  const c = fill(t);
  const b = baseColors(t);
  for (const k of safetyFallbacks(t)) c[k] = b[k];
  return c;
}
