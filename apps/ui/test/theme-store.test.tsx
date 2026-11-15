import { act, renderHook } from "@testing-library/react";
import { BUILTIN_THEMES, resolveColors, type Theme } from "@theterminal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme } from "../src/theme/apply";
import {
  THEME_KEY,
  THEMES_KEY,
  allThemes,
  currentTheme,
  loadChosenThemeId,
  loadUserThemes,
  saveUserThemes,
  useTheme,
} from "../src/theme/theme-store";

const light = BUILTIN_THEMES.find((t) => t.id === "light")!;
const user = (id: string, extra: Partial<Theme> = {}): Theme => ({ version: 1, id, name: id, base: "dark", colors: { accent: "#ff00aa" }, ...extra });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});
afterEach(() => vi.restoreAllMocks());

describe("applyTheme", () => {
  it("sets colours, fonts and colour-scheme", () => {
    applyTheme(light);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--bg")).toBe(resolveColors(light).bg);
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--font-ui")).toContain("system-ui");
    expect(root.style.getPropertyValue("--font-mono")).toContain("monospace");
  });
  it("puts a named font first, then the default stack", () => {
    applyTheme(user("f", { fonts: { mono: "Fira Code" } }));
    expect(document.documentElement.style.getPropertyValue("--font-mono").startsWith('"Fira Code", ')).toBe(true);
  });
});

describe("storage", () => {
  it("drops corrupt user themes without throwing", () => {
    localStorage.setItem(THEMES_KEY, "{");
    expect(loadUserThemes()).toEqual([]);
    localStorage.setItem(THEMES_KEY, '[{"id":"x"}]');
    expect(loadUserThemes()).toEqual([]);
  });
  it("drops a stored theme with an unsafe font", () => {
    localStorage.setItem(THEMES_KEY, JSON.stringify([user("bad", { fonts: { ui: "Arial;}" } }), user("good")]));
    expect(loadUserThemes().map((t) => t.id)).toEqual(["good"]);
  });
  it("falls back to Ice for an unknown id", () => {
    localStorage.setItem(THEME_KEY, "nope");
    expect(loadChosenThemeId()).toBe("nope");
    expect(currentTheme().id).toBe("ice");
  });
  it("defaults to ice", () => expect(loadChosenThemeId()).toBe("ice"));
  it("caps saved themes at 20", () => {
    saveUserThemes(Array.from({ length: 25 }, (_, i) => user(`t${i}`)));
    expect(JSON.parse(localStorage.getItem(THEMES_KEY)!)).toHaveLength(20);
  });
  it("lists built-ins then user themes", () => {
    saveUserThemes([user("mine")]);
    const ids = allThemes().map((t) => t.id);
    expect(ids.slice(0, BUILTIN_THEMES.length)).toEqual(BUILTIN_THEMES.map((t) => t.id));
    expect(ids.at(-1)).toBe("mine");
  });
});

describe("useTheme", () => {
  it("applies the chosen theme and persists it", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.choose("light"));
    expect(result.current.theme.id).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(resolveColors(light).bg);
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });
  it("still applies in memory when storage throws", () => {
    const { result } = renderHook(() => useTheme());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => result.current.choose("light"));
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(resolveColors(light).bg);
  });
  it("saves and deletes user themes", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.saveUserTheme(user("mine")));
    expect(result.current.themes.some((t) => t.id === "mine")).toBe(true);
    act(() => result.current.choose("mine"));
    act(() => result.current.deleteUserTheme("mine"));
    expect(result.current.themes.some((t) => t.id === "mine")).toBe(false);
    expect(result.current.theme.id).toBe("ice");
  });
});
