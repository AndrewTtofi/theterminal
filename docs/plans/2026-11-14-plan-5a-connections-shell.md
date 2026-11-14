# Plan 5A: Connections, Keychain and the Workspace Shell Implementation Plan

**Goal:** The Owner connects the tools they already pay for (Claude, OpenAI/Codex, Gemini API keys; a GitHub token) in one place, with every credential held in the operating system's keychain and never in a file, the ledger or an API response. Runs receive exactly the credential the Owner configured, through an environment allowlist, and every such use is recorded. The workspace gets a VS Code-style shell: activity bar, side bar, tabbed main area with the lifecycle board as home, a bottom panel for the agent feed and ledger, and a status bar. Plan 2B's carry-overs that touch secrets, the child environment and usage accounting are closed here.

**Architecture:**
- A `SecretStore` interface with two implementations: `KeychainSecretStore` (macOS Keychain, Windows Credential Manager, Linux Secret Service via `@napi-rs/keyring`) and `MemorySecretStore` (tests and e2e only). Values longer than a Windows credential blob are chunked by a wrapper, so a GCP service-account JSON fits later.
- A `ConnectionService` owns the connections projection. Non-secret fields (`config`) go to the ledger as `connection.*` events. Secret fields and "private" fields (local paths such as a custom CLI home, which would leak a username into the ledger) go to the keychain only; the ledger records field **names**. The service keeps an in-memory cache of secret values loaded at startup so (a) runs resolve credentials synchronously and (b) redaction sees every stored secret live. Removed secrets stay in the redaction set until restart.
- `AgentRunner.extraSecrets` becomes a getter. `buildChildEnv` becomes an allowlist. The runner resolves credentials for a run (`apiKey`, `cliHome`, `googleCloudProject`) from the connection cache, records `connection.used`, and passes them to the adapter in `AdapterStartOptions.credentials`.
- The UI keeps React + Vite and adds `dockview-react` for the centre (tab groups, bottom panel, drag, split, layout serialisation). The activity bar, side bar and status bar are plain React, as in VS Code itself (its side bar is not a dockable editor group). The "Needs you" strip renders above the dock in every layout, so decisions can't be hidden (spec §4.3).
- Test-only switches follow Plan 2B's pattern: honoured only when `THETERMINAL_FAKE_AGENT=1`.

**Tech Stack:** existing stack, plus `@napi-rs/keyring` 2.1.2 (MIT, updated Oct 2026; napi-rs prebuilt binaries as per-platform optional dependencies for darwin-arm64/x64, win32-x64/arm64/ia32 and linux; no node-gyp; wraps `keyring-rs`. `keytar` is rejected: the Atom repo is archived and it needs node-gyp prebuilds. Note for Linux later: the Linux binaries statically link libdbus, `AFL-2.1 OR GPL-2.0-or-later`; irrelevant for macOS/Windows), and `dockview-react` 8.9.0 (MIT, updated Nov 2026, peer React 18 ok; depends on `dockview`/`dockview-core`, zero further deps). No HTTP client library: connection tests use the global `fetch` (Node 22), injectable for tests.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §4.3 (main screen and panels), §6 (capacity, groundwork only here), §7 core item 5 (connections), §8 (credentials stay with the Owner), §10.3 (provider terms, estimates labelled). Builds on Plans 1, 2 and 2B. Carry-overs from Plan 2B's final review are tasks or constraints below (Task 0A and Task 0B). Out of scope (Plan 5B): cloud accounts, the GitHub view and CI badge, MCP through the gate, the capacity view and hardware detection.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Tests use values such as `sk-ant-TESTKEY-0000000000` and temp dirs.
- **Credentials live only in the OS keychain.** Never in SQLite, the ledger, JSON files, logs, or any API response (not even masked fragments). The API returns secret field **names**, never values. Provider logins (Claude Code, Codex, Gemini CLI) are never read, copied or proxied; only API keys and tokens the Owner pastes into The Terminal are stored.
- **Ledger payloads for connections carry no secret values and no absolute paths.** A `config` value that `redact()` would change is rejected (`secret_in_config`), and config keys that look like credential names are rejected by schema.
- **Child environments are allowlisted.** A provider CLI sees only the variables listed in Task 1 plus what its adapter sets; no other provider's key, no inherited `AWS_*`, `NPM_TOKEN`, `GITHUB_TOKEN`, etc.
- **Redaction is live.** Any secret stored through the connection API is redacted from agent traffic immediately, with no restart; a removed secret stays redacted until the process exits.
- **Fail closed.** Keychain unavailable → the write fails with 503, nothing is written anywhere else; the server still starts and lists connections. A shared git config that is no longer empty → the run fails before the CLI starts.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`:** `THETERMINAL_SECRET_STORE=memory` and `THETERMINAL_FAKE_HTTP=1` are ignored otherwise.
- **Decisions and gates surface in every layout.** The Needs-you strip and the status-bar count live outside the dockable area.
- Commits are authored by the repository owner only, with no AI attribution or co-author trailers. Every task is pushed when it lands; CI must stay green on macOS and Windows.
- Plan 1/2/2B constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, 127.0.0.1 bind, every action gated before it runs).

## Review Focus

1. **A secret leaving through the API or the ledger.** Add a connection with a key, update it, test it, remove it, and send malformed bodies. Expected: no response body, ledger payload, zod issue list or error message contains the value; a key pasted into a `config` field is rejected. (Tests in Tasks 3 and 4.)
2. **Live redaction.** A key stored after the server started appears in a fake agent's shell output. Expected: the ledger holds `[REDACTED]`; after the connection is removed the same output is still redacted. (Tests in Tasks 2 and 8.)
3. **The child environment.** With `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN` and `GITHUB_TOKEN` in the server's environment, a Gemini run's env contains none of them, contains exactly the allowlisted variables plus `GEMINI_API_KEY` from the connection, and on win32 still contains `SystemRoot`, `ComSpec`, `PATHEXT`, `APPDATA`. (Test in Task 1.)
4. **Keychain unavailable or failing mid-operation.** The store throws on `set`. Expected: `POST /api/connections` → 503 `keychain_unavailable`, no ledger entry, no partial keychain entries, no file written; a run needing that key fails with the existing `No <Provider> API key configured` message; `/api/status` reports `keychain: "unavailable"`. (Tests in Tasks 2 and 4.)
5. **A layout that tries to hide decisions.** Close the bottom panel, switch to the Connections view, save the layout, reload. A new pending action must still show its decision card and the status bar count. "Reset layout" restores the default. (Tests in Tasks 5 and 8.)

---

## File Structure

```
packages/shared/src/connections.ts            # kinds, providers, catalog, Connection type, connection.* payload schemas (Task 3)
packages/shared/src/agents.ts                 # (modify) AdapterEvent usage fields in agent.finished (Task 0)
packages/shared/src/events.ts                 # (modify) EventType gains connection.* (Task 3)
packages/shared/src/index.ts                  # (modify)

packages/core/src/agents/adapter.ts           # (modify) usage event, AdapterStartOptions.credentials (Tasks 0, 4)
packages/core/src/agents/runner.ts            # (modify) extraSecrets getter, token totals, credentials, connection.used (Tasks 0, 4)
packages/core/src/agents/child-env.ts         # (rewrite) allowlist (Task 1)
packages/core/src/agents/worktrees.ts         # (modify) read-only empty gitconfig + check (Task 0)
packages/core/src/agents/claude-adapter.ts    # (modify) tokens, credentials (Tasks 0, 4)
packages/core/src/agents/codex/adapter.ts     # (modify) thread/tokenUsage/updated, cliHome (Tasks 0, 1, 4)
packages/core/src/agents/codex/protocol.ts    # (modify) TOKEN_USAGE_UPDATED types (Task 0)
packages/core/src/agents/gemini/adapter.ts    # (modify) googleCloudProject, cliHome, usage if available (Tasks 0, 1, 4)
packages/core/src/secrets/store.ts            # SecretStore interface, errors, ChunkedSecretStore (Task 2)
packages/core/src/secrets/keychain-store.ts   # @napi-rs/keyring implementation (Task 2)
packages/core/src/secrets/memory-store.ts     # tests/e2e (Task 2)
packages/core/src/connections/service.ts      # ConnectionService (Task 3)
packages/core/src/connections/testers.ts      # read-only "test connection" calls per provider (Task 3)
packages/core/src/events/projections.ts       # (modify) connections table reducer, token columns, status queries (Tasks 0, 3, 4)
packages/core/src/db.ts                       # (modify) migrations 4 (token columns) and 5 (connections) (Tasks 0, 3)
packages/core/src/server/connection-routes.ts # /api/connections*, /api/status (Task 4)
packages/core/src/server/routes.ts            # (modify) error map, zod issue stripping (Task 4)
packages/core/src/server/server.ts            # (modify) wire store, service, fake http (Task 4)
packages/core/src/index.ts                    # (modify)

apps/ui/src/shell/Workbench.tsx               # activity bar | side bar | dock ; status bar (Task 5)
apps/ui/src/shell/ActivityBar.tsx
apps/ui/src/shell/SideBar.tsx
apps/ui/src/shell/Dock.tsx                    # dockview-react wrapper: panel registry, default layout, persistence (Task 5)
apps/ui/src/shell/layout-store.ts             # localStorage save/load/reset (Task 5)
apps/ui/src/shell/StatusBar.tsx               # (Task 5 skeleton, Task 7 data)
apps/ui/src/shell/views.ts                    # VIEWS list, labels, panel ids (Task 5)
apps/ui/src/views/BoardView.tsx               # main tab: existing Board (Task 5)
apps/ui/src/views/ProjectsSideBar.tsx         # Board view's side bar: existing ProjectList (Task 5)
apps/ui/src/views/AgentsSideBar.tsx           # existing AgentPanel start + run list (Task 5)
apps/ui/src/views/AgentFeedPanel.tsx          # bottom tab: selected run's actions and messages (Task 5)
apps/ui/src/views/LedgerBottomPanel.tsx       # bottom tab: existing LedgerPanel in <aside aria-label="Ledger"> (Task 5)
apps/ui/src/views/NeedsYouSideBar.tsx         # pending decisions list (Task 5)
apps/ui/src/views/PlaceholderSideBar.tsx      # GitHub and Capacity until Plan 5B (Task 5)
apps/ui/src/views/ConnectionsSideBar.tsx      # Extensions-style list (Task 6)
apps/ui/src/views/ConnectionEditor.tsx        # main tab per connection (Task 6)
apps/ui/src/components/ProviderAuthSettings.tsx # (modify) export ProviderModeSection for reuse (Task 6)
apps/ui/src/components/LedgerPanel.tsx        # (modify) describeEntry for connection.* (Task 7)
apps/ui/src/api.ts                            # (modify) connections, status (Tasks 6, 7)
apps/ui/src/App.tsx                           # (modify) data loading stays; renders Workbench (Task 5)
apps/ui/src/styles.css                        # (modify) shell layout, dockview theme variables (Task 5)
apps/ui/test/test-dock.tsx                    # flat Dock stand-in for jsdom (Task 5)
docs/connections-and-credentials.md           # where secrets live, keychain notes, Gemini transcripts at rest (Task 7)
e2e/shell.spec.ts, e2e/connections.spec.ts    # (Task 8); existing specs updated for the shell
```

---

### Task 0A: Plan 2B residuals and package licence fields

**Files:** Modify `packages/core/src/agents/codex/adapter.ts`, `packages/core/test/fixtures/fake-codex.mjs`, `apps/ui/src/components/DecisionCard.tsx`, `packages/core/src/agents/gemini/adapter.ts`, `packages/core/src/agents/redact.ts`, `packages/core/package.json`, `packages/shared/package.json`, `apps/ui/package.json`. Tests in the matching test files.

Rules:
- **Codex stdin approvals show what will be typed.** The summary of a `codex.stdin` action is `Type into <command ≤60>: <input ≤80>`, where the input is the approval's `reason` with control characters made visible (JSON-escaped, e.g. `\n`). The decision card shows `input.reason` in its command block for `codex.stdin` actions instead of the original command. The fake's writeStdin step matches Codex 0.169.0: `command` and `cwd` present, its own `itemId` (not the running command's).
- **Gemini `writeAtomic` keeps only permission bits:** mask the copied mode with `0o777` (never setuid/setgid).
- **Redacted object keys never merge:** when two keys redact to the same string, the later ones become `[REDACTED]#2`, `[REDACTED]#3`, … so no value is dropped.
- **Gemini terminal summary:** cap the cwd part at 60 characters with an ellipsis, so the command keeps the rest of the 150.
- Add `"license": "Apache-2.0"` to the core, shared and ui package files.

- [ ] **Step 1: Write failing tests** for each rule (a stdin summary containing an escaped `rm -rf /\n`; a card rendering the typed text; a setuid source file → copy without setuid on non-Windows; `{a: secret1, b: secret2}` with both as extra secrets keeps two keys; a 200-character cwd keeps the command visible).
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS.
- [ ] **Step 5: Commit:** `fix: Plan 2B review follow-ups; declare package licences`

---

### Task 0B: Carry-overs in the runner: live `extraSecrets`, token usage, read-only git config

**Files:**
- Modify: `packages/shared/src/agents.ts`, `packages/core/src/agents/adapter.ts`, `runner.ts`, `worktrees.ts`, `child-env.ts` (gitconfig check only), `claude-adapter.ts`, `codex/adapter.ts`, `codex/protocol.ts`, `gemini/adapter.ts`, `packages/core/src/events/projections.ts`, `packages/core/src/db.ts`, `packages/core/src/server/server.ts`, `packages/core/test/fixtures/fake-codex.mjs` (already emits `thread/tokenUsage/updated`; keep shape).
- Tests: `packages/core/test/agents/{runner,redact,claude-adapter,codex-adapter,gemini-adapter,worktrees,child-env}.test.ts`, `packages/shared/test/agents.test.ts`, `packages/core/test/events/projections.test.ts`.

**Interfaces:**
```ts
// adapter.ts
export type AdapterEvent =
  | { type: "message"; text: string }
  | { type: "action_result"; actionId: string; ok: boolean; output: string }
  | { type: "usage"; costUsd?: number; inputTokens?: number; outputTokens?: number }; // each a finite number ≥ 0; absent = not reported
// runner.ts
export type AgentRunnerDeps = { …; extraSecrets: () => string[]; … };   // read on every clean()/cleanInput() call
// shared/agents.ts
export type AgentRun = { …; costUsd: number | null; inputTokens: number | null; outputTokens: number | null; … };
// agent.finished payload gains: inputTokens: z.number().int().nonnegative().nullable().optional(), outputTokens: same
// worktrees.ts
export function ensureEmptyGitconfig(dataDir: string): string; // writes "" if missing, chmod 0o444 (best effort on Windows), returns the path
export class SharedGitconfigModifiedError extends Error {}         // "shared git config was modified"
// child-env.ts
export function assertEmptyGitconfig(dataDir: string): void;      // throws SharedGitconfigModifiedError if size > 0; called by buildChildEnv
// codex/protocol.ts
export const TOKEN_USAGE_UPDATED = "thread/tokenUsage/updated";
export type TokenUsageUpdatedNotification = { threadId: string; turnId?: string; tokenUsage: { total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number } } }; // verify against the installed CLI's generated types; record the version in the header
```
Rules:
- The runner sums `costUsd`, `inputTokens`, `outputTokens` separately per session (ignoring non-finite or negative values) and writes all three in `agent.finished`. Migration 4: `ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER; ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;` and the `agent.finished` reducer writes them. Old entries (no fields) project `NULL`.
- Codex: on `thread/tokenUsage/updated` for our thread, remember `tokenUsage.total`; at `turn/completed` emit one `usage` with `inputTokens: total.inputTokens`, `outputTokens: total.outputTokens` (totals are cumulative, so emit once, at the end). The existing test "emits no usage when only token counts are reported" flips to expect `{ type: "usage", inputTokens: 6, outputTokens: 4 }`.
- Claude: emit `{ costUsd: m.total_cost_usd, inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens }` from the result message (verify the field names in the installed `sdk.d.ts`; these are documented as estimates).
- Gemini: verify whether the installed `gemini --acp` sends an ACP `session/update` with `sessionUpdate: "usage_update"`. Its fields describe context size, not consumption, so do **not** map them to tokens. If the update carries a `cost`, emit `costUsd`; otherwise emit nothing. Record the finding in the adapter comment (the capacity view in 5B shows "not reported" for Gemini).
- `server.ts` passes `extraSecrets: () => [token, ...secretEnvValues(process.env)]` (Task 4 appends the connection secrets).
- `WorktreeManager` calls `ensureEmptyGitconfig` in its constructor; `buildChildEnv` calls `assertEmptyGitconfig` before returning, so a modified shared config fails the run before the CLI starts, with the error above.

- [ ] **Step 1: Write failing tests:**
  - runner: `extraSecrets` is a function; a secret added to the array it returns *after* the runner was constructed is redacted from the next `agent.message`;
  - runner + FakeAdapter: two `usage` events `{costUsd: 0.1, inputTokens: 10}` and `{outputTokens: 5}` → `agent.finished` carries `costUsd: 0.1, inputTokens: 10, outputTokens: 5`; a `usage` with `inputTokens: -1` is ignored;
  - projections: rebuild after `agent.finished` with and without token fields yields matching rows;
  - codex: the fake's token usage → the usage event above; claude: result usage mapped; shared: `agent.finished` accepts a payload without the token fields;
  - worktrees: after construction the empty gitconfig exists, is empty and (non-Windows) has mode `0o444`; writing a byte into it and calling `buildChildEnv` throws `SharedGitconfigModifiedError`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `refactor(agents): live redaction secrets, token usage totals, read-only shared git config`

---

### Task 1: Child environment allowlist and explicit CLI home / project fields

**Files:** Rewrite `packages/core/src/agents/child-env.ts`; modify `codex/adapter.ts`, `gemini/adapter.ts`, `claude-adapter.ts`. Test `packages/core/test/agents/child-env.test.ts` plus env assertions in the three adapter tests.

**Interfaces:**
```ts
export type ChildEnvOptions = {
  apiKey?: string;                 // api_key mode only
  dataDir: string;
  base?: NodeJS.ProcessEnv;        // default process.env
  cliHome?: string;                // login modes only: CODEX_HOME (codex) / GEMINI_CLI_HOME (gemini); ignored for claude and in api_key mode
  googleCloudProject?: string;     // gemini only → GOOGLE_CLOUD_PROJECT
};
export function buildChildEnv(provider: Provider, mode: AuthMode, opts: ChildEnvOptions): NodeJS.ProcessEnv;
export const CHILD_ENV_ALLOWLIST: readonly string[];  // exact names, copied from base when present
export const CHILD_ENV_ALLOWLIST_PREFIXES: readonly string[]; // ["LC_"] 
```
Allowlist (names): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TERM`, `TMPDIR`, `TEMP`, `TMP`, `TZ`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, and on win32 additionally `SystemRoot`, `windir`, `SystemDrive`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `USERNAME`, `USERDOMAIN`, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`, `OS`. Prefix `LC_`. Everything else is dropped, including every `GIT_*`, every provider variable, `NODE_OPTIONS`, `THETERMINAL_*`.
Then set: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`; per provider the same additions as today (`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`; api_key keys: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`+`CODEX_API_KEY` / `GEMINI_API_KEY`); `cliHome` → `CODEX_HOME` or `GEMINI_CLI_HOME` only when `mode` is `chatgpt` / `google`; `googleCloudProject` → `GOOGLE_CLOUD_PROJECT` for gemini in either mode. Adapters stop reading `process.env.CODEX_HOME` (Codex) and keep setting their run-specific variables (`GEMINI_CLI_TRUST_WORKSPACE`, `GEMINI_CLI_NO_RELAUNCH`, `NO_BROWSER`, api_key-mode isolated homes) **after** `buildChildEnv`. Until Task 4 wires connections, adapters pass `cliHome: undefined`.

- [ ] **Step 1: Write failing tests:**
  - **(Review Focus 3)** base `{ PATH, HOME, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, NPM_TOKEN, GITHUB_TOKEN, GIT_AUTHOR_EMAIL, NODE_OPTIONS, LC_ALL, THETERMINAL_FAKE_AGENT }` for `gemini`/`api_key` with `apiKey` → keys are exactly `PATH, HOME, LC_ALL, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT, GEMINI_API_KEY`;
  - win32 base with `SystemRoot`, `ComSpec`, `PATHEXT`, `APPDATA` → all kept (pass `platform` via a test-only option or `process.platform` stub);
  - `cliHome` sets `CODEX_HOME` in `chatgpt` mode and is absent in `api_key` mode; `googleCloudProject` sets `GOOGLE_CLOUD_PROJECT` for gemini and never for codex;
  - existing Codex/Gemini/Claude env tests still pass (login modes carry no key).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test child-env codex gemini claude`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `fix(agents): allowlist the child environment; explicit CLI home and Google Cloud project`

---

### Task 1B: Bundle the agent programs inside The Terminal

The author decided that everything ships inside the app. Codex and Gemini CLI become dependencies of `@theterminal/core` and are used by default; nothing has to be on PATH. This replaces Plan 2B's "use the user's installed CLI" rule.

**Files:** Modify `packages/core/package.json` (add `@openai/codex` and `@google/gemini-cli`, exact versions matching the protocol research: 0.169.0 and 0.68.0), `packages/core/src/agents/codex/adapter.ts`, `gemini/adapter.ts`, `claude-adapter.ts`, `packages/core/src/server/server.ts`, `agent-routes.ts`. Create `packages/core/src/agents/bundled.ts`. Tests: `packages/core/test/agents/bundled.test.ts` plus the adapter and route tests.

**Interfaces:**
```ts
// bundled.ts
export type BundledCli = { file: string; args: string[] }; // spawn process.execPath with a JS entry, or a native binary directly
export function bundledCodex(): BundledCli | null;   // resolve from @openai/codex's package.json bin via createRequire; prefer its platform-native binary package if present
export function bundledGemini(): BundledCli | null;  // @google/gemini-cli bin "gemini" → [process.execPath, <bundle/gemini.js>] (keeps GEMINI_CLI_NO_RELAUNCH)
export function bundledClaude(): string | null;      // path of the Claude Code binary shipped in the Agent SDK's platform package, for subscription mode
```
Rules:
- Default lookup order per provider: bundled first, then (only if the bundled one is missing) the PATH lookup used today.
- `installed` in `GET /api/agents` becomes `available` and is true when the bundled program resolves. Rename the field and update the UI and tests: the "(not installed)" label becomes "(unavailable)" and should never show in a normal install.
- Claude subscription mode uses the SDK's bundled Claude Code (the user's own login is still read by Claude Code itself, never by us). Remove the "Claude Code is not installed or not on PATH" requirement unless the bundled binary is missing.
- Resolution never uses a shell. Every resolved path must live inside the package's own directory: resolve the real path and check containment, as the Windows shim rule does.
- Plan 2B's protocol pins stay: the bundled versions are exactly the ones the adapters were verified against. A future version bump re-runs the protocol checks.
- Test-only overrides (`THETERMINAL_CODEX_BIN` / `THETERMINAL_GEMINI_BIN` under `THETERMINAL_FAKE_AGENT=1`) still win over the bundled programs.
- The lockfile must include both packages' platform-native optional dependencies for darwin-arm64 and win32-x64, so CI's `--frozen-lockfile` works.

- [ ] **Step 1: Write failing tests:** bundled resolution returns paths inside node_modules and nothing outside; `/api/agents` reports `available: true` for all three in a normal test server; a codex run uses the bundled entry (assert the spawn command via an injected spawn); PATH is consulted only when the bundled lookup returns null.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the dependencies.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(agents): bundle Codex and Gemini CLI and use them by default`

---

### Task 2: Secret store (keychain, memory, chunking)

**Files:** Create `packages/core/src/secrets/store.ts`, `keychain-store.ts`, `memory-store.ts`. Tests `packages/core/test/secrets/store.test.ts`, `keychain-live.test.ts` (`describe.skipIf(process.env.THETERMINAL_LIVE_KEYCHAIN !== "1")`). Add `@napi-rs/keyring` to core.

**Interfaces:**
```ts
export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;          // idempotent
}
export class SecretStoreUnavailableError extends Error {}  // "keychain unavailable"
export const SECRET_SERVICE = "TheTerminal";               // keychain service name
export const MAX_SECRET_BYTES = 16 * 1024;
export class MemorySecretStore implements SecretStore { constructor(opts?: { failOn?: Set<"get" | "set" | "delete"> }); size(): number; }
export class KeychainSecretStore implements SecretStore {
  constructor(opts?: { service?: string; entry?: (service: string, account: string) => KeyringEntryLike }); // entry injectable for unit tests
}
/** Splits values over `maxChunkBytes` into `<account>#<n>` entries behind a `<account>` manifest "chunks:<n>". */
export class ChunkedSecretStore implements SecretStore { constructor(backend: SecretStore, maxChunkBytes = 2048); }
```
Rules:
- `KeychainSecretStore` maps any keyring error to `SecretStoreUnavailableError` with a fixed message (never the library's text, which may include the account name). `get` returns `null` for a missing entry.
- The default store in `server.ts` is `new ChunkedSecretStore(new KeychainSecretStore())`: Windows generic credentials cap the blob at 2560 bytes; chunking at 2048 keeps every platform under it.
- `set` rejects empty values and values over `MAX_SECRET_BYTES` (`RangeError`), before touching the backend.
- No store ever logs or includes a value in an error.

- [ ] **Step 1: Write failing tests:**
  - memory store round trip, delete idempotent, missing → null;
  - chunked over a memory backend with `maxChunkBytes = 16`: a 100-byte value round-trips; the backend holds a manifest plus 7 chunks; delete removes all; overwriting with a shorter value leaves no stale chunk;
  - **(Review Focus 4)** keychain store with an injected entry whose `setPassword` throws → `SecretStoreUnavailableError` whose message does not contain the account or value;
  - a 20 KiB value → `RangeError` and no backend call;
  - live (opt-in): set a random value under account `theterminal-test/<uuid>`, read it back, delete it, read null.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test secrets`. Expected: FAIL.
- [ ] **Step 3:** Implement. Check `pnpm-lock.yaml` includes the darwin-arm64 and win32-x64-msvc optional packages so `--frozen-lockfile` works on both CI runners.
- [ ] **Step 4:** Run the same command. Expected: PASS, live test skipped.
- [ ] **Step 5: Commit:** `feat(core): keychain-backed secret store with in-memory test double`

---

### Task 3: Connections domain, events, projection and service

**Files:** Create `packages/shared/src/connections.ts`, `packages/core/src/connections/service.ts`, `connections/testers.ts`. Modify `packages/shared/src/events.ts`, `index.ts`, `packages/core/src/db.ts` (migration 5), `events/projections.ts`. Tests `packages/shared/test/connections.test.ts`, `packages/core/test/connections/{service,testers}.test.ts`, `packages/core/test/events/projections.test.ts`.

**Interfaces:**
```ts
// shared/connections.ts
export const CONNECTION_KINDS = ["llm", "cloud", "github", "mcp", "hardware"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export const CONNECTION_PROVIDERS = ["claude", "codex", "gemini", "github", "aws", "gcp", "azure", "mcp_stdio", "mcp_http", "local_hardware"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export type FieldStorage = "config" | "private" | "secret"; // config → ledger+API; private → keychain, API, not ledger; secret → keychain only
export type ConnectionField = { name: string; label: string; storage: FieldStorage; required: boolean; input: "text" | "password" | "path" | "url" | "multiline"; help?: string };
export type CatalogEntry = { provider: ConnectionProvider; kind: ConnectionKind; label: string; description: string; fields: ConnectionField[]; single: boolean; available: boolean };
export const CONNECTION_CATALOG: readonly CatalogEntry[];
export const KIND_LABELS: Record<ConnectionKind, string> = { llm: "AI model", cloud: "cloud account", github: "GitHub", mcp: "MCP server", hardware: "hardware" };
export type ConnectionStatus = { state: "untested" | "ok" | "failed"; message: string; testedAt: string | null };
export type Connection = { id: string; kind: ConnectionKind; provider: ConnectionProvider; name: string; enabled: boolean;
  config: Record<string, string>; private: Record<string, string>; secretFields: string[]; status: ConnectionStatus; createdAt: string; updatedAt: string };
export const FORBIDDEN_CONFIG_KEY = /key|secret|token|password|passwd|credential|auth/i;
export const connectionConfigSchema; // z.record(key /^[a-z][A-Za-z0-9]{0,40}$/ and !FORBIDDEN_CONFIG_KEY, z.string().max(2000))
export const connectionNameSchema;   // z.string().min(1).max(120)
export const connectionPayloadSchemas = {
  "connection.added":   { connectionId, kind, provider, name, config, secretFields: string[], privateFields: string[] } (strict; provider must belong to kind per catalog),
  "connection.updated": { connectionId, name, changes: { name?, config?, enabled?: boolean, secretsSet?: string[], secretsRemoved?: string[], privateSet?: string[], privateRemoved?: string[] } } (at least one change key),
  "connection.removed": { connectionId, name },
  "connection.tested":  { connectionId, name, ok: boolean, message: z.string().max(500) },
  "connection.used":    { connectionId, name, runId, purpose: z.enum(["api_key", "cli_home", "cloud_credentials"]) },
};
```
Catalog in 5A (`available: true`): `claude` (llm, "Claude (Anthropic)", fields `apiKey` secret/password), `codex` (llm, "Codex (OpenAI)", `apiKey` secret; `cliHome` private/path, help `Only for "My own ChatGPT plan": the folder where your Codex login lives (CODEX_HOME). Leave empty for the default.`), `gemini` (llm, "Gemini (Google)", `apiKey` secret; `googleCloudProject` config/text; `cliHome` private/path, same help with GEMINI_CLI_HOME), `github` (github, "GitHub", `token` secret required, help `A fine-grained personal access token with read access to the repositories you want to see.`). All four `single: true`. `aws`, `gcp`, `azure`, `mcp_stdio`, `mcp_http`, `local_hardware` are listed with `available: false` and their fields left for Plan 5B. No field is `required` for llm providers (a login mode needs no key).

```ts
// core/connections/service.ts
export class ConflictError extends Error {}         // single provider already connected
export class SecretInConfigError extends Error {}   // "config contains a secret"
export class UnknownFieldError extends Error {}
export type ConnectionTester = (input: { config: Record<string, string>; private: Record<string, string>; secrets: Record<string, string> },
  deps: { fetch: typeof fetch; signal: AbortSignal }) => Promise<{ ok: boolean; message: string }>;
export type Credentials = { connectionId: string; name: string; apiKey?: string; cliHome?: string; googleCloudProject?: string };
export class ConnectionService {
  constructor(deps: { db: Db; ledger: Ledger; secrets: SecretStore; testers: Partial<Record<ConnectionProvider, ConnectionTester>>;
    fetch?: typeof fetch; newId?: () => string; testTimeoutMs?: number /* 10000 */ });
  load(): Promise<void>;        // at startup: read every secret/private value of every connection into the cache; keychain failure → cache stays empty, `keychainState() === "unavailable"`
  keychainState(): "ok" | "unavailable";
  list(): Connection[];         // from projection + private cache; never secrets
  get(id: string): Connection;  // NotFoundError
  add(actor: Actor, input: { kind; provider; name; config; secrets?: Record<string, string>; private?: Record<string, string> }): Promise<Connection>;
  update(actor: Actor, id: string, patch: { name?; config?; enabled?; secrets?: Record<string, string | null>; private?: Record<string, string | null> }): Promise<Connection>;
  remove(actor: Actor, id: string): Promise<void>;
  test(actor: Actor, id: string): Promise<{ ok: boolean; message: string }>;
  credentialsFor(provider: Provider): Credentials | null;  // the enabled llm connection for claude/codex/gemini, from the cache (sync)
  secretValues(): string[];      // every secret value ever loaded or set in this process (removed ones included)
}
```
Service rules:
- Field names must exist in the catalog entry with the matching storage, else `UnknownFieldError`. `config` is passed through `redact()`; any change → `SecretInConfigError`. Secret values: non-empty, ≤ `MAX_SECRET_BYTES`, no `\r`/`\n` unless the field is `multiline`.
- `add`: keychain writes first (accounts `connection/<id>/<field>`), then `commitEvent(connection.added)`; if the commit throws, delete the written entries (best effort) and rethrow. `single` providers: a second connection for the same provider → `ConflictError`, regardless of `enabled`.
- `update`: keychain writes/deletes first, then one `connection.updated` whose `changes` lists field **names**. `enabled` toggles are recorded as `changes.enabled`.
- `remove`: commit `connection.removed`, then delete keychain entries; values stay in `secretValues()`.
- `test`: runs the tester with `AbortSignal.timeout(testTimeoutMs)`; the message is `redact`ed, truncated to 500, then committed as `connection.tested`; status projection updates. Unknown or unavailable provider → `{ ok: false, message: "Testing is not available for this connection yet" }` and still recorded.
- Projection table (migration 5): `connections(id TEXT PRIMARY KEY, kind, provider, name, enabled INTEGER, config TEXT, secret_fields TEXT, private_fields TEXT, status_state TEXT, status_message TEXT, tested_at TEXT, created_at TEXT, updated_at TEXT)`; added to `PROJECTION_TABLES`.

Testers (5A): each a `GET` with a 10 s signal, `ok` on 2xx, message exactly `Connected`; 401/403 → `Rejected by the provider (HTTP <status>)`; other non-2xx → `Unexpected response (HTTP <status>)`; network error → `Could not reach the provider`. Keys go in headers, never in URLs:
- claude: `https://api.anthropic.com/v1/models`, headers `x-api-key`, `anthropic-version: 2023-06-01`;
- codex: `https://api.openai.com/v1/models`, `Authorization: Bearer`;
- gemini: `https://generativelanguage.googleapis.com/v1beta/models`, header `x-goog-api-key`;
- github: `https://api.github.com/user`, `Authorization: Bearer`, `X-GitHub-Api-Version: 2022-11-28`, `Accept: application/vnd.github+json`; on success the message is `Connected (scopes: <X-OAuth-Scopes or "fine-grained">)`. No login name is recorded.
- A missing secret → `{ ok: false, message: "No API key stored" }` / `"No token stored"` without a request.

- [ ] **Step 1: Write failing tests:**
  - shared: catalog providers belong to their kinds; `connectionConfigSchema` rejects key `apiKey` and `authToken`, accepts `googleCloudProject`; each payload schema accept/reject; `connection.updated` with empty `changes` is rejected;
  - service (memory store, fake fetch): add → one `connection.added` entry, keychain holds `connection/<id>/apiKey`, `list()` shows `secretFields: ["apiKey"]` and no value anywhere in `JSON.stringify(list())`;
  - **(Review Focus 1)** `config: { googleCloudProject: "sk-ant-TESTKEY-0000000000" }` → `SecretInConfigError`, nothing committed, nothing stored;
  - a second `claude` connection → `ConflictError`;
  - update replaces the key: the ledger payload `changes.secretsSet` is `["apiKey"]` and holds no value; `secrets: { apiKey: null }` removes it;
  - remove deletes the keychain entry but `secretValues()` still contains the old value **(Review Focus 2)**;
  - **(Review Focus 4)** a store failing on `set` → `SecretStoreUnavailableError`, ledger count unchanged, `size()` unchanged;
  - `load()` after a restart (new service over the same db and store) restores `credentialsFor("claude").apiKey`; with a failing store, `keychainState()` is `"unavailable"` and `credentialsFor` is null;
  - `credentialsFor("gemini")` carries `googleCloudProject` from config and `cliHome` from private; a disabled connection yields null;
  - testers: each provider's request goes to the exact URL with the key in the right header and never in the URL; 401 → the exact message; `fetch` rejecting → `Could not reach the provider`; `connection.tested` is recorded with `ok` and the status projection updates; the recorded message of a tester that returns the key text is `[REDACTED]`;
  - projections: rebuild after add/update/test/remove equals the live table.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): connections with keychain-held secrets, ledger events and connection tests`

---

### Task 4: Connections and status API; runs use connection credentials

**Files:** Create `packages/core/src/server/connection-routes.ts`. Modify `server.ts`, `routes.ts`, `agent-routes.ts`, `agents/adapter.ts`, `agents/runner.ts`, `claude-adapter.ts`, `codex/adapter.ts`, `gemini/adapter.ts`, `events/projections.ts` (status queries), `index.ts`. Tests `packages/core/test/server/connection-routes.test.ts`, `agent-routes.test.ts`, `server.test.ts`, `agents/runner.test.ts`.

**Interfaces:**

| Method & path | Body | 2xx |
|---|---|---|
| `GET /api/connections/catalog` | — | `CatalogEntry[]` |
| `GET /api/connections` | — | `Connection[]` (+ `environment: Partial<Record<Provider, string>>` is NOT included; see `/api/agents`) |
| `POST /api/connections` | `{kind, provider, name, config?, secrets?, private?}` | 201 `Connection` |
| `PATCH /api/connections/:id` | `{name?, config?, enabled?, secrets?, private?}` | `Connection` |
| `DELETE /api/connections/:id` | — | 204 |
| `POST /api/connections/:id/test` | — | `{ ok, message }` |
| `GET /api/status` | — | `{ runningAgents, pendingDecisions, todayCostUsd, connections: { enabled, failed, keychain: "ok" \| "unavailable" }, ci: null }` |

- `GET /api/agents` gains per provider `apiKey: "connection" | "environment" | "none"` (connection wins; environment = the server's own `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`, kept as a documented fallback for development and live tests).
- Errors: `ConflictError` → 409 `{error:"conflict"}`; `SecretInConfigError` → 400 `{error:"secret_in_config"}`; `UnknownFieldError` → 400 `{error:"invalid_input"}`; `SecretStoreUnavailableError` → 503 `{error:"keychain_unavailable"}`. The zod error handler now returns issues as `{ path, code, message }` only (no `received`), for every route.
- `todayCostUsd` = sum of `cost_usd` over runs whose `started_at` falls on the server's local calendar day (costs land when a run finishes; running runs count 0). `runningAgents` = runs with status `running`; `pendingDecisions` = pending actions; `connections.failed` = enabled connections whose status is `failed`.

```ts
// adapter.ts
export type RunCredentials = { apiKey?: string; cliHome?: string; googleCloudProject?: string };
export interface AdapterStartOptions { …; credentials: RunCredentials; }   // resolved by the runner; adapters prefer it over their own apiKey() fallback
// runner.ts
export type AgentRunnerDeps = { …; credentials?: (provider: Provider) => Credentials | null };  // default: () => null
```
Runner flow change in `start()`: after `authMode` is resolved, `creds = deps.credentials?.(provider)`; commit `agent.started`; if `creds` exists and (`authMode === "api_key"` with `apiKey`, or a login mode with `cliHome`) commit `connection.used { connectionId, name, runId, purpose }` with actor `{kind:"system", id:"runner"}`; pass `credentials` to the adapter. Adapters: `apiKey = o.credentials.apiKey ?? this.apiKey()`; `buildChildEnv(…, { cliHome: o.credentials.cliHome, googleCloudProject: o.credentials.googleCloudProject })`.

`server.ts`: `createServer` gains `secrets?: SecretStore` and `fetch?: typeof fetch` options. Default store: `ChunkedSecretStore(KeychainSecretStore)`; when `THETERMINAL_FAKE_AGENT=1` and `THETERMINAL_SECRET_STORE=memory` → `MemorySecretStore`. When `THETERMINAL_FAKE_AGENT=1` and `THETERMINAL_FAKE_HTTP=1` → a stub `fetch` that answers 200 `{}` when the request carries a header value containing `TESTKEY` and 401 otherwise (never performs network I/O). `await connections.load()` before the runner is built; `extraSecrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues()]`; `credentials: (p) => connections.credentialsFor(p)`.

- [ ] **Step 1: Write failing tests:**
  - every row of the table with a memory store; 201 body has `secretFields: ["apiKey"]` and `JSON.stringify(body)` lacks the value **(Review Focus 1)**; the same for `GET`, `PATCH`, `/api/ledger` entries and a 400 `secret_in_config` body;
  - a zod failure on `POST /api/connections` with `secrets: { apiKey: 42 }` has issues without `received`;
  - second `claude` → 409; unknown id → 404; `DELETE` → 204 then 404;
  - **(Review Focus 4)** `createServer({ secrets: failingStore })` starts; `POST` → 503 `keychain_unavailable`; `/api/status` has `keychain: "unavailable"`;
  - `/api/status` counts after one fake run with a pending action, then after allowing it: `pendingDecisions` 1 → 0, `runningAgents` 1 → 0, `todayCostUsd` equals the fake's reported cost;
  - `GET /api/agents` reports `apiKey: "none"`, then `"connection"` after a `POST`;
  - a fake run started after a key is stored → the ledger contains `connection.used { purpose: "api_key" }` (use a test adapter that asserts `o.credentials.apiKey`), and a shell output containing the key is recorded `[REDACTED]` **(Review Focus 2)**;
  - without `THETERMINAL_FAKE_AGENT`, `THETERMINAL_SECRET_STORE=memory` is ignored (the server uses the injected `secrets` option in tests; assert the selection function directly).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): connections and status API; runs draw credentials from the keychain`

---

### Task 5: VS Code-style shell with dockview

**Files:** Create everything under `apps/ui/src/shell/` and `apps/ui/src/views/` listed in the file structure except the Connections views; create `apps/ui/test/test-dock.tsx`. Modify `App.tsx`, `styles.css`, `apps/ui/test/setup.ts` (ResizeObserver stub), `apps/ui/test/App.test.tsx`. Add `dockview-react` to ui. Tests `apps/ui/test/{Workbench,ActivityBar,StatusBar,layout-store}.test.tsx`.

**Interfaces and copy:**
```ts
// shell/views.ts
export const VIEWS = ["board", "agents", "needs_you", "ledger", "connections", "github", "capacity"] as const;
export type ViewId = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<ViewId, string> = { board: "Board", agents: "Agents", needs_you: "Needs you", ledger: "Ledger", connections: "Connections", github: "GitHub", capacity: "Capacity" };
// shell/Dock.tsx
export type DockPanelId = "board" | "agent_feed" | "ledger" | `connection:${string}`;
export type DockApi = { open(id: DockPanelId, title: string, where: "main" | "bottom"): void; focus(id: DockPanelId): void; close(id: DockPanelId): void; reset(): void; toggleBottom(): void };
export function Dock(props: { panels: Record<string, React.ComponentType<{ id: string }>>; onReady(api: DockApi): void; layoutKey: string }): JSX.Element;
// shell/layout-store.ts
export const LAYOUT_KEY = "tt.layout.v1";
export function saveLayout(json: unknown): void; export function loadLayout(): unknown | null; export function resetLayout(): void; // malformed JSON → null
```
- `Workbench` grid: `nav[aria-label="Views"]` (activity bar, 48 px) · `aside[aria-label="Side bar"]` (resizable 200–480 px, collapsible by clicking the active view again) · the dock · `footer[aria-label="Status bar"]` across the bottom. Activity-bar buttons carry `aria-pressed` for the active view and a badge: Agents = running runs, Needs you = pending decisions.
- Default dock layout: main group with the `board` panel titled `Board`; bottom group (30 % height) with `agent_feed` titled `Agent feed` and `ledger` titled `Ledger`. The layout is saved on every dockview `onDidLayoutChange` and restored on load; a failed restore falls back to the default. A `Reset layout` button sits in the status bar's right side.
- Side bars: Board → `ProjectsSideBar` (existing `ProjectList`, keeps `nav[aria-label="Projects"]` and the `New project name` input); Agents → `AgentsSideBar` (existing `AgentPanel`'s start form and run list; keeps combobox `Agent`, label `Prompt`, button `Start agent`); Needs you → `NeedsYouSideBar` (the same `DecisionCard`s); Ledger → a short filter (project / all) and "Open ledger panel" which focuses the bottom tab; Connections → placeholder until Task 6 (`Connections arrive in the next task` is NOT acceptable copy; Task 5 ships the sidebar with the catalog list read-only and Task 6 makes it live); GitHub and Capacity → `PlaceholderSideBar` with text `Arrives with Plan 5B.`
- The Needs-you strip (`section[aria-label="Needs you"]`) renders above the dock whenever `pending.length > 0`, in every view and layout **(Review Focus 5)**.
- `AgentFeedPanel` shows the selected run's actions (moved from `AgentPanel`'s action list) and messages, newest last; `LedgerBottomPanel` wraps `LedgerPanel` in `<aside aria-label="Ledger">` so the existing e2e selectors hold.
- Status bar (skeleton; live data in Task 7): left `Agents running: 0` · `Today: $0.00` · `Needs you: 0` ; right `Connections: 0 connected` · `CI: not connected` · `Reset layout`.
- Styling: import `dockview-react/dist/styles/dockview.css` (verify the exact path in the package) and use the `dockview-theme-dark` class; CSS variables in `styles.css` for the chrome. No visual design beyond a coherent dark theme (spec §11 leaves visuals to the builder).
- jsdom: `test/setup.ts` stubs `ResizeObserver`; `App.test.tsx` and `Workbench.test.tsx` mock `../src/shell/Dock` with `TestDock`, which renders every registered panel in a `div[data-panel=<id>]`. The real dockview is exercised by e2e.

- [ ] **Step 1: Write failing tests:**
  - ActivityBar renders the seven labels in order, marks the active one `aria-pressed`, and shows badge `2` on Needs you when given `pending: 2`;
  - Workbench: clicking `Agents` shows the start form; clicking `Board` shows `nav[aria-label="Projects"]`; with the dock mocked, the `Board` panel contains the five stage columns;
  - **(Review Focus 5)** with view `connections` and the bottom panel closed, a pending action renders `article[aria-label="Decision: Run: nvidia-smi"]`;
  - layout-store: save/load round trip; corrupt JSON → null; reset clears;
  - the existing App tests pass with the new structure (project create → board visible; decision flow).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e` (update `e2e/agent.spec.ts` and `providers.spec.ts` to click `Agents` in the Views nav before starting a run). Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): VS Code-style workbench with activity bar, side bar, docked main area and status bar`

---

### Task 6: Connections view (Extensions-style)

**Files:** Create `apps/ui/src/views/ConnectionsSideBar.tsx`, `ConnectionEditor.tsx`. Modify `api.ts`, `App.tsx`/`Workbench.tsx` (open `connection:<id>` tabs), `components/ProviderAuthSettings.tsx` (export `ProviderModeSection`). Tests `apps/ui/test/{ConnectionsSideBar,ConnectionEditor}.test.tsx`.

**Interfaces and copy:**
```ts
// api.ts
listConnections(): Promise<Connection[]>; getConnectionCatalog(): Promise<CatalogEntry[]>;
addConnection(i): Promise<Connection>; updateConnection(id, patch): Promise<Connection>; removeConnection(id): Promise<void>;
testConnection(id): Promise<{ ok: boolean; message: string }>; getStatus(): Promise<Status>;
```
- Side bar: search input `aria-label="Search connections"`, placeholder `Search connections`; groups in order `AI models`, `Code hosting`, `Cloud accounts`, `Tools (MCP)`, `Hardware`. Each catalog entry is a row: label, status dot (`untested` grey, `ok` green, `failed` red, not connected hollow), an enable switch (`role="switch"`, `aria-label="Enable <label>"`) when connected, and the row opens the editor tab. Unavailable entries render disabled with the note `Arrives with Plan 5B`. Search filters by label and description.
- Editor tab (`connection:<id>` or `connection:new:<provider>`), titled `<label>`: name input; for llm providers the `ProviderModeSection` (radios + ack, as today) followed by the fields; each secret field is a password input with placeholder `Stored in your keychain` when `secretFields` includes it, a `Replace` button to edit, and the note `Stored in your operating system's keychain. Never written to files, the ledger or the API.`; private path fields are plain inputs with their help text; buttons `Save`, `Test connection`, `Remove connection` (confirm with `Remove`). Status line: `Not tested` / `Connected` / `Failed: <message>` with `testedAt`. When `/api/agents` says `apiKey: "environment"` for that provider and no connection exists, show `Using the <VAR> environment variable. Add a key here to manage it in your keychain.`
- Error mapping in `errorMessage`: 409 → `Already connected`; `secret_in_config` → `That field must not contain a key or token`; 503 `keychain_unavailable` → `Your keychain is unavailable. Nothing was saved.`
- Saving a new connection posts secrets once and then clears them from component state; the UI never echoes a typed secret after save.

- [ ] **Step 1: Write failing tests:**
  - the side bar lists the five groups, filters by search, shows unavailable rows disabled with the note;
  - the editor posts `{ kind: "llm", provider: "claude", name, secrets: { apiKey } }` on Save; afterwards the password input is empty with placeholder `Stored in your keychain`;
  - `Test connection` calls `testConnection(id)` and shows `Connected`, then `Failed: Rejected by the provider (HTTP 401)` for a failing mock;
  - the enable switch calls `updateConnection(id, { enabled: false })`;
  - a 503 shows the keychain message; a 409 shows `Already connected`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Connections view with keychain-backed credentials and connection tests`

---

### Task 6B: Sign in with your own subscription from the UI

The Owner signs in to Claude, ChatGPT (Codex) or Google (Gemini) from the Connections editor without opening a terminal. The Terminal only starts the provider's **own, official** login command and then checks whether it succeeded. It never reads, stores or relays the login itself: the browser talks to the provider and the CLI saves its own credentials, exactly as when the Owner runs the command by hand.

**Files:** Create `packages/core/src/connections/signin.ts`, `apps/ui/src/views/SignInPanel.tsx`. Modify `connection-routes.ts`, `ConnectionEditor.tsx`, `api.ts`. Tests `packages/core/test/connections/signin.test.ts`, `apps/ui/test/SignInPanel.test.tsx`.

Rules:
- **Research first (record findings and CLI versions in the report):** for each installed CLI, find (a) its official non-interactive or browser/device login command, (b) a status command or exit code that says whether it is signed in, and (c) whether login works without a terminal. Candidates to verify, not assumptions: `claude` login/status subcommands, `codex login` / `codex login status` / device-code login, `gemini` login flow. If a CLI has no login path that works without a terminal, its button instead shows the exact command to run and a "Check again" button.
- `POST /api/connections/signin/:provider` starts the login command with `execFile` (no shell) using the provider's login-mode child env, captures stdout/stderr (≤64 KiB), and returns a sign-in id. `GET /api/connections/signin/:id` returns `{ state: "running" | "succeeded" | "failed", lines: string[] }`. Lines are passed through `redact()` and path scrubbing before they leave the server, and only lines matching an allowlist of safe patterns (URLs on the provider's own domains, device codes, status words) are shown. One sign-in per provider at a time; it is killed after 10 minutes.
- `GET /api/connections/signin-status` runs each provider's status check and returns `{ claude|codex|gemini: "signed_in" | "signed_out" | "unknown" | "not_installed" }`. This never reads credential files.
- Nothing from a sign-in goes into the ledger except `connection.signin { provider, ok }` (no output, no account names, no emails).
- UI: in a provider's editor, under "My own … plan/account", a **Sign in** button opens `SignInPanel`, which shows the provider's login link or device code as a clickable link, a spinner, then `Signed in` or `Sign-in failed`. The panel says: `You sign in on <provider>'s own page. The Terminal never sees your password or login tokens.`
- The ledger event schema `connection.signin` is added to shared, with a `describeEntry` line `Owner signed in to <Provider>` / `Sign-in to <Provider> failed`.

- [ ] **Step 1: Write failing tests** with a fake login CLI (a node script under `test/fixtures/` that prints a fake device URL on the provider's domain and a fake code, then exits 0 or 1). Cover: the allowlist hides a line containing an email or a path; a running sign-in for the same provider returns 409; status reports `not_installed` when the CLI is missing; the 10-minute timeout kills the process (with an injectable timeout); and the ledger holds only `connection.signin`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: sign in to your own subscriptions from the Connections view`

---

### Task 7: Status bar data, ledger wording, documentation

**Files:** Modify `apps/ui/src/shell/StatusBar.tsx`, `App.tsx` (poll `/api/status` through the coalescer on any ledger entry plus every 30 s), `components/LedgerPanel.tsx`. Create `docs/connections-and-credentials.md`. Tests `apps/ui/test/{StatusBar,LedgerPanel}.test.tsx`.

**Copy:**
- Status bar items (exact): `Agents running: <n>` · `Today: $<x.xx>` · `Needs you: <n>` (clicking selects the Needs you view) · `Connections: <n> connected` with `, <m> failed` appended when m > 0 (clicking selects Connections) · `Keychain unavailable` replaces the connections item when the server reports it · `CI: not connected`.
- `describeEntry`:
  - `connection.added` → `Owner connected "<name>" (<KIND_LABELS[kind]>)`
  - `connection.updated` → `enabled === true` → `Owner enabled "<name>"`; `false` → `Owner disabled "<name>"`; `secretsSet` non-empty → `Owner replaced the <field names joined by ", "> of "<name>"`; else `Owner updated "<name>"`
  - `connection.removed` → `Owner removed "<name>"`
  - `connection.tested` → `"<name>" connected` / `"<name>" failed to connect: <message>`
  - `connection.used` → `Agent <runId first 8> was given access to "<name>"`
- `docs/connections-and-credentials.md` documents: where each kind of value lives (keychain vs ledger vs memory); the keychain service name and account scheme; macOS prompts when the Node binary changes; the Windows 2560-byte blob limit and chunking; the environment-variable fallback and how to stop using it; that removed secrets stay redacted until restart; the child-env allowlist; that **Gemini stores session transcripts and error dumps at rest** (`~/.gemini/tmp` in Google-login mode; `<dataDir>/projects/<id>/gemini-home/.gemini/tmp` in API-key mode) and how to clear them; that Codex MCP is unavailable in v1 and why; what Plan 5B adds.

- [ ] **Step 1: Write failing tests:** the status-bar strings for `{ runningAgents: 2, todayCostUsd: 0.4, pendingDecisions: 1, connections: { enabled: 3, failed: 1, keychain: "ok" } }` and for `keychain: "unavailable"`; each `describeEntry` string above.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement and write the doc.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): live status bar; ledger wording for connections; credentials documentation`

---

### Task 8: End-to-end: shell, connections, live redaction

**Files:** Create `e2e/shell.spec.ts`, `e2e/connections.spec.ts`. Modify `e2e/global-setup.ts` (agent server env adds `THETERMINAL_SECRET_STORE=memory`, `THETERMINAL_FAKE_HTTP=1`, and a fake script whose shell step outputs the string `key=sk-ant-TESTKEY-e2e-00000000000000`), `e2e/{board,agent,providers}.spec.ts` (navigate via the Views nav).

- [ ] **Step 1: Write the failing e2e tests:**
  - shell: the activity bar shows the seven views; `Board` is home with the five columns; closing the `Ledger` tab and reloading keeps it closed; `Reset layout` brings it back; **(Review Focus 5)** with the bottom panel closed and `Connections` selected, starting a fake run still shows the decision card and `Needs you: 1` in the status bar;
  - connections: open Connections → `Claude (Anthropic)` → paste `sk-ant-TESTKEY-e2e-00000000000000` → Save → the field shows `Stored in your keychain`; `Test connection` → `Connected`; the ledger shows `Owner connected "Claude" (AI model)` and `"Claude" connected`; intercept every response during the test and assert none contains the key;
  - **(Review Focus 2)** start the fake agent, allow its shell step; the ledger's completed-action detail shows `key=[REDACTED]`; remove the connection; run again; still `[REDACTED]`;
  - `GET /api/connections` in a context without the cookie → 401.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows.
- [ ] **Step 5: Commit:** `test(e2e): workbench shell, connections and live redaction`

---

## Done when

- The Owner adds Claude, OpenAI, Gemini and GitHub credentials in the Connections view; they live in the OS keychain, never appear in any response, file or ledger entry, and a connection test runs read-only calls.
- A run uses exactly its provider's configured key through an allowlisted environment; the use is recorded as `connection.used`; a stored key is redacted from agent traffic immediately and stays redacted after removal.
- The workspace opens in the VS Code-style shell with the board as home, a working bottom panel, a saved layout and a live status bar; pending decisions are visible in every layout.
- Claude, Codex and Gemini work out of the box with no separate installs; the bundled programs are used by default.
- The Owner can sign in to their own Claude, ChatGPT or Google subscription from the Connections view, using the provider's own login page; The Terminal never sees the credentials.
- Codex runs record token counts; `agent.finished` carries tokens for the capacity view.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI without touching a real keychain.

---

## Plan 5B outline: cloud accounts, GitHub view, MCP through the gate, capacity

To be written in full after 5A lands, in the same format. Tasks:

1. **Cloud connections (AWS, GCP, Azure).** Catalog fields: AWS `accessKeyId` (secret), `secretAccessKey` (secret), `region` (config), or `profile` (private; a name from the user's own `~/.aws`); GCP `serviceAccountJson` (secret, multiline, chunked), `project` (config); Azure `tenantId`, `clientId` (config), `clientSecret` (secret), `subscriptionId` (config). Test connection = read-only identity calls: AWS STS `GetCallerIdentity`, GCP token exchange + `GET cloudresourcemanager.googleapis.com/v1/projects/<id>`, Azure OAuth2 client-credentials + `GET management.azure.com/subscriptions/<id>?api-version=2022-12-01`. **Recommendation:** `@aws-sdk/client-sts` only (SigV4 is the one piece worth not hand-rolling; Apache-2.0, Node ≥ 20), and plain `fetch` for GCP (RS256 JWT via `node:crypto`) and Azure (a POST). No cloud CLIs (plug-and-play, spec §2 goal 7) and no `@azure/*` or `google-auth-library` (Node ≥ 22 pin and weight for one call each). Decision for the author.
2. **Scoped credential passing.** `POST /api/projects/:id/runs` gains `connectionIds?: string[]`; the runner verifies each is enabled, injects provider env (`AWS_*`, `GOOGLE_CLOUD_PROJECT`, `AZURE_*`) through the allowlist, and records `connection.used { purpose: "cloud_credentials" }` per connection. Open decision: GCP tooling wants a credentials **file**; prefer minting a short-lived access token (`CLOUDSDK_AUTH_ACCESS_TOKEN`) over writing the JSON to a per-run temp file; same idea for AWS (`GetSessionToken`).
3. **GitHub view (Source Control-like).** Connection gains `repo` (config `owner/name`). `GET /api/github/overview` → repo, default branch, branches, open PRs, latest 10 CI runs, via plain `fetch` with ETag caching (no octokit: one dependency fewer for four GET calls). Side bar: repo, branches, PRs, CI runs; status bar `CI: passing | failing | running` with a link; `ci` filled in `/api/status`. No writes in v1.
4. **MCP through the gate.** Providers `mcp_stdio` (`command`, `args` config; `env` secret map) and `mcp_http` (`url` config, `headers` secret). Runs select MCP connections. Claude: pass `mcpServers` with `strictMcpConfig: true`; `mcp__*` tools already hit the PreToolUse gate. Gemini: `mcpServers` in `session/new`, `--allowed-mcp-server-names <names>`, and `ask_user` policy rules for the server's tools (verify the policy tool-name pattern for MCP tools against the installed CLI). Codex: the editor shows `Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.` and the run API rejects MCP connections for Codex.
5. **Capacity (spec §6).** Inventory from connections + a `local_hardware` connection created by detection (Apple Silicon via `sysctl` and `system_profiler -json`; NVIDIA via `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`; `execFile`, no shell; Windows/WSL note). Owner-entered limits per llm connection (`monthlyBudgetUsd`, plan name). Used-vs-available from `agent_runs` cost and token columns per provider per day/month; 429s observed by adapters feed an estimate; every estimated figure is labelled `estimate`. Capacity side bar + main tab; status bar shows today's cost vs budget.
6. **e2e** for scoped cloud env (fake HTTP), the GitHub view (fake HTTP), Gemini MCP ask rule (fake ACP), capacity numbers.

---
