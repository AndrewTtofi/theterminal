# Plan 2B: Codex and Gemini Agents Implementation Plan

**Goal:** Add the Codex and Gemini agents behind the same glass-box gate as Claude. Every tool action they take is recorded and decided **before** it executes. Each provider uses the user's own official CLI and login, or an API key. Plan 2's parked redaction edge cases are closed first.

**Architecture:**
- Both agents speak a JSON-RPC protocol over stdio to a child process the user already has installed:
  - **Codex:** `codex app-server`. The host answers `requestApproval` server-requests before each command or file change.
  - **Gemini:** `gemini --acp` (Agent Client Protocol). The Terminal advertises the client `fs` and `terminal` capabilities, so Gemini routes file reads, file writes and command execution **through us**. We gate each one, then perform it ourselves inside the worktree. `session/request_permission` is gated too.
- A small shared JSON-RPC stdio transport serves both adapters.
- Provider auth generalises the Claude setting into one per-provider setting.
- Test doubles are small fake CLI scripts that speak each protocol. Live tests run only when explicitly enabled.

**Tech Stack:** existing stack, `@agentclientprotocol/sdk` (ACP TypeScript client; verify the current version and Apache/MIT licence before adding), and the user-installed `codex` and `gemini` binaries (not bundled). Codex protocol types: generate them with the installed CLI (`codex app-server generate-ts`), or read them from the openai/codex repo's `app-server-protocol` schema. Vendor ONLY the types used, under `packages/core/src/agents/codex/protocol.ts`, with a header naming the source version.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` (§3, §5, §8, §10.2 mediate-don't-reconstruct, §10.3 provider terms: Gemini allows driving the official CLI; extracting its OAuth tokens is a violation. Codex app-server supports ChatGPT login; never read or copy credentials). This builds on Plan 2 (`docs/plans/2026-11-14-plan-2-agent-runtime.md`).

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Use fake values in tests.
- **Every agent action is recorded and decided before it executes** (spec §10.2). If a protocol path would let a tool run without our gate, it must be disabled or routed through the client. If neither is possible, the adapter must refuse to start, with a clear error.
- **Never read, store, copy or proxy any provider credential** (`~/.codex`, `~/.gemini`, keychains, OAuth tokens). Login modes only mean "do not pass an API key; let the user's own installed CLI use its own login".
- **Use the user's installed CLI** (`codex`, `gemini`) found on PATH with the same absolute-PATH-only `which` as Plan 2's Claude subscription mode. If it's missing, the run fails with `"<Name> CLI is not installed or not on PATH"`. Nothing is bundled.
- **Child env:** start from the env stripping rules of Plan 2 (`GIT_*` removed, `GIT_CONFIG_GLOBAL` pointing at the empty dataDir file, `GIT_CONFIG_NOSYSTEM=1`), plus provider rules: strip `OPENAI_*` and `CODEX_*` (Codex), and `GEMINI_*`, `GOOGLE_*` and `VERTEX*` (Gemini). Re-add only the configured API key in api_key mode.
- **Fail closed and bounded:** protocol errors, a malformed message, an unknown server-request method, child exit, or a timeout all deny and are recorded, and the run ends `failed`. Abort kills the child process (with a 5s grace, then a hard kill).
- Test-only binary overrides (`THETERMINAL_CODEX_BIN`, `THETERMINAL_GEMINI_BIN`) are honoured **only** when `THETERMINAL_FAKE_AGENT=1`.
- Commits are authored by the repository owner. Push after every task so macOS + Windows CI runs per task.

## Review Focus

1. **Ungated execution paths.** An auto-approved Codex command (approval policy too lax), a Gemini tool that bypasses client `fs`/`terminal` (e.g. its own shell tool, web fetch or MCP), or a protocol notification acted on as approval. Expected: none execute without a recorded decision. (Tests in Tasks 3 and 4.)
2. **A malformed or hostile peer.** Huge lines, invalid JSON, out-of-order or duplicate ids, a response to an unknown id, a server-request flood. Expected: bounded memory, deny, and the run fails. No crash or hang. (Test in Task 2.)
3. **Client-side fs/terminal on behalf of Gemini.** A path outside the worktree, `..`, `.git`, a symlink escape (reuse `resolveInside`), a write after deny, terminal output containing secrets. Expected: the same guarantees as Plan 2's policy and redaction. (Test in Task 4.)
4. **Child process lifecycle.** Abort mid-approval, the child ignoring SIGTERM, a zombie after shutdown, stdout closed while a gate is pending. Expected: killed within bounds, pending gates denied, `shutdown()` bounded. (Tests in Tasks 2–4.)
5. **Credential isolation.** The env passed in login modes contains no API keys; api_key mode contains exactly one; no credential files are touched. (Tests in Tasks 3 and 4.)

---

## File Structure

```
packages/core/src/agents/redact.ts            # (modify, Task 0)
packages/core/src/agents/runner.ts            # (modify, Task 0, Task 1)
packages/core/src/agents/policy.ts            # (modify, Task 0)
packages/core/src/agents/claude-adapter.ts    # (modify, Task 0, Task 1)
packages/core/src/agents/which.ts             # (extract from claude-adapter, Task 1)
packages/core/src/agents/child-env.ts         # shared env builder (Task 1)
packages/core/src/agents/settings.ts          # ProviderSettings (Task 1)
packages/shared/src/agents.ts                 # (modify) ADAPTERS, provider auth event (Task 1)
packages/core/src/agents/jsonrpc.ts           # JSON-RPC stdio transport (Task 2)
packages/core/src/agents/codex/protocol.ts    # vendored subset of Codex app-server types (Task 3)
packages/core/src/agents/codex/adapter.ts     # CodexAdapter (Task 3)
packages/core/src/agents/gemini/adapter.ts    # GeminiAdapter (ACP client) (Task 4)
packages/core/test/fixtures/fake-codex.mjs    # scripted fake app-server (Task 3)
packages/core/test/fixtures/fake-gemini.mjs   # scripted fake ACP agent (Task 4)
packages/core/src/server/agent-routes.ts      # (modify, Task 5)
packages/core/src/server/server.ts            # (modify, Task 5)
apps/ui/src/components/ProviderAuthSettings.tsx  # replaces ClaudeAuthSetting (Task 6)
apps/ui/src/components/LedgerPanel.tsx        # (modify, Task 6)
e2e/providers.spec.ts                         # (Task 7)
```

---

### Task 0: Close Plan 2's parked leak edge cases

**Files:** Modify `packages/core/src/agents/redact.ts`, `runner.ts`, `policy.ts`, `claude-adapter.ts`. Tests: `packages/core/test/agents/{redact,runner,policy,claude-adapter}.test.ts`.

**Interfaces:**
- `redact()` applies `extraSecrets` **longest first** (stable sort by length, descending).
- `AgentRunner`'s `clean()`/`cleanInput()` redact `extraSecrets` **before** path and username scrubbing, then scrub, then redact again with all patterns, then truncate.
- The username scrubber treats a trailing `.` as a boundary when it is not followed by a name character (`alice.` → `<user>.`; `alice.bak` unchanged).
- Claude child env: strip `GIT_AUTHOR_*`, `GIT_COMMITTER_*` and every other `GIT_*`, then apply Plan 2's git env (empty global config file, no system config).
- `classify()`: a `shell` action whose recorded input is truncated (`{truncated:true,…}`) → `auto_deny` with reason `"command too long to review"`.

- [ ] **Step 1: Write failing tests:**
  - with username `alice` and the extra secret `alice:Fake-Pw-0001`, the recorded text contains no `Fake-Pw-0001`;
  - with extraSecrets `["abc","abcdef"]`, `"abcdef"` becomes `[REDACTED]` with no `def` tail;
  - `owned by alice.` → `owned by <user>.`;
  - the Claude child env has no `GIT_AUTHOR_EMAIL` when one is set in `process.env`;
  - a 25k-char shell command is auto-denied with the reason above, and its card never asks.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `fix(agents): close parked redaction and env edge cases from Plan 2`

---

### Task 1: Per-provider auth settings, shared `which` and child env

**Files:**
- Create: `packages/core/src/agents/which.ts`, `packages/core/src/agents/child-env.ts`.
- Modify: `packages/core/src/agents/settings.ts`, `claude-adapter.ts`, `runner.ts`, `events/projections.ts`, `packages/shared/src/agents.ts`, `packages/shared/src/events.ts`.
- Tests: `packages/core/test/agents/{settings,which,child-env}.test.ts`, `packages/shared/test/agents.test.ts`.

**Interfaces:**
```ts
// shared
export const ADAPTERS = ["claude", "codex", "gemini", "fake"] as const;
export const PROVIDERS = ["claude", "codex", "gemini"] as const; export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_MODES = { claude: ["api_key", "subscription"], codex: ["api_key", "chatgpt"], gemini: ["api_key", "google"] } as const;
export type AuthMode = "api_key" | "subscription" | "chatgpt" | "google" | "none";
export const PROVIDER_ACKS: Record<Provider, string>; // claude = existing CLAUDE_SUBSCRIPTION_ACK; codex/gemini acks below
// new event: settings.provider_auth_changed { provider, mode, acknowledgement (0..1000) }
//   mode must be valid for provider; non-api_key mode requires acknowledgement === PROVIDER_ACKS[provider]
//   settings.claude_auth_changed stays readable (projection maps it to provider "claude") but is no longer written
// core
export function which(name: string, opts?: { path?: string; platform?: NodeJS.Platform; exists?: (p: string) => boolean }): string | null;
export function buildChildEnv(provider: Provider, mode: AuthMode, opts: { apiKey?: string; dataDir: string; base?: NodeJS.ProcessEnv }): NodeJS.ProcessEnv;
export class ProviderSettings { constructor(db: Db, ledger: Ledger);
  getMode(p: Provider): AuthMode;            // default "api_key"
  setMode(actor: Actor, p: Provider, mode: AuthMode, acknowledgement?: string): void; }
```
- Acknowledgement texts (exact):
  - codex: `"I understand that running Codex on my own ChatGPT plan through The Terminal uses my plan's limits and is subject to OpenAI's terms. I choose to do this."`
  - gemini: `"I understand that running Gemini on my own Google account through The Terminal is subject to Google's terms. I choose to do this."`
- The settings projection key becomes `auth_mode:<provider>`. The rebuild replays both old and new events.
- `ClaudeSettings` is replaced by `ProviderSettings`, and `ClaudeAdapter` uses `which` and `buildChildEnv` from the new modules with no behaviour change. All existing Claude tests stay green.
- The runner resolves `authMode` for `claude`, `codex` and `gemini` via `ProviderSettings`.

- [ ] **Step 1: Write failing tests:**
  - the mode/provider validity matrix;
  - an ack is required for each non-api_key mode;
  - an old `settings.claude_auth_changed` entry still yields claude=subscription after a rebuild;
  - `buildChildEnv` strips the provider-prefixed vars and re-adds exactly one key in api_key mode;
  - `which` ignores relative PATH entries, and on win32 tries `.exe` then `.cmd`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `refactor(agents): per-provider auth settings, shared which and child env`

---

### Task 2: JSON-RPC stdio transport

**Files:** Create `packages/core/src/agents/jsonrpc.ts`. Test `packages/core/test/agents/jsonrpc.test.ts` (uses in-memory streams, no child).

**Interfaces:**
```ts
export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;
export class JsonRpcPeer {
  constructor(io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }, opts: {
    onRequest: RpcHandler;                       // server→client requests (approvals, fs, terminal)
    onNotification: (method: string, params: unknown) => void;
    maxLineBytes?: number;                       // default 8 MiB; longer line → protocol error
    requestTimeoutMs?: number;                   // default 10 min for our outgoing requests
  });
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(reason: string): void;                   // rejects all pending; idempotent
  readonly closed: Promise<string>;              // resolves with reason on close/EOF/protocol error
}
```
- The framing is newline-delimited JSON (one message per line). Both protocols use this. Verify against the installed CLIs and note it in the report.
- Errors from `onRequest` → a JSON-RPC error response `{code:-32000, message:"denied"}`. The internal message is never sent to the peer.
- Rules for bad input:
  - invalid JSON, a line too long, or a response to an unknown id → `close("protocol error")`;
  - an unknown `jsonrpc` version → close;
  - incoming requests are processed concurrently, but at most 64 may be in flight; beyond that → close.

- [ ] **Step 1: Write failing tests:**
  - a request/response round trip;
  - a server request answered by `onRequest`;
  - a notification delivered;
  - **(Review Focus 2)** invalid JSON closes, a 9 MiB line closes without buffering it whole, a response to an unknown id closes, a 100-request flood closes, and every pending `request()` rejects on close;
  - EOF closes with "eof".
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test jsonrpc`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(agents): bounded JSON-RPC stdio transport`

---

### Task 3: Codex adapter (`codex app-server`)

**Files:**
- Create: `packages/core/src/agents/codex/protocol.ts`, `codex/adapter.ts`, `packages/core/test/fixtures/fake-codex.mjs`.
- Tests: `packages/core/test/agents/codex-adapter.test.ts`, `codex-live.test.ts` (`skipIf(process.env.THETERMINAL_LIVE_CODEX !== "1")`).

**Interfaces:**
```ts
export class CodexAdapter implements AgentAdapter {
  constructor(opts?: { bin?: () => string | null /* default which("codex") */; apiKey?: () => string | undefined; spawn?: typeof import("node:child_process").spawn });
}
export function codexApprovalToAction(method: string, params: unknown, cwd: string): ProposedAction;
```
Flow (verify every method name and field against the installed CLI's generated types, recording the CLI version in protocol.ts):
1. Spawn `<codex> app-server` with `cwd` = the worktree and env = `buildChildEnv("codex", mode, …)`.
2. `initialize` with clientInfo `{name:"theterminal", version}`, then `initialized`.
3. api_key mode: log in with the apiKey login type. chatgpt mode: rely on the user's existing login. If the account read reports no login → fail `"Codex is not logged in; run 'codex login' yourself"`.
4. `thread/start` with `cwd`, the **strictest approval policy that requests approval for every command and file change**, and a `workspaceWrite` sandbox limited to the cwd, with network off. If the installed CLI offers no policy that asks for every command, refuse to start: `"Codex approval policy cannot gate every action"`.
5. `turn/start` with the prompt.
6. The server-requests `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` → `codexApprovalToAction` → `gate()` → answer `accept` or `decline` (never `acceptForSession` or execpolicy amendments). Any other server-request method → error response, plus a recorded `other` action denied with reason `"unsupported request <method>"`.
7. Notifications:
   - `item/completed` for command or file-change items → `action_result` (linked by item id → actionId);
   - agent message deltas aggregate into `message`;
   - `turn/completed` → `usage` if token or cost info is present → finish completed;
   - `turn/failed` or an error → failed.
8. Abort sends `turn/interrupt` (if available), then kills the child.

`codexApprovalToAction`:
- a command → kind `shell`, summary `Run: <command ≤150>`, paths = [cwd of the command if given];
- a file change → kind `file_write`/`file_edit` per change type, paths = every changed file path, summary `Edit <first path>` + ` (+N more)`;
- `paths` come only from params; the policy decides.

`fake-codex.mjs` is a script-driven fake app-server reading a JSON script from `THETERMINAL_FAKE_SCRIPT`. It must reproduce the real message shapes.

- [ ] **Step 1: Write failing tests (fake-codex):**
  - the happy path: started, then command approval asked, Allow → accept sent, then completed result recorded;
  - Deny → `decline` sent and no result;
  - a file change outside the worktree → policy auto-deny → `decline`;
  - an unknown server-request → recorded as denied with an error response;
  - **(Review Focus 1)** the thread/start params use the strict policy, and an adapter given a CLI whose schema lacks it refuses to start;
  - **(Review Focus 4)** abort mid-approval kills the fake within 6s and the pending gate is denied;
  - **(Review Focus 5)** the chatgpt-mode env has no `OPENAI_API_KEY`/`CODEX_API_KEY`, and api_key mode has exactly the configured one;
  - a missing binary → `"Codex CLI is not installed or not on PATH"`;
  - the live test (skipped by default) asks Codex to create a file, and the test's gate denies it, so the file doesn't exist.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test codex`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(agents): Codex adapter over app-server with per-action approvals`

---

### Task 4: Gemini adapter (ACP client with client-side fs and terminal)

**Files:**
- Create: `packages/core/src/agents/gemini/adapter.ts`, `packages/core/test/fixtures/fake-gemini.mjs`.
- Tests: `packages/core/test/agents/gemini-adapter.test.ts`, `gemini-live.test.ts` (`skipIf(process.env.THETERMINAL_LIVE_GEMINI !== "1")`).

**Interfaces:**
```ts
export class GeminiAdapter implements AgentAdapter {
  constructor(opts?: { bin?: () => string | null /* which("gemini") */; apiKey?: () => string | undefined; spawn?: typeof import("node:child_process").spawn });
}
```
Flow (verify against `@agentclientprotocol/sdk` and the installed gemini CLI version; use the SDK's client connection class if it fits our transport, else `JsonRpcPeer`):
1. Spawn `<gemini> --acp` (or the current flag; verify it) with cwd = the worktree and env = `buildChildEnv("gemini", …)`.
2. `initialize`, advertising `clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }`.
3. Authenticate: api_key → the API-key auth method; google → the user's existing login. If neither is available → fail `"Gemini is not logged in; run 'gemini' once yourself"`.
4. `session/new` with cwd and **no** MCP servers. Set the strictest session mode (every tool asks) if modes exist.
5. `session/prompt`.
6. Client methods we implement, each gated FIRST:
   - `fs/read_text_file` → `file_read`, path → `resolveInside` → after allow, read with an 8 MiB cap → return the content;
   - `fs/write_text_file` → `file_write` → after allow, write inside the worktree;
   - `terminal/create` → `shell`, summary `Run: <command + args ≤150>` → after allow, spawn with no shell (`execFile` semantics, args array), cwd = the worktree (reject any other cwd), env = the child env, and a 1 MiB output cap;
   - `terminal/output`, `wait_for_exit`, `kill` and `release` → operate only on terminals we created;
   - `session/request_permission` → gate a `ProposedAction` built from its `toolCall` (kind from the tool kind, paths from locations), and answer the **reject_once** option on deny or the **allow_once** option on allow (never allow_always).
7. Notifications: `session/update` tool_call / tool_call_update → `action_result` when completed or failed, linked by toolCallId when we gated it. Agent message chunks → `message`. Prompt response stop reason → finish.
8. **(Review Focus 1)** A `tool_call` update reporting execution of a tool we never gated (neither through fs/terminal nor through request_permission) → the run is failed immediately with `"agent executed an ungated tool"`, the child is killed, and it's recorded as a policy-denied `other` action.

`fake-gemini.mjs` is a script-driven fake ACP agent.

- [ ] **Step 1: Write failing tests (fake-gemini):**
  - a read inside the worktree is auto-allowed by policy and the content returned;
  - a write asks, Allow → the file is written;
  - Deny → no file and an error returned to the agent;
  - terminal create → asks → runs `node -e "console.log(1)"` → output returned and recorded redacted;
  - **(Review Focus 3)** fs read of `../x`, `/etc/passwd`, `.git/config` or a symlink escape → policy denied and nothing read;
  - terminal with a cwd outside → denied;
  - terminal output containing `sk-ant-TESTKEY…` is recorded redacted;
  - **(Review Focus 1)** an ungated tool_call execution → the run fails and the child is killed;
  - request_permission maps to allow_once/reject_once, never allow_always;
  - **(Review Focus 4/5)** like Codex: abort, env and a missing binary;
  - the live test (skipped by default) denies a write and the file doesn't exist.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test gemini`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(agents): Gemini adapter over ACP with client-mediated fs and terminal`

---

### Task 5: Server wiring and API

**Files:** Modify `packages/core/src/server/server.ts`, `agent-routes.ts`, `routes.ts`. Test `packages/core/test/server/agent-routes.test.ts`.

**Interfaces:**
- Register `codex` and `gemini` adapters always. The binary is checked at run start, not at registration.
- `GET /api/agents` → `{ adapters, providers: { claude|codex|gemini: { mode, installed: boolean } }, acks: PROVIDER_ACKS }`. `installed` comes from `which`, computed per request.
- `POST /api/settings/provider-auth {provider, mode, acknowledgement?}` → `{provider, mode}`. The existing `POST /api/settings/claude-auth` stays as an alias (provider claude) for compatibility.
- Test-only: when `THETERMINAL_FAKE_AGENT=1`, `THETERMINAL_CODEX_BIN` / `THETERMINAL_GEMINI_BIN` override the binary lookup (pointing at `node <fixture>` via a small wrapper). They are ignored otherwise.

- [ ] **Step 1: Write failing tests:**
  - the agents listing shape;
  - provider-auth validation (bad mode for a provider → 400; missing ack → 400);
  - the claude alias still works;
  - with the fake env plus fake bins, a codex run and a gemini run each go start → ask → allow → completed through the API;
  - without the fake env, the bin overrides are ignored (a missing CLI → the run fails with the not-installed error).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): Codex and Gemini agents and per-provider auth API`

---

### Task 6: UI — providers and auth

**Files:** Create `apps/ui/src/components/ProviderAuthSettings.tsx` (replacing ClaudeAuthSetting). Modify `AgentPanel.tsx`, `LedgerPanel.tsx`, `api.ts`, `App.tsx`. Tests `apps/ui/test/*`.

**Interfaces and copy:**
- The Agent select lists Claude, Codex and Gemini. A provider whose CLI isn't installed (except Claude in api_key mode) shows `(not installed)` and is disabled.
- `ProviderAuthSettings`: one section per provider with radios (`API key (recommended)` / `My own Claude subscription` | `My own ChatGPT plan` | `My own Google account`). A non-API mode shows the server's ack verbatim, a checkbox and **Confirm** (disabled until ticked), as for Claude in Plan 2.
- It renders even with no project selected, because the setting is global.
- `describeEntry` for `settings.provider_auth_changed` → `Owner set <Provider> to use <API key | own subscription | own ChatGPT plan | own Google account>`. The old claude event keeps its Plan 2 string.

- [ ] **Step 1: Write failing tests:**
  - the select shows not-installed providers as disabled;
  - each provider's Confirm stays disabled until the box is ticked and posts the exact ack;
  - the settings render with no project selected;
  - the describeEntry strings.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Codex and Gemini in the agent panel; per-provider auth settings`

---

### Task 7: End-to-end — Codex and Gemini through the gate

**Files:** Create `e2e/providers.spec.ts`. Modify `e2e/global-setup.ts` (the agent server also sets `THETERMINAL_CODEX_BIN`/`THETERMINAL_GEMINI_BIN` to the fixtures, plus scripts).

- [ ] **Step 1: Write the failing e2e test:**
  1. Start a Codex agent (fake). Its command card appears → Allow → the ledger shows `Owner allowed: approved`, then `Agent run completed`.
  2. Start a Gemini agent (fake). Its write card appears → Deny with "not now" → the ledger shows `Owner denied: not now`.
  3. The fake Gemini's read of `../outside` → `Policy denied: outside worktree`.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the test exposes.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows.
- [ ] **Step 5: Commit:** `test(e2e): Codex and Gemini agents through the approval gate`

---

## Done when

- Codex and Gemini runs start from the UI using the user's installed CLIs (with API key or own-login modes), and every command, file read, file write and permission request is recorded and decided before it executes.
- Any ungated execution fails the run.
- Plan 2's parked leak cases are closed.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI.
