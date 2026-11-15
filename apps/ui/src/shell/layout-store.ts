/** Where the dock layout lives in localStorage. Bump the version when saved layouts stop being compatible. */
export const LAYOUT_KEY = "tt.layout.v1";

// Storage can be unavailable (private windows, blocked site data); the layout is a convenience, so fail quietly.
export function saveLayout(json: unknown, key = LAYOUT_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(json));
  } catch {
    // keep working with the in-memory layout
  }
}

/** The saved layout, or null when there is none or it is not valid JSON. */
export function loadLayout(key = LAYOUT_KEY): unknown | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function resetLayout(key = LAYOUT_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing saved that we could reach
  }
}

/** Layouts the Owner saved under a name, as `[{ name, layout }]` in the order they were first saved. */
export const LAYOUTS_KEY = "tt.layouts.v1";
/** The name of the layout on screen: a preset's label, a saved name, or "Custom". */
export const LAYOUT_NAME_KEY = "tt.layout.name.v1";
export const MAX_SAVED_LAYOUTS = 10;
const MAX_NAME = 40;
/** Names the Layout select already uses for the presets and an unsaved layout. */
const TAKEN = ["guided", "operator", "custom"];

type Named = { name: string; layout: unknown };

function readNamed(): Named[] {
  try {
    const raw = localStorage.getItem(LAYOUTS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Named => typeof e === "object" && e !== null && typeof (e as Named).name === "string" && "layout" in e,
    );
  } catch {
    return [];
  }
}

function writeNamed(list: Named[]): void {
  try {
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(list));
  } catch {
    // the layout stays on screen; it just is not kept
  }
}

export function listSavedLayouts(): string[] {
  return readNamed().map((e) => e.name);
}

/**
 * Saves `json` under `name` (trimmed), replacing a layout of the same name. RangeError when the name is empty,
 * longer than 40 characters or taken by the select, or when 10 other layouts are already saved.
 */
export function saveNamedLayout(name: string, json: unknown): void {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME) throw new RangeError(`A layout name has 1 to ${MAX_NAME} characters`);
  if (TAKEN.includes(trimmed.toLowerCase())) throw new RangeError("That name is taken");
  const list = readNamed();
  const at = list.findIndex((e) => e.name === trimmed);
  if (at >= 0) list[at] = { name: trimmed, layout: json };
  else if (list.length >= MAX_SAVED_LAYOUTS) throw new RangeError(`You can keep up to ${MAX_SAVED_LAYOUTS} layouts`);
  else list.push({ name: trimmed, layout: json });
  writeNamed(list);
}

/** The layout saved under `name`, or null. */
export function loadNamedLayout(name: string): unknown | null {
  return readNamed().find((e) => e.name === name)?.layout ?? null;
}

export function removeNamedLayout(name: string): void {
  const list = readNamed();
  if (list.some((e) => e.name === name)) writeNamed(list.filter((e) => e.name !== name));
}

/** The name of the layout on screen; "Guided" when none was recorded. */
export function currentLayoutName(): string {
  try {
    return localStorage.getItem(LAYOUT_NAME_KEY) || "Guided";
  } catch {
    return "Guided";
  }
}

export function setCurrentLayoutName(name: string): void {
  try {
    localStorage.setItem(LAYOUT_NAME_KEY, name);
  } catch {
    // the name is shown for this session only
  }
}
