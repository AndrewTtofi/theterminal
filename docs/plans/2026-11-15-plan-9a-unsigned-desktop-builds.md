# Plan 9A: Unsigned Desktop Builds Implementation Plan

**Goal:** A release workflow produces an unsigned macOS `.dmg` (arm64 and x64) and a Windows `.exe` installer. The author installs them on their own machines, accepts the OS warnings, and launching the app starts the local server and opens the workspace in a window.

**Architecture:**
- New package `apps/desktop`: an Electron shell. Its main process holds no workspace code. It spawns the core server as a child process: `<shipped node> core/dist/cli.js start --data-dir … --ui-dir … --core-dir …`. The two talk over Node's IPC channel: the child sends `{ type: "ready", url, loopbackUrl, port }`, the host sends `{ type: "shutdown" }`, and the child shuts down by itself if the channel drops. The shell then opens a `BrowserWindow` on the bootstrap URL `http://theterminal.localhost:<port>/?token=…`. The existing auth turns that into the host-only session cookie.
- Core gains a small host contract: a `coreDir` option and `--core-dir` flag for the bundled-CLI lookup, the IPC protocol in `cli.ts`, a data-folder lock so the CLI and the desktop app never open one ledger at the same time, and a host-safe entry `dist/host.js` that exposes the env allowlist without loading native modules.
- Packaging: `pnpm deploy --prod --node-linker hoisted` stages core with flat, real-file `node_modules`. A stage script prunes it, adds a pinned and checksum-verified official Node binary and the built UI, and electron-builder places all three under `Resources/` (`extraResources`, outside asar). `release.yml` builds on each target natively, installs the built artifact, runs a Playwright smoke suite against the installed app, and uploads the installers.

**Tech Stack:** existing stack, plus `electron` **44.10.1** (MIT, published 2026-10-31, bundles Node 24.22.1 / Chromium 152; no install script, the binary downloads lazily on first dev run), `electron-builder` **26.18.1** (MIT, published 2026-10-26), and the official Node runtime **v24.22.2** (published 2026-10-27, Active LTS) shipped inside the app. All three are the newest releases at least two weeks old on 2026-11-15. Electron 45.x and Node 24.22.3 are newer than that. Actions: `actions/upload-artifact` v7.0.2 `cf430e030ddbb5b0abf93d22962f4752f3646cd9` (2026-10-07) and `actions/download-artifact` v8.0.2 `9000827ccba6bdab643e8b6fd33ac0654aef8333` (2026-10-07). Smoke tests use the repo's existing `@playwright/test` (`_electron`).

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §2 goal 7 (plug-and-play: download, open, start), goal 9 (offline mode), §3 "Local (default)" (installer; local server, web UI, wrapped in a desktop app) and "Own local address", §8 "Everything ships inside The Terminal" and "Installers in milestone 1" (macOS Apple Silicon, Windows), §9 open item on the desktop shell (Electron vs Tauri: these are recommendations for the author to approve). Out of scope: signing and notarization (Plan 9B), auto-update, silent installation of prerequisites (Git, WSL), Linux.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, workflow logs or commit messages. The smoke suite reads the token from a throwaway data folder and never prints it. Under IPC, the CLI prints the token-free loopback URL.
- **No AI attribution.** Commits and the PR are authored by the repository owner only, with no co-author or tool trailers and no AI-tooling traces.
- **Branch and PR.** The work lands on branch `plan-9a-unsigned-desktop-builds`, one commit per task, and merges through a pull request once `CI` and `Release builds` are green on all three runners.
- **Exact pins.** New dependencies use exact versions (`44.10.1`, `26.18.1`, never `^`). Every action is pinned by commit SHA. The shipped Node archive is pinned by SHA-256.
- **No new install scripts.** Every newly reported build script gets `false` in `allowBuilds` with a one-line reason. `true` needs a plan amendment. The Node runtime is fetched by the stage script at packaging time, not by an install hook.
- **No `shell: true`.** Every spawn and `execFile` takes an argument array: the server child, the login-shell PATH probe, `tar`, and the smoke suite's CLI version checks.
- **Allowlisted environments.** The server child gets `allowlistedEnv(process.env, platform)` (the same list agents get), with PATH replaced by the resolved login PATH on macOS. Agent children are unchanged: `buildChildEnv` still decides. No `ELECTRON_*`, `NODE_OPTIONS` or `THETERMINAL_FAKE_*` reaches the server from a packaged launch.
- **No secrets in 9A workflows.** Only the built-in `GITHUB_TOKEN`, and only in the tag-only draft-release job (`contents: write`). Everything else is `contents: read`.
- **Offline.** The packaged app makes no network request of its own: spellcheck is off, no updater, and the window never loads a non-app origin.
- Earlier plans' constraints still hold: Node ≥ 22 for development, strict TS ESM, 127.0.0.1 bind, the Host and Origin checks, default-deny auth, keychain-only secrets, cross-platform paths via `node:path`.

## Decisions

- **Decision (controller default): Electron with electron-builder, not Node SEA plus a native launcher.** SEA cannot load `.node` addons from inside the blob, so better-sqlite3, keyring and node-pty would still be extracted to disk next to the executable. SEA gives no window, so the system browser would be the only UI. The dmg and NSIS installers would have to be built by hand (`hdiutil`, NSIS or WiX scripts), and so would every signing and notarization step. electron-builder already has dmg and nsis targets and has the signing hooks 9B needs (`mac.identity`, `notarize`, `win.signtoolOptions`). No concrete blocker for Electron turned up. Tauri, the spec's other option, would add a Rust toolchain and still needs Node for the server and CLIs.
- **Decision (controller default): the server runs in a separate process on a shipped official Node 24.22.2, not in Electron's main or utility process.** Gemini CLI is run as `process.execPath <bundle>`, and both PATH `.cmd` fallbacks (Codex, Gemini) do the same. Under Electron, `process.execPath` is the app binary. Making that act as Node needs `ELECTRON_RUN_AS_NODE=1`, which has two problems. Kept, it leaks to every grandchild: an agent that runs the user's own Electron project would start it as plain Node. Scrubbed, the Gemini bundle's own `process.execPath` spawns (it has several) would relaunch the GUI app. With a real Node, core runs exactly as `theterminal start` does, needs no runtime change, crashes in isolation from the window, and leaves Electron's `RunAsNode` fuse free for 9B to disable. Cost: about 110 MB.
- **Decision (controller default): no native rebuild.** better-sqlite3 13.1.1 ships N-API prebuilds (`node-addon-api`, `gypfile: false`, no install script), as do `@napi-rs/keyring` and `@lydell/node-pty`. They load in the shipped Node, never in Electron. electron-builder runs with `npmRebuild: false`. The shell's own `node_modules` are empty.
- **Decision (controller default): core, Node and UI live under `Resources/` via `extraResources`, outside asar.** Layout: `Resources/core/{package.json,dist,node_modules}` (hoisted, real files), `Resources/node/node[.exe]` and `Resources/ui/`. `app.asar` holds only the shell's `dist/` and `package.json`. This avoids asar-unpack because `spawn` cannot run a file inside `app.asar`, and the path checks in `bundled.ts` would have to map `app.asar` to `app.asar.unpacked`. Nothing from core runs inside Electron, so asar would protect nothing.
- **Decision (controller default): the bundled-CLI lookup takes an explicit `coreDir`, passed by the host as `--core-dir <absolute>` → `createServer({ coreDir })`.** No environment variable is added for this: an env-driven path would let any process that can set the app's environment choose which binaries the app runs. When `coreDir` is given, `findCoreDir()` is not consulted. The CLI from source keeps using it.
- **Decision (controller default): one data folder shared with the CLI.** It is `~/Library/Application Support/TheTerminal` on macOS and `%APPDATA%\TheTerminal` on Windows. The host computes it as `join(app.getPath("appData"), "TheTerminal")`, which equals core's `defaultDataDir()`, and always passes it explicitly. The Chromium profile is `<dataDir>/desktop` (set before the single-instance lock, so the lock is per data folder) and the server log is `<dataDir>/desktop/server.log`. Because the CLI and the app can now open the same ledger, core takes a `server.lock` in the data folder (pid, `wx`). A second server refuses with a fixed message, and a lock whose pid is gone is taken over.
- **Decision (controller default): a `BrowserWindow` on `http://theterminal.localhost:<port>`, with the system browser as an option.** Chromium resolves `*.localhost` to loopback internally, so no hosts file is needed. The Host check accepts `theterminal.localhost:<port>`, and the Origin check accepts `http://theterminal.localhost:<port>`. The bootstrap `/?token=` sets the host-only, HttpOnly, SameSite=Strict cookie in the app's own profile. A window is plug-and-play and does not depend on how each browser handles `.localhost`. A menu item **Open in Browser** hands the same bootstrap URL to the OS. Navigation is locked to the app origin. `http(s)` links open in the system browser, and every other scheme is dropped. Permissions are denied and spellcheck is off.
- **Decision (controller default): macOS GUI launches get the login-shell PATH.** Finder starts apps with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so agents would not find Homebrew tools. The host runs `execFile($SHELL, ["-ilc", <print PATH between markers>])` with a 5 s timeout. It falls back to the current PATH plus `/opt/homebrew/bin:/usr/local/bin`. Windows is unchanged.
- **Decision (controller default): the 9B hooks live in one place.** `apps/desktop/electron-builder.mjs` exports `builderConfig(env)`. In 9A, macOS is ad-hoc signed (`identity: "-"`): Apple Silicon kills arm64 code without a valid signature, and repackaging invalidates Electron's upstream signature. `hardenedRuntime` is `false`, and Windows is unsigned. `THETERMINAL_SIGN=1` throws `Signing is configured in Plan 9B`, so nothing half-signs. The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so a keychain certificate is never picked up by accident. 9B fills in that branch (hardened runtime, entitlements for V8 JIT, notarize, signtool) and adds secrets to `release.yml` at one marked step.
- **Decision (controller default): `release.yml` runs on `workflow_dispatch`, on `v*` tags, and on pull requests that touch packaging paths.** The pull-request trigger goes beyond the brief, for two reasons. `workflow_dispatch` only runs workflows that already exist on the default branch, so without it this PR could not prove its own workflow. It also catches packaging regressions before a tag. The matrix is `macos-latest` (arm64), `macos-15-intel` (x64) and `windows-latest` (x64). Each arch is built natively: `pnpm deploy` installs only the host's platform packages, and the smoke suite must run the binaries. Artifacts are kept 7 days. On tags, a draft GitHub release attaches the installers.
- **Decision (controller default): the smoke suite tests the installed artifact.** The dmg is mounted read-only, and the NSIS installer runs silently (`/S`, per-user). The suite runs with Playwright: one headless launch (no window; the app writes a ready file) checks that the server answers and that the bundled CLIs run, and one window launch (`_electron.launch`) checks the workspace and the cookie.
- **Decision (controller default): identity.** `productName` is `The Terminal`, `appId` is `org.theterminal.desktop`, and the author is `The Terminal contributors`. The author confirms the app id before 9B: changing it later resets macOS permissions and keychain access.

## Review Focus

1. **The app opened twice.** The user double-clicks the app while it runs. Expected: the second process exits 0 within 10 s without starting a server, the first window is focused, and the first server keeps answering. (Test in Task 6. Lock order pinned in Task 4.)
2. **The CLI already serves the same data folder.** `theterminal start` is running, and the user opens the app. Expected: no second server touches the ledger. The app shows `The Terminal could not start` with the detail `Another The Terminal server is already using this data folder.` In headless mode it prints that line to stderr and exits 1. (Tests in Tasks 1, 2 and 6.)
3. **The server cannot start.** The data folder is unwritable or no port is free. Expected: an error dialog with the server's last stderr lines, then quit. Never a blank window, a hang or a silent exit. A server that never reports ready fails after 60 s. (Tests in Task 3.)
4. **Quit or crash leaves no orphan server.** The user quits, Task Manager kills the app, or Electron crashes. Expected: the server child shuts down gracefully (IPC `shutdown`, or channel loss), releases `server.lock`, and the port stops answering within 15 s. A child that ignores `shutdown` is killed after 10 s. (Tests in Tasks 2, 3 and 6.)
5. **A data folder path with spaces and non-ASCII characters.** Examples: `Application Support`, or a Windows user named `Zoë Smith`. Expected: everything works, because paths only ever travel as array arguments. (The Task 2 and Task 6 tests use a temp folder named `tt smoke ü-…`.)

---

## File Structure

```
packages/core/src/server/data-dir-lock.ts      # acquireDataDirLock, DataDirInUseError (Task 1)
packages/core/src/server/server.ts             # (modify) coreDir option, lock acquire/release (Task 1)
packages/core/src/agents/child-env.ts          # (modify) extract allowlistedEnv; buildChildEnv uses it (Task 1)
packages/core/src/host.ts                      # host-safe entry: allowlistedEnv + IPC message types (Tasks 1, 2)
packages/core/src/index.ts                     # (modify) export DataDirInUseError (Task 1)
packages/core/src/cli.ts                       # (modify) --core-dir, IPC ready/shutdown/disconnect, start errors (Task 2)
packages/core/test/server/data-dir-lock.test.ts
packages/core/test/server/core-dir.test.ts
packages/core/test/cli.test.ts

apps/desktop/package.json                      # @theterminal/desktop, main dist/main.js, scripts (Task 3)
apps/desktop/tsconfig.json
apps/desktop/src/server-env.ts                 # serverEnv, parseLoginPath, loginShellPath, fallbackMacPath (Task 3)
apps/desktop/src/server-process.ts             # startServer, ServerHandle, ServerStartError (Task 3)
apps/desktop/src/args.ts                       # parseDesktopArgs, DesktopArgsError (Task 4)
apps/desktop/src/layout.ts                     # Layout, packagedLayout, devLayout, desktopDataDir, serverArgs (Task 4)
apps/desktop/src/navigation.ts                 # appOrigin, isAppUrl, externalUrl (Task 4)
apps/desktop/src/main.ts                       # Electron wiring (Task 4)
apps/desktop/test/fixtures/fake-server.mjs     # child double for the supervisor tests (Task 3)
apps/desktop/test/*.test.ts
apps/desktop/node-runtime.json                 # pinned Node version + SHA-256 per target (Task 5)
apps/desktop/scripts/stage-lib.mjs             # nodeArchive, verifySha256, PRUNE, assertLayout (Task 5)
apps/desktop/scripts/stage.mjs                 # prune core, fetch+verify+extract Node, copy UI, assert (Task 5)
apps/desktop/electron-builder.mjs              # builderConfig(env) (Task 5)
apps/desktop/smoke/playwright.config.ts        # (Task 6)
apps/desktop/smoke/packaged.spec.ts            # (Task 6)
apps/desktop/smoke/paths.ts                    # resourcesDir(exe, platform) (Task 6)
pnpm-workspace.yaml                            # (modify) allowBuilds entries (Task 3)
.gitignore                                     # (modify) apps/desktop/{stage,release,.cache}/ (Task 5)
.github/workflows/release.yml                  # (Task 7)
README.md, CHANGELOG.md                        # (modify) desktop install notes (Task 7)
```

---

### Task 1: Core host contract: `coreDir`, data-folder lock, host-safe env entry

**Files:**
- Create: `packages/core/src/server/data-dir-lock.ts`, `packages/core/src/host.ts`
- Modify: `packages/core/src/server/server.ts`, `packages/core/src/agents/child-env.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/server/data-dir-lock.test.ts`, `packages/core/test/server/core-dir.test.ts`, `packages/core/test/agents/child-env.test.ts`

**Interfaces:**
- Produces: `createServer({ …, coreDir?: string })`; `class DataDirInUseError extends Error` (message exactly `Another The Terminal server is already using this data folder.`); `acquireDataDirLock(dataDir: string, pid?: number, isAlive?: (pid: number) => boolean): { release(): void }`; `allowlistedEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv`; `dist/host.js` exporting `allowlistedEnv`.

- [ ] **Step 0: Branch.** `git switch -c plan-9a-unsigned-desktop-builds`. Copy this plan to `docs/plans/2026-11-15-plan-9a-unsigned-desktop-builds.md`.

- [ ] **Step 1: Write the failing tests**

`data-dir-lock.test.ts`:
- `acquires server.lock with our pid and releases it`: after acquire, `readFileSync(join(dir,"server.lock"),"utf8") === "111\n"`; after `release()` the file is gone.
- `a lock held by a live process is refused`: lock file `"222\n"`, `isAlive = () => true` → throws `DataDirInUseError` with the exact message.
- `a lock whose process is gone is taken over`: `"222\n"`, `isAlive = () => false` → succeeds, the file holds `"111\n"`.
- `an unreadable or garbage lock counts as stale`: `"not a pid"` → taken over.
- `release leaves a lock that is no longer ours`: overwrite with `"333\n"` and then `release()` → the file still holds `"333\n"`.
- `a second server on the same data folder is refused while the first runs`: `s1 = await createServer({ dataDir, port: 0 })`. Then `createServer({ dataDir, port: 0 })` rejects with `DataDirInUseError`. After `s1.close()`, a new server starts.
- `a failed start releases the lock`: `createServer({ dataDir, port: 70000 })` rejects (bad port), and then `createServer({ dataDir, port: 0 })` resolves.

`core-dir.test.ts`:
- `coreDir decides where bundled programs are found (the hoisted layout the desktop app ships)`. Build in a temp dir: `core/package.json` `{"name":"@theterminal/core"}`, `core/node_modules/@openai/codex/package.json`, and `core/node_modules/@openai/codex-${process.platform}-${process.arch}/{package.json, vendor/<target>/bin/codex[.exe]}`, reusing the triple table from `bundled.ts`. Then `createServer({ dataDir, port: 0, coreDir, which: () => null })`. `GET /api/agents` with `authorization: Bearer <token>` and host `127.0.0.1:<port>` → `providers.codex.available === true`, `providers.claude.available === false`, `providers.gemini.available === false`.

`child-env.test.ts` (add):
- `allowlistedEnv keeps exactly the allowlisted names and LC_* (Windows names only on win32)`: `allowlistedEnv({ PATH:"p", HOME:"h", LC_ALL:"c", NODE_OPTIONS:"x", ELECTRON_RUN_AS_NODE:"1", SystemRoot:"C:\\W" }, "darwin")` → `{ PATH:"p", HOME:"h", LC_ALL:"c" }`. On `"win32"` it also keeps `SystemRoot`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @theterminal/core test -- data-dir-lock core-dir child-env`
Expected: FAIL. The module `data-dir-lock` is not found, `coreDir` is ignored (codex available false), and `allowlistedEnv` is not exported.

- [ ] **Step 3: Implement**
- `data-dir-lock.ts`: `writeFileSync(file, \`${pid}\n\`, { flag: "wx", mode: 0o600 })`. On `EEXIST`, parse the pid. If it parses and `isAlive(pid)`, throw `DataDirInUseError`. Otherwise `rmSync` and retry once. The default `isAlive` is `process.kill(pid, 0)`: `ESRCH` means dead and `EPERM` means alive. `release()` removes the file only if it still holds our pid.
- `server.ts`: acquire right after `assertDataDirOutsideUiDir`, before `openDatabase`. Release in `close()` after `db.close()`, and on every start-failure path: wrap everything after acquisition in one `try`. `coreDir` builds the lookups as `{ claude: () => bundledClaude({ coreDir }), codex: () => bundledCodex({ coreDir }), gemini: () => bundledGemini({ coreDir }) }` when given, and the memoized defaults otherwise.
- `child-env.ts`: move the copy loop of `buildChildEnv` into `allowlistedEnv`. `buildChildEnv` calls it, with no behaviour change.
- `host.ts`: `export { allowlistedEnv } from "./agents/child-env.js";`. This entry must not import `db.ts`, `secrets/*`, `server/*` or any native module.
- `index.ts`: export `DataDirInUseError`.

- [ ] **Step 4: Run the full core suite**

Run: `pnpm --filter @theterminal/core test`
Expected: PASS, including the existing `buildChildEnv` and server tests. If an existing test starts two servers on one data folder at once, give the second its own folder. That test was relying on unsafe behaviour.

- [ ] **Step 5: Commit**

```bash
git add docs/plans packages/core
git commit -m "feat(core): coreDir option, data folder lock and host-safe env entry"
```

---

### Task 2: The CLI as a supervised child: `--core-dir` and the IPC protocol

**Files:**
- Modify: `packages/core/src/cli.ts`, `packages/core/src/host.ts`
- Test: `packages/core/test/cli.test.ts`

**Interfaces:**
- Consumes: `createServer({ coreDir })`, `DataDirInUseError` (Task 1).
- Produces (types exported from `host.ts`): `type ReadyMessage = { type: "ready"; url: string; loopbackUrl: string; port: number }` and `type HostMessage = { type: "shutdown" }`. CLI flag `--core-dir <absolute path>`. Exit codes: 0 after a clean shutdown, 1 on a usage or start error. Start errors print one line to stderr: `The Terminal could not start: <message>`.

- [ ] **Step 1: Write the failing tests.** Spawn `process.execPath` with `[<core>/dist/cli.js, "start", "--data-dir", dir, "--port", "0"]`, `stdio: ["ignore","pipe","pipe","ipc"]`, in a temp dir named `tt smoke ü-…`.
- `under an IPC channel it sends ready and prints no token`: the first message matches `{ type: "ready" }`. `url` matches `/^http:\/\/theterminal\.localhost:\d+\/\?token=[0-9a-f]{64}$/` and `loopbackUrl === \`http://127.0.0.1:${port}/\``. stdout contains `The Terminal is running at http://127.0.0.1:` and does not contain the token.
- `a shutdown message closes the server and exits 0`: `child.send({ type: "shutdown" })` → exit code 0 within 15 s, and `server.lock` is gone.
- `losing the host channel shuts down too`: `child.disconnect()` → exit code 0 within 15 s, and `server.lock` is gone.
- `--core-dir must be absolute`: `--core-dir relative/dir` → exit 1, stderr contains `Invalid --core-dir: must be an absolute path`.
- `a data folder in use exits 1 with the fixed message`: an in-process `createServer` holds `dir`, and the spawned CLI exits 1 with stderr containing `The Terminal could not start: Another The Terminal server is already using this data folder.`

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @theterminal/core test -- cli.test`
Expected: FAIL. No ready message arrives (timeout), and `--core-dir` is rejected as an unknown option.

- [ ] **Step 3: Implement in `cli.ts`.**
- Add the `core-dir` option and validate it with `isAbsolute`.
- Wrap `createServer` in `try/catch`. On error, print the fixed line using `err.message` and `process.exit(1)`.
- When `process.send` exists, print the loopback URL (not `url`), then `process.send(readyMessage)`. Handle `message` events of `{ type: "shutdown" }` and the `disconnect` event with the existing `shutdown`, made idempotent with a guard.
- Without IPC, behaviour is unchanged.

- [ ] **Step 4: Run the core suite.** `pnpm --filter @theterminal/core test` → PASS.

- [ ] **Step 5: Commit** `feat(core): IPC ready/shutdown protocol and --core-dir for host processes`

---

### Task 3: Desktop package and server supervisor

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/src/server-env.ts`, `apps/desktop/src/server-process.ts`, `apps/desktop/test/fixtures/fake-server.mjs`
- Test: `apps/desktop/test/server-env.test.ts`, `apps/desktop/test/server-process.test.ts`

**Interfaces:**
- Consumes: `allowlistedEnv` (Task 1, via `@theterminal/core/dist/host.js`); `ReadyMessage`, `HostMessage` (Task 2).
- Produces:
  - `serverEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, allowlisted: (b: NodeJS.ProcessEnv, p: NodeJS.Platform) => NodeJS.ProcessEnv, loginPath: string | null): NodeJS.ProcessEnv`
  - `parseLoginPath(stdout: string): string | null`
  - `loginShellPath(shell: string | undefined, run: (file: string, args: string[], opts: { timeout: number }) => Promise<string>): Promise<string | null>`
  - `fallbackMacPath(path: string | undefined): string`
  - `startServer(o: { nodeFile: string; cliFile: string; args: string[]; env: NodeJS.ProcessEnv; logFile?: string; readyTimeoutMs?: number /* 60000 */; stopTimeoutMs?: number /* 10000 */ }): ServerHandle`
  - `type ServerHandle = { ready: Promise<ReadyMessage>; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; stop(): Promise<void>; pid: number | undefined }`
  - `class ServerStartError extends Error { exitCode: number | null; detail: string }` (`detail` is the last 4000 characters of stderr, or `timed out waiting for the server`).

- [ ] **Step 1: Scaffold the package.** `package.json`: `"name": "@theterminal/desktop"`, `"private": true`, `"version": "0.0.0"`, `"type": "module"`, `"main": "dist/main.js"`, `"description": "The Terminal desktop app"`, `"author": "The Terminal contributors"`, `"license": "Apache-2.0"`. `devDependencies`: `"electron": "44.10.1"`, `"electron-builder": "26.18.1"`, `"@theterminal/core": "workspace:*"` (types and tests only, never packaged). Scripts: `build` = `tsc -p tsconfig.json`, `test` = `tsc -p tsconfig.json && vitest run`, `dev` = `tsc -p tsconfig.json && electron .`, and `deploy:core` / `stage` / `dist` (added in Task 5). Write `tsconfig.json` like core's (`outDir: dist`, `rootDir: src`, `types: ["node"]`). In `pnpm-workspace.yaml`, add `electron-winstaller: false` under `allowBuilds`, with the comment `# Squirrel.Windows target of electron-builder (via its auto-installed peer); unused (NSIS only). Its script only picks a 7-Zip binary.` Run `pnpm install`, which updates the lockfile. For any other package that pnpm reports with an ignored build script, add `false` with a one-line reason. Never add `true`. `electron` 44.10.1 has no install script.

- [ ] **Step 2: Write the failing tests**

`server-env.test.ts`:
- `serverEnv keeps only allowlisted variables`: the input holds `PATH, HOME, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, THETERMINAL_FAKE_AGENT, ANTHROPIC_API_KEY`. Using core's real `allowlistedEnv`, the result has only `PATH` and `HOME`.
- `on darwin the login PATH replaces PATH; elsewhere it is ignored`.
- `parseLoginPath`: `"motd\n__TT_PATH__/opt/homebrew/bin:/usr/bin__TT_PATH__\n"` → `"/opt/homebrew/bin:/usr/bin"`. With no markers or an empty value → `null`.
- `loginShellPath runs the shell with -ilc and a 5 s timeout`: the injected `run` sees `("/bin/zsh", ["-ilc", 'printf "__TT_PATH__%s__TT_PATH__" "$PATH"'], { timeout: 5000 })`. A relative shell, or one whose basename is not in `zsh|bash|sh|fish`, uses `/bin/zsh`. If `run` rejects → `null`.
- `fallbackMacPath("/usr/bin:/bin")` → `"/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"`, with no duplicates when they are already present.

`server-process.test.ts` uses `nodeFile = process.execPath` and `cliFile = fixtures/fake-server.mjs`, whose mode comes from `argv[2]`. The modes are `ready`, `fail` (stderr `boom`, exit 3), `hang`, and `ignore-shutdown`. In `ready` mode the fixture exits 0 on `{type:"shutdown"}` and on `disconnect`.
- `resolves ready with the child's ready message`.
- `rejects with ServerStartError carrying the exit code and stderr tail when the child exits first`: `exitCode === 3`, and `detail` contains `boom`.
- `rejects after readyTimeoutMs and kills the child`: `hang` with `readyTimeoutMs: 500`. Then `detail === "timed out waiting for the server"` and `exited` resolves.
- `stop() sends shutdown and resolves after a clean exit`: `exited` resolves with `code 0`.
- `stop() kills a child that ignores shutdown after stopTimeoutMs`: `ignore-shutdown` with `stopTimeoutMs: 300` → `exited` resolves with `code !== 0`.
- `writes child output to the log file, truncated at start`: a pre-existing log content is gone, and the fixture's stdout line is present.

- [ ] **Step 3: Run to verify failure.** `pnpm --filter @theterminal/desktop test` → FAIL (modules missing).

- [ ] **Step 4: Implement.** In `startServer`, call `spawn(nodeFile, [cliFile, ...args], { env, stdio: ["ignore","pipe","pipe","ipc"], windowsHide: true, shell: false })`. Open the log with flag `"w"`, and keep a rolling 4000-character stderr tail. `ready` settles once, on the first `{type:"ready"}` message, on exit, or on timeout. `stop()` sends `{type:"shutdown"}` if connected, waits up to `stopTimeoutMs` for `exited`, then calls `child.kill()`.

- [ ] **Step 5: Run.** `pnpm --filter @theterminal/desktop test` → PASS.

- [ ] **Step 6: Commit** `feat(desktop): package scaffold, allowlisted server env and server supervisor`

---

### Task 4: Electron shell: layout, arguments, window and lifecycle

**Files:**
- Create: `apps/desktop/src/args.ts`, `apps/desktop/src/layout.ts`, `apps/desktop/src/navigation.ts`, `apps/desktop/src/main.ts`
- Test: `apps/desktop/test/args.test.ts`, `apps/desktop/test/layout.test.ts`, `apps/desktop/test/navigation.test.ts`

**Interfaces:**
- Consumes: `startServer`, `ServerStartError`, `serverEnv`, `loginShellPath`, `fallbackMacPath` (Task 3); `allowlistedEnv` (Task 1), loaded at run time from `pathToFileURL(join(layout.coreDir, "dist", "host.js"))`.
- Produces:
  - `parseDesktopArgs(argv: string[]): DesktopArgs`, where `type DesktopArgs = { dataDir?: string; port?: number; headless: boolean; readyFile?: string }`, and `class DesktopArgsError extends Error`
  - `type Layout = { nodeFile: string; cliFile: string; coreDir: string; uiDir: string }`
  - `packagedLayout(resourcesPath: string, platform: NodeJS.Platform): Layout`
  - `devLayout(appPath: string): Layout`
  - `desktopDataDir(appData: string, override?: string): string`
  - `profileDir(dataDir: string): string` (`<dataDir>/desktop`) and `serverLogFile(dataDir: string): string` (`<dataDir>/desktop/server.log`)
  - `serverArgs(layout: Layout, dataDir: string, port?: number): string[]`
  - `appOrigin(port: number): string`, `isAppUrl(url: string, port: number): boolean`, `externalUrl(url: string): string | null`
  - App flags used by Task 6: `--data-dir <abs>`, `--port <n>`, `--headless`, `--ready-file <abs>`. In headless mode, the ready file holds `{"loopbackUrl": "...", "port": n}` and never the token.

- [ ] **Step 1: Write the failing tests**
- args: `parseDesktopArgs(["--data-dir", abs, "--port", "0", "--headless", "--ready-file", absR, "--remote-debugging-port=0", "--inspect=0"])` → `{ dataDir: abs, port: 0, headless: true, readyFile: absR }`, ignoring unknown switches that Chromium or Playwright add. A relative `--data-dir` throws `DesktopArgsError("--data-dir must be an absolute path")`, and so does a relative `--ready-file`. `--port abc` and `--port 70000` throw `DesktopArgsError("--port must be an integer from 0 to 65535")`.
- layout: `packagedLayout(R, "darwin")` → `{ nodeFile: join(R,"node","node"), cliFile: join(R,"core","dist","cli.js"), coreDir: join(R,"core"), uiDir: join(R,"ui") }`. On `"win32"`, `nodeFile` is `join(R,"node","node.exe")`. `devLayout(join(root,"apps","desktop"))` → `coreDir` is `join(root,"packages","core")`, `uiDir` is `join(root,"apps","ui","dist")`, and `nodeFile` is `"node"` (a PATH lookup by `spawn`; dev needs Node ≥ 22 on PATH, as the repo already requires). `desktopDataDir(a)` → `join(a,"TheTerminal")`, and with an override → the override. `it.runIf(process.platform === "darwin")`: `desktopDataDir("/Users/a/Library/Application Support")` equals `defaultDataDir("darwin", { HOME: "/Users/a" })`. `serverArgs(L, d, 0)` → `["start","--data-dir",d,"--ui-dir",L.uiDir,"--core-dir",L.coreDir,"--port","0"]`, with no `--port` pair when `port` is undefined.
- navigation: `isAppUrl("http://theterminal.localhost:4317/x", 4317)` → true. False for `:4318`, `http://127.0.0.1:4317/`, `http://theterminal.localhost.evil.test:4317/`, `https://theterminal.localhost:4317/` and an unparsable string. `externalUrl("https://example.com/a")` returns the URL, and `externalUrl("http://example.com")` returns its normalized form. `file:///etc/hosts`, `javascript:alert(1)` and `mailto:a@b.c` → `null`.

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @theterminal/desktop test` → FAIL.

- [ ] **Step 3: Implement `args.ts`, `layout.ts` and `navigation.ts`.** `parseDesktopArgs` uses `parseArgs({ strict: false, allowPositionals: true })` and reads only the four known options.

- [ ] **Step 4: Implement `main.ts` in this order.** Each item is one behaviour. There is no unit test for this file; Task 6 tests it.
  1. Parse `process.argv.slice(app.isPackaged ? 1 : 2)`. On `DesktopArgsError`, print it to stderr and `app.exit(2)`.
  2. Compute `dataDir = desktopDataDir(app.getPath("appData"), args.dataDir)`. Call `mkdirSync(profileDir(dataDir), { recursive: true })`, then `app.setPath("userData", profileDir(dataDir))`. Only then call `app.requestSingleInstanceLock()`; when it is not granted, `app.exit(0)`. On `second-instance`, restore and focus the window.
  3. Pick the layout: `app.isPackaged ? packagedLayout(process.resourcesPath, process.platform) : devLayout(app.getAppPath())`.
  4. After `app.whenReady()`, build the server env. Import `allowlistedEnv` from the layout's `host.js`. The login PATH comes from `loginShellPath` with `execFile` (macOS only), falling back to `fallbackMacPath`. Then `startServer({ nodeFile, cliFile, args: serverArgs(layout, dataDir, args.port), env, logFile: serverLogFile(dataDir) })`.
  5. On a `ServerStartError` in headless mode, print `The Terminal could not start: <detail>` to stderr and `app.exit(1)`. With a window, call `dialog.showErrorBox("The Terminal could not start", detail)`, then `app.exit(1)`.
  6. Headless (`args.headless`): on macOS `app.dock?.hide()`. Write the ready file if given, and open no window.
  7. Otherwise, create the window. Use `BrowserWindow({ show: false, width: 1400, height: 900, title: "The Terminal", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } })`. Set `session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false))`. `webContents.setWindowOpenHandler` opens `externalUrl` results with `shell.openExternal` and always returns `{ action: "deny" }`. On `will-navigate`, call `preventDefault()` unless `isAppUrl(url, port)`; if `externalUrl(url)` is non-null, open it externally. Then `loadURL(ready.url)` and show on `ready-to-show`.
  8. The application menu is Electron's default plus **Open in Browser**, which calls `shell.openExternal(ready.url)`.
  9. On `window-all-closed`, quit on Windows and keep running on macOS. On `activate`, recreate the window.
  10. On `before-quit`, call `preventDefault()` once, `await server.stop()`, then `app.exit(0)`.
  11. If the server exits while the app is not quitting, show `dialog.showMessageBox` with the message `The Terminal's server stopped unexpectedly.` and the buttons `Restart` / `Quit`. `Restart` → `app.relaunch(); app.exit(0)`.

- [ ] **Step 5: Run the tests and a dev launch.** `pnpm --filter @theterminal/desktop test` → PASS. `pnpm build && pnpm --filter @theterminal/desktop dev` → a window shows the workspace (the activity bar with seven views), and quitting leaves no `node` process running `cli.js`.

- [ ] **Step 6: Commit** `feat(desktop): Electron shell with locked-down window, single instance and server lifecycle`

---

### Task 5: Staging and packaging configuration

**Files:**
- Create: `apps/desktop/node-runtime.json`, `apps/desktop/scripts/stage-lib.mjs`, `apps/desktop/scripts/stage.mjs`, `apps/desktop/electron-builder.mjs`
- Modify: `apps/desktop/package.json` (scripts), `.gitignore`
- Test: `apps/desktop/test/stage-lib.test.ts`, `apps/desktop/test/builder-config.test.ts`

**Interfaces:**
- Consumes: `packagedLayout` paths (Task 4). The staged tree must match them exactly: `stage/core`, `stage/node/node[.exe]`, `stage/ui`.
- Produces:
  - `nodeArchive(manifest, platform, arch): { url: string; file: string; sha256: string; member: string }`
  - `verifySha256(file: string, expected: string): void`
  - `PRUNE: readonly string[]`
  - `assertLayout(stageDir: string, platform: NodeJS.Platform, arch: string): string[]` (missing or forbidden entries; empty when good)
  - `builderConfig(env: NodeJS.ProcessEnv): import("electron-builder").Configuration`
  - Output: `apps/desktop/release/TheTerminal-<version>-<mac|win>-<arch>.<dmg|exe>`

- [ ] **Step 1: Pin the runtime.** `node-runtime.json`:

```json
{
  "version": "24.22.2",
  "targets": {
    "darwin-arm64": { "file": "node-v24.22.2-darwin-arm64.tar.gz", "sha256": "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a", "member": "node-v24.22.2-darwin-arm64/bin/node" },
    "darwin-x64":   { "file": "node-v24.22.2-darwin-x64.tar.gz",   "sha256": "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52", "member": "node-v24.22.2-darwin-x64/bin/node" },
    "win32-x64":    { "file": "node-v24.22.2-win-x64.zip",         "sha256": "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2", "member": "node-v24.22.2-win-x64/node.exe" }
  }
}
```

These hashes come from `https://nodejs.org/dist/v24.22.2/SHASUMS256.txt`. Re-check them against that file before committing.

- [ ] **Step 2: Write the failing tests**
- `nodeArchive(m, "darwin", "arm64")` → `url === "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz"`, with the pinned `sha256` and `member`. `("linux","x64")` throws `No pinned Node runtime for linux-x64`.
- `verifySha256` passes on a temp file whose hash matches, and throws `Checksum mismatch for <basename>` otherwise.
- `PRUNE` equals `["src","test","tsconfig.json","pnpm-lock.yaml","pnpm-workspace.yaml","node_modules/.pnpm","node_modules/.bin","node_modules/.modules.yaml","node_modules/.pnpm-workspace-state-v1.json"]`.
- `assertLayout` on a complete fixture tree → `[]`. The required entries are: `core/package.json` named `@theterminal/core`, `core/dist/cli.js`, `core/dist/host.js`, `core/node_modules/better-sqlite3/prebuilds/<p>-<a>.node`, a `core/node_modules/@napi-rs/keyring-<p>-<a>*` directory, `core/node_modules/@openai/codex-<p>-<a>`, `core/node_modules/@anthropic-ai/claude-agent-sdk-<p>-<a>`, `core/node_modules/@google/gemini-cli/package.json`, `node/node[.exe]` and `ui/index.html`. A tree without the codex platform package → `["core/node_modules/@openai/codex-darwin-arm64"]`. A tree that still has `core/node_modules/.pnpm` → `["forbidden: core/node_modules/.pnpm"]`.
- `builderConfig({})`:
  - `productName === "The Terminal"`, `appId === "org.theterminal.desktop"`, `asar === true` and `npmRebuild === false`. `files` is `["dist/**/*","package.json"]`. `extraResources` maps `stage/core→core`, `stage/node→node` and `stage/ui→ui`. `publish === null`.
  - `mac.identity === "-"`, `mac.hardenedRuntime === false`, and `mac.target` is dmg. `win.target` is nsis x64, with `nsis.oneClick === true` and `nsis.perMachine === false`.
  - `artifactName === "TheTerminal-${version}-${os}-${arch}.${ext}"`.
- `builderConfig({ THETERMINAL_VERSION: "1.2.3" }).extraMetadata.version === "1.2.3"`. `"1.2"` throws `Invalid THETERMINAL_VERSION`. `{ THETERMINAL_SIGN: "1" }` throws `Signing is configured in Plan 9B`.

- [ ] **Step 3: Run to verify failure.** `pnpm --filter @theterminal/desktop test` → FAIL.

- [ ] **Step 4: Implement.**
  - `stage.mjs`:
    1. Refuse `--arch` ≠ `process.arch`, with the message `Build on a <arch> runner: platform packages are installed for the host only`.
    2. Remove the `PRUNE` entries from `stage/core`.
    3. Download the archive with `fetch` into `apps/desktop/.cache/`, unless it is already there, and verify its SHA-256 before extracting.
    4. Extract only `member` and the archive's `LICENSE` with `execFile("tar", ["-xf", archive, "-C", tmp, member, "<root>/LICENSE"])`. bsdtar on macOS and `tar.exe` on Windows both read zip.
    5. Move them to `stage/node/`, and `chmod 0o755` on POSIX.
    6. `cpSync` `apps/ui/dist` → `stage/ui`.
    7. Fail if `assertLayout` returns anything.
  - Scripts:
    - `deploy:core` = `pnpm --filter @theterminal/core deploy --prod --node-linker hoisted --frozen-lockfile apps/desktop/stage/core`, run from the workspace root via `pnpm -w`. Confirm in Step 5 where pnpm resolves the target directory, and adjust the path so it lands in `apps/desktop/stage/core`.
    - `stage` = `node scripts/stage.mjs`.
    - `dist` = `pnpm run deploy:core && pnpm run stage && electron-builder --config electron-builder.mjs --publish never`.
  - `electron-builder.mjs`: `export default builderConfig(process.env)`. `electronVersion` is read from the installed `electron/package.json`. Put the 9B branch behind `env.THETERMINAL_SIGN === "1"` (throws in 9A).
  - `.gitignore`: add `apps/desktop/stage/`, `apps/desktop/release/` and `apps/desktop/.cache/`.

- [ ] **Step 5: Run the tests and a local package.** `pnpm --filter @theterminal/desktop test` → PASS. Then `pnpm build && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @theterminal/desktop dist` on an Apple Silicon Mac. It produces `apps/desktop/release/TheTerminal-0.0.0-mac-arm64.dmg`, and `apps/desktop/release/mac-arm64/The Terminal.app` opens the workspace. `codesign -dv "…/The Terminal.app"` reports `Signature=adhoc`.

- [ ] **Step 6: Commit** `build(desktop): stage core with a pinned Node runtime and package with electron-builder`

---

### Task 6: Smoke suite against the packaged app

**Files:**
- Create: `apps/desktop/smoke/playwright.config.ts`, `apps/desktop/smoke/packaged.spec.ts`, `apps/desktop/smoke/paths.ts`
- Test: the suite itself, run against the Task 5 output.

**Interfaces:**
- Consumes: the app flags and ready file from Task 4; `bundledCodex`, `bundledClaude` and `bundledGemini({ coreDir })`, imported from `<resources>/core/dist/agents/bundled.js` by file URL; `server.lock` (Task 1).
- Produces: `resourcesDir(exe: string, platform: NodeJS.Platform): string`. On darwin it is `<exe>/../../Resources`; on win32 it is `<dirname(exe)>/resources`. Env `TT_DESKTOP_APP` is the executable under test.

- [ ] **Step 1: Write the suite.** `playwright.config.ts`: `testDir: "."`, `workers: 1`, `timeout: 120_000`. Every test uses a fresh `mkdtempSync(join(tmpdir(), "tt smoke ü-"))` and removes it afterwards with `maxRetries: 5`.
- `headless: the server answers, serves the UI and the bundled CLIs run`:
  1. `spawn(TT_DESKTOP_APP, ["--headless","--data-dir",d,"--port","0","--ready-file",r])` and poll `r` for up to 60 s. Read the token from `join(d,"token")`; never log it.
  2. `GET /api/health` with Bearer → 200 `{ ok: true }`. `GET /` → 200 HTML containing `<div id="root">`. `GET /api/agents` → 200.
  3. Run each bundled program with `execFile` and `--version` (exit 0, non-empty stdout): codex as `{file,args}` from `bundledCodex({ coreDir })`; claude from `bundledClaude({ coreDir })`; gemini as `join(resources,"node",<node[.exe]>)` with `[entry, "--version"]`, the entry taken from `bundledGemini({ coreDir })!.args[0]`. Pass `env` = `{ PATH, HOME/USERPROFILE, SystemRoot, GEMINI_CLI_NO_RELAUNCH: "1" }` (only those present).
- `a second launch with the same data folder exits and leaves the first serving`: start A as above. Start B with the same `d` and its own ready file → B exits with code 0 within 10 s and writes no ready file. A's `/api/health` is still 200.
- `the app refuses a data folder held by a running CLI server`: start `process.execPath packages/core/dist/cli.js start --data-dir d --port 0` and wait for its stdout line. The app headless on `d` → exit code 1, and stderr contains `Another The Terminal server is already using this data folder.` Stop the CLI.
- `killing the app stops its server`: start A, then `appProcess.kill()`. Within 15 s, `GET /api/health` fails with a connection error and `join(d,"server.lock")` does not exist.
- `window: opens the workspace on theterminal.localhost with the session cookie`:
  1. `const app = await _electron.launch({ executablePath: TT_DESKTOP_APP, args: ["--data-dir", d, "--port", "0"] })` and `page = await app.firstWindow()`.
  2. `await expect(page).toHaveURL(/^http:\/\/theterminal\.localhost:\d+\/$/)`. `page.getByRole("navigation", { name: "Views" }).getByRole("button")` has count 7.
  3. `app.context().cookies()` contains `{ name: "tt_token", domain: "theterminal.localhost", httpOnly: true, sameSite: "Strict" }`, and `await page.evaluate(() => document.cookie)` does not contain `tt_token`.
  4. `await app.close()`, then the port stops answering within 15 s.

- [ ] **Step 2: Run against the local build.** `TT_DESKTOP_APP="apps/desktop/release/mac-arm64/The Terminal.app/Contents/MacOS/The Terminal" pnpm exec playwright test -c apps/desktop/smoke/playwright.config.ts` → five passed. To prove the suite can fail, temporarily delete `stage/node`, rebuild, and confirm the headless test fails. Then restore it.

- [ ] **Step 3: Commit** `test(desktop): smoke suite for the packaged app`

---

### Task 7: Release workflow and install notes

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md` (new section "Desktop app (unsigned test builds)" after "Run it from source"), `CHANGELOG.md` (Unreleased → Added)

**Interfaces:**
- Consumes: `pnpm --filter @theterminal/desktop dist` and `THETERMINAL_VERSION` (Task 5); `TT_DESKTOP_APP` and the smoke config (Task 6).
- Produces: workflow `Release builds`, whose artifacts are named `TheTerminal-<os>-<arch>`.

- [ ] **Step 1: Write `release.yml`.** Use the same checkout, pnpm and setup-node SHAs as `ci.yml`.

```yaml
name: Release builds
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
  pull_request:
    paths:
      - "apps/desktop/**"
      - ".github/workflows/release.yml"
      - "pnpm-lock.yaml"
      - "pnpm-workspace.yaml"
      - "packages/core/package.json"
      - "packages/core/src/cli.ts"
      - "packages/core/src/host.ts"
      - "packages/core/src/agents/bundled.ts"
permissions:
  contents: read
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-latest, name: mac-arm64 }
          - { os: macos-15-intel, name: mac-x64 }
          - { os: windows-latest, name: win-x64 }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 60
    env:
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
      # Plan 9B: signing secrets are added here, and THETERMINAL_SIGN=1 switches builderConfig to signing.
    steps:
      # checkout, pnpm/action-setup, setup-node 22 (cache pnpm): same SHAs as ci.yml
      - run: pnpm install --frozen-lockfile
      - name: Version
        shell: bash
        run: |
          if [[ "$GITHUB_REF" == refs/tags/v* ]]; then v="${GITHUB_REF_NAME#v}"; else v="0.0.0-dev.${GITHUB_RUN_NUMBER}"; fi
          echo "THETERMINAL_VERSION=$v" >> "$GITHUB_ENV"
      - run: pnpm build
      - run: pnpm --filter @theterminal/desktop dist
      - name: Install from the dmg (macOS)
        if: runner.os == 'macOS'
        shell: bash
        run: |
          mnt="$(mktemp -d)"
          hdiutil attach apps/desktop/release/*.dmg -nobrowse -readonly -mountpoint "$mnt"
          echo "TT_DESKTOP_APP=$mnt/The Terminal.app/Contents/MacOS/The Terminal" >> "$GITHUB_ENV"
      - name: Install from the installer (Windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $installer = Get-ChildItem apps/desktop/release -Filter *.exe | Select-Object -First 1
          Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
          $app = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Depth 2 -Filter 'The Terminal.exe' | Select-Object -First 1
          "TT_DESKTOP_APP=$($app.FullName)" >> $env:GITHUB_ENV
      - run: pnpm exec playwright test -c apps/desktop/smoke/playwright.config.ts
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: TheTerminal-${{ matrix.name }}
          path: |
            apps/desktop/release/*.dmg
            apps/desktop/release/*.exe
          if-no-files-found: error
          retention-days: 7
  draft-release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { path: dist, merge-multiple: true }
      - env: { GH_TOKEN: "${{ github.token }}" }
        run: gh release create "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft --title "$GITHUB_REF_NAME (unsigned)" --notes "Unsigned test builds. See README, Desktop app." dist/*
```

- [ ] **Step 2: Write the docs.**
  - README section, in plain language:
    - Downloads come from the workflow run's artifacts or a draft release.
    - macOS: open the dmg and drag the app to Applications. On first open, macOS says it cannot verify the app. Use System Settings → Privacy & Security → **Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/The Terminal.app"`.
    - Windows: SmartScreen → **More info** → **Run anyway**. The installer is per-user, with no admin rights needed.
    - Data lives in the same folder as `theterminal start`, and only one of the two can run at a time.
    - The builds are unsigned until Plan 9B, and macOS may ask for keychain access again after each new build.
  - CHANGELOG: `- Desktop app (unsigned test builds): a macOS dmg (Apple Silicon and Intel) and a Windows installer, built by the "Release builds" workflow. Opening the app starts the local server and shows the workspace in its own window.`

- [ ] **Step 3: Verify in CI.** Push the branch and open the PR. `CI` must be green on macOS and Windows, which includes the desktop unit tests. `Release builds` must be green on `mac-arm64`, `mac-x64` and `win-x64`, with all five smoke tests passing on each, and three artifacts uploaded. Check that the workflow logs contain no token: search the log for `token=` and for 64-character hex strings.

- [ ] **Step 4: Manual acceptance (author).**
  - Download the arm64 dmg on the Mac and the exe on the Windows desktop, and install each one, accepting the warnings.
  - The app opens the workspace. Create a project.
  - Quit the app, then confirm no `node` process remains.
  - Reopen it, and the project is still there. Run `theterminal start` while the app is open and confirm it refuses with the in-use message.
  - Start a Codex run in api_key mode with a test key, and confirm the bundled CLI is used (no PATH install present).

- [ ] **Step 5: Commit** `ci: release workflow for unsigned macOS and Windows builds`. Then merge through the PR once it is green.

---

## Done when

- `pnpm test` and `pnpm e2e` pass on macOS and Windows. `Release builds` is green on all three runners, and each run uploads an installer that passed the smoke suite after installation.
- The author has installed and opened the app on the Mac and on the Windows desktop.
- `pnpm install` reports no build script outside `allowBuilds`, and every new pin is exact.
- No token, personal path or name appears in the code, the docs or the workflow logs.

---

## Controller ruling (added before execution)

**Claude Code is not bundled in 9A artifacts.** Workflow artifacts on a public repository can be downloaded by any signed-in GitHub user, which counts as redistribution, and the spec requires Anthropic's written confirmation before the Claude Agent SDK's native binary is redistributed. Until then, staging excludes the `@anthropic-ai/claude-agent-sdk-*` platform packages; Claude in the desktop app uses the Owner's own installed Claude Code (the existing PATH fallback). A single switch in `electron-builder.mjs` (`BUNDLE_CLAUDE`, default `false`) restores it. Codex and Gemini CLI (Apache-2.0) stay bundled. The README states this.
