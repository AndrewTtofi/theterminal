import { THEME_KEYS, resolveColors, type Theme } from "@theterminal/shared";

const UI_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_STACK = 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace';

/** A validated font name (letters, digits, spaces, hyphens) first, then the default stack. */
const stack = (name: string | undefined, fallback: string) => (name ? `"${name}", ${fallback}` : fallback);

/** Writes the theme onto `root` as CSS custom properties. Only `setProperty`: no markup and no stylesheet text. */
export function applyTheme(t: Theme, root: HTMLElement = document.documentElement): void {
  const colors = resolveColors(t);
  for (const k of THEME_KEYS) root.style.setProperty(`--${k}`, colors[k]);
  root.style.setProperty("--font-ui", stack(t.fonts?.ui, UI_STACK));
  root.style.setProperty("--font-mono", stack(t.fonts?.mono, MONO_STACK));
  root.style.setProperty("color-scheme", t.base);
}
