# Plan 10: Brand and themes, implementation plan


**Goal:** Give The Terminal its brand (the `>_` mark, wordmark, app icons, Ice as the default look) and let each person choose, make, import and export colour themes.

**Architecture:**
- **Themes:** a theme is a validated JSON document in `packages/shared`. The UI applies it by setting CSS custom properties on `<html>`, and every colour in `apps/ui/src/styles.css` reads from those properties. A person's choice and their own themes live in the browser's localStorage, in the same way as the dock layout.
- **Brand assets:** SVG sources in the repo. A dev-time script turns them into PNG, ICO and ICNS files using Electron, which is already a dev dependency.

**Tech Stack:** TypeScript, zod (already used in shared), React 18, Vitest, Playwright, Electron.

**Spec:** `docs/specs/2026-11-15-brand-and-themes-design.md`. It is the authority for behaviour. The main spec `docs/specs/2026-11-13-agent-workspace-design.md` still applies.

## Global Constraints

- No new runtime or dev dependencies.
- Colours in themes: `#rgb` or `#rrggbb` only; `#rrggbbaa` is allowed only on the overlay keys `glow`, `status-hover`, `diff-add`, `diff-del` and `diff-hunk` (`ALPHA_KEYS`). Font names: `^[A-Za-z0-9 -]{1,64}$`. Unknown keys are rejected. A serialised theme is at most 8 KB.
- Theme values are applied only through `style.setProperty(name, value)` on `document.documentElement`, never as stylesheet text, `innerHTML` or inline `<style>`. The CSP is unchanged.
- **Readability (WCAG 2.x contrast):**
  - `fg` on `bg` is at least 4.5:1;
  - `accent`, `attention` and `danger` on `bg` are each at least 3:1;
  - `on-accent` on `accent`, `on-attention` on `attention`, `status-fg` on `status`, `badge-fg` on `badge` and `badge-fg` on `danger` (the banner) are each at least 4.5:1.

  Every built-in theme passes, and a test enforces it.
- **Safety colours fail closed:** when a theme is applied, `attention`, `danger` or `override` below 3:1 against `bg` is replaced by the base theme's value; `attention` and `on-attention` are replaced together when either that check or `on-attention` on `attention` (4.5:1) fails.
- **Storage keys** (localStorage, each read and write wrapped in try/catch like `layout-store.ts`):
  - `tt.theme.v1`: the chosen theme id;
  - `tt.themes.v1`: the person's own themes, at most 20.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, the cursor does not blink.
- **Monospace stack:** `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`. No bundled fonts.
- Cross-platform (macOS and Windows CI); tests first. Commits have conventional subjects, the author AndrewTtofi with the noreply email, and no trailers.

## Theme keys (shared by Tasks 1, 2, 3, 4)

`THEME_KEYS`, in this order. Each key `k` is the CSS custom property `--k`:

```
bg fg fg-strong muted line line-strong panel input activity activity-fg activity-active
accent accent-hover on-accent focus hover selected glow
status status-fg status-hover badge badge-fg
attention on-attention danger danger-hover ok override idle running
error-bg error-fg warning-bg warning-fg warning-line diff-add diff-del diff-hunk
```

New keys replace today's hard-coded values in `styles.css`:

| New key | Replaces |
|---|---|
| `on-accent` | button text, now `var(--status-fg)` |
| `on-attention` | text on an attention background (status-bar Needs-you items, the over-budget figure, the layout-save error), now `var(--status-fg)` |
| `status-hover` | `rgba(255,255,255,0.12)` |
| `idle` | `#6e6e6e` |
| `running` | `#3794ff` |
| `danger-hover` | `#b3412e` |
| `badge-fg` | `#fff` in `.badge`, `.banner` and `.recommended` |
| `error-bg`, `error-fg` | `#4a1d22`, `#f5c6cb` |
| `warning-bg`, `warning-fg`, `warning-line` | `#3d3112`, `#f1deb0`, `#7a6320` |
| `diff-add`, `diff-del`, `diff-hunk` | the `rgba(...)` diff backgrounds |
| `glow` | the soft accent glow on live things (translucent accent) |


**Ice's values.** Tasks 1 and 2 both use these exactly, so neither waits for the other:

```
bg #0d1016  fg #cdd3df  fg-strong #e8ecf3  muted #8a93a6  line #1f2533  line-strong #2b3344  panel #121620
input #1a1f2b  activity #090b10  activity-fg #6f7a8f  activity-active #e8ecf3
accent #4fc3d9  accent-hover #6fd0e2  on-accent #041217  focus #4fc3d9  hover #171c27  selected #1d2433  glow #4fc3d966
status #12303a  status-fg #d7f3f9  status-hover #ffffff1f  badge #4fc3d9  badge-fg #041217
attention #e3a33b  on-attention #1a1000  danger #e5534b  danger-hover #f06b63  ok #3fb97f  override #ff5c5c  idle #5c6578  running #4fc3d9
error-bg #3a1519  error-fg #f5c6cb  warning-bg #33290f  warning-fg #f1deb0  warning-line #7a6320
diff-add #3fb97f26  diff-del #e5534b26  diff-hunk #4fc3d914
```

If a readability test fails on one of these, the implementer of Task 1 adjusts it, and the controller carries the change to Task 2.

`.share-frame` uses `var(--bg)`: share pages are Ice now, so the preview has no white literal. Fonts are two more properties, `--font-ui` and `--font-mono`, which are not colour keys.

## Review Focus

1. **Corrupt or old localStorage** (bad JSON, unknown id, a theme that no longer validates): the app falls back to Ice and never crashes or shows a blank screen.
2. **Importing a hostile theme** (`"bg": "red; background:url(x)"`, `</style>`, a 1 MB file, extra keys, `__proto__`): it is refused with a plain message, and nothing is applied or stored.
3. **A theme that makes safety signals invisible** (`override` equal to `bg`): the base value is used, and the editor says so.
4. **Light theme:** every view, including the warning, error and diff colours, stays readable. No leftover dark-only colour remains.
5. **Storage blocked** (private window): theme switching still works for the session, and nothing throws.

---

### Task 1: Theme model, built-in themes and contrast (shared)

**Files:**
- Create: `packages/shared/src/theme.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Test: `packages/shared/test/theme.test.ts`

**Interfaces (produces):**
- `THEME_KEYS: readonly ThemeKey[]` (the list above) and `type ThemeKey`.
- `type Theme = { version: 1; id: string; name: string; base: "dark" | "light"; colors: Partial<Record<ThemeKey, string>>; fonts?: { ui?: string; mono?: string } }`.
- `themeSchema` (zod, strict). `id` matches `^[a-z0-9-]{1,40}$`, and `name` is 1–40 visible characters.
- `parseTheme(json: string): { ok: true; theme: Theme } | { ok: false; error: string }`. It enforces the 8 KB limit before parsing and never throws.
- `BUILTIN_THEMES: readonly Theme[]`, with ids `ice`, `phosphor`, `amber`, `classic`, `light` and `high-contrast`, each listing every key. `DEFAULT_THEME_ID = "ice"`.
- `resolveColors(t: Theme): Record<ThemeKey, string>`. Missing keys come from `ice` (dark) or `light` (light), then the safety fallback is applied.
- `contrastRatio(a: string, b: string): number`, using WCAG relative luminance. Alpha is composited over `bg` by the caller when needed.
- `readabilityIssues(colors): { pair: string; ratio: number; min: number }[]`.
- `safetyFallbacks(t: Theme): ThemeKey[]`: the safety keys that `resolveColors` replaced.

- [ ] **Step 1: Write the failing tests.** Include:
  - `contrastRatio("#000000", "#ffffff")` is 21, within 0.01;
  - `contrastRatio("#777777", "#ffffff")` is about 4.48;
  - every `BUILTIN_THEMES` entry has every key and an empty `readabilityIssues`;
  - Classic's colours equal today's `:root` values in `apps/ui/src/styles.css`, as listed in the spec;
  - Ice has `bg #0d1016`, `panel #121620` and `accent #4fc3d9`;
  - Phosphor, Amber, Light and High contrast match the spec table's three colours;
  - `parseTheme` rejects:
    - a non-hex colour (`"red"`, `"#12345"`, `"#fff; x"`);
    - an unknown colour key;
    - an unknown top-level key;
    - a font name `"Arial;}"`;
    - more than 8 KB;
    - invalid JSON;
    - a `__proto__` key;

    each returns `ok: false` with a readable `error`;
  - `resolveColors` of a dark theme with only `{accent}` fills the rest from Ice;
  - `resolveColors` of a theme with `override === bg` returns Ice's `override`, and `safetyFallbacks` returns `["override"]`.
- [ ] **Step 2:** `pnpm --filter @theterminal/shared exec vitest run test/theme.test.ts`. It fails with module not found.
- [ ] **Step 3:** Implement `theme.ts`. You choose the values for the other keys of each built-in theme, within the readability rules.
- [ ] **Step 4:** Run the test again. It passes. Then run `pnpm --filter @theterminal/shared test`, which is all green.
- [ ] **Step 5:** Commit `feat(shared): theme model, built-in themes and contrast checks`.

### Task 2: Every UI colour from a theme property; Ice by default (ui)

**Files:**
- Modify: `apps/ui/src/styles.css`
- Test: `apps/ui/test/styles-tokens.test.ts` (new)

**Interfaces:** Consumes the key list above. Does not import Task 1: it may run in parallel, and Task 3 ties them together.

- [ ] **Step 1: Write the failing test.** It reads `styles.css` as text and asserts:
  - outside the `:root` block, no `#hex` or `rgb(`/`rgba(` literal appears;
  - `:root` defines every key in the list above, in Ice's values (`--bg: #0d1016`, `--panel: #121620`, `--accent: #4fc3d9`);
  - `body` uses `var(--font-ui)`, and `:root` defines `--font-ui` (today's system sans stack) and `--font-mono` (the monospace stack).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui exec vitest run test/styles-tokens.test.ts`. It fails.
- [ ] **Step 3:** Replace every literal with its key, following the table above. Set `:root` to Ice's values, exactly as listed above. `button` text uses `var(--on-accent)`.
- [ ] **Step 4:** Run the test, then `pnpm --filter @theterminal/ui test`. All green; existing tests don't depend on raw colours.
- [ ] **Step 5:** Commit `refactor(ui): every colour from a theme property, Ice by default`.

### Task 3: Applying and storing themes (ui)

**Files:**
- Create: `apps/ui/src/theme/theme-store.ts` and `apps/ui/src/theme/apply.ts`
- Modify: `apps/ui/src/main.tsx` (apply before `createRoot(...).render`)
- Test: `apps/ui/test/theme-store.test.ts`

**Interfaces (produces):**
- `applyTheme(t: Theme, root = document.documentElement): void`. It sets `--<key>` for every resolved colour, `--font-ui` and `--font-mono` (a font name, then the default stack), and `root.style.colorScheme` from `base`. It only uses `setProperty`.
- `loadChosenThemeId(): string`, which defaults to `"ice"`, and `saveChosenThemeId(id)`.
- `loadUserThemes(): Theme[]`. Each stored theme is re-validated with `themeSchema`, and invalid ones are dropped.
- `saveUserThemes(ts: Theme[])`, which caps the list at 20.
- `allThemes(): Theme[]`: the built-in themes followed by the user's.
- `currentTheme(): Theme`. An unknown id gives Ice.
- `useTheme()`: a React hook returning `{ theme, themes, choose(id), saveUserTheme(t), deleteUserTheme(id) }`. It re-applies on change.

- [ ] **Step 1: Write the failing tests** (jsdom):
  - `applyTheme(BUILTIN light)` makes `documentElement.style.getPropertyValue("--bg")` equal Light's `bg`, and `colorScheme` equal `"light"`;
  - corrupt `tt.themes.v1` (`"{"`, `[{"id":"x"}]`) gives `loadUserThemes()` as `[]`, and the call doesn't throw;
  - an unknown `tt.theme.v1` gives `currentTheme().id === "ice"`;
  - a stored user theme with a font `"Arial;}"` is dropped;
  - a throwing `localStorage` stub makes `choose` still apply the theme in memory;
  - `saveUserThemes` with 25 themes stores 20.
- [ ] **Step 2:** Run the test. It fails.
- [ ] **Step 3:** Implement the store and the hook. In `main.tsx`, call `applyTheme(currentTheme())` before rendering, on every route: the workbench, sign-in and join.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): apply and remember the chosen theme`.

### Task 4: Settings → Appearance (ui)

**Files:**
- Create: `apps/ui/src/views/SettingsSideBar.tsx` and `apps/ui/src/views/AppearanceSettings.tsx`
- Modify:
  - `apps/ui/src/shell/views.ts` (a `settings` view, label "Settings");
  - `apps/ui/src/shell/ActivityBar.tsx` (a gear button pinned to the bottom, outside the `VIEWS` map);
  - `Workbench.tsx` and `SideBar.tsx` as needed;
  - `styles.css` (layout only, colours through `var()`).
- Test: `apps/ui/test/AppearanceSettings.test.tsx` and `e2e/themes.spec.ts`

**Interfaces:** Consumes Task 3's `useTheme` and Task 1's `parseTheme`, `readabilityIssues`, `safetyFallbacks` and `BUILTIN_THEMES`.

**Behaviour:** as in the spec's "Choosing and making themes".
- **Gallery:** cards show swatches of `bg`, `panel` and `accent`, plus the name. Ice is marked "default".
- **Editing:** "Duplicate & edit" creates `"<name> copy"` with a new id and opens the editor. The main six are colour inputs (`input type="color"`, plus a text field for exact hex); "Advanced" lists every key. Edits apply live.
- **Warnings:** readability issues show as `role="status"` lines naming the pair and its ratio, one decimal place. Safety fallbacks show "Danger colour was too hard to read, so the default is used."
- **Export:** downloads `<id>.theme.json` through a Blob and an object URL, with no server.
- **Import:** a file input, read as text, with a 64 KB pre-read cap (`parseTheme` caps at 8 KB). An error shows the parse error verbatim in `role="alert"`. An id clash gets a suffix.
- **Built-in themes:** they have no rename or delete controls.

- [ ] **Step 1: Write the failing component tests:**
  - clicking the gear opens Settings with Appearance;
  - clicking "Light" applies it, and `--bg` changes;
  - Duplicate & edit, then changing Accent, updates `--accent` live and persists after a reload of the store;
  - importing `{"version":1,"id":"x","name":"X","base":"dark","colors":{"bg":"red"}}` shows an alert and adds no theme;
  - importing a valid theme adds it and selects it;
  - setting override equal to bg shows the fallback note, and `--override` keeps Ice's value;
  - delete removes a user theme;
  - built-in themes show no delete button.
- [ ] **Step 2: Write the failing e2e.** Open the app, click the gear, choose Light, reload, and check Light is still applied (computed `--bg`). Import a valid theme fixture from `e2e/fixtures/neon.theme.json`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and `pnpm e2e`. All green, with the layout presets still working.
- [ ] **Step 5:** Commit `feat(ui): Settings view with Appearance: choose, edit, import and export themes`.

### Task 5: Brand assets, icons and brand guide

**Files:**
- Create:
  - `assets/brand/mark.svg` (`>_` in a rounded square, cursor in accent `#4fc3d9`, background `#0d1016`);
  - `assets/brand/wordmark.svg`;
  - `apps/desktop/scripts/make-icons.mjs`;
  - generated and committed: `apps/desktop/build/icon.icns`, `apps/desktop/build/icon.ico`, `apps/desktop/build/icon.png` (1024), `apps/ui/public/favicon.svg`;
  - `docs/brand.md`.
- Modify: `apps/desktop/electron-builder.mjs` (icon paths for mac and win; dmg background optional), `apps/ui/index.html` (`<link rel="icon" href="/favicon.svg">`), and the server's static asset allowlist if it limits served files.
- Test: `apps/desktop/test/icons.test.ts`

**Script:** `node apps/desktop/scripts/make-icons.mjs` launches Electron offscreen (`electron` from devDependencies) to render `mark.svg` to PNGs at 16, 32, 48, 64, 128, 256, 512 and 1024 pixels.
- `.ico`: a PNG-embedded ICO with 16, 32, 48 and 256 entries.
- `.icns`: an `icns` container with `ic07`–`ic10` PNG entries, written by hand from the format headers.
- Neither format needs a new dependency or `iconutil`.

- [ ] **Step 1: Write the failing test.**
  - `icon.ico` starts with `00 00 01 00` and has at least 4 entries, each a PNG (`89 50 4E 47`);
  - `icon.icns` starts with `icns`, its length field equals the file size, and it contains `ic10`;
  - `icon.png` is 1024×1024 (IHDR);
  - `electron-builder.mjs` config references both icons.
- [ ] **Step 2:** Run it. It fails.
- [ ] **Step 3:** Draw the SVGs, write the script, run it, and commit the outputs. Write `docs/brand.md`, covering:
  - the mark and its clear space;
  - Ice's colours;
  - the type;
  - the hacker-touch rules from the spec;
  - how to regenerate the icons.
- [ ] **Step 4:** Run the desktop tests and the UI build. The favicon is served: check with a server test, or by loading `/favicon.svg` in an existing static test.
- [ ] **Step 5:** Commit `feat(brand): the mark, wordmark, app icons, favicon and brand guide`.

### Task 6: Hacker touches and the empty state (ui)

Runs after Task 2, since both edit `styles.css`.

**Files:** `apps/ui/src/styles.css`, the prompt box (`StartRunForm.tsx`), the agent output (`AgentFeedPanel.tsx` and `ConversationPanel.tsx`), the workbench empty state (find where "nothing open" renders), and tests next to each.

**Behaviour:**
- **Mono:** agent output, prompts, commands and the status bar use `var(--font-mono)`.
- **Cursor:** a blinking block cursor (a `.cursor` span, accent colour, 1.1 s `steps(1)` blink) sits after the prompt box placeholder while it is empty and focused, and at the end of a running agent's output. It is `aria-hidden`. It does not animate under `prefers-reduced-motion: reduce`.
- **Markers:** in agent output, prompt lines start with `❯` and completed steps with `✓`, in accent, wherever the feed already distinguishes them. Recorded text is not changed.
- **Glow:** `box-shadow: 0 0 6px var(--glow)` on the active activity-bar item, running-agent status and the selected list item.
- **Empty state:** the workbench empty state shows the wordmark (inline SVG, or text in mono: "THE TERMINAL", with "TERMINAL" in accent) and one line: "Start by opening a project."

- [ ] **Step 1: Write the failing tests.**
  - the cursor renders with `aria-hidden="true"` while a run is running and is gone when it ends;
  - the CSS contains a `@media (prefers-reduced-motion: reduce)` rule that sets `.cursor` to `animation: none`;
  - the empty state shows the wordmark text.
- [ ] **Step 2:** Run them. They fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and `pnpm e2e`. Update e2e selectors only where text changed.
- [ ] **Step 5:** Commit `feat(ui): the cursor, mono output, glow and branded empty state`.

### Task 7: Desktop window colour and share-page palette

**Files:** `apps/desktop/src/main.ts`, a new `apps/desktop/src/window-color.ts`, and `packages/core/src/share/render.ts`. Tests go in `apps/desktop/test/window-color.test.ts` and the existing share render tests.

**Ruling:** the spec's "preload bridge" is replaced by a main-process read, so that no preload or IPC surface is added to the sandboxed window. Before the window closes, the main process runs `w.webContents.executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--bg")')`, with a 500 ms timeout.

**Interfaces:**
- `parseWindowColor(v: unknown): string | null`. It accepts only `#rgb` or `#rrggbb` after trimming.
- `loadWindowColor(file: string): string`, which defaults to `#0d1016` on a missing file, corrupt JSON or an invalid colour.
- `saveWindowColor(file: string, c: string): void`, an atomic write.

The file is `window.json` in `app.getPath("userData")`. `createWindow` passes `backgroundColor: loadWindowColor(...)`.

**Share pages:** the `:root` palette in `render.ts` changes to Ice's colours: `--bg #0d1016`, `--panel #121620`, `--accent #4fc3d9`, and Ice's line, text and muted. Keep the text and muted contrast at least 4.5:1, and the CSP as it is.

- [ ] **Step 1: Write the failing tests.**
  - `parseWindowColor` rejects `"red"`, `"#fff; x"`, `1` and `null`, and accepts `" #0D1016 "` (normalised to lowercase);
  - `loadWindowColor` returns the default for a missing file or corrupt JSON;
  - the share render output contains `--bg: #0d1016` and `--accent: #4fc3d9`;
  - existing share snapshot tests are updated for the palette only.
- [ ] **Step 2:** Run them. They fail.
- [ ] **Step 3:** Implement. Hook the read into the window's `close` event, keeping it best effort: a failure keeps the old colour.
- [ ] **Step 4:** Run the desktop and core tests. All green.
- [ ] **Step 5:** Commit `feat(desktop,core): window opens in the theme's colour; share pages use Ice`.

## Order and parallelism

- **Wave 1, in parallel:** Tasks 1, 2, 5 and 7. They touch disjoint files.
- **Wave 2:** Task 3, then Task 4.
- **Wave 3:** Task 6. It can run alongside Task 4 if it stays out of the files Task 4 touches. Otherwise it runs after Task 4.
