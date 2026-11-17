# Preview on devices, and a Board run by agents: design

## Intent

The owner wants to see real results, not just summaries:
- a website the agent built, working, on phone, tablet and laptop sizes;
- a phone app the agent built, running in Apple's or Google's simulator.

The owner also wants the Board to belong to the agents. Agents create and move the cards. The person only watches the progress and, when they want to, says something about one specific card.

The owner reviewed a sketch of the preview ("looks good"). Home stays the main screen, and the Board stays optional behind Settings → Workspace → Show the Board.

## Goals

- **Website preview:** a Preview tab, and a small block on Home, that shows the site a run built, live, side by side on chosen devices. You can click and type in each one, reload, rotate, and take a screenshot of every device to attach to the job.
- **Phone app preview:** for iOS and Android apps, The Terminal:
  - checks which tools this computer has;
  - builds the app;
  - starts the simulator;
  - installs and opens the app;
  - shows a progress bar and a percentage for each stage;
  - collects screenshots onto the job.

  You use the app in the simulator's own window.
- **A Board run by agents.** Agents create cards, move them between stages and mark them done. Each card shows its agent, a progress bar and a plain one-line status. People can't drag or edit cards; they leave a comment on a card, which reaches the agent.
- **Progress everywhere:** starting a preview, building and booting all report progress in the same way as jobs.

## Non-goals

- No cloud device farms, no real phones over USB, and no app-store publishing.
- The Terminal doesn't install Xcode or Android Studio for you. It detects them and shows exactly how to install them.
- No general web browser: the preview only opens the run's own site.
- No editing of cards by people. Cards are the agents' workspace.

## Anti-goals (a failure even if it works)

- **Running project code without approval.** Starting a site, or building an app, runs the project's own code on this computer. It goes through the same approval as any agent command.
- **A preview that can reach The Terminal.** The previewed site must never read The Terminal's cookies or storage, never call its API, and never see the person's other browsing.
- **Fake progress:** the same rule as on Home. Percentages come only from real stages.
- **Comments that silently vanish:** every comment shows whether an agent has read it.

## Website preview

- **How a run offers a preview:** the agent says how to start its site in a marker line, the same channel as progress steps:
  - `[[preview: <command> | port <n>]]`, for example `[[preview: npm run dev | port 5173]]`;
  - the marker is parsed from the agent's own messages only, never from tool output.

  It appears on the run's card as **Preview**.
- **Starting it is an approval.** Clicking **Preview** the first time shows a decision card: "Start the website preview: `npm run dev`". Once approved, it is recorded in the ledger like any command.
  - **Where it runs:** in the run's working copy, as an argument array, with the environment from `buildChildEnv`. No API keys or connection secrets are passed.
  - **The port:** The Terminal picks a free port on `127.0.0.1` and passes it as `PORT`; the stated port is only a hint.
  - **Stopping it:** after 30 minutes idle, when the run's tab closes, or on shutdown.
  - **Who:** the owner, or a maintainer on their own run. Local listener only.
- **Progress:** "Starting the site" counts from the command started until the port answers HTTP. The stages are started, port open and first page loaded. It times out after 3 minutes with a plain error and the last 20 lines of output, redacted.
- **Showing it in the desktop app:**
  - **Isolation:** each device is an Electron `WebContentsView` in its own in-memory session partition, with sandbox on, no node, no preload, and no access to The Terminal's session.
  - **Navigation:** limited to the preview's origin. Links elsewhere open in the person's own browser, after a confirmation.
  - **Device emulation:** `webContents.enableDeviceEmulation` with each device's viewport, scale factor, mobile flag and user agent.
  - **No IPC:** the main process positions these views over the Preview tab's device frames when the UI asks, through a new local-only server route on the existing host channel (the same pattern as the folder picker).
- **Showing it in a browser (headless server):** a sandboxed `<iframe>` per device (`sandbox="allow-scripts allow-forms allow-same-origin"`) on the preview's own origin (a different port, so a different origin from The Terminal), scaled to the device viewport. Only on the local listener.
- **Devices:** iPhone 16 (393×852 @3x), Pixel 9 (412×915 @2.625x), iPad (820×1180 @2x) and Laptop (1440×900 @2x). You can pick up to four at once, and the choice is remembered per device. **Rotate** swaps width and height.
- **Screenshots:** **Screenshot all** captures each device view at its emulated size.
  - **Storage:** PNG files are stored under `<data>/projects/<id>/artifacts/`, and each one is recorded as a `preview.screenshot` ledger event with its hash, size and device. The image itself is never stored in the ledger.
  - **Where they show:** on the job's card and in Finished today.
  - **Who sees them:** viewers see them only if they can see the run.

## Phone app preview

- **Detecting tools:** owner only, local listener, desktop or headless.
  - **iOS (macOS only):** `xcode-select -p`, `xcrun simctl list devices --json` and `xcodebuild -version`.
  - **Android:** `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or the default SDK folder; `adb`, `emulator -list-avds` and a Gradle wrapper in the project.

  The results show in a **What you need on this computer** box. Anything missing gets **How to install**: plain steps and the official download page, opened in the person's browser.
- **How a run offers an app:** a marker, `[[app: ios <scheme or path>]]` or `[[app: android <module>]]`. Without one, The Terminal looks for a single `.xcodeproj` / `.xcworkspace`, or a single Gradle app module, and asks the person to confirm.
- **Build and run is an approval**, like the website preview: one decision card per run listing the commands it will run. The stages, each a progress stage:
  - **iOS:**
    1. `xcodebuild -scheme <s> -sdk iphonesimulator -destination 'platform=iOS Simulator,name=<device>' -derivedDataPath <data>/projects/<id>/build/<run> build`;
    2. `xcrun simctl boot <udid>` (if it isn't already running);
    3. `open -a Simulator`;
    4. `xcrun simctl install <udid> <app>`;
    5. `xcrun simctl launch <udid> <bundle id>`.
  - **Android:**
    1. `./gradlew :<module>:assembleDebug`;
    2. `emulator -avd <name>`, waiting for `adb wait-for-device` and `sys.boot_completed`;
    3. `adb install -r <apk>`;
    4. `adb shell monkey -p <package> 1`.
  - **Rules:** all of these run as argument arrays with `buildChildEnv`. Build output is redacted, and only its last lines are shown on failure.
- **Progress:** each stage is a step of a fixed plan (check, build, start simulator, install, open), so the percentage is real. Long builds also show the build tool's own "N of M" counts when the tool prints them.
- **Screenshots:** **Screenshot** runs `xcrun simctl io <udid> screenshot <file>` or `adb exec-out screencap -p`, stored and recorded as for websites. Optional: a screenshot every 10 seconds while the app runs, keeping the last 5.
- **Stop:** quits the app, and leaves the simulator running unless The Terminal started it.

## A Board run by agents

- **Cards come from agents.** New marker lines in the agent's messages:
  - `[[card: <title>]]` creates a card in the run's project, linked to the run, with the run's plan as its checklist;
  - `[[card-stage: <stage>]]` moves the run's card;
  - `[[card-done]]` marks it done.

  These create and change cards only through the existing card events (`card.created`, `card.moved`, `card.status_changed`), with the agent as actor.
- **Runs started from Home** get a card automatically, titled with the job title, if the agent states none.
- **People can't drag, edit or move cards.** The Board's drag handles and editing controls are removed. Cards show:
  - the title;
  - the agent;
  - a progress bar and percentage (from the linked run's steps);
  - a "Now:" line;
  - a comment count.
- **Comments:** clicking a card opens its side panel with the summary timeline and a **Say something about this** box.
  - A comment is a `card.comment` ledger event (text clipped to 2,000 characters, with visible-control escaping) by the person.
  - **If a run is working on the card:** the comment is delivered to that agent as its next input, on adapters that accept input mid-run. Otherwise it is queued.
  - **Queued comments** are prepended to the prompt of the next run on that card: "Notes from <name> about this card: …". The ledger keeps the person's prompt unchanged, as with the step instruction.
  - **State:** each comment shows **Waiting**, **Delivered to <agent>** or **Read** (the agent acknowledges with `[[noted]]`).
  - **Who:** reviewers and above can comment; viewers only read.
- **The intake and gates** keep their current behaviour. A gate on a card stays a human decision, shown on Home.

## Constraints

- AGENTS.md and the main spec apply: changes go through `commitEvent`; nothing uses a shell string; the environment comes from `buildChildEnv`; it works on macOS and Windows (iOS only on macOS); tests first; no new runtime dependencies without approval; no safeguard weakened.
- **Electron's hardening stays as it is:** no preload on The Terminal's own window. New views get their own partition and the existing navigation and permission locks.
- **CI can't run simulators.** Native stages are tested with fake `xcrun`, `xcodebuild`, `adb` and `emulator` programs, and live tests are opt-in (`THETERMINAL_LIVE_IOS=1`, `THETERMINAL_LIVE_ANDROID=1`).

## Left to the builder

- The exact layout of the Preview tab, within the approved sketch.
- How device views are positioned over the tab, and kept in place on resize and scroll.
- Which adapters can take a comment mid-run, and how. Queue when unsure.
- Splitting this into plan tasks.

## Calls made without the owner (check these)

- Starting a preview, or building an app, needs an approval, since it runs project code.
- The preview opens only the run's own site. Other links go to your normal browser after a confirmation.
- The Terminal doesn't install Xcode or Android Studio. It detects them and shows how to install them.
- Screenshots are stored as files, with only their hash in the ledger.
- Agents create and move cards with marker lines; people can't drag or edit cards, only comment.
- Comments reach a working agent straight away where its adapter allows; otherwise they wait for the next run on that card.
- The Board stays optional (Settings → Workspace), and Home stays the main screen.

## Decisions after review (these override the sections above)

1. **Starting a preview or a build is the person's own confirmed action, not an agent approval.** It follows the emergency override service, not the agent gate.
   - The person clicks **Preview** or **Run the app**. A confirmation dialog shows the exact commands, and the person confirms.
   - The confirmation is recorded as `preview.requested`, then `preview.started`, `preview.ready`, `preview.failed` or `preview.stopped`, with the person as actor.
   - **Who:** the owner, or a maintainer on a run they started themselves. Local listener only.
   - **Timing:** allowed while the agent is still working, since dev servers reload as files change.
   - **When it needs confirming again:** the confirmation covers that exact command and the exact contents of `package.json` (or the build files) at that moment, recorded as a hash. If the agent changes either, the person confirms again.
   - **Commands that are always refused:** any command that comes out redacted, truncated or holding control characters, the same rule the policy applies.
2. **No shell, on any platform.**
   - **Website commands:** limited to `npm`, `pnpm` or `yarn run <script>`, or `npx <tool>`. They are resolved to Node plus the package manager's own JavaScript entry point, the way the bundled CLIs already run. Native executables are run directly. `.cmd` and `.bat` files are never run.
   - **Android builds:** on macOS and Linux only in this version, since `gradlew` there is run directly. Android on Windows is a later step.
   - **iOS:** macOS only.
3. **Ports and binding.**
   - The Terminal sets `PORT=<free port>` and `HOST=127.0.0.1`. For Vite, Next, Astro and Nuxt dev scripts it also appends the tool's own `--port <p> --host 127.0.0.1` flags.
   - **Readiness:** it probes `127.0.0.1` and `::1` on the chosen port, then on the stated port.
   - **Network check:** if the server is found listening on a non-loopback address (a best-effort check with the platform's socket listing), the Preview tab shows "This site may be reachable from other devices on your network". It never blocks.
   - **Timeout:** if nothing answers within 3 minutes, it fails with a plain error.
4. **Cards and gates.**
   - **An agent moving a card:**
     - into a stage whose gate passes, the move happens;
     - into a stage whose gate needs a human, it becomes a pending request on Home ("<agent> wants to move <card> to Ship"). The human's gate decision performs the move.
   - **`[[card-done]]`** sets the card's status to done without moving its stage.
   - **New cards** start in Plan.
   - **A second `[[card: …]]`** from a run already linked to a card is ignored: the first card wins.
   - **The checklist** on a card is the linked run's step plan, displayed and not stored.
   - **People's controls:** the human card routes stay on the server, since the intake and the API use them. The Board UI no longer offers drag, edit or move.
5. **Who can comment, and how it reaches the agent.**
   - Comments are for **maintainers and above**, since they become agent input. They are framed to the agent as "Note from <name> (<role>)".
   - No adapter takes input mid-run today, so in this version comments are delivered by putting them at the start of the next run on that card.
   - Each comment shows **Waiting for the next run**, **Given to <agent>**, or **Read** once the agent replies `[[noted]]`.
6. **Locks for the preview views** in the desktop app, a policy of their own that covers each preview partition:
   - **Navigation:** top-level navigation within the preview's origin is allowed. Navigation elsewhere opens in the person's own browser after a confirmation.
   - **Content:** sub-resources and embedded frames from the internet are allowed, so ordinary sites work.
   - **Refused:** new windows, downloads and every permission request (camera, microphone, location, notifications and the rest).
   - **The partition:** it gets the same session hardening as The Terminal's own session, adapted to these rules. The Terminal's own window keeps its current locks unchanged.
7. **The preview in a browser (headless server):**
   - **The page:** it is served from its own route, `/preview/:id`, whose CSP adds `frame-src` for exactly that preview's origin. The main UI's CSP is unchanged.
   - **A site that refuses to be framed** (`X-Frame-Options` or `frame-ancestors`): the device shows "This site can't be shown inside another page", with **Open in my browser**.
8. **Live views and Home.**
   - Live device views exist only in the Preview tab. They hide whenever a dialog, menu or toast opens, and come back when it closes.
   - The Home block and job cards show the latest screenshots, not live views.
9. **Installing dependencies:** when a working copy has no `node_modules`, the confirmed commands include the install first: `npm ci`, `pnpm install --frozen-lockfile` or `yarn install --frozen-lockfile`, chosen by the lockfile. It is one confirmation for both.
10. **Smaller points.**
    - Preview, app and card markers work for runs on this computer only. Runs on a linked machine ignore them in this version.
    - The fixed instruction appended to every run grows to describe all the markers (`plan`, `step`, `card`, `card-stage`, `card-done`, `preview`, `app`, `noted`) in one short block.

## Visual style, for the whole app

The owner approved a sketch of the agent Board with this style: crisp like VS Code, but rounded and not rectangular. It applies to every screen, the new ones in this design and the existing ones (Home, dialogs, side bars, settings), through a polish pass.

- **Sharp:**
  - thin 1px lines;
  - no heavy shadows or glows;
  - everything on a 4px grid;
  - type at 13px for body text, 12px for controls and 11px for labels;
  - numbers in a monospace font with tabular figures;
  - colour only where it means something: accent for live, amber for needs-you, green for done.
- **Rounded:**
  - 8px corners on cards, fields and menus, and 10–12px on panels;
  - pill-shaped buttons, tags and chips;
  - progress bars 4px tall with rounded ends;
  - the activity bar, main area and side panels float as separate rounded panels, with 8px gaps instead of hard dividers;
  - the active tab is rounded at the top and joins its content.
- **Smooth:**
  - hover and selection respond within 80ms, with no bouncy motion;
  - progress bars move forward with a short linear ease and never jump back;
  - nothing shifts around when data updates; text truncates instead of resizing cards;
  - everything works with the keyboard, with a visible focus ring;
  - motion stops under reduced motion.
- **Tokens:** radii, spacing and type sizes become theme-independent tokens (`--radius-s/m/l`, `--space-1…6`, `--text-s/m/l`), so every theme keeps the same shape.
