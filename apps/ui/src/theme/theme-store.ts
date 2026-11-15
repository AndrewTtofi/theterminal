import { BUILTIN_THEMES, DEFAULT_THEME_ID, themeSchema, type Theme } from "@theterminal/shared";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { applyTheme } from "./apply";

/** Which theme is chosen: a built-in id or a user theme's id. */
export const THEME_KEY = "tt.theme.v1";
/** The Owner's own themes, as a JSON array. */
export const THEMES_KEY = "tt.themes.v1";
export const MAX_USER_THEMES = 20;

// Storage can be unavailable; the theme is a convenience, so keep working in memory when a write is refused.
let memId: string | null = null;
let memUsers: Theme[] | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** The in-memory choice wins when set: it is newer than whatever storage holds, since its write was refused. */
export function loadChosenThemeId(): string {
  if (memId !== null) return memId;
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v) return v;
  } catch {
    // storage unavailable: use the default
  }
  return DEFAULT_THEME_ID;
}

export function saveChosenThemeId(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
    memId = null;
  } catch {
    memId = id;
  }
  changed();
}

/** The stored user themes that still pass the schema; invalid ones are dropped. The in-memory list wins when set. */
export function loadUserThemes(): Theme[] {
  if (memUsers !== null) return [...memUsers];
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(THEMES_KEY);
    if (raw === null) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Theme[] = [];
  for (const e of parsed) {
    const r = themeSchema.safeParse(e);
    if (r.success) out.push(r.data as Theme);
  }
  return out.slice(0, MAX_USER_THEMES);
}

export function saveUserThemes(ts: Theme[]): void {
  const capped = ts.slice(0, MAX_USER_THEMES);
  try {
    localStorage.setItem(THEMES_KEY, JSON.stringify(capped));
    memUsers = null;
  } catch {
    memUsers = capped;
  }
  changed();
}

export function allThemes(): Theme[] {
  return [...BUILTIN_THEMES, ...loadUserThemes()];
}

const ice = () => BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]!;

/** The chosen theme; an unknown id gives Ice. */
export function currentTheme(): Theme {
  const id = loadChosenThemeId();
  return allThemes().find((t) => t.id === id) ?? ice();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useTheme(): {
  theme: Theme;
  themes: Theme[];
  choose: (id: string) => void;
  saveUserTheme: (t: Theme) => void;
  deleteUserTheme: (id: string) => void;
} {
  useSyncExternalStore(subscribe, () => version);
  const theme = currentTheme();
  const themes = allThemes();
  useEffect(() => applyTheme(theme), [theme]);

  const choose = useCallback((id: string) => {
    saveChosenThemeId(id);
    applyTheme(currentTheme());
  }, []);
  const saveUserTheme = useCallback((t: Theme) => {
    const list = loadUserThemes();
    const at = list.findIndex((x) => x.id === t.id);
    if (at >= 0) list[at] = t;
    else list.push(t);
    saveUserThemes(list);
    applyTheme(currentTheme());
  }, []);
  const deleteUserTheme = useCallback((id: string) => {
    saveUserThemes(loadUserThemes().filter((x) => x.id !== id));
    applyTheme(currentTheme());
  }, []);
  return { theme, themes, choose, saveUserTheme, deleteUserTheme };
}
