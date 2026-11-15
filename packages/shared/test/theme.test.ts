import { describe, expect, it } from "vitest";
import {
  ALPHA_KEYS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  THEME_KEYS,
  contrastRatio,
  isThemeColor,
  parseTheme,
  readabilityIssues,
  resolveColors,
  safetyFallbacks,
  type Theme,
} from "../src/index.js";

const byId = (id: string) => BUILTIN_THEMES.find((t) => t.id === id)!;
const base = (over: Partial<Theme> = {}): Theme => ({ version: 1, id: "mine", name: "Mine", base: "dark", colors: {}, ...over });

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeGreaterThan(4.4);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.55);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
  });
});

describe("built-in themes", () => {
  it("lists ids and the default", () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual(["ice", "phosphor", "amber", "classic", "light", "high-contrast"]);
    expect(DEFAULT_THEME_ID).toBe("ice");
  });
  it("each has every key and passes readability", () => {
    for (const t of BUILTIN_THEMES) {
      for (const k of THEME_KEYS) expect(t.colors[k], `${t.id}.${k}`).toBeDefined();
      expect(readabilityIssues(resolveColors(t)), t.id).toEqual([]);
      expect(safetyFallbacks(t), t.id).toEqual([]);
      expect(parseTheme(JSON.stringify(t)).ok, t.id).toBe(true);
    }
  });
  it("Classic keeps today's palette", () => {
    const c = byId("classic").colors;
    expect(c).toMatchObject({
      bg: "#1e1e1e", fg: "#cccccc", "fg-strong": "#e7e7e7", muted: "#8b8b8b", line: "#2b2b2b", "line-strong": "#3c3c3c",
      panel: "#252526", input: "#313131", activity: "#181818", "activity-fg": "#858585", "activity-active": "#e7e7e7",
      accent: "#0078d4", "accent-hover": "#026ec1", focus: "#0078d4", hover: "#2a2d2e", selected: "#37373d",
      status: "#007acc", "status-fg": "#ffffff", attention: "#cc6d00", badge: "#0078d4", danger: "#c74e39", ok: "#2ea043",
      override: "#f14c4c", idle: "#6e6e6e", running: "#3794ff", "danger-hover": "#b3412e", "badge-fg": "#ffffff",
      "error-bg": "#4a1d22", "error-fg": "#f5c6cb", "warning-bg": "#3d3112", "warning-fg": "#f1deb0", "warning-line": "#7a6320",
    });
  });
  it("Ice, Phosphor, Amber, Light, High contrast match the spec", () => {
    expect(byId("ice").colors).toMatchObject({ bg: "#0d1016", panel: "#121620", accent: "#4fc3d9" });
    expect(byId("phosphor").colors).toMatchObject({ bg: "#0b0f14", panel: "#10161d", accent: "#4cc38a" });
    expect(byId("amber").colors).toMatchObject({ bg: "#0f0d0a", panel: "#15120e", accent: "#f0a43a" });
    expect(byId("light").colors).toMatchObject({ bg: "#f6f8fa", panel: "#ffffff", accent: "#0a7ea4" });
    expect(byId("high-contrast").colors).toMatchObject({ bg: "#000000", panel: "#000000", accent: "#ffd400" });
    expect(byId("light").base).toBe("light");
  });
});

describe("parseTheme", () => {
  const ok = JSON.stringify(base({ colors: { accent: "#123456" } }));
  it("accepts a valid theme", () => {
    const r = parseTheme(ok);
    expect(r.ok).toBe(true);
  });
  it.each([
    ["non-hex colour", JSON.stringify(base({ colors: { bg: "red" } }))],
    ["short hex", JSON.stringify(base({ colors: { bg: "#12345" } }))],
    ["injection", JSON.stringify(base({ colors: { bg: "#fff; x" } }))],
    ["unknown colour key", JSON.stringify({ ...base(), colors: { nope: "#ffffff" } })],
    ["unknown top-level key", JSON.stringify({ ...base(), extra: 1 })],
    ["bad font", JSON.stringify(base({ fonts: { ui: "Arial;}" } }))],
    ["too big", JSON.stringify(base({ name: "x".repeat(9000) }))],
    ["invalid json", "{not json"],
    ["proto key", '{"version":1,"id":"a","name":"A","base":"dark","colors":{},"__proto__":{"x":1}}'],
    ["colour proto key", '{"version":1,"id":"a","name":"A","base":"dark","colors":{"__proto__":"#ffffff"}}'],
    ["bad id", JSON.stringify(base({ id: "Bad Id" }))],
    ["empty name", JSON.stringify(base({ name: "" }))],
    ["not an object", "42"],
    ["alpha on override", JSON.stringify(base({ colors: { override: "#ff000000" } }))],
    ["alpha on bg", JSON.stringify(base({ colors: { bg: "#0d1016ff" } }))],
    ["alpha on attention", JSON.stringify(base({ colors: { attention: "#e3a33b00" } }))],
    ["alpha on danger", JSON.stringify(base({ colors: { danger: "#e5534b10" } }))],
    ["alpha on fg", JSON.stringify(base({ colors: { fg: "#cdd3df00" } }))],
  ])("rejects %s", (_n, json) => {
    const r = parseTheme(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(3);
  });
});

describe("alpha", () => {
  it("is allowed only on translucent overlay keys", () => {
    expect(ALPHA_KEYS).toEqual(["glow", "status-hover", "diff-add", "diff-del", "diff-hunk"]);
    for (const k of ALPHA_KEYS) expect(parseTheme(JSON.stringify(base({ colors: { [k]: "#11223344" } }))).ok, k).toBe(true);
    for (const k of THEME_KEYS.filter((k) => !ALPHA_KEYS.includes(k))) {
      expect(parseTheme(JSON.stringify(base({ colors: { [k]: "#11223344" } }))).ok, k).toBe(false);
      expect(isThemeColor(k, "#11223344"), k).toBe(false);
      expect(isThemeColor(k, "#112233"), k).toBe(true);
      expect(isThemeColor(k, "#123"), k).toBe(true);
    }
  });
  it("refuses an invisible override with a plain message", () => {
    const r = parseTheme(JSON.stringify(base({ colors: { override: "#ff000000" } })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("colors.override: a colour must be #rgb or #rrggbb");
  });
});

describe("resolveColors", () => {
  it("fills missing keys from Ice for dark themes", () => {
    const r = resolveColors(base({ colors: { accent: "#ff00ff" } }));
    expect(r.accent).toBe("#ff00ff");
    expect(r.bg).toBe(byId("ice").colors.bg);
    expect(Object.keys(r)).toEqual([...THEME_KEYS]);
  });
  it("fills missing keys from Light for light themes", () => {
    expect(resolveColors(base({ base: "light" })).bg).toBe(byId("light").colors.bg);
  });
  it("replaces an invisible safety colour with the base value", () => {
    const t = base({ colors: { override: byId("ice").colors.bg } });
    expect(resolveColors(t).override).toBe(byId("ice").colors.override);
    expect(safetyFallbacks(t)).toEqual(["override"]);
  });
});
