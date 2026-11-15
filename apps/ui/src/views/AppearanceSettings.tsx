import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, KeyboardEvent } from "react";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  ALPHA_KEYS,
  THEME_KEYS,
  isThemeColor,
  parseTheme,
  readabilityIssues,
  resolveColors,
  safetyFallbacks,
} from "@theterminal/shared";
import type { Theme, ThemeKey } from "@theterminal/shared";
import { MAX_USER_THEMES, allThemes, useTheme } from "../theme/theme-store";

/** A file larger than this is refused before it is read; `parseTheme` then holds the theme itself to 8 KB. */
const IMPORT_MAX_BYTES = 64 * 1024;
const NAME_MAX = 40;
const ID_MAX = 40;

/** The editor's main six, in the spec's order. */
const MAIN: { key: ThemeKey; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "panel", label: "Panels" },
  { key: "fg", label: "Text" },
  { key: "accent", label: "Accent" },
  { key: "attention", label: "Needs you" },
  { key: "danger", label: "Danger" },
];

/** Readability pairs in plain words, and the safety colour each one is about (if any). */
const PAIRS: Record<string, { label: string; key?: ThemeKey }> = {
  "fg on bg": { label: "Text on background" },
  "accent on bg": { label: "Accent on background" },
  "attention on bg": { label: "Needs you on background", key: "attention" },
  "danger on bg": { label: "Danger on background", key: "danger" },
  "on-accent on accent": { label: "Button text on accent" },
};
const SAFETY_LABELS: Partial<Record<ThemeKey, string>> = { attention: "Needs you", danger: "Danger", override: "Override" };

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));
const builtinBase = (base: Theme["base"]) => BUILTIN_THEMES.find((t) => t.id === (base === "light" ? "light" : DEFAULT_THEME_ID))!;

/** Every colour of the theme as written, a missing one taken from its base; safety fallbacks are not applied here. */
function filled(t: Theme): Record<ThemeKey, string> {
  const base = builtinBase(t.base).colors;
  const out = {} as Record<ThemeKey, string>;
  for (const k of THEME_KEYS) out[k] = (Object.hasOwn(t.colors, k) ? t.colors[k] : undefined) ?? base[k]!;
  return out;
}

/** `#rrggbb` for the native picker, which knows nothing of short forms or alpha. */
function toPicker(hex: string): string {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return `#${h.slice(0, 6).toLowerCase()}`;
}

/** An id from `seed` that no theme has yet: a "-2", "-3"… suffix when it is taken, within the 40 characters. */
function uniqueId(seed: string, taken: ReadonlySet<string>): string {
  const slug = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, ID_MAX).replace(/-+$/, "") || "theme";
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${slug.slice(0, ID_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

const copyName = (name: string) => `${name.slice(0, NAME_MAX - 5).trimEnd()} copy`;
/** One decimal place, rounded down, so a ratio just under a minimum never reads as meeting it. */
const ratio = (r: number) => (Math.floor(r * 10) / 10).toFixed(1);

function exportTheme(t: Theme) {
  const blob = new Blob([`${JSON.stringify(t, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${t.id}.theme.json`;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

type RowProps = { colourKey: ThemeKey; label: string; hexLabel: string; value: string; mono?: boolean; onChange: (hex: string) => void };

/** One colour: the native picker and a text field for the exact hex value. Only a valid hex value is applied. */
function ColourRow({ colourKey, label, hexLabel, value, mono, onChange }: RowProps) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const alpha = ALPHA_KEYS.includes(colourKey);
  const valid = isThemeColor(colourKey, text);
  return (
    <div className="colour-row">
      <label htmlFor={id} className={mono ? "colour-label mono" : "colour-label"}>
        {label}
      </label>
      <input
        id={id}
        type="color"
        className="colour-picker"
        value={toPicker(value)}
        onChange={(e) => onChange(value.length === 9 ? `${e.target.value}${value.slice(7)}` : e.target.value)}
      />
      <input
        type="text"
        className="colour-hex"
        aria-label={hexLabel}
        aria-invalid={!valid}
        title={valid ? undefined : alpha ? "Use #rgb, #rrggbb or #rrggbbaa" : "Use #rgb or #rrggbb"}
        spellCheck={false}
        autoComplete="off"
        maxLength={9}
        value={text}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          if (isThemeColor(colourKey, v) && v !== value) onChange(v);
        }}
      />
    </div>
  );
}

/** Readability warnings and safety-fallback notes for a person's own theme. */
function Warnings({ theme }: { theme: Theme }) {
  const fallbacks = safetyFallbacks(theme);
  const issues = readabilityIssues(filled(theme)).filter((i) => {
    const key = PAIRS[i.pair]?.key;
    return key === undefined || !fallbacks.includes(key);
  });
  if (issues.length === 0 && fallbacks.length === 0) return null;
  return (
    <div className="theme-warnings">
      {issues.map((i) => (
        <p key={i.pair} role="status" className="theme-warning">
          {PAIRS[i.pair]?.label ?? i.pair} is {ratio(i.ratio)}:1; at least {i.min}:1 is recommended.
        </p>
      ))}
      {fallbacks.map((k) => (
        <p key={k} role="status" className="theme-fallback">
          {SAFETY_LABELS[k]} colour was too hard to read, so the default is used.
        </p>
      ))}
    </div>
  );
}

function Editor({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const nameId = useId();
  const [name, setName] = useState(theme.name);
  useEffect(() => setName(theme.name), [theme.name]);
  const nameValid = name.trim().length > 0 && name.trim().length <= NAME_MAX;
  const colors = filled(theme);
  const setColour = (k: ThemeKey, v: string) => onChange({ ...theme, colors: { ...theme.colors, [k]: v } });
  return (
    <section className="theme-editor" aria-label={`Edit ${theme.name}`}>
      <div className="theme-name">
        <label htmlFor={nameId}>Theme name</label>
        <input
          id={nameId}
          type="text"
          maxLength={NAME_MAX}
          aria-invalid={!nameValid}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            const v = e.target.value.trim();
            if (v.length > 0 && v !== theme.name) onChange({ ...theme, name: v });
          }}
        />
      </div>
      <div className="colour-grid">
        {MAIN.map((m) => (
          <ColourRow key={m.key} colourKey={m.key} label={m.label} hexLabel={`${m.label} hex`} value={colors[m.key]} onChange={(v) => setColour(m.key, v)} />
        ))}
      </div>
      <details className="theme-advanced">
        <summary>Advanced</summary>
        <p className="note">Every colour the interface uses, by its property name.</p>
        <div className="colour-grid">
          {THEME_KEYS.map((k) => (
            <ColourRow key={k} colourKey={k} label={`--${k}`} hexLabel={`--${k} hex`} mono value={colors[k]} onChange={(v) => setColour(k, v)} />
          ))}
        </div>
      </details>
    </section>
  );
}

/** Settings → Appearance: choose a theme, make your own, and import or export one. Everything stays on this device. */
export function AppearanceSettings() {
  const { theme, themes, choose, saveUserTheme, deleteUserTheme } = useTheme();
  const headingId = useId();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLUListElement>(null);
  const focusChosen = useRef(false);

  const own = !BUILTIN_IDS.has(theme.id);
  const editing = own && editingId === theme.id;
  const full = themes.length - BUILTIN_THEMES.length >= MAX_USER_THEMES;

  useEffect(() => setConfirmDelete(false), [theme.id]);
  useEffect(() => {
    if (!focusChosen.current) return;
    focusChosen.current = false;
    galleryRef.current?.querySelector<HTMLElement>("[aria-pressed='true']")?.focus();
  });

  const pick = (id: string) => {
    setImportError(null);
    setNotice(null);
    choose(id);
  };

  const duplicate = () => {
    const name = copyName(theme.name);
    const copy: Theme = {
      version: 1,
      id: uniqueId(name, new Set(allThemes().map((t) => t.id))),
      name,
      base: theme.base,
      colors: filled(theme),
      ...(theme.fonts !== undefined && { fonts: { ...theme.fonts } }),
    };
    saveUserTheme(copy);
    pick(copy.id);
    setEditingId(copy.id);
  };

  const remove = () => {
    const id = theme.id;
    setConfirmDelete(false);
    setEditingId(null);
    deleteUserTheme(id);
    choose(DEFAULT_THEME_ID);
    setNotice(`Deleted ${theme.name}.`);
    focusChosen.current = true;
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setImportError(null);
    setNotice(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setImportError("That file is too large to be a theme (the limit is 64 KB).");
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportError("That file could not be read.");
      return;
    }
    const parsed = parseTheme(text);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    if (allThemes().length - BUILTIN_THEMES.length >= MAX_USER_THEMES) {
      setImportError(`You already have ${MAX_USER_THEMES} themes. Delete one to import another.`);
      return;
    }
    const t: Theme = { ...parsed.theme, id: uniqueId(parsed.theme.id, new Set(allThemes().map((x) => x.id))) };
    saveUserTheme(t);
    choose(t.id);
    setNotice(`Imported ${t.name}.`);
  };

  const onConfirmKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setConfirmDelete(false);
    }
  };

  return (
    <section className="appearance" aria-labelledby={headingId}>
      <h2 id={headingId}>Appearance</h2>
      <p className="note">Themes are kept on this device only. Export one to use it elsewhere.</p>

      <ul className="theme-gallery" aria-label="Themes" ref={galleryRef}>
        {themes.map((t) => {
          const c = resolveColors(t);
          const chosen = t.id === theme.id;
          const isDefault = t.id === DEFAULT_THEME_ID;
          return (
            <li key={t.id}>
              <button
                type="button"
                className={chosen ? "theme-card chosen" : "theme-card"}
                aria-pressed={chosen}
                aria-label={isDefault ? `${t.name}, default` : t.name}
                onClick={() => pick(t.id)}
              >
                <span className="theme-card-preview" aria-hidden="true">
                  <span className="swatch swatch-bg" style={{ "--swatch": c.bg } as CSSProperties} />
                  <span className="swatch swatch-panel" style={{ "--swatch": c.panel } as CSSProperties} />
                  <span className="swatch swatch-accent" style={{ "--swatch": c.accent } as CSSProperties} />
                </span>
                <span className="theme-card-label" aria-hidden="true">
                  <span className="theme-card-name">{t.name}</span>
                  {isDefault && <span className="theme-tag">default</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="theme-actions" role="group" aria-label={`${theme.name} actions`}>
        <button type="button" className="secondary" onClick={duplicate} disabled={full}>
          Duplicate &amp; edit
        </button>
        {own && (
          <button type="button" className="secondary" aria-expanded={editing} onClick={() => setEditingId(editing ? null : theme.id)}>
            Edit
          </button>
        )}
        <button type="button" className="secondary" onClick={() => exportTheme(theme)}>
          Export
        </button>
        {own && (
          <button type="button" className="secondary quiet-danger" onClick={() => setConfirmDelete(true)} disabled={confirmDelete}>
            Delete
          </button>
        )}
      </div>
      {!own && <p className="note">Built-in themes cannot be changed. Duplicate one to make it your own.</p>}

      {own && confirmDelete && (
        <div className="theme-confirm" role="group" aria-label="Confirm delete" onKeyDown={onConfirmKey}>
          <p>Delete {theme.name}? This cannot be undone.</p>
          <div className="theme-actions">
            <button type="button" className="danger" aria-label={`Delete ${theme.name}`} onClick={remove}>
              Delete
            </button>
            <button type="button" className="secondary" autoFocus onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {own && <Warnings theme={theme} />}
      {editing && <Editor theme={theme} onChange={saveUserTheme} />}

      <div className="theme-import">
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()} disabled={full}>
          Import theme…
        </button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          accept=".json,application/json"
          aria-label="Import theme file"
          onChange={(e) => void onImport(e)}
        />
        {full && <p className="note">You have {MAX_USER_THEMES} themes, the most kept. Delete one to add another.</p>}
      </div>
      {importError !== null && (
        <p role="alert" className="theme-error">
          {importError}
        </p>
      )}
      <p role="status" className="note theme-notice">
        {notice}
      </p>
    </section>
  );
}
