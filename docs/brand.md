# The brand

This page is the brand guide for The Terminal: the mark, the wordmark, the colours of the default theme (Ice), the type, the small "hacker touches" in the interface, and how to regenerate the icons. The design spec is `docs/specs/2026-11-15-brand-and-themes-design.md`; where the two differ, the spec wins.

## The mark

The mark is a terminal prompt, `>_`, in a rounded square:

- the square is the Ice background `#0d1016`, with a subtle `#2b3344` border;
- the `>` chevron is light text, `#e8ecf3`;
- the `_` cursor bar is the accent, `#4fc3d9`.

The source is `assets/brand/mark.svg`, drawn on a 64 by 64 grid. Its strokes are thick on purpose, so it still reads as `>_` at 16 pixels in a browser tab.

The mark is used for:

- the desktop app icon (macOS `.icns`, Windows `.ico`, and a 1024 pixel PNG);
- the browser favicon (`apps/ui/public/favicon.svg`, a copy of the mark);
- the title bar and the empty state shown when nothing is open.

**Clear space.** Keep empty space around the mark of at least a quarter of its width on every side. Nothing else (text, edges, other marks) goes inside it.

**Do:**

- use the mark as it is, on a dark or a light background;
- keep the cursor in the accent colour.

**Don't:**

- recolour, stretch, rotate, outline or add a shadow to the mark;
- put the `>` and the `_` on separate backgrounds, or drop the square;
- swap the chevron for another prompt character.

## The wordmark

"THE TERMINAL" in monospace capitals with wide letter spacing. "THE" is light text `#e8ecf3`, "TERMINAL" is the accent `#4fc3d9`. The source is `assets/brand/wordmark.svg`. It uses the system monospace stack below, with no font file, so it renders slightly differently on each system. That is expected. The wordmark is drawn for dark backgrounds; on a light background, set "THE" in the theme's text colour.

## Ice's colours

Ice is the default theme: cool graphite with an icy cyan accent. Its full list of values is in the plan (`docs/plans/2026-11-15-plan-10-brand-and-themes.md`, "Ice's values"). The ones the brand leans on:

| Role | Value |
|---|---|
| Background | `#0d1016` |
| Panel | `#121620` |
| Line | `#1f2533` |
| Strong line | `#2b3344` |
| Text | `#cdd3df` |
| Strong text | `#e8ecf3` |
| Muted text | `#8a93a6` |
| Accent | `#4fc3d9` |
| Text on the accent | `#041217` |
| Attention | `#e3a33b` |
| Danger | `#e5534b` |
| OK | `#3fb97f` |

Text keeps at least 4.5:1 contrast against the background, and the accent and the safety colours at least 3:1.

## Type

- The interface uses the system sans-serif font, for readability.
- Monospace is used for agent output, prompts, commands, the status bar and the wordmark. The stack is `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`.
- No font files are bundled.

## Hacker touches

Small terminal touches, used sparingly:

- The prompt box and the live agent output show a blinking block cursor in the accent colour. It does not blink when the operating system asks for reduced motion.
- Live things (a running agent, the active view, the selected item) get a soft accent glow.
- Agent output uses `❯` for prompts and `✓` for completed steps, both in the accent colour.

## Regenerating the icons

The SVG files are the source. Every other icon format is generated from `assets/brand/mark.svg` by one script:

```
node apps/desktop/scripts/make-icons.mjs
```

The script starts Electron (already a dev dependency of the desktop app), draws the mark on a canvas in a hidden window, and writes:

| File | What it holds |
|---|---|
| `apps/desktop/build/icon.png` | 1024 by 1024, edge to edge |
| `apps/desktop/build/icon.ico` | PNG entries at 16, 32, 48 and 256 pixels, for Windows |
| `apps/desktop/build/icon.icns` | PNG entries `ic07` to `ic14` (32 to 1024 pixels), for macOS |
| `apps/ui/public/favicon.svg` | a copy of the mark |

The macOS icon follows Apple's icon grid: the square takes 824 of the 1024 pixels, centred, so it sits at the same size as other apps in the Dock. The `.ico` and `.icns` files are written by hand from their format headers, so no other tool (such as `iconutil`) is needed and the script runs the same on macOS and Windows.

Commit the generated files with the change to the SVG. `apps/desktop/test/icons.test.ts` checks that they are well formed and that the packaging config uses them.
