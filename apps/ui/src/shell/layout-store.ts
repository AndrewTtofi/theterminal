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
/** Largest serialised layout kept under a name; anything bigger is refused on save and skipped on read. */
const MAX_LAYOUT_CHARS = 200_000;
/** Names the Layout select already uses for the presets and an unsaved layout. */
const TAKEN = ["guided", "operator", "custom"];

type Named = { name: string; layout: unknown };

/** Why `name` cannot be a saved layout's name, or null when it can. Expects a trimmed name. */
function nameProblem(name: string): string | null {
  if (name.length < 1 || name.length > MAX_NAME) return `A layout name has 1 to ${MAX_NAME} characters`;
  if (TAKEN.includes(name.toLowerCase())) return "That name is taken";
  return null;
}

const tooLarge = (layout: unknown) => (JSON.stringify(layout) ?? "").length > MAX_LAYOUT_CHARS;

/** The stored entries a save would have accepted: a valid trimmed name and a layout within the size limit. */
function readNamed(): Named[] {
  try {
    const raw = localStorage.getItem(LAYOUTS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Named =>
        typeof e === "object" && e !== null && typeof (e as Named).name === "string" && "layout" in e &&
        (e as Named).name === (e as Named).name.trim() && nameProblem((e as Named).name) === null && !tooLarge((e as Named).layout),
    );
  } catch {
    return [];
  }
}

/** False when storage refused the write (full or blocked). */
function writeNamed(list: Named[]): boolean {
  try {
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function listSavedLayouts(): string[] {
  return readNamed().map((e) => e.name);
}

/**
 * Saves `json` under `name` (trimmed), replacing a layout of the same name. RangeError, with the message to show,
 * when the name is empty, longer than 40 characters or taken by the select; when 10 other layouts are already
 * saved; when the layout is over 200 KB; or when storage refuses the write.
 */
export function saveNamedLayout(name: string, json: unknown): void {
  const trimmed = name.trim();
  const problem = nameProblem(trimmed);
  if (problem) throw new RangeError(problem);
  if (tooLarge(json)) throw new RangeError("That layout is too large to save");
  const list = readNamed();
  const at = list.findIndex((e) => e.name === trimmed);
  if (at >= 0) list[at] = { name: trimmed, layout: json };
  else if (list.length >= MAX_SAVED_LAYOUTS) throw new RangeError(`You can keep up to ${MAX_SAVED_LAYOUTS} layouts`);
  else list.push({ name: trimmed, layout: json });
  if (!writeNamed(list)) throw new RangeError("The layout could not be saved: browser storage is full or blocked");
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
