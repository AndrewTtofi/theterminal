# Brand and themes: design

## Intent

The Terminal should feel dark and calm, like VS Code, and make someone who is not technical feel like a hacker the first time they open it. The look is built from named colours and fonts, so users can choose a theme and make their own on top of it.

## Goals

- One clear brand: a logo mark, a wordmark, an app icon and a short brand guide.
- **Ice** is the default theme: cool graphite with an icy cyan accent.
- Six built-in themes, and users can duplicate one, edit it, export it and import other people's themes.
- Every colour in the interface comes from the theme; none are written directly into components.

## Non-goals

- Themes do not change the layout, icons or wording.
- No theme marketplace or online gallery.
- No per-project themes.

## Anti-goals (a failure even if it works)

- **Gimmicks:** no scanlines, Matrix rain or flicker. Hacker touches stay quiet and never get in the way of reading.
- **Code in themes:** a theme must never be able to run code or change anything but colours and font names. Importing a stranger's theme must be safe.
- **Broken safety signals:** a theme must not hide them. Approvals ("needs you"), danger and the OVERRIDE label stay visible and readable in every theme.
- **Unreadable defaults:** every built-in theme passes the readability checks below.

## Brand

- **Mark:** `>_` in a rounded square, with the cursor in the accent colour. It is used for the app icon (macOS `.icns`, Windows `.ico`, PNG sizes), the favicon and the title bar.
- **Wordmark:** "THE TERMINAL" in monospace capitals with wide letter spacing, "TERMINAL" in the accent colour.
- **Where it appears:**
  - the desktop app icon (the installers have none today);
  - the browser favicon;
  - the macOS dmg background;
  - the empty state shown when nothing is open.
- **Type:**
  - The interface uses the system sans-serif font, for readability.
  - Monospace is used for agent output, prompts, commands, the status bar and the wordmark, from the system font stack: `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`. No font files are bundled.
- **Hacker touches:**
  - The prompt box and the live agent output show a blinking block cursor in the accent colour. It does not blink when the operating system asks for reduced motion.
  - Live things (a running agent, the active view, the selected item) get a soft accent glow.
  - Agent output uses `❯` for prompts and `✓` for completed steps, both in the accent colour.
- **Brand guide:** `docs/brand.md`. It holds the mark, clear space, the colours of Ice, the type, the do's and don'ts above, and how to export the icon. Source artwork is SVG in the repo; the other icon formats are generated from it by a script.

## Built-in themes

| Theme | Feel | Background | Panel | Accent |
|---|---|---|---|---|
| Ice (default) | cool graphite, icy cyan | `#0d1016` | `#121620` | `#4fc3d9` |
| Phosphor | near-black, soft green | `#0b0f14` | `#10161d` | `#4cc38a` |
| Amber | warm charcoal, amber | `#0f0d0a` | `#15120e` | `#f0a43a` |
| Classic | today's VS Code-like palette | `#1e1e1e` | `#252526` | `#0078d4` |
| Light | light, blue-teal accent | `#f6f8fa` | `#ffffff` | `#0a7ea4` |
| High contrast | black, yellow accent | `#000000` | `#000000` | `#ffd400` |

Classic keeps exactly the values in `apps/ui/src/styles.css` today. The other colours of each theme are the builder's call, within the rules below.

## What a theme is

A theme is a small JSON document:

- a name;
- whether it is dark or light;
- values for a fixed set of named colours (the current CSS variables in `apps/ui/src/styles.css`, plus any that replace the ~30 colours now written directly into the stylesheet);
- optionally, two font names: interface and monospace.

Rules:

- A colour is a hex value (`#rgb` or `#rrggbb`) and nothing else. Only the translucent overlay keys (`glow`, `status-hover`, `diff-add`, `diff-del`, `diff-hunk`) may also use `#rrggbbaa`: alpha on a solid colour could make a safety colour invisible while its contrast still passes.
- A font name is a plain family name, matched against a safe pattern (letters, digits, spaces, hyphens). The app's own fallback stack is always appended.
- Unknown keys are rejected.
- A missing colour falls back to the theme's base (dark falls back to Ice, light to Light).
- The schema lives in `packages/shared`, with a version number for future changes.
- Size is capped (a few KB).
- Theme values are applied only as CSS custom-property values, through a safe setter, never as stylesheet text.

**Readability checks** (WCAG contrast ratios):

- body text on its background is at least 4.5:1;
- the accent, "needs you" and danger colours are at least 3:1 against the background;
- button text on the accent colour, text on a "needs you" background, status-bar text, badge text and banner text on the danger colour are each at least 4.5:1.

Built-in themes must pass, and a test enforces it. For user themes the checks are mostly advisory: the editor shows a warning naming the pair and its ratio.

The safety colours are the exception, and they fail closed. When a theme is applied, any of "needs you" (attention), danger or override that is below 3:1 against the background is replaced by the base theme's value, and the editor says so. The text drawn on a "needs you" background falls back with it, and both fall back when that text is below 4.5:1. An imported theme can therefore never hide an approval request, a danger sign or the OVERRIDE label.

## Choosing and making themes

- **Settings → Appearance:**
  - a gallery of theme cards, each with colour swatches; clicking one applies it immediately;
  - **Duplicate & edit** opens an editor with colour pickers for the main six colours (background, panels, text, accent, needs you, danger) and an **Advanced** list of every colour. Changes show live, with readability warnings inline;
  - **Export** saves the theme as a `.json` file; **Import** loads one, validating it first and saying plainly what is wrong if it is invalid;
  - user themes can be renamed and deleted; built-in themes cannot be edited or deleted, only duplicated.
- **Where Settings opens:** from a gear at the bottom of the activity bar, as in VS Code ("Manage"). It is a new Settings view, and Appearance is its first section.
- **Per device, never shared:** themes are personal appearance preferences, like the dock layout and the Learn state, and they live in the browser's storage the same way. They are not kept in the ledger or on the server:
  - they are not workspace state, and nobody needs to audit them;
  - a deleted theme must really be gone.

  A collaborator's choice never changes what anyone else sees. To use a theme on another device, export it and import it there.
- **Before sign-in:** the sign-in and join pages use the last theme used on that device, or Ice if there is none.
- **First paint:** the bundle reads the stored choice and applies it before the workbench renders, so there is no flash of the wrong colours. No inline script is used, and the CSP is unchanged.
- **Desktop window:** the desktop app opens its window with Ice's background. Whenever the theme changes, the UI tells the app the new background colour over the preload bridge. The app saves it in its own settings file and uses it for the window background on the next launch.
- **Upgrade:** everyone without a saved choice gets Ice, including existing users. Classic stays available.
- **Share view:** shared pages, standalone pages and PDFs are seen by outside viewers, so they do not use the sharer's theme. Their fixed palette (in `packages/core/src/share/render.ts`) changes to Ice's colours, and their separate strict CSP stays as it is.

## Constraints

- These come from the repo's AGENTS.md and the main design spec: no new runtime dependencies without approval, cross-platform, tests first, no safeguards weakened.
- Existing UI tests and end-to-end tests keep passing.
- The default changes from Classic to Ice. Tests that check colours check theme variables, not raw values.
- Accessibility is kept: focus outlines remain visible in every theme, and the reduced-motion preference is respected.

## Left to the builder

- The remaining colour values of each built-in theme, within the readability rules.
- The exact colour-picker control (the native `<input type="color">` is fine).
- How the icon formats are generated from the SVG, using a dev-time script with no new runtime dependency.
- Splitting this into plan tasks.

## Calls made without the owner (check these)

- No bundled font files; system monospace only.
- Themes cannot contain custom CSS.
- Themes are per device, kept in the browser like the dock layout, not in the ledger.
- Settings opens from a gear at the bottom of the activity bar.
- The share view uses Ice's palette, never the sharer's theme.
- Safety colours fall back to the base theme when they are hard to read.
- Existing users move to Ice by default.
- Light and High contrast are included as built-in themes.
- Reduced motion disables the cursor blink.
