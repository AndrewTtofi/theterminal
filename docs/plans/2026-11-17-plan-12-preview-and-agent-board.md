# Plan 12: Preview on devices and a Board run by agents, implementation plan

**Goal:** Let the person see a run's website live on phone, tablet and laptop sizes and its phone app in Apple's or Google's simulator, give the Board to the agents (they create and move cards; people watch and leave notes), and give the whole app one crisp, rounded visual style.

**Architecture:**
- **Markers:** the runner reads every marker line of the agent's own messages through one line reader (`markers.ts`). `plan` and `step` feed the existing `ProgressTracker`. `card`, `card-stage`, `card-done` and `noted` go to `AgentCards`, which writes only the existing card events (plus links, notes and move requests) with the agent as actor. `preview` and `app` are recorded as `preview.offered`.
- **Previews:** a person-confirmed action on the override pattern, not the agent gate. `PreviewService` builds an argument-array plan (`web-command.ts`, `native.ts`), hashes the commands and the build files into a key, records `preview.requested` when the person confirms that key, runs the stages through one supervisor (`process.ts`) and records each stage as `preview.progress`. Screenshots are PNG files under `<data>/projects/<id>/artifacts/`, recorded by hash.
- **Showing a site:** in the desktop app, the UI asks the server (`POST /api/host/preview-views`), the server asks the Electron main process over the existing host IPC channel, and main lays `WebContentsView`s with their own in-memory partitions and their own locks over the Preview tab's frames. In a browser, the Preview tab embeds the same-origin page `/preview/:id`, whose CSP alone allows framing the preview's origin.
- **Board:** read-only cards with progress, a "Now:" line and note counts; a side panel with the checklist, the story and the notes box. A move the gates hold becomes a request on Home, settled through the existing gate card.
- **Style:** shape tokens (`--radius-*`, `--space-*`, `--text-*`, `--motion-*`) that no theme overrides, checked by the stylesheet tests, applied app-wide in a final polish task.

**Tech Stack:** TypeScript, zod, Fastify 5, better-sqlite3, `node:child_process` (`spawn`/`execFile`, argument arrays only), `node:net`, `node:http`, `node:crypto`, React 18, dockview, Electron (`WebContentsView`, `session.fromPartition`, `webContents.debugger`), Vitest, Playwright.

**Spec:** `docs/specs/2026-11-16-preview-and-agent-board-design.md` is the authority; its "Decisions after review" override its earlier sections, and its "Visual style" applies to every screen. The main spec `docs/specs/2026-11-13-agent-workspace-design.md`, `docs/specs/2026-11-16-home-and-project-sources-design.md` and `AGENTS.md` still apply.

## Global Constraints

- No new runtime or dev dependencies. Device views use Electron's own APIs; PNG headers, probes and socket listings are read by hand.
- State changes go through `commitEvent`/`commitEvents`. Every new table or column is filled only in `applyEvent` and added to `PROJECTION_TABLES`, so projections rebuild exactly from the ledger.
- No shell on any platform. Every program is spawned with an argument array, `shell: false`, `windowsHide: true`, and an environment from `baseChildEnv(dataDir)` plus only the names listed in Ruling 14. `.cmd`, `.bat` and `.ps1` files are never run. No API key or connection value reaches a preview or build.
- **Website commands:** only `npm run <script>`, `pnpm run <script>`, `yarn run <script>` or `npx <tool>`, each with optional plain arguments (Ruling 9). A command that comes out of cleaning redacted, truncated or holding control characters is refused.
- **Platforms:** website previews on macOS, Windows and Linux; iOS on macOS only; Android on macOS and Linux only in this version.
- **Who:** starting, stopping and screenshotting a preview: the Owner, or a maintainer on a run they started themselves, on the local listener only. Seeing a live preview: reviewers and above, local listener only. Notes on cards: maintainers and above. Screenshots and notes are read by viewers and above. Tool detection: Owner, local listener.
- **Fixed values:** devices iPhone 16 `393×852 @3`, Pixel 9 `412×915 @2.625`, iPad `820×1180 @2`, Laptop `1440×900 @2`; at most `4` devices at once; start timeout `180_000` ms; idle stop `1_800_000` ms (30 minutes); failure tail `20` lines; note text clipped to `2000` characters; screenshot files at most `16_777_216` bytes.
- **iframe sandbox** (browser mode): exactly `sandbox="allow-scripts allow-forms allow-same-origin"`, on the preview's own origin. The main UI's CSP (`UI_CSP`) is unchanged.
- **Electron:** The Terminal's own window keeps `contextIsolation`, `sandbox`, no node, no preload and its current locks; `harden.test.ts` cases are unchanged. Preview views get their own partitions and their own policy (Task 12).
- **Markers** are read only from whole lines of the agent's own messages, never from tool output, and only for runs on this computer: a run started for a linked machine (`foreignCard: true`) reads `plan` and `step` only.
- **No fake progress:** every percentage is `Math.floor(100 * done / steps)` of a fixed stage plan or of the agent's stated plan.
- **Storage key:** `tt.preview.v1` for `{ devices, rotated }`, every read and write in try/catch like `layout-store.ts`.
- **Live tests are opt-in:** `THETERMINAL_LIVE_IOS=1`, `THETERMINAL_LIVE_ANDROID=1`. CI uses the fake native programs of Task 8.
- New CSS uses `var(--…)` tokens only; after Task 1 the stylesheet checks also cover radii, the 4px grid, font sizes, shadows and transitions (Task 1, Task 18).
- Cross-platform (macOS and Windows CI): `node:path` everywhere, no case-sensitivity assumptions. Tests first. Conventional commit subjects, the author AndrewTtofi with the noreply email, and no trailers.

## API contract (shared by Tasks 13, 14, 15, 16 and 17)

| Route | Role | Body or query | Answer |
|---|---|---|---|
| `GET /api/projects/:id/cards/info` | viewer | | `{ cards: CardInfo[] }` |
| `GET /api/cards/:id/comments` | viewer | | `{ comments: CardComment[] }` |
| `POST /api/cards/:id/comments` | maintainer | `{ text }` | 201 `CardComment` |
| `POST /api/cards/:id/move-request/decline` | reviewer | `{}` | 204 |
| `GET /api/runs/:id/preview/plan` | maintainer, local | `?kind=web\|ios\|android` | `PreviewPlan` |
| `POST /api/runs/:id/preview` | maintainer, local | `{ kind, key, target? }` | 201 `PreviewView` (200 when the same one is already live) |
| `GET /api/previews/:id` | reviewer, local | | `PreviewView` |
| `POST /api/previews/:id/stop` | maintainer, local | `{ reason: "person" \| "tab_closed" }` | 204 |
| `POST /api/previews/:id/seen` | reviewer, local | `{}` | 204 |
| `POST /api/previews/:id/screenshots` | maintainer, local | `{}` | 201 `{ screenshots: Screenshot[] }` |
| `GET /api/runs/:id/screenshots` | viewer | | `{ screenshots: Screenshot[] }` |
| `GET /api/screenshots/:sha` | viewer | `?runId=` | `image/png` |
| `GET /api/host/capabilities` | reviewer, local | | `{ previewViews: boolean }` |
| `POST /api/host/preview-views` | reviewer, local | `PreviewViewsBody` | 204 |
| `GET /api/host/native-tools` | owner, local | | `NativeTools` |
| `GET /preview/:id` | reviewer, local | | the UI page with the preview CSP (Ruling 23) |

"maintainer" rows also need the service check of Ruling 13 (the Owner, or the maintainer who started the run).

**Error codes** (fixed codes; nothing from the request is echoed back):
- `preview_changed` (409): the key no longer matches; confirm again.
- `preview_not_allowed` (403): a maintainer on someone else's run.
- `preview_refused` (400) `{ reason: "redacted" | "truncated" | "controls" | "program" | "script_missing" | "no_package_json" }`
- `package_manager_not_found` (409) `{ manager: "npm" | "pnpm" | "yarn" }`
- `no_preview_offer` (404): the run stated no marker and detection found nothing single.
- `preview_busy` (409): another live preview of that kind for the run, or the server's limit (Ruling 19).
- `platform_unsupported` (409) `{ kind }`
- `native_tools_missing` (409) `{ missing: ToolId[] }`
- `preview_host_unavailable` (404)
- `screenshots_unavailable` (409): a website preview outside the desktop app.
- `local_only` (403), `run_active` and `remote_run` as today; an unknown preview, card or screenshot is `not_found`.
- `secret_in_text` (400) for a note holding a secret, as for other text a person writes.

`HomeRuns` gains `moveRequests: CardMoveRequest[]`, and each `HomeRun` gains `offers: PreviewKind[]`, `screenshots: Screenshot[]` (the latest 3) and `livePreviewId: string | null`.

## Rulings (where the spec leaves a choice)

1. **Marker grammar** (each on the trimmed whole line):
   - `card`: `/^\[\[card: (.+)\]\]$/`; the title is trimmed, cleaned like a step text and clipped to 200.
   - `card-stage`: `/^\[\[card-stage: (plan|design|build|ship|operate)\]\]$/i`.
   - `card-done`: `/^\[\[card-done\]\]$/`; `noted`: `/^\[\[noted\]\]$/`.
   - `preview`: `/^\[\[preview: (.+) \| port ([1-9]\d{0,4})\]\]$/` with the port at most 65535; the port is required.
   - `app`: `/^\[\[app: (ios|android) (.+)\]\]$/`, the target at most 200 characters.
   - The carry of an unfinished line (400 characters) applies to every marker.
2. **Card for a run started from Home:** the start body's `autoCard: true` creates the card at the start, in one `commitEvents` with `agent.started`: `card.created` in Plan titled `jobTitle({ prompt, progress: null })` (the prompt's first line, clipped to 60), actor the agent (`{ kind: "agent", id: runId }`). A later `[[card: …]]` from that run is ignored (the first card wins), so the instruction tells the agent it may already have a card.
3. **Linking:** a `[[card: …]]` from a run without a card records `card.created` and `card.run_linked { cardId, runId }` together; the projection sets `agent_runs.card_id`.
4. **Move requests:** a move a gate holds records `card.move_requested { cardId, runId, from, to }`. The projection keeps one request per card, replaced by a newer one and cleared by any `card.moved` of that card or by `card.move_declined`. On Home it reads "Claude wants to move “Fix the form” to Ship" with **Review** (selects the project and calls the existing `onMoveCard(cardId, to)`, so the gate card and its sign-off do the move) and **Not yet** (records `card.move_declined`).
5. **Notes:** the text is clipped to 2,000 characters, then passed through `visibleControls`, scrubbed of local paths and refused with `secret_in_text` when it holds a secret (`RecordedText`). The author's name and role at that moment are recorded in `card.comment`, so the projection rebuilds without the people table.
6. **Giving notes:** a run started on this computer with a card gets that card's waiting notes (the 20 oldest) in front of its prompt, and `card.comments_given` is committed with `agent.started`. The ledger keeps the person's prompt unchanged. The exact text is in Task 6. `[[noted]]` records `card.comments_read` for every note given to that run and not yet read, once per run. A run on a linked machine is given no notes; they keep waiting.
7. **States shown:** "Waiting for the next run", "Given to Claude", "Read by Claude" (`adapterLabel`).
8. **Offers:** `[[preview: …]]` and `[[app: …]]` record `preview.offered` (agent actor), only when it differs from the run's latest offer of that kind. The latest offer of each kind wins.
9. **Website command grammar:** the command is split on single spaces (no quotes, no escapes). Allowed shapes:
   - `npm run <script> [args]`, `pnpm run <script> [args]`, `yarn run <script> [args]`, `npx <tool> [args]`;
   - `<script>` and `<tool>` match `/^[A-Za-z0-9@][A-Za-z0-9@:._/-]{0,99}$/`, each argument `/^[A-Za-z0-9@%+=:,._/-]{1,200}$/`, at most 16 arguments;
   - `<script>` must exist in `package.json`'s `scripts` (else `script_missing`).
10. **Package-manager entry points**, tried in order, never a `.cmd`, `.bat` or `.ps1`:
    - npm and npx: `node_modules/npm/bin/npm-cli.js` (`npx-cli.js`) beside `process.execPath` (Windows) or under `../lib/` from it (POSIX);
    - the `which` hit on the child environment's PATH, when its real path is a `.js`, `.cjs` or `.mjs` file (run as `process.execPath <file>`) or a native executable (run directly);
    - for a `.cmd` shim found on PATH: the sibling `node_modules/<pm>/bin/<pm>.cjs` or `.js` (`npm/bin/npx-cli.js` for npx), run with `process.execPath`.
    - Nothing found: `package_manager_not_found`.
11. **Framework flags:** when the script's text (or the npx tool) names `vite`, `astro dev`, or `nuxt dev`/`nuxi dev`, The Terminal appends `--port <p> --host 127.0.0.1`; for `next dev` it appends `--port <p> --hostname 127.0.0.1` (Next's own flag). npm gets them after `--`.
12. **The confirmation key:** `sha256(canonicalJson({ kind, commands, files }))`, where `commands` are the argument arrays with the port flags left out and `files` maps each relative path to the sha256 of its bytes:
    - web: `package.json`, plus the lockfile when the install step is included;
    - iOS: the chosen `project.pbxproj`, the workspace's `contents.xcworkspacedata` and `Podfile.lock` when present;
    - Android: `settings.gradle(.kts)`, the root and module `build.gradle(.kts)`, `gradle/wrapper/gradle-wrapper.properties` and `gradlew`.
    - The plan says `confirmedEarlier: true` when an earlier `preview.requested` of that run has the same key; the UI then skips the dialog. Every start still records `preview.requested`.
13. **Who started a run:** the actor id of its `agent.started` entry. A maintainer may preview only runs whose starter is their own person id (`PreviewNotAllowedError` otherwise).
14. **Environment:** `baseChildEnv(dataDir)` plus `PORT`, `HOST=127.0.0.1` and `BROWSER=none` for websites. Native builds also get `ANDROID_HOME` and `ANDROID_SDK_ROOT` (the detected SDK folder) and `JAVA_HOME` (from the server's environment when it is an existing absolute directory), set explicitly by the build. The child allowlist is unchanged.
15. **Stages:**
    - web: `["Starting the site", "Waiting for the port", "Loading the first page"]`, with `"Installing packages"` first when an install is included;
    - iOS: `["Check the tools", "Build the app", "Start the simulator", "Install the app", "Open the app"]`; Android: the same with `"Start the emulator"`;
    - each change is a `preview.progress` entry. Build counts (`liveCount`) are kept in memory only and served by `GET /api/previews/:id`; they are read from lines matching `/^\s*\[\s*(\d+)\s*\/\s*(\d+)\s*\]/`.
16. **Readiness:** every 500 ms the probe tries `127.0.0.1` and `::1` on the chosen port, then on the stated port. "Port open" is a TCP connect; "first page loaded" is any HTTP response under 500 to `GET /`. The 3 minutes count from the site command's start, after any install (10 minutes of its own).
17. **Network check:** `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fn` on macOS and Linux, `netstat -ano -p tcp` on Windows, 5 s timeout. A listening address other than `127.0.0.1` or `::1` sets `exposed`. A missing tool or a failure leaves `exposed: false`.
18. **Framing:** on readiness the server reads the first page's headers. `X-Frame-Options` of any value, or a CSP `frame-ancestors` other than `*`, sets `frameable: false`.
19. **Limits:** one live preview per run and kind; a second start with the same key returns it, with another key `preview_busy`. At most 4 live website previews and 1 native build on the server.
20. **Stops:** the person (`person`), the Preview tab closing (`tab_closed`), no `seen` for 30 minutes (`idle`; the tab sends `seen` every 60 s), shutdown (`shutdown`), or a previous process (`restarted`, by `recoverOnStartup`). Stopping kills the process tree; a native stop quits the app and shuts down the simulator or emulator only if The Terminal booted it.
21. **Desktop views:**
    - one `WebContentsView` per device, partition `preview-<previewId>-<device>` (no `persist:`, so in memory);
    - `web-contents-created` chooses the policy by session: a preview session gets Task 12's policy, every other contents `hardenContents` as today;
    - the app window's user agent gains ` TheTerminalDesktop`; the UI uses live views only when that is present and `/api/host/capabilities` says `previewViews: true`;
    - rectangles are CSS pixels of the window, multiplied by the window's zoom factor in main;
    - every view hides while an overlay (dialog, menu or toast) is open, while the Preview tab is not visible, and during a sash drag.
22. **Screenshots:** in the desktop app through CDP `Page.captureScreenshot` (`clip` at the viewport, `scale: 1`, `captureBeyondViewport: true`). In browser mode **Screenshot all** is replaced by "Screenshots need the desktop app". A PNG is checked (signature, size limit), named `<sha256>.png`, de-duplicated, and recorded with its real IHDR width and height.
23. **`/preview/:id` page:** the same `index.html`, with `UI_CSP` changed in exactly two places: `frame-ancestors 'self'` and an added `frame-src <origin>` for that preview's recorded origin. `route.ts` gains `{ page: "preview"; id }`, which renders only the device frames (`?d=<ids>&r=<rotated ids>&k=<reload counter>`).
24. **Native choices:**
    - iOS: a `.xcodeproj`/`.xcworkspace` target is used as `-project`/`-workspace` with the scheme of the same base name, any other target is a scheme. The device is the booted iPhone, else the first available iPhone of the newest iOS runtime. The app is the single `*.app` under `Build/Products/Debug-iphonesimulator`, its bundle id from `plutil -extract CFBundleIdentifier raw -o - <app>/Info.plist`.
    - Android: the first AVD of `emulator -list-avds`. The APK and package come from `<module>/build/outputs/apk/debug/output-metadata.json` (`elements[0].outputFile`, `applicationId`).
    - Timeouts: detection 15 s per command, build 20 minutes, boot 5 minutes (polling `getprop sys.boot_completed` every 2 s), install 2 minutes, open 1 minute.
25. **Automatic screenshots every 10 seconds** are not in this version (the spec marks them optional).
26. **Shape tokens:** `--radius-s: 4px`, `--radius-m: 8px`, `--radius-l: 10px`, `--radius-pill: 999px`; `--space-1` … `--space-6` = `4px 8px 12px 16px 24px 32px`; `--text-s: 11px`, `--text-m: 12px`, `--text-l: 13px`; `--motion-fast: 80ms`, `--motion-progress: 200ms` (both `0ms` under reduced motion). The `--glow` colour stays in the themes but nothing uses it.
27. **Home:** a `previews` block ("Previews") after `finished` in `HOME_BLOCKS`; it shows live previews and the latest screenshots of the selected project.
28. **Board panel:** clicking a card opens a panel inside the Board tab (as in the approved sketch), not a dock tab. Its "Open the full story" link opens the existing `story:<cardId>` tab.
29. **Preview tab:** a dock component `preview`, id `preview:<runId>`, titled "Preview · <job title>".

## Review Focus

1. **The agent changes what the person confirmed.** After a confirmation, the agent edits the `dev` script or the lockfile, or states a new `[[preview: …]]`. The next start must ask again and never run the new command on the old confirmation (Task 10 test `asks again when package.json changes`; Task 13 test `a stale key gets preview_changed`).
2. **The previewed site reaches for The Terminal.** A page in a view or frame calls `/api/…`, reads cookies, opens windows, asks for the camera, starts a download or navigates the view elsewhere. Every one is refused or sent to the person's browser after a confirmation (Task 12 tests on the preview policy; Task 13 test `a request from the preview's origin gets bad_origin`).
3. **A dev server that hangs, dies, or prints secrets.** It never answers, exits at once, or prints `sk-ant-TESTKEY…`. The preview fails after 3 minutes (or at once on exit) with at most 20 redacted lines, and the process tree is gone (Task 9 test `kills the tree and keeps a redacted tail`; Task 10 test `fails after three minutes`).
4. **Processes left behind.** The tab closes, the person leaves for 30 minutes, the server shuts down, or the app crashes mid-build. Each ends with the tree killed and one `preview.stopped`, and a restart records `restarted` (Task 10 tests `stops when idle`, `records restarted on startup`).
5. **A note that silently vanishes.** A note on a card with no run, a note while its run is working, a run that fails before `[[noted]]`, or a card whose run is on a linked machine. Each note always shows its true state and is never marked Read without `[[noted]]` (Task 5 test `notes keep their state across rebuild`; Task 6 test `a note given to a failed run stays Given`).

---

### Task 1: Shape tokens and the stylesheet checks (ui)

**Files:**
- Modify: `apps/ui/src/styles.css` (a second `:root` block for shape tokens; the base rules for `input, select, textarea`, `button`, `fieldset`, `:focus-visible`; the reduced-motion block)
- Test: `apps/ui/test/styles-tokens.test.ts` and `apps/ui/test/theme-store.test.tsx` (an addition)

**Interfaces (produces):**
- Tokens per Ruling 26, in a `:root` block of their own after the colour block, so `rootMatch` still reads the colours.
- Exported checkers in `styles-tokens.test.ts` (each returns the offending declarations as strings):
  - `checkRadii(text)`: a `border-radius` whose value holds a number with `px` (only `var(--radius-…)`, `0` and `50%` pass);
  - `checkGrid(text)`: a `padding`, `margin`, `gap`, `row-gap` or `column-gap` with a px number that is not a multiple of 4;
  - `checkFontSizes(text, allow: string[])`: a `font-size` that is not `var(--text-…)`, `inherit` or an `em` value, outside the selectors in `allow` (`h1`, `.wordmark`);
  - `checkShadows(text)`: a `box-shadow` other than `none` or `0 0 0 1px var(--…)`;
  - `checkTransitions(text)`: a `transition` or `animation` duration that is not `var(--motion-…)`, except `.cursor`'s blink.
- Base rules: `input, select, textarea { border-radius: var(--radius-m) }`; `button { border-radius: var(--radius-pill); font-size: var(--text-m) }`; `fieldset { border-radius: var(--radius-m) }`; `:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px }`; `.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums }`.

- [ ] **Step 1: Write the failing tests.**
  - `checkRadii(".a{border-radius:2px}")` is `["border-radius:2px"]`; `var(--radius-m)`, `0` and `50%` give `[]`.
  - `checkGrid(".a{padding:6px 8px}")` flags it; `".a{margin:0 4px 8px}"` gives `[]`.
  - `checkShadows(".a{box-shadow:0 0 6px var(--glow)}")` flags it; `"0 0 0 1px var(--accent)"` gives `[]`.
  - `checkTransitions(".a{transition:width 200ms linear}")` flags it; `"width var(--motion-progress) linear"` gives `[]`.
  - The shape block defines exactly the Ruling 26 values (`--radius-m` is `8px`, `--space-6` is `32px`, `--text-l` is `13px`, `--motion-fast` is `80ms`).
  - Under `@media (prefers-reduced-motion: reduce)` `:root` sets `--motion-fast: 0ms` and `--motion-progress: 0ms`.
  - The base `button` rule uses `var(--radius-pill)`; `input, select, textarea` use `var(--radius-m)`; `:focus-visible` has `outline: 2px solid var(--focus)`.
  - No key in `THEME_KEYS` starts with `radius`, `space`, `text` or `motion`, and `applyTheme` with every built-in theme never sets such a property on the root.
  - Replace the assertion in `glows live things and sets output in mono` with: none of `.activity-bar button.active`, `.dot.active`, `.runs button.selected` has a `box-shadow` with `var(--glow)`; the mono assertions stay.
  - The sweep over every `src/**/*.css` in this task runs `checkRadii` and `checkShadows` on `styles.css` only; Task 18 widens it to every file and every checker.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/styles-tokens.test.ts test/theme-store.test.tsx`. It fails.
- [ ] **Step 3:** Implement. Only `styles.css` changes in this task: the base elements, tokens, focus ring, the three glows removed, and every `border-radius` in `styles.css` moved to a token.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): shape, spacing, type and motion tokens shared by every theme`.

### Task 2: Agent board events and types (shared)

**Files:**
- Create: `packages/shared/src/agent-board.ts`
- Modify: `packages/shared/src/events.ts`, `packages/shared/src/narration.ts` (cases; `topicOf` → `"board"`), `packages/shared/src/index.ts`
- Test: `packages/shared/test/agent-board.test.ts`, plus `narration.test.ts`

**Interfaces (produces):**
- `COMMENT_LIMITS = { textChars: 2000, perRun: 20 } as const`.
- `type CommentState = "waiting" | "given" | "read"`.
- `type CardComment = { id: string; cardId: string; authorName: string; role: Role; text: string; at: string; state: CommentState; runId: string | null; adapter: AdapterId | null }`.
- `type CardInfo = { cardId: string; runId: string | null; adapter: AdapterId | null; runStatus: RunStatus | null; progress: RunProgress | null; percent: number | null; now: string | null; waiting: boolean; comments: number; commentsWaiting: number; screenshots: number; moveRequest: { to: Stage } | null }`.
- `type CardMoveRequest = { cardId: string; projectId: string; projectName: string; title: string; runId: string; adapter: AdapterId | null; from: Stage; to: Stage; at: string }`.
- `commentStateLabel(c: Pick<CardComment, "state" | "adapter">): string`: Ruling 7's words.
- `agentBoardPayloadSchemas`, each strict, ids `string(1..200)`:
  - `card.run_linked`: `{ cardId, runId }`;
  - `card.comment`: `{ commentId, cardId, text: string(1..2000), authorName: string(1..120), role: enum(ROLES) }`;
  - `card.comments_given`: `{ cardId, runId, commentIds: id[] (1..20, unique) }`;
  - `card.comments_read`: `{ cardId, runId, commentIds: id[] (1..20, unique) }`;
  - `card.move_requested`: `{ cardId, runId, from: stage, to: stage }`, refined `from !== to`;
  - `card.move_declined`: `{ cardId, to: stage }`.
- Narration (the card title from `NarrationContext`, `“…”` quotes):
  - `card.run_linked`: `Claude took on “Fix the form”`;
  - `card.comment`: `<who> left a note on “Fix the form”`;
  - `card.comments_given`: `2 notes on “Fix the form” were given to Claude` (`1 note on “Fix the form” was given to Claude` for one);
  - `card.comments_read`: `Claude read the notes on “Fix the form”`;
  - `card.move_requested`: `Claude wants to move “Fix the form” to Ship`;
  - `card.move_declined`: `<who> said not yet to moving “Fix the form” to Ship`.

- [ ] **Step 1: Write the failing tests.**
  - `card.comment` rejects a 2001-character text, an empty one, `role: "admin"` and an unknown key.
  - `card.comments_given` rejects 21 ids and `["a","a"]`.
  - `card.move_requested` rejects `from: "build", to: "build"`.
  - `commentStateLabel({state:"given", adapter:"claude"})` is `"Given to Claude"`; `{state:"read", adapter:"codex"}` is `"Read by Codex"`; `{state:"waiting", adapter:null}` is `"Waiting for the next run"`.
  - Each narration line above, with a context naming card `c1` "Fix the form" and run `r1` as Claude; the topic is `"board"`.
  - `eventPayloadSchemas` has the six new types.
- [ ] **Step 2:** `pnpm --filter @theterminal/shared exec vitest run test/agent-board.test.ts test/narration.test.ts`. It fails.
- [ ] **Step 3:** Implement; register `...agentBoardPayloadSchemas` and the `AgentBoardEventType` union in `events.ts`.
- [ ] **Step 4:** `pnpm --filter @theterminal/shared test`. All green.
- [ ] **Step 5:** Commit `feat(shared): card notes, run links and move requests`.

### Task 3: Preview events, devices and API types (shared)

Runs after Task 2 (both edit `events.ts`, `narration.ts` and `index.ts`).

**Files:**
- Create: `packages/shared/src/preview.ts`
- Modify: `packages/shared/src/events.ts`, `packages/shared/src/narration.ts` (cases; a new topic `"preview"`), `packages/shared/src/home.ts` (`HomeRuns.moveRequests`, the three `HomeRun` fields, all optional so existing fixtures stay valid), `packages/shared/src/index.ts`
- Test: `packages/shared/test/preview.test.ts`, plus `narration.test.ts`

**Interfaces (produces):**
- `type DeviceId = "iphone16" | "pixel9" | "ipad" | "laptop"`; `DEVICE_IDS`.
- `DEVICES: Record<DeviceId, { label: string; width: number; height: number; scale: number; mobile: boolean; userAgent: string | null }>` with the Global Constraints' sizes. User agents:
  - iPhone 16: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1`;
  - Pixel 9: `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36`;
  - iPad: `Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1`;
  - Laptop: `null` (the default).
- `viewport(id: DeviceId, rotated: boolean): { width: number; height: number }`.
- `PREVIEW_LIMITS = { maxDevices: 4, startTimeoutMs: 180_000, installTimeoutMs: 600_000, idleMs: 1_800_000, tailLines: 20, tailLineChars: 300, screenshotBytes: 16_777_216, webPreviews: 4, nativeBuilds: 1 } as const`.
- `type PreviewKind = "web" | "ios" | "android"`; `WEB_STEPS`, `WEB_INSTALL_STEP`, `IOS_STEPS`, `ANDROID_STEPS` (Ruling 15's labels).
- `type PreviewState = "requested" | "starting" | "ready" | "failed" | "stopped"`.
- `type PreviewView = { id: string; runId: string; projectId: string; kind: PreviewKind; state: PreviewState; progress: RunProgress; percent: number; origin: string | null; frameable: boolean | null; exposed: boolean; error: PreviewFailure | null; tail: string[]; liveCount: { n: number; m: number } | null; startedAt: string }`.
- `type PreviewPlan = { kind: PreviewKind; commands: string[][]; display: string[]; key: string; confirmedEarlier: boolean; install: boolean; target: { source: "marker" | "detected"; label: string } }`. `display` shows each command as one line with `<port>` in place of the port.
- `type Screenshot = { sha256: string; runId: string; previewId: string; device: string; width: number; height: number; bytes: number; at: string }`.
- `type ToolId = "xcode" | "xcode_cli" | "simulator" | "android_sdk" | "adb" | "emulator" | "avd" | "gradle_wrapper"`; `TOOL_HELP: Record<ToolId, { title: string; steps: string[]; url: string }>`. URLs: `https://developer.apple.com/xcode/` for the Apple tools, `https://developer.android.com/studio` for the Android ones.
- `type NativeTools = { platform: "darwin" | "win32" | "linux"; ios: { supported: boolean; xcode: string | null; simulators: { udid: string; name: string; state: string; runtime: string }[]; missing: ToolId[] }; android: { supported: boolean; sdk: boolean; avds: string[]; missing: ToolId[] } }`.
- `type PreviewFailure = "timed_out" | "exited" | "install_failed" | "build_failed" | "boot_failed" | "install_app_failed" | "launch_failed" | "start_failed"`; `failureSentence(f: PreviewFailure, kind: PreviewKind): string`, e.g. `timed_out` → "The site did not answer within 3 minutes.".
- `previewPayloadSchemas`, each strict; `previewId` `string(1..200)`; `sha256` `/^[0-9a-f]{64}$/`:
  - `preview.offered`: `{ runId, kind, command?: string(1..500), port?: int(1..65535), target?: string(1..200) }`; `web` requires `command` and `port`, the others require `target` (`superRefine`);
  - `preview.requested`: `{ previewId, runId, kind, commands: string(0..1000)[](1..64)[](1..8), key: sha256, install: boolean, target: string(1..200) }`;
  - `preview.started`: `{ previewId, port: int(1..65535).optional() }`;
  - `preview.progress`: `{ previewId, steps: string(1..80)[](1..6), done: int[], current: int | null }`, with the same refinements as `agent.progress`;
  - `preview.ready`: `{ previewId, origin: /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/.optional(), frameable: boolean.optional(), exposed: boolean.optional() }`;
  - `preview.failed`: `{ previewId, reason: PreviewFailure, tail: string(0..300)[](0..20) }`;
  - `preview.stopped`: `{ previewId, reason: enum("person","tab_closed","idle","shutdown","restarted") }`;
  - `preview.screenshot`: `{ previewId, runId, device: string(1..60), sha256, bytes: int(1..16_777_216), width: int(1..20000), height: int(1..20000) }`.
- Narration, topic `"preview"`:
  - `preview.offered`: `Claude offered a website preview` / `an iPhone app` / `an Android app`;
  - `preview.requested`: `<who> confirmed starting the website preview: npm run dev` (the first command line, clipped to 80);
  - `preview.ready`: `The website preview is ready`; `preview.failed`: the `failureSentence`;
  - `preview.stopped`: `The website preview stopped` plus ` (idle for 30 minutes)`, ` (The Terminal restarted)` for those reasons;
  - `preview.screenshot`: `<who> took a screenshot on iPhone 16`;
  - `preview.started` and `preview.progress` narrate as `Started the website preview` / `Website preview: step 2 of 3 done`.

- [ ] **Step 1: Write the failing tests.**
  - `viewport("iphone16", true)` is `{width:852,height:393}`; `DEVICES.pixel9.scale` is `2.625`.
  - `preview.offered` accepts `{runId, kind:"web", command:"npm run dev", port:5173}`, and rejects web without `port`, `port: 70000`, and `{kind:"ios"}` without `target`.
  - `preview.ready` rejects `origin: "http://localhost:3000"` and `"http://10.0.0.2:3000"`, and accepts `"http://[::1]:5173"`.
  - `preview.failed` rejects 21 tail lines and a 301-character line.
  - `preview.requested` rejects a key of 63 hex characters and 9 commands.
  - `failureSentence("timed_out","web")` is `"The site did not answer within 3 minutes."`.
  - Narration: `preview.requested` with `commands:[["npm","ci"],["npm","run","dev"]]` reads `confirmed starting the website preview: npm ci`; `preview.stopped` with `idle` ends `(idle for 30 minutes)`.
  - A `HomeRuns` without `moveRequests` still type-checks in `home.test.ts` fixtures.
- [ ] **Step 2:** `pnpm --filter @theterminal/shared exec vitest run test/preview.test.ts test/narration.test.ts`. It fails.
- [ ] **Step 3:** Implement and register the schemas.
- [ ] **Step 4:** `pnpm --filter @theterminal/shared test`. All green.
- [ ] **Step 5:** Commit `feat(shared): preview events, devices and stage plans`.

### Task 4: One reader for every marker (core)

**Files:**
- Create: `packages/core/src/agents/markers.ts`
- Modify: `packages/core/src/agents/progress.ts` (it uses `LineReader`; `STEP_PLAN_INSTRUCTION` grows)
- Test: `packages/core/test/agents/markers.test.ts`, plus `progress.test.ts`

**Interfaces (produces):**
- `type Marker = ProgressLine | { kind: "card"; title: string } | { kind: "card-stage"; stage: Stage } | { kind: "card-done" } | { kind: "noted" } | { kind: "preview"; command: string; port: number } | { kind: "app"; platform: "ios" | "android"; target: string }`.
- `parseMarkerLine(line: string): Marker | null` (Ruling 1; `plan` and `step` delegate to `parseProgressLine`).
- `class LineReader { feed(text: string): string[] }`: the whole lines of the text, keeping the unfinished last line (at most 400 characters, only while it could still start any marker of Ruling 1) for the next feed; a last line that is a whole marker is returned at once, as today.
- `ProgressTracker` gains `apply(m: ProgressLine): RunProgress | null`; `feed(text)` keeps its behaviour through its own `LineReader`.
- `STEP_PLAN_INSTRUCTION` (same name, same first line `"\n\n---\nProgress for The Terminal:"`) describes, in one short block: `plan`, `step`, `card` ("only if this run has no card yet"), `card-stage` with the five stage words, `card-done`, `preview: <command> | port <n>` (with "`npm run`, `pnpm run`, `yarn run` or `npx` only"), `app: ios <scheme or path>` / `app: android <module>`, and `noted` ("after you read notes from people"). Each marker on a line of its own; never secrets.

- [ ] **Step 1: Write the failing tests.**
  - `parseMarkerLine("[[card: Fix the form]]")` is `{kind:"card", title:"Fix the form"}`; `"[[card-stage: Ship]]"` is `{kind:"card-stage", stage:"ship"}`; `"[[card-stage: done]]"` is `null`.
  - `"[[preview: npm run dev | port 5173]]"` is `{kind:"preview", command:"npm run dev", port:5173}`; `"| port 0"`, `"| port 70000"` and a marker without `| port` are `null`.
  - `"[[app: ios Trips.xcodeproj]]"` and `"[[app: android app]]"` parse; `"[[app: web x]]"` is `null`.
  - `"say [[noted]]"` is `null`; `"  [[noted]] "` is `{kind:"noted"}`.
  - `LineReader`: `"[[card: Fi"` then `"x]]\nrest"` yields `["[[card: Fix]]"]` once; a 401-character unfinished line is dropped; `"[[noted]]"` without a newline is returned at once.
  - The existing `progress.test.ts` cases pass unchanged except the instruction text check, which now also finds `[[card-stage:`, `[[preview:` and `[[noted]]` in `STEP_PLAN_INSTRUCTION`.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/agents/markers.test.ts test/agents/progress.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the two files again. They pass.
- [ ] **Step 5:** Commit `feat(core): one reader for the agent's marker lines`.

### Task 5: Agent cards, notes and move requests (core)

**Files:**
- Create: `packages/core/src/board/agent-cards.ts`
- Modify:
  - `packages/core/src/db.ts`: a new migration with `card_comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, project_id TEXT NOT NULL, author_name TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT)` and `card_move_requests (card_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, at TEXT NOT NULL)`;
  - `packages/core/src/events/projections.ts`: reducers for the six Task 2 events, `card.moved` also deleting the card's move request, `PROJECTION_TABLES`, `listCardComments(db, cardId)`, `listMoveRequests(db, projectId?)`, `cardInfos(db, projectId)`.
- Test: `packages/core/test/board/agent-cards.test.ts`, plus `projections.test.ts`

**Interfaces:**
- Consumes Task 2's schemas and types, `GateService.evaluate/move`, `BoardService.setCardStatus`, `RecordedText`.
- Produces `class AgentCards`, with `constructor(deps: { db; ledger; gates: Pick<GateService, "evaluate" | "move">; board: Pick<BoardService, "setCardStatus">; recorded: RecordedText; newId?: () => string; now?: () => Date })`:
  - `onCard(runId: string, title: string): void` (Ruling 3; ignored when the run has a card);
  - `onStage(runId: string, stage: Stage): void`: nothing without a card or when already there; every evaluation `pass` → `gates.move({kind:"agent", id: runId}, cardId, stage)`; otherwise `card.move_requested`, unless the same request is pending; a `HumanRequiredError` from a race also records the request;
  - `onDone(runId: string): void`: `setCardStatus(agent, cardId, "done")` unless it is done;
  - `onNoted(runId: string): void` (Ruling 6);
  - `addComment(actor: Actor, person: { name: string; role: Role }, cardId: string, text: string): CardComment` (Ruling 5; `HumanRequiredError` for a non-human actor; `NotFoundError` for an unknown card);
  - `notesFor(cardId: string): { ids: string[]; lines: string[] } | null`: the 20 oldest waiting notes as `Note from <name> (<Role label>): <text>`;
  - `declineMove(actor: Actor, cardId: string): void` (`NotFoundError` without a pending request).
- `cardInfos(db, projectId): CardInfo[]`: per card, its latest run (`started_at` desc): adapter, status, `progress`, `progressPercent`, `nowLine` of its latest action, `waiting` (a pending action), the counts, `screenshots: 0` (Task 10 fills it from `preview_screenshots`), the move request.

- [ ] **Step 1: Write the failing tests** (a temp db and ledger, a real `GateService`):
  - `onCard("r1","Fix")` on a run without a card records `card.created` (actor `{kind:"agent", id:"r1"}`, stage `plan`) and `card.run_linked`; `getRun(db,"r1").cardId` is the new id; a second `onCard` records nothing.
  - `onStage(r1,"design")` from Plan with the intake not complete records `card.move_requested` (the `plan_approved` gate does not pass) and no `card.moved`; repeated, it records nothing more; `listMoveRequests` holds one row.
  - With the intake complete, `onStage(r1,"design")` records `card.moved` with the agent as actor, and clears any request.
  - `onStage(r1,"ship")` records a request; then a human `gates.move` with sign-offs to Ship clears it.
  - `onDone` records `card.status_changed` to `done` once; the stage is unchanged.
  - `addComment` stores a 2,500-character text as exactly 2,000 characters, shows `\u202e` escaped, and throws `SecretInTextError` for `sk-ant-TESTKEY…`; an agent actor gets `HumanRequiredError`.
  - `notesFor` returns `Note from Ana (Maintainer): …` for a maintainer's note, the 20 oldest of 25 waiting.
  - `onNoted(r1)` after `card.comments_given` for `r1` marks those notes `read`; notes given to another run stay `given`.
  - `notes keep their state across rebuild`: after waiting, given and read notes, `rebuildAllProjections` gives the same `listCardComments` and `listMoveRequests`.
  - `cardInfos` shows `percent: 33` for a card whose latest run reported 1 of 3, `comments: 2, commentsWaiting: 1`, and `moveRequest: {to:"ship"}`.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/board/agent-cards.test.ts test/events/projections.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): agents create and move cards; people leave notes`.

### Task 6: The runner reads every marker, makes Home cards and gives notes (core)

**Files:**
- Modify: `packages/core/src/agents/runner.ts`, `packages/core/src/server/agent-routes.ts` (`startBody.autoCard: z.boolean().optional()`, passed through)
- Test: additions to `packages/core/test/agents/runner.test.ts` and `packages/core/test/server/agent-routes.test.ts`

**Interfaces:**
- Consumes Task 4's `LineReader`, `parseMarkerLine` and `ProgressTracker.apply`; Task 5's `AgentCards` through `type CardMarkers = Pick<AgentCards, "onCard" | "onStage" | "onDone" | "onNoted" | "notesFor">`.
- Produces:
  - `AgentRunnerDeps.cards?: CardMarkers` (absent: card markers are ignored, as in existing tests).
  - `start` input gains `autoCard?: boolean` (Ruling 2; ignored with a `cardId` or `foreignCard`).
  - `Session` gains `lines: LineReader` and `markers: "all" | "progress"` (`"progress"` when `foreignCard`).
  - `NOTES_HEADER = "Notes about this card from people on the project:"` and `NOTES_FOOTER = "When you have read these notes, write [[noted]] on a line of its own."`. The adapter prompt is `NOTES_HEADER + "\n" + lines.join("\n") + "\n" + NOTES_FOOTER + "\n\n" + prompt + STEP_PLAN_INSTRUCTION`.
  - `agent.started` and `card.comments_given` (actor `RUNNER`) are one `commitEvents`.
  - `onEmit` on a `message`: after `agent.message`, each line from `lines.feed(raw)` is parsed once; `plan`/`step` → `progress.apply` and `agent.progress`; with `markers: "all"`, card markers → `cards`, `preview`/`app` → `preview.offered` per Ruling 8 (the command and target cleaned with `this.clean`, `visibleControls` and truncated to 500 / 200).
  - A thrown commit fails the run as today; a card marker the cards service ignores is not a failure.

- [ ] **Step 1: Write the failing tests** (FakeAdapter scripts):
  - Script `[{message:"[[card: Fix the form]]"},{message:"[[card-stage: design]]"},{message:"[[card-done]]"}]` with the intake complete: the ledger holds `card.created`, `card.run_linked`, `card.moved` and `card.status_changed`, all with actor `{kind:"agent", id: runId}`.
  - The same markers inside an `action_result` output, or mid-line in a message, record nothing.
  - `autoCard: true` with prompt `"Fix the login\nmore"`: `card.created` titled `"Fix the login"` directly before `agent.started`, whose payload has its `cardId`; a later `[[card: Other]]` records nothing.
  - A run started with `foreignCard: true` and the card script records only `agent.message` entries (and `agent.progress` for a plan).
  - With two waiting notes on card `c1`, a run started on `c1` gives the adapter a prompt starting with `NOTES_HEADER`, then `Note from Ana (Maintainer): …`; `agent.started.payload.prompt` is the person's prompt; `card.comments_given` lists both ids; `[[noted]]` then marks both `read`.
  - `a note given to a failed run stays Given`: a run that fails before `[[noted]]` leaves its notes `given`, and the next run on the card gets none of them.
  - `[[preview: npm run dev | port 5173]]` twice records one `preview.offered`; a changed port records a second.
  - `POST /api/projects/:id/runs` with `autoCard: true` creates the card; `autoCard: "yes"` is 400.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/agents/runner.test.ts test/server/agent-routes.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green; the adapters' own tests are unchanged.
- [ ] **Step 5:** Commit `feat(core): the runner reads card, preview and note markers`.

### Task 7: The website command plan (core)

**Files:**
- Create: `packages/core/src/preview/web-command.ts`
- Test: `packages/core/test/preview/web-command.test.ts`

**Interfaces (produces):**
- `class PreviewRefusedError extends Error { constructor(readonly reason: "redacted" | "truncated" | "controls" | "program" | "script_missing" | "no_package_json") }` and `class PackageManagerNotFoundError extends Error { constructor(readonly manager: "npm" | "pnpm" | "yarn") }`.
- `parseWebCommand(command: string): { manager: "npm" | "pnpm" | "yarn"; runner: "run" | "npx"; name: string; args: string[] }`. It refuses (`PreviewRefusedError`) per the Global Constraints and Ruling 9: a `REDACTED` marker → `redacted`, a recorded truncation (`…` at the end of a 500-character text) → `truncated`, any character `visibleControls` changes → `controls`, any other shape → `program`.
- `resolvePackageManager(pm: "npm" | "npx" | "pnpm" | "yarn", o: { env: NodeJS.ProcessEnv; execPath?: string; platform?: NodeJS.Platform; which?: typeof which; realpath?: (p: string) => string; isFile?: (p: string) => boolean }): { file: string; args: string[] }` (Ruling 10).
- `frameworkFlags(scriptText: string | null, tool: string | null, port: number): string[]` (Ruling 11).
- `installCommand(worktree: string, manager): string[] | null`: `null` when `node_modules` exists; else by lockfile (`package-lock.json` → `["npm","ci"]`, `pnpm-lock.yaml` → `["pnpm","install","--frozen-lockfile"]`, `yarn.lock` → `["yarn","install","--frozen-lockfile"]`), else `[manager,"install"]`.
- `webPlan(worktree: string, command: string, o): { commands: string[][]; display: string[]; files: string[]; install: boolean; script: string | null }`, where `commands` are logical (`["npm","run","dev"]`), not resolved, and without port flags.
- `contentKey(worktree: string, kind: PreviewKind, commands: string[][], files: string[]): string` (Ruling 12; a missing file hashes as `null`).
- `resolveWebArgv(cmd: string[], port: number, o): { file: string; args: string[] }`: the resolved entry, the logical arguments, then `--` (npm only) and the framework flags.

- [ ] **Step 1: Write the failing tests** (a temp project folder):
  - `parseWebCommand("npm run dev")` is `{manager:"npm", runner:"run", name:"dev", args:[]}`; `"npx vite --open"` parses; `"npm run dev && rm -rf /"`, `"node server.js"`, `"npm run"`, `"pnpm dlx x"` and `"npm run dev\u0007"` are refused with `program`, `program`, `program`, `program` and `controls`; `"npm run [REDACTED]"` is `redacted`.
  - `webPlan` with `scripts: {dev: "vite"}`, a `package-lock.json` and no `node_modules` gives `commands: [["npm","ci"],["npm","run","dev"]]`, `display[1]` equal to `"npm run dev -- --port <port> --host 127.0.0.1"` and `install: true`; with `node_modules` present `install` is false. A missing script gives `script_missing`.
  - `frameworkFlags("next dev", null, 4000)` is `["--port","4000","--hostname","127.0.0.1"]`; `("react-scripts start", null, 4000)` is `[]`.
  - `resolvePackageManager("pnpm", …)` with a fake `which` returning `C:\\n\\pnpm.cmd` (`platform:"win32"`) and a sibling `node_modules/pnpm/bin/pnpm.cjs` gives `{ file: execPath, args: [<that .cjs>] }`; with no sibling it throws `PackageManagerNotFoundError("pnpm")`; a PATH hit whose real path is `npm-cli.js` gives `{file: execPath, args:[…npm-cli.js]}`; a `.bat` is never returned.
  - `contentKey` changes when one byte of `package.json` changes, and does not change when the port does.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/preview/web-command.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. It passes.
- [ ] **Step 5:** Commit `feat(core): website preview commands as argument arrays, without a shell`.

### Task 8: Native tools, app detection and build plans (core)

**Files:**
- Create: `packages/core/src/preview/native.ts` and `packages/core/test/fixtures/fake-native.mjs` (a program that acts as `xcode-select`, `xcrun`, `xcodebuild`, `plutil`, `adb`, `emulator` or `gradlew` by its first argument, scripted by `THETERMINAL_FAKE_NATIVE` JSON; writes the `.app` and `output-metadata.json` a real build would)
- Test: `packages/core/test/preview/native.test.ts` and `packages/core/test/preview/native-live.test.ts` (skipped unless `THETERMINAL_LIVE_IOS=1` / `THETERMINAL_LIVE_ANDROID=1`)

**Interfaces (produces):**
- `type ToolRunner = (tool: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>`; `realTools(platform)` resolves `xcode-select`, `xcrun`, `xcodebuild` and `plutil` on PATH and `adb` and `emulator` under the SDK, and runs them with `execFile` (argument arrays).
- `detectTools(run: ToolRunner, o: { platform; env; homedir: string; worktree?: string }): Promise<NativeTools>`: Ruling 24's commands, 15 s each; the default SDK folder is `~/Library/Android/sdk` (macOS) or `~/Android/Sdk` (Linux); `gradle_wrapper` is missing when the worktree has no `gradlew`. iOS is unsupported off macOS, Android on Windows.
- `findAppTarget(worktree: string, kind: "ios" | "android"): { target: string; label: string } | null`: exactly one `.xcworkspace` (preferred) or `.xcodeproj` at the top two levels, or exactly one module whose `build.gradle(.kts)` applies `com.android.application`.
- `iosPlan(o: { worktree; target; simulator: { udid; name; state }; derivedData: string }): { commands: string[][]; files: string[] }`: the five commands of the spec, `xcrun simctl boot` left out when the device is `Booted`, `plutil -extract …` before install.
- `androidPlan(o: { worktree; module; avd: string; sdk: string }): { commands: string[][]; files: string[] }`: `./gradlew :<module>:assembleDebug` (run as `<worktree>/gradlew` directly), `emulator -avd <name>`, `adb wait-for-device`, `adb install -r <apk>`, `adb shell monkey -p <package> 1`.
- `readAndroidOutput(worktree, module): { apk: string; applicationId: string }` and `findIosApp(derivedData): string` (each throws `PreviewFailedError("build_failed")` unless exactly one).
- `buildCount(line: string): { n: number; m: number } | null` (Ruling 15).

- [ ] **Step 1: Write the failing tests** (the fake program run as `process.execPath fake-native.mjs <tool> …` through an injected `ToolRunner`, so they run on Windows too):
  - `detectTools` on `platform:"darwin"` with a fake scripted Xcode 17 and one booted iPhone 16 gives `ios.xcode: "Xcode 17.0"`, one simulator and `missing: []`; with `xcode-select` failing it gives `missing: ["xcode_cli"]`.
  - With no SDK folder and no `ANDROID_HOME`, `android.missing` contains `"android_sdk"`; with an SDK and `emulator -list-avds` printing `Pixel_9_API_35`, `avds` is that.
  - `platform:"win32"`: `ios.supported` and `android.supported` are false.
  - `findAppTarget` with `Trips.xcodeproj` gives target `Trips.xcodeproj`; with two projects it gives `null`.
  - `iosPlan` with a `Booted` simulator has no `boot` command and contains `["open","-a","Simulator"]`; its first command ends `-derivedDataPath <derivedData> build`, as separate arguments.
  - `androidPlan` gives `["<worktree>/gradlew", ":app:assembleDebug"]` (joined with `node:path`) and `["adb","shell","monkey","-p","{{package}}","1"]`, with the package filled from `readAndroidOutput` at run time.
  - `buildCount("[ 12/80] Compiling")` is `{n:12, m:80}`; `"12 of 80"` is `null`.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/preview/native.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. It passes; the live file reports skipped.
- [ ] **Step 5:** Commit `feat(core): detect Xcode and the Android SDK, and plan app builds`.

### Task 9: The preview process supervisor and probes (core)

**Files:**
- Create: `packages/core/src/preview/process.ts`
- Test: `packages/core/test/preview/process.test.ts`, with `packages/core/test/fixtures/fake-site.mjs` (listens on `PORT` and `HOST` after `FAKE_SITE_DELAY_MS`, or exits with `FAKE_SITE_EXIT`, or prints `FAKE_SITE_PRINT`, or sends `X-Frame-Options: DENY` with `FAKE_SITE_NOFRAME=1`)

**Interfaces (produces):**
- `class Supervised { readonly pid: number | undefined; readonly exited: Promise<{ code: number | null; signal: string | null }>; tail(): string[]; onLine(listener: (line: string) => void): void; kill(): Promise<void> }`.
- `startSupervised(argv: { file: string; args: string[] }, o: { cwd: string; env: NodeJS.ProcessEnv; clean: (s: string) => string; spawn?: typeof spawn; execFile?: typeof execFile; platform?: NodeJS.Platform }): Supervised`. POSIX: its own process group (`detached`), killed with `-pid`; Windows: `taskkill /PID <pid> /T /F`, as `OverrideService.killTree`. The tail keeps the last 20 lines of stdout and stderr together, each cleaned and clipped to 300.
- `freePort(): Promise<number>` (listen on `127.0.0.1:0`, read, close).
- `probe(port: number, o?: { timeoutMs?: number }): Promise<{ origin: string; status: number; headers: Record<string, string> } | "open" | null>`: Ruling 16 for one port (`127.0.0.1`, then `::1`); `"open"` when TCP connects but HTTP does not answer within the timeout (default 2 s).
- `waitReady(ports: number[], o: { deadline: number; signal: AbortSignal; onStage(stage: "open" | "loaded"): void; now?: () => number; sleep?: (ms) => Promise<void> }): Promise<{ origin: string; headers } | null>`.
- `frameable(headers: Record<string, string>): boolean` (Ruling 18).
- `listeningAddresses(port: number, o: { platform; execFile }): Promise<string[]>` and `isExposed(addresses: string[]): boolean` (Ruling 17).

- [ ] **Step 1: Write the failing tests.**
  - `fake-site.mjs` started with `PORT` from `freePort()` and `FAKE_SITE_DELAY_MS=300`: `waitReady` calls `onStage("open")` then `onStage("loaded")` and returns origin `http://127.0.0.1:<port>`.
  - With a fake clock and `deadline` passed, `waitReady` returns `null` and never calls `onStage("loaded")`.
  - `kills the tree and keeps a redacted tail`: the site prints 30 lines, the last holding `sk-ant-TESTKEY…`; `tail()` has 20 lines and the last shows `[REDACTED]`; after `kill()` the child and the grandchild it spawned are gone (`process.kill(pid, 0)` throws).
  - `frameable({"x-frame-options":"DENY"})` is false; `{"content-security-policy":"frame-ancestors 'self'"}` is false; `{}` and `frame-ancestors *` are true.
  - `isExposed(["127.0.0.1","::1"])` is false; `["0.0.0.0"]` and `["*"]` are true. `listeningAddresses` parses a recorded `lsof -Fn` sample (`n*:5173`, `n127.0.0.1:5173`) to `["*","127.0.0.1"]` and a `netstat -ano` sample to `["0.0.0.0"]`; a failing tool gives `[]`.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/preview/process.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. It passes on macOS and Windows CI.
- [ ] **Step 5:** Commit `feat(core): supervise preview processes and probe their ports`.

### Task 10: PreviewService, its projection and screenshots (core)

**Files:**
- Create: `packages/core/src/preview/service.ts` and `packages/core/src/preview/screenshots.ts`
- Modify:
  - `packages/core/src/db.ts`: a new migration with `preview_offers (run_id TEXT NOT NULL, kind TEXT NOT NULL, command TEXT, port INTEGER, target TEXT, PRIMARY KEY (run_id, kind))`, `previews (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL, progress TEXT NOT NULL, origin TEXT, frameable INTEGER, exposed INTEGER NOT NULL DEFAULT 0, reason TEXT, tail TEXT, started_by TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT)` and `preview_screenshots (sha256 TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, preview_id TEXT NOT NULL, device TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (sha256, run_id))`;
  - `packages/core/src/events/projections.ts`: the eight reducers, `PROJECTION_TABLES`, `cardInfos` counting the screenshots of the card's runs, `getPreview(db, id)`, `livePreviews(db, projectId?)`, `listScreenshots(db, runId, limit?)`, `runStarter(db, runId): string | null`, `latestOffer(db, runId, kind)`.
- Test: `packages/core/test/preview/service.test.ts`, `packages/core/test/preview/screenshots.test.ts`, plus `projections.test.ts`

**Interfaces:**
- Consumes Tasks 3, 7, 8 and 9, `runWorktree` and `RunActiveError`/`RemoteRunError` as the override does.
- Produces:
  - Errors: `PreviewChangedError`, `PreviewNotAllowedError`, `NoPreviewOfferError`, `PreviewBusyError`, `PlatformUnsupportedError(kind)`, `NativeToolsMissingError(missing)`, `ScreenshotsUnavailableError`, `PreviewFailedError(reason)`.
  - `class PreviewService`, with `constructor(deps: ChangesDeps & { ledger; clean: (s: string) => string; tools?: ToolRunner; platform?; homedir?: string; capture?: (previewId: string) => Promise<{ device: string; png: Buffer }[]>; newId?; now?; sleep?; spawn?; execFile? })`:
    - `plan(actor: Actor, runId: string, kind: PreviewKind, target?: string): Promise<PreviewPlan>`: `HumanRequiredError` unless human; `PreviewNotAllowedError` per Ruling 13; `RemoteRunError` for a run on a linked machine; the target from `latestOffer` else `findAppTarget` (web: the offer only) else `NoPreviewOfferError`; the platform check; `NativeToolsMissingError` when `detectTools` lists anything needed.
    - `start(actor, runId, i: { kind; key; target? }): Promise<{ view: PreviewView; created: boolean }>`: recomputes the plan; a different key → `PreviewChangedError`; Ruling 19; records `preview.requested` then `preview.started`, then runs the stages in the background, recording `preview.progress` at each stage change, then `preview.ready` (origin, frameable, exposed) or `preview.failed` (reason, tail). Allowed while the run is running.
    - `view(id): PreviewView` (with the in-memory `liveCount`), `seen(id): void`, `stop(actor, id, reason: "person" | "tab_closed"): Promise<void>`.
    - `screenshot(actor, id): Promise<Screenshot[]>`: web needs `capture` (else `ScreenshotsUnavailableError`); native runs `xcrun simctl io <udid> screenshot <file>` or `adb exec-out screencap -p`; each image goes through `storeScreenshot`.
    - `recoverOnStartup(): void` (dangling previews → `preview.stopped { reason: "restarted" }`, actor `{kind:"system", id:"preview"}`), `shutdown(): Promise<void>` (every tree killed, `shutdown`), and an idle sweep every minute (`idle` after `PREVIEW_LIMITS.idleMs` without `seen` or `start`).
  - `screenshots.ts`: `pngSize(buf: Buffer): { width: number; height: number } | null` (signature and IHDR); `storeScreenshot(dataDir, projectId, png: Buffer): { sha256; bytes; width; height; file }`, which throws `InvalidScreenshotError` for anything that is not a PNG or is over `PREVIEW_LIMITS.screenshotBytes` (a capture that fails this records nothing); `screenshotFile(dataDir, projectId, sha256): string | null` (exists and is a regular file inside `artifacts`).

- [ ] **Step 1: Write the failing tests** (a temp data folder; the run's worktree holding a `package.json` with `scripts.dev = "node ../fake-site.mjs"` copied in; `resolveWebArgv` pointed at the fixture through an injected resolver):
  - `plan` for a run with `preview.offered` gives `display` `["npm run dev"]` (node_modules present) and `confirmedEarlier: false`; after a `start`, the same plan says `confirmedEarlier: true`.
  - `asks again when package.json changes`: `start` with the old key after one byte of `package.json` changed rejects with `PreviewChangedError` and records nothing.
  - A maintainer on another person's run gets `PreviewNotAllowedError`; the Owner may; an agent actor gets `HumanRequiredError`.
  - A run without an offer: web gives `NoPreviewOfferError`.
  - A start records `preview.requested` (person as actor, the key, `install: false`), `preview.started`, three `preview.progress` entries (done `[1]`, `[1,2]`, `[1,2,3]`) and `preview.ready` with an origin `http://127.0.0.1:<port>`; the site got `PORT` and `HOST=127.0.0.1` and no `ANTHROPIC_API_KEY` set in the parent.
  - `fails after three minutes`: with a fake clock and a site that never listens, `preview.failed { reason: "timed_out" }` with the tail, and the tree is killed.
  - A site that exits at once gives `exited` without waiting 3 minutes.
  - A second `start` with the same key returns the live one with `created: false`; a fifth web preview on the server gives `PreviewBusyError`.
  - `stops when idle`: after 30 minutes without `seen`, `preview.stopped { reason: "idle" }` and the process is gone; with `seen` every minute it keeps running.
  - `records restarted on startup`: a `preview.started` with no end in the ledger gets `restarted` from `recoverOnStartup`.
  - iOS with fake tools: stages progress through `[1]` … `[1,2,3,4,5]`, `preview.ready` has no origin; `simctl boot` is skipped for a booted device and `stop` does not shut it down; when The Terminal booted it, `stop` runs `xcrun simctl shutdown <udid>`.
  - Android on `platform:"win32"` gives `PlatformUnsupportedError("android")`.
  - `screenshot` on a native preview stores one PNG under `<data>/projects/<id>/artifacts/<sha>.png` and records `preview.screenshot` with the IHDR size; the same image twice stores one file and records two entries; a web preview without `capture` gives `ScreenshotsUnavailableError`.
  - `pngSize` of a 1×1 PNG is `{width:1,height:1}`; of a JPEG is `null`.
  - `cardInfos` of the card linked to that run shows `screenshots: 2`.
  - After `rebuildAllProjections`, `getPreview`, `listScreenshots` and `latestOffer` are the same.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/preview test/events/projections.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): previews the person confirms, with real stage progress and screenshots`.

### Task 11: Preview views over the host channel (core host)

**Files:**
- Create: `packages/core/src/server/preview-host.ts`
- Modify: `packages/core/src/host.ts` (message types), `packages/core/src/cli.ts` (`createPreviewHost` on the same `process.send`/`process.on("message")` as the folder picker, passed as `ServerOptions.previewHost`), `packages/core/src/server/server.ts` (the option type only: `previewHost?: PreviewHost`)
- Test: `packages/core/test/server/preview-host.test.ts`

**Interfaces (produces):**
- `host.ts`:
  - `type PreviewDeviceView = { device: string; x: number; y: number; width: number; height: number; viewport: { width: number; height: number }; scale: number; mobile: boolean; userAgent: string | null }`;
  - `type PreviewViewsMessage = { type: "preview_views"; id: string; previewId: string; origin: string; action: "show" | "hide" | "reload" | "close"; views: PreviewDeviceView[] }`;
  - `type PreviewCaptureMessage = { type: "preview_capture"; id: string; previewId: string }`;
  - `ChildMessage` adds both; `HostMessage` adds `{ type: "preview_views_done"; id: string; ok: boolean }` and `{ type: "preview_captured"; id: string; shots: { device: string; png: string }[] }` (base64).
- `type PreviewHost = { views(m: Omit<PreviewViewsMessage, "type" | "id">): Promise<boolean>; capture(previewId: string): Promise<{ device: string; png: Buffer }[]> }`.
- `createPreviewHost(io: FolderPickerIo-like, opts?: { viewsTimeoutMs?: number; captureTimeoutMs?: number; newId? }): PreviewHost`: defaults 5 s and 30 s; a timeout gives `false` / `[]`; answers with other ids are ignored; at most 4 shots, each decoded only when its base64 is at most `ceil(16_777_216 / 3) * 4` characters.

- [ ] **Step 1: Write the failing tests** (a fake io):
  - `views({previewId:"p1", origin:"http://127.0.0.1:5173", action:"show", views:[…]})` sends a `preview_views` with a fresh id and resolves `true` on `{type:"preview_views_done", id, ok:true}`.
  - An answer with another id is ignored and the call resolves `false` after `viewsTimeoutMs: 10`.
  - `capture` resolves the decoded buffers; a fifth shot and an oversized base64 string are dropped.
  - The folder picker and the preview host on one io do not consume each other's answers.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/server/preview-host.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite. All green.
- [ ] **Step 5:** Commit `feat(core): ask the desktop app to show and capture preview views`.

### Task 12: Device views and their locks in the desktop app (desktop)

**Files:**
- Create: `apps/desktop/src/preview-policy.ts` and `apps/desktop/src/preview-views.ts`
- Modify:
  - `apps/desktop/src/server-process.ts` (`startServer({ …, onPreview })`: valid `preview_views` / `preview_capture` messages call it and answer the child with the same id);
  - `apps/desktop/src/main.ts` (the `web-contents-created` dispatch of Ruling 21; the app window's user agent; `onPreview` wired to the views manager; views closed on window close and on quit).
- Test: `apps/desktop/test/preview-policy.test.ts`, `apps/desktop/test/preview-views.test.ts`, plus `server-process.test.ts`

**Interfaces (produces):**
- `preview-policy.ts`:
  - `isPreviewOrigin(origin: string): boolean`: exactly `http://127.0.0.1:<1-65535>` or `http://[::1]:<1-65535>`;
  - `hardenPreviewSession(s: SessionLike & { on(…) }): void`: `hardenSession(s)` plus `will-download` prevented;
  - `hardenPreviewContents(c: ContentsLike, o: { origin: string; confirmOpen: (url: string) => Promise<boolean>; openExternal: (url: string) => void }): void`: a main-frame `will-navigate` or `will-frame-navigate` off the origin is prevented and, when `externalUrl` accepts it and the person confirms, opened outside; a main-frame `will-redirect` off the origin is prevented; sub-frame navigations are allowed; `setWindowOpenHandler` always denies (http(s) asks, then opens outside); `will-attach-webview` and the Bluetooth picker are refused as for the app window.
  - `policyFor(isPreview: boolean): "preview" | "app"`.
- `preview-views.ts`: `createPreviewViews(deps: { window: () => WindowLike | null; makeView: (partition: string) => ViewLike; fromPartition: (p: string) => SessionLike; markPreviewSession: (s) => void; confirmOpen; openExternal }): { apply(m: PreviewViewsMessage): boolean; capture(previewId: string): Promise<{ device: string; png: string }[]>; closeAll(): void }`.
  - `show` creates one view per device on first use (partition `preview-<previewId>-<device>`, `webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition }`, no preload), `loadURL(origin)` once, `enableDeviceEmulation({ screenPosition: mobile ? "mobile" : "desktop", screenSize: viewport, viewSize: viewport, deviceScaleFactor: scale, viewPosition: {x:0,y:0}, scale: width / viewport.width })`, `setUserAgent` when given, and `setBounds` from the rectangle times the window's zoom factor (rounded). Views for devices no longer listed are removed.
  - `hide` sets every view of the preview invisible; `reload` reloads each; `close` removes and destroys them.
  - `capture` uses `webContents.debugger` (`attach("1.3")`, `Page.captureScreenshot` per Ruling 22, `detach`).
- `server-process.ts`: a message is valid only with an id of `PICK_ID`'s form, a `previewId` of `/^[A-Za-z0-9_-]{1,100}$/`, an origin `isPreviewOrigin` accepts, at most 4 views and every number finite in `0..20000` (scale in `(0, 10]`). Anything else is ignored.

- [ ] **Step 1: Write the failing tests** (plain emitters and fake views, as `harden.test.ts`):
  - Preview session: every permission request is refused; a `will-download` is prevented.
  - Preview contents with origin `http://127.0.0.1:5173`: a main-frame navigation to `http://127.0.0.1:5173/about` is allowed; to `https://example.com/` it is prevented and, when `confirmOpen` resolves true, `openExternal` gets it, and when false nothing opens; to `http://theterminal.localhost:4000/` it is prevented; a sub-frame navigation to `https://youtube.com/embed/x` is allowed; `window.open` is denied; a `file:` URL never reaches `openExternal`.
  - The app policy is unchanged: `policyFor(false)` gives `"app"`, and the existing `harden.test.ts` cases pass untouched.
  - `isPreviewOrigin("http://localhost:5173")` and `"http://127.0.0.1:0"` are false.
  - `apply(show)` with two devices makes two views with partitions `preview-p1-iphone16` and `preview-p1-laptop`, none named `persist:`, bounds multiplied by a zoom factor of `1.25`, and emulation `scale` `width / viewport.width`; a second `show` with one device removes the other view; `close` destroys all.
  - `server-process` with a fake child: a valid `preview_views` calls `onPreview` once and answers `preview_views_done` with the same id; an origin `http://example.com` or 5 views is ignored.
- [ ] **Step 2:** `pnpm --filter @theterminal/desktop exec vitest run`. It fails.
- [ ] **Step 3:** Implement. The app window keeps its web preferences and `hardenContents`; only the dispatch chooses.
- [ ] **Step 4:** Run the desktop suite. All green.
- [ ] **Step 5:** Commit `feat(desktop): locked-down device views for website previews`.

### Task 13: Routes and wiring (core server)

**Files:**
- Create: `packages/core/src/server/preview-routes.ts` and `packages/core/src/server/card-routes.ts`
- Modify:
  - `packages/core/src/server/auth.ts` (`ROUTE_ROLES` per the contract);
  - `packages/core/src/server/routes.ts` (`sendError` per the contract's codes);
  - `packages/core/src/server/static-ui.ts` (export `serveIndex(reply, csp: string)` and `previewCsp(origin: string): string`; the existing routes call `serveIndex(reply, UI_CSP)`);
  - `packages/core/src/server/home-routes.ts` (`moveRequests`, `offers`, `screenshots`, `livePreviewId`);
  - `packages/core/src/server/server.ts` (construct `GateService` before the runner; `AgentCards` into the runner's `cards`; `PreviewService` with `capture` from `previewHost`; register the routes; `previews.recoverOnStartup()` with the others; `await previews.shutdown()` right after `overrides.shutdown()`).
- Test: `packages/core/test/server/preview-routes.test.ts`, `packages/core/test/server/card-routes.test.ts`, plus `route-roles.test.ts`, `home-routes.test.ts`, `no-secrets.test.ts` and `static-ui.test.ts`

**Interfaces:**
- Consumes Tasks 5, 6, 10 and 11.
- Produces the contract's routes. `localOnly` (from `sources-routes.ts`) guards every preview and host route. `PreviewViewsBody = { previewId, action, devices: { device: DeviceId; rotated: boolean; x; y; width; height }[] (≤4) }`; the route fills viewport, scale, mobile and user agent from `DEVICES`, the origin from the projection (only a `ready` web preview), and answers `preview_host_unavailable` without a host.
- `GET /api/screenshots/:sha?runId=` answers only a recorded `(sha256, runId)` pair, with `content-type: image/png`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'` and `cache-control: private, max-age=86400`.
- `GET /preview/:id` serves `index.html` with `previewCsp(origin)` (Ruling 23) for a ready web preview, else 404.

- [ ] **Step 1: Write the failing tests** (`app.inject` with principals from `fixtures/principal.ts`):
  - `assertRoutesHaveRoles` passes and `route-roles` lists every new key with its role.
  - A viewer's `POST /api/cards/:id/comments` gets 403 `required: "maintainer"`; a maintainer's is 201 with `state: "waiting"` and `authorName` the maintainer's name; `text` of 2,500 characters is stored as 2,000; a text with `ghp_TESTKEY…` gets 400 `secret_in_text`.
  - `GET /api/cards/:id/comments` as a viewer lists it.
  - `POST /api/cards/:id/move-request/decline` without a request gives 404 `not_found`; with one it is 204 and `GET /api/home` no longer lists it.
  - `GET /api/home` lists a move request of another project with its `projectName`, and a run's `offers: ["web"]`.
  - Preview, on the remote listener: every preview and host route gives 403 `local_only` for the Owner.
  - `GET /api/runs/:id/preview/plan?kind=web` as the Owner gives the plan; as a maintainer on another person's run 403 `preview_not_allowed`; as a reviewer 403 `required: "maintainer"`.
  - `a stale key gets preview_changed`: `POST /api/runs/:id/preview` with a key of 64 zeros gives 409 `preview_changed`.
  - A start with the plan's key gives 201 with `state: "starting"`; the same again gives 200.
  - `POST /api/host/preview-views` without a host gives 404 `preview_host_unavailable`; with a stub host it passes the origin and `DEVICES.iphone16`'s viewport, and a rotated iPad's viewport is `{width:1180,height:820}`.
  - `GET /preview/:id` of a ready preview has a CSP containing `frame-src http://127.0.0.1:<port>` and `frame-ancestors 'self'`, and `GET /` still has `UI_CSP` exactly.
  - `a request from the preview's origin gets bad_origin`: `GET /api/home` with `Origin: http://127.0.0.1:<preview port>` gets 403 `bad_origin`.
  - `GET /api/screenshots/<sha>?runId=<other run>` gives 404; the right pair gives the bytes with the four headers.
  - `no-secrets`: after a preview whose site prints `sk-ant-TESTKEY…` and fails, no response body, ledger entry or log line holds the key.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/server`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): routes for previews, screenshots, card notes and move requests`.

### Task 14: API client, model and overlays (ui)

**Files:**
- Create: `apps/ui/src/shell/overlay-store.ts`
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/shell/model.ts`, `apps/ui/src/App.tsx`, `apps/ui/src/components/Modal.tsx` (counts as an overlay while open)
- Test: additions to `apps/ui/test/api.test.ts` and `apps/ui/test/App.test.tsx`; `apps/ui/test/overlay-store.test.ts`

**Interfaces:**
- Consumes the API contract and Tasks 2–3's types.
- Produces:
  - `api` methods: `cardInfos(projectId)`, `cardComments(cardId)`, `addCardComment(cardId, text)`, `declineMove(cardId)`, `previewPlan(runId, kind, target?)`, `startPreview(runId, { kind, key, target? })`, `getPreview(id)`, `stopPreview(id, reason)`, `previewSeen(id)`, `takeScreenshots(id)`, `runScreenshots(runId)`, `screenshotUrl(s: Screenshot): string`, `hostCapabilities()`, `previewViews(body)`, `nativeTools()`; `startRun` gains `autoCard?: boolean`.
  - `errorMessage` sentences:
    - `preview_changed`: "The agent changed what will run. Look at the commands again before you start it.";
    - `preview_not_allowed`: "Only the Owner, or the person who started this job, can start its preview.";
    - `preview_refused`: "The Terminal won't run this command. A preview runs only npm, pnpm or yarn scripts, or npx.";
    - `package_manager_not_found`: "<manager> isn't installed on this computer.";
    - `platform_unsupported`: "iPhone apps need a Mac." / "Android apps can't be built on Windows in this version.";
    - `native_tools_missing`: "Some tools are missing on this computer. See What you need on this computer.";
    - `screenshots_unavailable`: "Screenshots of websites need the desktop app.".
  - `overlay-store.ts`: `pushOverlay(): () => void` and `useOverlayOpen(): boolean` (a module-level count with listeners).
  - `WorkbenchModel` gains:
    - `cardInfos: { data: Record<string, CardInfo>; refresh(): void }` (reloaded on `card.*`, `agent.*` and `preview.screenshot` entries of the selected project, debounced 500 ms);
    - `onStartRun` gains a sixth argument `opts?: { autoCard?: boolean }`;
    - `onReviewMove(r: CardMoveRequest): Promise<void>` (selects the project, then `onMoveCard`) and `onDeclineMove(cardId): Promise<boolean>`;
    - `openPreview(runId: string): void` (opens `preview:<runId>` in the main group).
  - `App` reloads `home` on `card.*` and `preview.*` entries as well.

- [ ] **Step 1: Write the failing tests.**
  - `addCardComment("c1","hi")` posts `{text:"hi"}` to `/api/cards/c1/comments`.
  - `screenshotUrl({sha256:"ab…", runId:"r1"})` is `/api/screenshots/ab…?runId=r1`.
  - `errorMessage(new ApiError(409,"package_manager_not_found",{manager:"pnpm"}))` is `"pnpm isn't installed on this computer."`.
  - Two `pushOverlay()` calls make `useOverlayOpen()` true until both release functions are called; calling one release twice counts once.
  - An open `Modal` makes `useOverlayOpen()` true; closing it makes it false.
  - In `App`, a `card.comment` entry triggers one `cardInfos` call within 600 ms.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/api.test.ts test/App.test.tsx test/overlay-store.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): API and model for previews, card notes and move requests`.

### Task 15: The Board run by agents, and move requests on Home (ui)

**Files:**
- Create: `apps/ui/src/components/CardPanel.tsx` and `apps/ui/src/components/board.css`
- Modify:
  - `apps/ui/src/components/Board.tsx` (read-only cards; no `AddCard`, no move `<select>`, nothing `draggable`);
  - `apps/ui/src/views/BoardView.tsx` (the panel beside the columns; the header line "Cards are managed by agents · click a card to leave a note");
  - `apps/ui/src/home/ApprovalsBlock.tsx` (move-request rows; `waitingCount` counts them);
  - `apps/ui/src/home/AskBox.tsx` (`onStartRun(…, { autoCard: true })`);
  - e2e: `e2e/support.ts` (`moveCardViaApi(request, cardId, to, gates?)`), and `e2e/board.spec.ts`, `e2e/gates.spec.ts`, `e2e/story.spec.ts` where they used the Board's "Move to…" select or "+ Add".
- Test: `apps/ui/test/Board.test.tsx`, `apps/ui/test/BoardView.test.tsx`, `apps/ui/test/CardPanel.test.tsx`, plus `ApprovalsBlock.test.tsx`

**Interfaces:** Consumes Tasks 14's model, Plan 11's `ProgressBar`/`StepChecklist`, and `commentStateLabel`.

**Behaviour:**
- **A card** is one `<button className="agent-card">` with `aria-label="Open <title>"`: the title (one line, ellipsis), the percent (`.num`, when known), a 4px `ProgressBar` (`compact`), the "Now:" line or "Waiting for your approval" (amber) or "Waiting for an agent" (no run), then the agent's label, the note count ("2 notes", amber "1 note waiting" when any wait) and "3 screenshots". The dot colour: accent live, amber waiting, green done, `--idle` otherwise. Column headers show the count in `.num`.
- **The panel** (`aria-label="Card"`): the title, the bar and `StepChecklist` of the latest run, "Open the full story" (the `story:<cardId>` tab), **Preview** when the latest run offered one (`model.openPreview`), the notes list (text, "You" or the name, the time, the state label coloured green for Read and amber for Waiting), and the **Say something about this** box: a `<textarea maxLength={2000}>` with a `0/2000` counter (`.num`) and **Send**, for maintainers and above; below that role, "Notes are for maintainers and above." Escape closes the panel and returns focus to the card.
- **Move request row** on Home: "Claude wants to move “Fix the form” to Ship", the project name when it is another project, **Review** (`onReviewMove`) and **Not yet** (`onDeclineMove`), for reviewers and above.

- [ ] **Step 1: Write the failing tests.**
  - The Board renders no `select`, no `input`, no element with `draggable="true"` and no "+ Add"; a viewer and an Owner see the same controls.
  - A card with `CardInfo {percent:72, now:"Checking the fix works", adapter:"claude", comments:2}` shows `72%`, `Now: Checking the fix works`, `Claude` and `2 notes`; one with `waiting:true` shows "Waiting for your approval".
  - Clicking a card opens the panel with the checklist (step 3 `aria-current`); Escape closes it and focuses the card.
  - Typing and **Send** calls `addCardComment("c1", text)` once and clears the box; a failure keeps the text and shows the error sentence; a reviewer sees no textarea and the note sentence.
  - A note with `state:"read", adapter:"claude"` shows "Read by Claude"; a waiting one shows "Waiting for the next run".
  - Home: a `moveRequests` entry renders the sentence; **Review** calls `onReviewMove` with it; **Not yet** calls `onDeclineMove("c1")`; a viewer sees no buttons; `waitingCount` includes it.
  - The ask box's **Go** passes `{ autoCard: true }`.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/Board.test.tsx test/BoardView.test.tsx test/CardPanel.test.tsx test/ApprovalsBlock.test.tsx`. It fails.
- [ ] **Step 3:** Implement on the approved sketch (`agent-board-soft`): columns without dividers, 8px cards, the panel as a rounded side panel. Update only the e2e specs that drove the Board's removed controls, to `moveCardViaApi`.
- [ ] **Step 4:** `pnpm test` and `pnpm e2e -- e2e/board.spec.ts e2e/gates.spec.ts e2e/story.spec.ts`. All green.
- [ ] **Step 5:** Commit `feat(ui): the Board belongs to the agents; people leave notes`.

### Task 16: The Preview tab for websites (ui)

**Files:**
- Create:
  - `apps/ui/src/preview/preview-store.ts` (`tt.preview.v1`);
  - `apps/ui/src/preview/PreviewPanel.tsx` (the dock component `preview`);
  - `apps/ui/src/preview/ConfirmPreviewDialog.tsx`;
  - `apps/ui/src/preview/DeviceStage.tsx` (the frames, measured);
  - `apps/ui/src/preview/live-views.ts` (desktop mode);
  - `apps/ui/src/preview/PreviewPage.tsx` (browser mode, the `/preview/:id` page);
  - `apps/ui/src/preview/preview.css`.
- Modify: `apps/ui/src/shell/Workbench.tsx` (`PANELS.preview` only), `apps/ui/src/route.ts` (`{ page: "preview"; id }`), `apps/ui/src/main.tsx` (renders `PreviewPage` for that route)
- Test: `apps/ui/test/preview-store.test.ts`, `apps/ui/test/PreviewPanel.test.tsx`, `apps/ui/test/live-views.test.ts`, `apps/ui/test/PreviewPage.test.tsx`, plus `route.test.ts`

**Interfaces (produces):**
- `loadPreviewPrefs(): { devices: DeviceId[]; rotated: DeviceId[] }` (default `["iphone16","ipad","laptop"]`, `[]`; unknown ids dropped; at most 4; never empty), `savePreviewPrefs(p)`.
- `isDesktop(ua = navigator.userAgent): boolean` (`TheTerminalDesktop`).
- `useLiveViews(o: { previewId: string | null; frames: Map<DeviceId, HTMLElement>; rotated; visible: boolean }): void`: sends `show` with the frames' `getBoundingClientRect()` on mount, on `ResizeObserver` and scroll (once per animation frame), `hide` while `useOverlayOpen()`, while `!visible` or while `document.body.classList.contains("resizing")`, and `close` on unmount.
- `fitScale(viewport: { width; height }, box: { width; height }): number` (never above 1).

**Behaviour** (the approved sketch `preview-devices`):
- **Top bar:** "PREVIEW · <job title>", **Open in my browser ↗** (a link to the origin, `rel="noreferrer noopener"`, `target="_blank"`).
- **Controls:** a device toggle group (`role="group"`, `aria-pressed` per device, a fifth pick disabled with the title "Up to 4 devices"), the origin line ("● live · from “<job>” (Claude)"), **Reload**, **Rotate** (rotates every selected device), **Screenshot all** (desktop) or "Screenshots need the desktop app" (browser).
- **Not started:** **Preview** loads the plan; with `confirmedEarlier` it starts at once; otherwise `ConfirmPreviewDialog` shows "Start the website preview" and each `display` line in a `<code>` block, "This runs the project's own code on this computer." and **Start** / **Cancel**. `preview_changed` reloads the plan and shows the dialog again.
- **Starting:** `ProgressBar` with the stage checklist and the percentage; **Stop**.
- **Ready:** desktop: device frames with `useLiveViews`; browser: one `<iframe className="preview-host" src="/preview/<id>?d=…&r=…&k=…" title="Device previews">`. `exposed` shows a warning line "This site may be reachable from other devices on your network".
- **Failed:** `failureSentence`, the tail in a `<pre>` (already redacted), **Try again**.
- `seen` every 60 s while the tab is mounted; closing the tab sends `stopPreview(id, "tab_closed")`.
- **PreviewPage:** reads `?d`, `?r` and `?k`; per device a frame with the label "iPhone 16 · 393×852"; an `<iframe sandbox="allow-scripts allow-forms allow-same-origin" src={origin}>` sized to the viewport and scaled by `fitScale`; when `frameable` is false, "This site can't be shown inside another page" and **Open in my browser**.

- [ ] **Step 1: Write the failing tests.**
  - Prefs: corrupt JSON and a throwing `localStorage` give the default; `["laptop","x","ipad","ipad","pixel9","iphone16","laptop"]` normalises to the four distinct known ids.
  - `routeOf("/preview/p1")` is `{page:"preview", id:"p1"}`; `"/preview/../x"` is `{page:"app"}`.
  - The panel with no preview shows **Preview**; clicking it with a plan `confirmedEarlier:false` opens the dialog listing `npm ci` and `npm run dev -- --port <port> --host 127.0.0.1`; **Start** calls `startPreview(runId, {kind:"web", key})` once; with `confirmedEarlier:true` no dialog opens.
  - A `preview_changed` error reloads the plan and reopens the dialog.
  - A ready view in browser mode renders the host iframe with `src` `/preview/p1?d=iphone16,ipad,laptop&r=&k=0`; **Reload** changes `k` to `1`; picking a fifth device is disabled.
  - `exposed: true` shows the network warning.
  - `useLiveViews` with a fake `api.previewViews`: mount sends `show` with three devices; opening a `Modal` sends `hide`; closing it sends `show`; unmount sends `close`.
  - `PreviewPage` renders three iframes, each with exactly the sandbox string and `src` the origin; `frameable:false` renders the refusal sentence and no iframe.
  - `fitScale({width:1440,height:900},{width:360,height:400})` is `0.25`.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/preview-store.test.ts test/PreviewPanel.test.tsx test/live-views.test.ts test/PreviewPage.test.tsx test/route.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): preview a run's website on phone, tablet and laptop sizes`.

### Task 17: Phone apps, the Previews block and screenshots on jobs (ui)

**Files:**
- Create: `apps/ui/src/preview/AppPreview.tsx`, `apps/ui/src/preview/ToolsBox.tsx`, `apps/ui/src/home/PreviewsBlock.tsx`, `apps/ui/src/components/Screenshots.tsx`
- Modify:
  - `apps/ui/src/preview/PreviewPanel.tsx` (an iOS / Android switch when the run offered an app, rendering `AppPreview`);
  - `apps/ui/src/home/home-store.ts` (`previews` per Ruling 27, label "Previews");
  - `apps/ui/src/views/HomeView.tsx` (the block);
  - `apps/ui/src/home/WorkingBlock.tsx` and `apps/ui/src/home/FinishedBlock.tsx` (`Screenshots` and a **Preview** button when `offers` is not empty).
- Test: `apps/ui/test/AppPreview.test.tsx`, `apps/ui/test/ToolsBox.test.tsx`, `apps/ui/test/PreviewsBlock.test.tsx`, plus `home-store.test.ts` and `HomeView.test.tsx`

**Interfaces:** Consumes Tasks 14 and 16.
- `Screenshots({ shots, max }: { shots: Screenshot[]; max: number })`: thumbnails (`<img loading="lazy" alt="Screenshot on iPhone 16">` from `screenshotUrl`), fixed 64×64 boxes with `object-fit: contain`, so loading never shifts the layout.

**Behaviour:**
- **ToolsBox** ("What you need on this computer"): one row per needed tool with ✓ or "!"; a missing one has **How to install**, which expands `TOOL_HELP` steps and a link to its `url` (`rel="noreferrer"`, `target="_blank"`). Shown for the Owner only; others see "The Owner sets up the tools on this computer."
- **AppPreview:** "Getting it running · 64%" with `ProgressBar`, one row per stage with ✓ and its duration, "❯ starting…" for the current one (plus "12 of 80" when `liveCount` is set), and "○" for the rest; **Run the app** (plan, then the dialog listing every command as in Task 16); **Screenshot**; **Stop**; "You use the app in the simulator's own window." On failure, the sentence and the tail.
- **PreviewsBlock:** live previews of the selected project (job title, state, **Open**) and the latest 8 screenshots with the device label; with none, "No previews yet. When an agent builds a website or an app, you can preview it here."
- Finished today lines show up to 3 thumbnails; Working now cards show up to 3 and **Preview**.

- [ ] **Step 1: Write the failing tests.**
  - `normalizeHome` of a stored v1 layout without `previews` inserts it right after `finished`.
  - ToolsBox with `missing:["xcode"]` shows "!" and **How to install**; clicking it shows the steps and a link to `https://developer.apple.com/xcode/`; a maintainer sees the Owner sentence.
  - AppPreview with a view at done `[1,2]` of 5 and `current: 3` shows `40%`, two ✓, "❯ starting…" on the third row, and "12 of 80" with `liveCount {n:12, m:80}`.
  - `platform_unsupported` for Android shows its sentence.
  - PreviewsBlock with two screenshots renders two images whose `src` is `screenshotUrl`; empty, it renders the empty sentence.
  - A Working now card for a run with `offers:["web"]` has **Preview**, which calls `model.openPreview(runId)`; a Finished today line renders at most 3 thumbnails from 5.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/AppPreview.test.tsx test/ToolsBox.test.tsx test/PreviewsBlock.test.tsx test/home-store.test.ts test/HomeView.test.tsx`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): run phone apps in the simulator and show screenshots on jobs`.

### Task 18: App-wide polish in the approved style (ui)

**Files:**
- Modify: every `apps/ui/src/**/*.css` (`styles.css`, `home/home.css`, `components/sources.css`, `components/progress.css`, `components/board.css`, `preview/preview.css`); `apps/ui/src/shell/Workbench.tsx` and `apps/ui/src/shell/ActivityBar.tsx` (class names for floating panels only); `apps/ui/src/components/ProgressBar.tsx` (never moves back, `.num` percent)
- Create: `e2e/style.spec.ts`
- Test: `apps/ui/test/styles-tokens.test.ts`, `apps/ui/test/ProgressBar.test.tsx`

**Interfaces:** Consumes Task 1's tokens and checkers.

**What changes:**
- **Shell:** `.workbench-body` has `gap: var(--space-2)`, `padding: var(--space-2)` and the `--activity` background; `.activity-bar`, `.side-bar`, `.main-column` and the side panels are separate panels with `border: 1px solid var(--line)`, `border-radius: var(--radius-l)` and `overflow: hidden`; the sash lives in the gap with no border of its own; activity buttons are 40px with `var(--radius-m)` and the selected one has the `--selected` background and no glow.
- **Tabs:** dockview's active tab has `border-radius: var(--radius-m) var(--radius-m) 0 0`, a 1px `--line` border whose bottom is the content's background, and joins its content.
- **Home, dialogs, side bars, settings and the Board:** cards and fields `var(--radius-m)`, panels and dialogs (`.modal`) `var(--radius-l)`, buttons, tags, chips, badges and switches `var(--radius-pill)`; body text `var(--text-l)`, controls `var(--text-m)`, labels and headers `var(--text-s)`; every number (percent, counts, costs, times, the status bar) `.num`.
- **Motion:** hover and selection `transition: background-color var(--motion-fast) linear, border-color var(--motion-fast) linear`; progress fills `width var(--motion-progress) linear`; no other animation but the cursor.
- **Stability:** titles and "Now:" lines are one line with `text-overflow: ellipsis`; cards have fixed rows so updates never resize them; percentages keep `min-width: 4ch`.
- `ProgressBar` keeps the highest percent it has shown for the same `key` prop (a stale response never moves it back).

- [ ] **Step 1: Write the failing tests.**
  - The every-file sweep now runs `checkRadii`, `checkGrid`, `checkFontSizes(text, ["h1", ".wordmark"])`, `checkShadows` and `checkTransitions` on every `src/**/*.css`, and each returns `[]`.
  - `styles.css` rules: `.workbench-body` has `gap: var(--space-2)`; `.activity-bar`, `.side-bar` and `.main-column` each have `border-radius: var(--radius-l)` and `border: 1px solid var(--line)`; `.modal` has `border-radius: var(--radius-l)`; the dockview active-tab rule has `var(--radius-m) var(--radius-m) 0 0`.
  - `ProgressBar` rerendered from `67` to `33` with the same `key` still shows `67%`; with a new `key` it shows `33%`; the percent element has the class `num`.
  - `e2e/style.spec.ts`:
    - **Focus ring:** pressing Tab reaches the ask box's **Go**, a Board card (with the Board shown) and the "Show the Board" switch; each has a computed `outline-style` of `solid` and `outline-width` of `2px`.
    - **Reduced motion:** with `page.emulateMedia({ reducedMotion: "reduce" })`, a progress fill's computed `transition-duration` is `0s`.
    - **No layout shift:** a Working now card's bounding box height is the same at `33%` and at `67%`; a card whose title is 200 characters has the same width and height as one with a short title.
    - **Tokens in use:** computed `border-radius` is `8px` on a Home card and on an input, `10px` on the open New project dialog, and `999px` on a button.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/styles-tokens.test.ts test/ProgressBar.test.tsx` and `pnpm e2e -- e2e/style.spec.ts`. They fail.
- [ ] **Step 3:** Implement, screen by screen: shell, Home, dialogs (`Modal`, New project, Write-back, Invite, preview confirmation), side bars, Settings (Appearance, Workspace), the Board, the Preview tab, the status bar. Change look only, never behaviour or text.
- [ ] **Step 4:** `pnpm test` and `pnpm e2e`. All green, including `themes.spec.ts` on every theme.
- [ ] **Step 5:** Commit `style(ui): one crisp, rounded style across the app`.

### Task 19: End-to-end: website preview and the agents' Board

**Files:**
- Create: `e2e/preview.spec.ts`, `e2e/agent-board.spec.ts`, `e2e/fixtures/site/` (`package.json` with `"scripts": { "dev": "node server.mjs" }`, a `package-lock.json`, an empty `node_modules/.keep`, and `server.mjs` serving one page on `PORT` and `HOST`)
- Modify: `e2e/global-setup.ts` (a second fake script, selected for the project imported from `e2e/fixtures/site/`, of messages only: `[[plan: Build | Check]]`, `[[card: Contact form]]`, `[[preview: npm run dev | port 5173]]`, `[[card-stage: design]]`, `[[step 1/2 done]]`, `[[noted]]`. The first run has no notes, so its `[[noted]]` changes nothing; a second run on the card reads its notes), `e2e/support.ts` (helper `openPreview(page, jobTitle)`)

- [ ] **Step 1: Write the failing e2e tests.**
  - **Preview (browser mode, the e2e server is headless):**
    - after the run, its Home card shows **Preview**; clicking it opens the Preview tab; **Preview** opens the confirmation listing `npm run dev -- --port <port> --host 127.0.0.1`;
    - **Start**: the stage bar reaches `100%`, and inside the host frame three device frames show the fixture's heading in each iframe (`frameLocator`);
    - the ledger shows "confirmed starting the website preview: npm run dev" and "The website preview is ready";
    - **Reload** keeps it working; closing the tab records "The website preview stopped";
    - opening the tab again and clicking **Preview** starts without the dialog (the same key was confirmed);
    - **Screenshot all** is replaced by "Screenshots need the desktop app".
    - (Asking again after a change is covered by Task 10 and Task 13, where the files can be changed directly.)
  - **Board run by agents** (with "Show the Board" on):
    - the card "Contact form" appears in Plan with the run's agent, a bar and a "Now:" line, and no "Move to…" or "+ Add" anywhere;
    - Home shows "… wants to move “Contact form” to Design" (the intake is not complete); **Not yet** clears it;
    - open the card, write "Make the error message red", **Send**: it shows "Waiting for the next run";
    - start a second run on the card from the Agents view: the ledger shows "1 note on “Contact form” was given to Fake" (the singular of Task 2's line), and the note ends as "Read by Fake";
    - as a viewer (the people fixture), the card panel has no textarea.
- [ ] **Step 2:** `pnpm e2e -- e2e/preview.spec.ts e2e/agent-board.spec.ts`. It fails until Tasks 13–17 are in.
- [ ] **Step 3:** Fix only what the e2e tests reveal, in the task that owns the code.
- [ ] **Step 4:** `pnpm test` and `pnpm e2e`. All green on macOS and Windows CI.
- [ ] **Step 5:** Commit `test(e2e): website preview and the Board run by agents`.

## Order and parallelism

Each wave's tasks touch disjoint files and can run in parallel worktrees. A wave starts when the waves before it are merged.

- **Wave 1:** Task 1 (tokens), Task 2 (shared board events), Task 4 (marker reader), Task 7 (website commands), Task 8 (native tools), Task 9 (process supervisor) and Task 11 (host channel).
- **Wave 2:** Task 3 (shared preview; after Task 2 for `events.ts`, `narration.ts` and `index.ts`) and Task 12 (desktop views; needs Task 11's message types).
- **Wave 3:** Task 5 (agent cards; needs Task 2) and Task 14 (UI API and model; needs Tasks 2–3 and codes against the API contract).
- **Wave 4:** Task 6 (runner; needs Tasks 4–5), Task 10 (preview service; needs Tasks 3, 7, 8, 9 and comes after Task 5 in `db.ts` and `projections.ts`), Task 15 (Board UI) and Task 16 (Preview tab).
- **Wave 5:** Task 13 (routes and wiring; needs Tasks 5, 6, 10 and 11) and Task 17 (phone apps and Home; after Task 16 for `PreviewPanel.tsx`).
- **Wave 6:** Task 18 (polish) and Task 19 (end-to-end).

Files shared across waves, never within one:
- `events.ts`, `narration.ts`, `index.ts` (shared): Tasks 2, then 3;
- `db.ts`, `projections.ts`: Tasks 5, then 10;
- `server.ts`: Tasks 11 (the option type), then 13;
- `styles.css`: Tasks 1, then 18;
- `Workbench.tsx`: Tasks 16, then 18;
- `PreviewPanel.tsx`: Tasks 16, then 17;
- `ProgressBar.tsx`: Task 18 only (Tasks 15–17 use it as it is);
- `e2e/support.ts`: Tasks 15, then 19.
