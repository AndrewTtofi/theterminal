# Plan 2: Agent Runtime, Part A (glass-box Claude agent with human approval) Implementation Plan

**Goal:** An Owner starts an agent from the workspace. The agent works in its own git worktree. Every action it proposes is recorded in the ledger **before** it runs, and consequential actions wait on a decision card the Owner allows or denies. The first real agent is Claude, using an API key by default, or the user's own Claude Code login after an explicit, ledger-recorded opt-in. This plan also moves the workspace to its own local hostname, so the session cookie never reaches other local web servers.

**Architecture:**
- Agent work runs through one `AgentRunner`. It talks to provider adapters through a small `AgentAdapter` interface.
- The adapter's pre-execution hook calls a `gate(action)` function. The gate:
  1. redacts secrets;
  2. appends `agent.action.requested`;
  3. applies policy: auto-allow read-only actions inside the worktree, auto-deny file paths outside it, and ask a human for everything else;
  4. waits on the `ApprovalBroker`;
  5. appends `agent.action.decided`;
  6. returns allow or deny to the adapter.
- Every state event goes through one shared commit path, `commitEvent` (ledger append plus projection, one transaction, notify after commit). Board and agent projections share it.
- A test-only `FakeAdapter` drives unit tests and the e2e test. A live Claude test runs only when explicitly enabled through an environment variable.

**Tech Stack:** existing stack plus `@anthropic-ai/claude-agent-sdk` (0.3.x; read its shipped `sdk.d.ts` for the exact types) and the system `git` CLI (via `node:child_process` `execFile`, with no shell).

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` (§3 agents work and humans decide, §5 gates and ledger, §8 constraints, §10.2 mediate-don't-reconstruct, §10.3 provider terms and the Claude subscription opt-in, §4.1 own local address). Out of scope (Plan 2B): Codex (`codex app-server`) and Gemini (`gemini --acp`) adapters. Out of scope (Plan 3): plain-language narration.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs or ledger payloads. Use placeholders such as `owner` or `example.com`, and temp dirs.
- **Secrets never enter the ledger.** The ledger is append-only, so anything written is permanent. Every string an adapter reports (action input, output, messages, errors) passes through `redact()` before it is committed.
- **No absolute paths in the ledger.** Worktree and file paths are stored relative to the run's worktree, or relative to `dataDir`.
- **Never read, store, copy or proxy Claude.ai credentials or session tokens** (spec §10.3). Subscription mode only means "do not pass an API key; let the user's own installed Claude Code use its own login".
- Claude defaults to `api_key` auth. `subscription` mode requires a prior `settings.claude_auth_changed` ledger entry carrying the exact acknowledgement text.
- **Fail closed:** any adapter, hook or gate error, any timeout, or any restart while an action is pending results in **deny**, and the denial is recorded.
- Every agent action is recorded **before** it executes (spec §10.2). No adapter configuration may auto-approve tools outside our gate: no `allowedTools`, no `bypassPermissions`, and `settingSources: []`.
- Commits are authored by the repository owner only (repo-local noreply address), with no AI attribution or co-author trailers.
- Existing Plan 1 constraints still hold: Node ≥ 22, TS strict ESM, macOS and Windows, append-only ledger, 127.0.0.1 bind, default-deny auth.

## Review Focus

1. **Secrets in agent traffic.** A command like `curl -H "Authorization: Bearer sk-ant-…"`, an `.env` file read, or tool output containing `ANTHROPIC_API_KEY=…` must be stored redacted (`[REDACTED]`). (Tests in Task 2.)
2. **Restart with an action pending.** On startup, every action still `pending` is recorded as `agent.action.decided {decision:"deny", by:"policy", reason:"workspace restarted"}`, and its run is recorded as `agent.finished {status:"failed"}`. (Test in Task 5.)
3. **Two decisions for one action** (double click, two tabs). The first one wins. The second returns 409 `{error:"already_decided"}` and writes nothing. (Tests in Tasks 5 and 8.)
4. **A file action outside the worktree** (`/etc/passwd`, `../other-run/x`, a symlink escape). It is auto-denied by policy with reason `"outside worktree"` and never reaches a human or the tool. (Test in Task 5.)
5. **An adapter or hook crash mid-action.** The action is recorded as denied, the run as `failed` with a redacted error, and nothing hangs. (Tests in Tasks 6 and 7.)

---

## File Structure

```
packages/shared/src/agents.ts            # agent domain types + agent event payload schemas
packages/shared/src/events.ts            # (modify) EventType union + schema registry gain agent/settings events

packages/core/src/events/commit.ts       # commitEvent(): ledger append + projection in one tx, notify after commit
packages/core/src/events/projections.ts  # applyEvent registry: board + agent reducers (moves board/projections.ts here)
packages/core/src/agents/redact.ts       # redact(value) for strings/objects
packages/core/src/agents/worktrees.ts    # WorktreeManager (git via execFile)
packages/core/src/agents/policy.ts       # classify(action, worktree) → "auto_allow" | "auto_deny" | "ask"
packages/core/src/agents/approvals.ts    # ApprovalBroker
packages/core/src/agents/adapter.ts      # AgentAdapter interface + shared types
packages/core/src/agents/fake-adapter.ts # scripted adapter (tests + e2e only)
packages/core/src/agents/claude-adapter.ts
packages/core/src/agents/runner.ts       # AgentRunner (+ startup recovery)
packages/core/src/agents/settings.ts     # Claude auth mode setting (ledger-backed)
packages/core/src/server/agent-routes.ts
packages/core/src/server/auth.ts         # (modify) own hostname
packages/core/src/server/server.ts       # (modify) wire runner, recovery, hostname url

apps/ui/src/components/AgentPanel.tsx    # start run, run list, live actions
apps/ui/src/components/DecisionCard.tsx  # allow / deny pending actions
apps/ui/src/components/ClaudeAuthSetting.tsx
apps/ui/src/components/LedgerPanel.tsx   # (modify) describeEntry for new events
apps/ui/src/api.ts                       # (modify) agent endpoints
e2e/agent.spec.ts
```

---

### Task 1: Own local hostname (closes final-review I-5)

**Files:**
- Modify: `packages/core/src/server/auth.ts`, `packages/core/src/server/server.ts`, `packages/core/src/cli.ts`, `e2e/global-setup.ts`
- Test: `packages/core/test/server/auth.test.ts`, `packages/core/test/server/server.test.ts`

**Interfaces:**
- Produces: `export const APP_HOST = "theterminal.localhost";`. `RunningServer.url` becomes `http://theterminal.localhost:${port}/?token=${token}`. `RunningServer.loopbackUrl` = `http://127.0.0.1:${port}/` (no token).
- Rules (the server still binds 127.0.0.1 only):
  - The accepted Host set is `theterminal.localhost:${port}`, `127.0.0.1:${port}` and `localhost:${port}`.
  - **Cookie bootstrap (`GET /?token=`) is honoured only when Host is `theterminal.localhost:${port}`.** On `127.0.0.1` or `localhost`, `GET /?token=…` responds 302 to `http://theterminal.localhost:${port}/?token=…`, which keeps the token and sets no cookie.
  - The cookie stays host-only (no `Domain` attribute), so browsers never send it to `127.0.0.1:*` or `localhost:*`.
  - The accepted Origin is exactly `http://theterminal.localhost:${port}`, plus the two loopback origins (for Bearer clients).
  - Bearer auth keeps working on any accepted Host.

- [ ] **Step 1: Write failing tests:**
  - `GET /?token=T` with `Host: theterminal.localhost:P` → 302 to `/`, and the cookie has no `Domain`.
  - The same request with `Host: 127.0.0.1:P` → 302 whose `Location` is `http://theterminal.localhost:P/?token=T`, with no `Set-Cookie`.
  - `Origin: http://theterminal.localhost:P` + cookie → 200 on `/api/projects`.
  - `Host: evil.theterminal.localhost:P` → 403.
  - `createServer` url starts with `http://theterminal.localhost:`.
  - Every existing auth test still passes. Update any that assumed the bootstrap works on 127.0.0.1.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Test requests send `Host` explicitly. The e2e setup passes the `theterminal.localhost` url (Chromium resolves `*.localhost` to loopback).
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): serve workspace on its own local hostname so the session cookie stays isolated`

---

### Task 2: Agent domain, event schemas and secret redaction

**Files:**
- Create: `packages/shared/src/agents.ts`, `packages/core/src/agents/redact.ts`
- Modify: `packages/shared/src/events.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/agents.test.ts`, `packages/core/test/agents/redact.test.ts`

**Interfaces:**
```ts
// shared/agents.ts
export const ADAPTERS = ["claude", "fake"] as const; export type AdapterId = (typeof ADAPTERS)[number];
export type AuthMode = "api_key" | "subscription" | "none";
export const ACTION_KINDS = ["file_read", "file_write", "file_edit", "shell", "web", "mcp", "other"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type ActionStatus = "pending" | "allowed" | "denied" | "completed" | "failed";
export type RunStatus = "running" | "completed" | "failed" | "stopped";
export type AgentRun = { id: string; projectId: string; cardId: string | null; adapter: AdapterId;
  authMode: AuthMode; prompt: string; status: RunStatus; worktree: string /* relative to dataDir */;
  costUsd: number | null; error: string | null; startedAt: string; finishedAt: string | null };
export type AgentAction = { id: string; runId: string; kind: ActionKind; tool: string; summary: string;
  input: unknown; status: ActionStatus; decidedBy: "human" | "policy" | null; reason: string;
  output: string | null; requestedAt: string; decidedAt: string | null };
export const CLAUDE_SUBSCRIPTION_ACK = "I understand that running Claude on my own Claude subscription through The Terminal may violate Anthropic's terms and could put my account at risk. I choose to do this at my own risk.";
```
New `EventType` members and their **strict** payload schemas. All strings are bounded; longer values are truncated by the producer, never rejected:
- `agent.started` `{runId, adapter, authMode, prompt (1..20000), cardId: string|null, worktree (1..500, relative, must not start with "/" or match /^[A-Za-z]:/)}`
- `agent.message` `{runId, text (0..4000)}`
- `agent.action.requested` `{runId, actionId, kind, tool (1..200), summary (1..200), input: JSON value}`
- `agent.action.decided` `{runId, actionId, decision: "allow"|"deny", by: "human"|"policy", reason (0..500)}`
- `agent.action.completed` `{runId, actionId, ok: boolean, output (0..4000)}`
- `agent.finished` `{runId, status: "completed"|"failed"|"stopped", costUsd: number|null, error: string|null (≤1000)}`
- `settings.claude_auth_changed` `{mode: "api_key"|"subscription", acknowledgement: string}`. When mode is `subscription`, `acknowledgement` must equal `CLAUDE_SUBSCRIPTION_ACK` exactly.

```ts
// core/agents/redact.ts
export const REDACTED = "[REDACTED]";
export function redact<T>(value: T, extraSecrets?: string[]): T; // deep-copies strings/arrays/plain objects
export function truncate(s: string, max: number): string;          // appends "…[truncated]" when cut
```
Redaction rules:
- `sk-ant-[A-Za-z0-9_-]{10,}`, `sk-[A-Za-z0-9_-]{20,}`, `AKIA[0-9A-Z]{16}`, `gh[pousr]_[A-Za-z0-9]{20,}`, `xox[abposr]-[A-Za-z0-9-]{10,}`, `AIza[0-9A-Za-z_-]{35}`.
- `-----BEGIN [A-Z ]*PRIVATE KEY-----` through `-----END … -----`.
- `Bearer <token>`: keep `Bearer`, redact the token.
- `KEY=value` style pairs whose key matches `/(api[_-]?key|secret|token|password|passwd|private[_-]?key)/i`: redact the value.
- Any exact string in `extraSecrets`. The workspace token is always passed here.

- [ ] **Step 1: Write failing tests:**
  - Schema accept and reject cases for each new event, including an absolute `worktree` being rejected and a wrong acknowledgement being rejected.
  - **(Review Focus 1)** `redact("curl -H 'Authorization: Bearer sk-ant-abc123def456ghi'")` contains no `sk-ant` and contains `Bearer [REDACTED]`.
  - `redact({env:"ANTHROPIC_API_KEY=xyz123"})` → `{env:"ANTHROPIC_API_KEY=[REDACTED]"}`.
  - A PEM block is fully redacted.
  - `extraSecrets` is honoured.
  - Non-secret text is unchanged.
  - The input object is not mutated.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: agent domain, event schemas, secret redaction`

---

### Task 3: One commit path for all state events, plus agent projections

**Files:**
- Create: `packages/core/src/events/commit.ts`, `packages/core/src/events/projections.ts`
- Delete: `packages/core/src/board/projections.ts` (its reducer moves into `events/projections.ts`)
- Modify: `packages/core/src/board/board-service.ts` (uses `commitEvent`), `packages/core/src/db.ts` (migration: `agent_runs`, `agent_actions`, `settings` tables), `packages/core/src/index.ts`
- Test: `packages/core/test/events/commit.test.ts`, `packages/core/test/events/projections.test.ts`; the existing board tests must still pass unchanged

**Interfaces:**
```ts
export function commitEvent<T>(db: Db, ledger: Ledger,
  build: () => { event?: NewLedgerEntry; result: (entry: LedgerEntry | null) => T },
  apply?: (db: Db, e: LedgerEntry) => void): T;
// immediate tx: build() → appendInTransaction → apply; then ledger.notify after commit. No event → no write.
export function applyEvent(db: Db, e: LedgerEntry): void;   // board + agent + settings reducers
export function rebuildAllProjections(db: Db, ledger: Ledger, opts?: { beforeSeq?: number }): void;
```
- `BoardService.rebuildProjections` delegates to `rebuildAllProjections`. The server startup (from Plan 1's final fix) now rebuilds every projection.
- Projections:
  - `agent_runs` from `agent.started` and `agent.finished`.
  - `agent_actions` from requested, decided and completed. `decided` sets status `allowed` or `denied`. `completed` sets `completed` or `failed`.
  - `settings(key, value)` from `settings.claude_auth_changed` (key `claude_auth_mode`).
  - Timestamps come from the entry `ts`.

- [ ] **Step 1: Write failing tests:**
  - `commitEvent` rolls back the ledger row when `apply` throws, and notifies only after commit.
  - Feeding a scripted agent event sequence through `applyEvent` yields the expected `agent_runs` and `agent_actions` rows.
  - A rebuild after a mixed board + agent history is deep-equal to the live projections.
  - The settings projection holds the last mode.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Move the board reducer without behaviour change.
- [ ] **Step 4:** Run the same command. Expected: PASS, including all Plan 1 tests.
- [ ] **Step 5: Commit:** `refactor(core): single commit path for state events; agent projections`

---

### Task 4: Worktree manager

**Files:**
- Create: `packages/core/src/agents/worktrees.ts`
- Test: `packages/core/test/agents/worktrees.test.ts` (real `git` in a temp dir)

**Interfaces:**
```ts
export class WorktreeManager {
  constructor(dataDir: string, git?: (args: string[], cwd: string) => Promise<string>);
  ensureProjectRepo(projectId: string): Promise<string>;   // <dataDir>/projects/<projectId>/repo, git init + empty initial commit
  createRunWorktree(projectId: string, runId: string): Promise<{ absPath: string; relPath: string }>;
  // `git worktree add -b run/<runId> <dataDir>/projects/<projectId>/worktrees/<runId>`; relPath relative to dataDir, "/" separators
  resolveInside(worktreeAbs: string, p: string): string | null; // realpath-resolved absolute path if inside worktree, else null
}
```
- The repo's commits use a fixed local identity, `-c user.name="The Terminal" -c user.email="agent@theterminal.localhost"`. They never use the user's global git identity, so no personal data ends up in project history.
- Use `execFile("git", args, {cwd})` with no shell.

- [ ] **Step 1: Write failing tests:**
  - `ensureProjectRepo` is idempotent.
  - Two runs get two separate worktrees on separate branches.
  - `relPath` has no drive letter or leading slash and uses `/`.
  - `resolveInside` returns null for `../x`, an absolute path elsewhere, and a symlink pointing outside. It returns a path for `src/a.ts`, including a not-yet-existing file whose parent is inside.
  - The initial commit's author email is `agent@theterminal.localhost`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test worktrees`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): per-run git worktrees`

---

### Task 5: Policy, approval broker and agent runner (with the FakeAdapter)

**Files:**
- Create: `packages/core/src/agents/adapter.ts`, `policy.ts`, `approvals.ts`, `fake-adapter.ts`, `runner.ts`
- Test: `packages/core/test/agents/policy.test.ts`, `approvals.test.ts`, `runner.test.ts`

**Interfaces:**
```ts
// adapter.ts
export type ProposedAction = { tool: string; kind: ActionKind; summary: string; input: unknown; paths: string[] };
export type GateResult = { decision: "allow" | "deny"; reason: string };
export type AdapterEvent =
  | { type: "message"; text: string }
  | { type: "action_result"; actionId: string; ok: boolean; output: string }
  | { type: "usage"; costUsd: number };
export interface AdapterStartOptions {
  cwd: string; prompt: string; authMode: AuthMode; signal: AbortSignal;
  gate: (a: ProposedAction) => Promise<GateResult & { actionId: string }>;
  emit: (e: AdapterEvent) => void;
}
export interface AgentAdapter { id: AdapterId; start(o: AdapterStartOptions): Promise<{ status: "completed" | "failed"; error?: string }>; }

// policy.ts
export function classify(a: ProposedAction, worktreeAbs: string, wt: WorktreeManager): { verdict: "auto_allow" | "auto_deny" | "ask"; reason: string };
//  any path not inside the worktree → auto_deny "outside worktree"; file_read with all paths inside → auto_allow "read-only inside worktree"; everything else → ask

// approvals.ts
export class AlreadyDecidedError extends Error {}
export class ApprovalBroker {
  wait(actionId: string, signal: AbortSignal): Promise<GateResult>; // resolves on decide(); signal abort → deny "run stopped"
  decide(actionId: string, decision: "allow" | "deny", reason: string): void; // throws AlreadyDecidedError / NotFoundError
  pendingIds(): string[];
}

// runner.ts
export class AgentRunner {
  constructor(deps: { db: Db; ledger: Ledger; worktrees: WorktreeManager; broker: ApprovalBroker;
    adapters: Partial<Record<AdapterId, AgentAdapter>>; extraSecrets: string[]; newId?: () => string });
  start(actor: Actor, input: { projectId: string; adapter: AdapterId; prompt: string; cardId?: string | null }): Promise<AgentRun>;
  decide(actor: Actor, actionId: string, decision: "allow" | "deny", reason?: string): AgentAction; // 409-able AlreadyDecidedError
  stop(actor: Actor, runId: string): void;
  listRuns(projectId: string): AgentRun[]; getRun(runId: string): { run: AgentRun; actions: AgentAction[] };
  recoverOnStartup(): void; // Review Focus 2
}
```
Runner flow:
1. `start` checks that the project exists (`NotFoundError`) and that `ledger.readOnly` is false (`LedgerReadOnlyError`).
2. It resolves `authMode`: `claude` uses the settings projection (default `api_key`); `fake` uses `none`.
3. It creates the worktree, commits `agent.started` with actor `{kind:"human", id:"owner"}`, and returns the run. The adapter is not awaited: it runs in the background.
4. Each `gate(a)` call runs:
   - `redact` + truncate;
   - commit `agent.action.requested` (actor `{kind:"agent", id: runId}`);
   - `classify`;
   - on auto: commit `decided {by:"policy"}` with actor `{kind:"system", id:"policy"}`;
   - on ask: `broker.wait`, with the decision committed by `decide()` under the human actor;
   - return.
5. Any exception inside the gate is treated as deny, and the denial is still committed.
6. `emit` events become `agent.message`, `agent.action.completed` and usage events (all redacted).
7. When the adapter returns or throws, the runner commits `agent.finished`.
8. `stop` aborts the signal, which denies pending actions with "run stopped", and finishes the run with status `stopped`.

`FakeAdapter` takes a script: `Array<{propose: ProposedAction; result?: {ok: boolean; output: string}} | {message: string} | {throw: string}>`. For each `propose` it calls `gate`, then emits `action_result` with the script's result only if allowed. It is **only** registered when `THETERMINAL_FAKE_AGENT=1`.

- [ ] **Step 1: Write failing tests:**
  - policy: an inside read → `auto_allow`; an inside write → `ask`; shell → `ask`; **(Review Focus 4)** `/etc/passwd`, `../x` and a symlink escape → `auto_deny`.
  - broker: decide resolves the wait; **(Review Focus 3)** a second decide throws `AlreadyDecidedError`; an abort → deny.
  - runner + FakeAdapter, a full happy path: ledger order is started → requested → decided(policy, read) → completed → requested → (human allow) → decided → completed → finished.
  - A denied action never gets `action_result`.
  - The ledger contains no unredacted secret from a scripted input.
  - **(Review Focus 2)** with a pending action, a new runner's `recoverOnStartup()` commits a policy deny "workspace restarted" and `agent.finished failed`.
  - Starting a run in read-only mode throws `LedgerReadOnlyError`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test agents`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): agent runner with policy gate and human approvals`

---

### Task 6: Claude adapter and the auth-mode setting

**Files:**
- Create: `packages/core/src/agents/claude-adapter.ts`, `packages/core/src/agents/settings.ts`
- Test: `packages/core/test/agents/claude-adapter.test.ts` (uses an injected fake `query`), `packages/core/test/agents/claude-live.test.ts` (`describe.skipIf(process.env.THETERMINAL_LIVE_CLAUDE !== "1")`)

**Interfaces:**
```ts
export function toolToAction(tool: string, input: Record<string, unknown>, cwd: string): ProposedAction;
//  Read/Glob/Grep/LS → file_read; Write → file_write; Edit/MultiEdit/NotebookEdit → file_edit; Bash → shell;
//  WebFetch/WebSearch → web; mcp__* → mcp; else other. paths from file_path/path/notebook_path (cwd-relative).
//  summary: "Run: <command ≤150>", "Edit <relpath>", "Read <relpath>", etc.
export class ClaudeAdapter implements AgentAdapter {
  constructor(opts?: { query?: typeof import("@anthropic-ai/claude-agent-sdk").query; apiKey?: () => string | undefined });
}
export class ClaudeSettings {
  constructor(db: Db, ledger: Ledger);
  getMode(): "api_key" | "subscription";
  setMode(actor: Actor, mode: "api_key" | "subscription", acknowledgement?: string): void; // subscription requires exact CLAUDE_SUBSCRIPTION_ACK
}
```
Adapter rules (verify each against the installed SDK's `sdk.d.ts`):
- `query({ prompt, options })` with `cwd`, `permissionMode: "default"`, `settingSources: []`, **no** `allowedTools`, and a `hooks.PreToolUse` callback with fail-closed behaviour (`onFailure: "block"` or the SDK's equivalent).
- The callback calls `gate(toolToAction(...))` and returns the SDK's allow or deny decision with the reason.
- A `PostToolUse` hook maps tool outputs to `action_result`, linked by tool-use id.
- The result message cost goes to `usage`.
- Assistant text goes to `message`.
- **api_key:** pass `ANTHROPIC_API_KEY` from `apiKey()` (in this plan, read from `process.env.ANTHROPIC_API_KEY`; the keychain arrives in Plan 5). If it's missing, fail the run with error `"No Anthropic API key configured"`.
- **subscription:** pass an env **without** any `ANTHROPIC_API_KEY`, so the user's own logged-in Claude Code is used. Never read `~/.claude` or any credential file.
- The `AbortSignal` interrupts the query.

- [ ] **Step 1: Write failing tests** (with a fake `query` that yields scripted SDK messages and invokes the registered PreToolUse hook):
  - The tool mapping table.
  - A hook deny is returned when the gate denies.
  - **(Review Focus 5)** if the gate throws, the hook returns deny and the run fails with a redacted error.
  - The api_key mode env contains the key; the subscription mode env has no `ANTHROPIC_API_KEY`; with no key in api_key mode the run fails with the exact message.
  - The options passed have `settingSources: []` and no `allowedTools`.
  - `ClaudeSettings` rejects subscription without the exact acknowledgement, and records it when given.
  - A live test (skipped by default) runs a tiny read-only prompt against a temp worktree.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test claude`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `@anthropic-ai/claude-agent-sdk` to core.
- [ ] **Step 4:** Run the same command. Expected: PASS, with the live test skipped.
- [ ] **Step 5: Commit:** `feat(core): Claude adapter with pre-execution gate; opt-in subscription mode`

---

### Task 7: Agent API routes and server wiring

**Files:**
- Create: `packages/core/src/server/agent-routes.ts`
- Modify: `packages/core/src/server/server.ts` (construct WorktreeManager, ApprovalBroker, ClaudeSettings and AgentRunner; register the `claude` adapter, plus `fake` only when `THETERMINAL_FAKE_AGENT=1`; pass the token as an extra secret; call `recoverOnStartup()` after the projection rebuild; stop runs on close), `routes.ts` (error map: `AlreadyDecidedError` → 409 `{error:"already_decided"}`)
- Test: `packages/core/test/server/agent-routes.test.ts`

| Method & path | Body | 2xx |
|---|---|---|
| `GET /api/agents` | — | `{ adapters: AdapterId[], claudeAuthMode, subscriptionAck: string }` |
| `POST /api/settings/claude-auth` | `{mode, acknowledgement?}` | `{ mode }` |
| `POST /api/projects/:id/runs` | `{adapter, prompt, cardId?}` | 201 `AgentRun` |
| `GET /api/projects/:id/runs` | — | `AgentRun[]` newest first |
| `GET /api/runs/:id` | — | `{run, actions}` |
| `POST /api/runs/:id/stop` | — | `AgentRun` |
| `POST /api/actions/:id/decision` | `{decision: "allow"\|"deny", reason?}` | `AgentAction` |

- [ ] **Step 1: Write failing tests:**
  - Each row works (using `fake` with a scripted run).
  - An unknown adapter → 400.
  - A `fake` adapter when the env var is unset → 400 `{error:"invalid_input"}`.
  - **(Review Focus 3)** a second decision → 409.
  - A decision on an auto-decided action → 409.
  - Subscription without the ack → 400.
  - **(Review Focus 5)** a scripted `{throw}` → the run is failed, the action denied, and the response time is bounded.
  - `close()` with a pending action doesn't hang.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): agent run, decision and settings API`

---

### Task 8: UI — agent panel, decision cards, Claude auth setting

**Files:**
- Create: `apps/ui/src/components/AgentPanel.tsx`, `DecisionCard.tsx`, `ClaudeAuthSetting.tsx`
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/App.tsx`, `apps/ui/src/components/LedgerPanel.tsx`
- Test: `apps/ui/test/DecisionCard.test.tsx`, `AgentPanel.test.tsx`, `ClaudeAuthSetting.test.tsx`, `LedgerPanel.test.tsx` (new strings)

**Interfaces and copy:**
- `AgentPanel` (per selected project):
  - an adapter select (from `GET /api/agents`), a prompt textarea, and a "Start agent" button;
  - a run list showing status and cost;
  - selecting a run shows its actions: kind icon, summary, status, and "decided by human/policy".
  - It refreshes on ledger WS entries for that project through the same coalescer pattern as the board.
- `DecisionCard` for every `pending` action, always visible in a "Needs you" strip that no layout can hide (spec §4.3):
  - title `Agent wants to: <summary>`;
  - a collapsible "Details" `<pre>` with the redacted input;
  - buttons **Allow** and **Deny** (Deny reveals an optional reason input);
  - 409 → "Already decided".
- `ClaudeAuthSetting`:
  - a radio with "API key (recommended)" and "My own Claude subscription".
  - Choosing subscription shows the exact `subscriptionAck` text from the server in a warning box, a checkbox "I understand and accept this risk", and **Confirm**. Confirm is disabled until the box is checked, then it posts the ack.
- `describeEntry` additions (human owner → "Owner", agent actor → `Agent <first 8 chars of id>`, system policy → "Policy"):
  - `agent.started` → `Owner started a <Adapter> agent: "<prompt ≤60>"`
  - `agent.action.requested` → `<Actor> wants to: <summary>`
  - `agent.action.decided` → `<Actor> allowed: <reason or "approved">` / `<Actor> denied: <reason or "rejected">`
  - `agent.action.completed` → `<Actor> finished an action` / `<Actor> action failed`
  - `agent.message` → `<Actor> said: "<text ≤80>"`
  - `agent.finished` → `Agent run <status>`
  - `settings.claude_auth_changed` → `Owner set Claude to use <API key | own subscription>`
  - unknown type → `<Actor> recorded <type>`, which also closes the Plan 1 deferred minor.

- [ ] **Step 1: Write failing tests:**
  - DecisionCard calls `onDecide(id,"allow")`; Deny with a reason calls `onDecide(id,"deny","too risky")`; 409 renders "Already decided".
  - ClaudeAuthSetting's Confirm stays disabled until the checkbox is ticked and posts the exact ack.
  - Every `describeEntry` string above.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): agent panel, decision cards, Claude auth setting`

---

### Task 9: End-to-end — run an agent, approve and deny

**Files:**
- Create: `e2e/agent.spec.ts`
- Modify: `e2e/global-setup.ts` (set `THETERMINAL_FAKE_AGENT=1` and a fake-script env such as `THETERMINAL_FAKE_SCRIPT=<json>` read by the fake adapter; document both in the adapter)

- [ ] **Step 1: Write the failing e2e test:**
  1. Create project "Local Model Hub".
  2. Start a `fake` agent with prompt "Detect GPU". The script is: read `README.md` (auto-allowed), run `nvidia-smi` (asks), edit `/etc/hosts` (auto-denied).
  3. A decision card "Agent wants to: Run: nvidia-smi" appears. Click **Allow**.
  4. The ledger panel shows, in order: the started line; `Policy allowed: read-only inside worktree`; `Owner allowed: approved`; `Policy denied: outside worktree`; `Agent run completed`.
  5. No decision card remains.
  6. Start a second run and **Deny** its shell action with reason "not now". The ledger shows `Owner denied: not now`.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the test exposes.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push to the branch and confirm CI is green on macOS and Windows (the repo now has a remote; pushing a feature branch is fine).
- [ ] **Step 5: Commit:** `test(e2e): agent run with policy and human decisions`

---

## Done when

- An Owner can start a Claude agent (API key) or a fake agent from the UI.
- Every action appears in the ledger before it runs. Reads inside the worktree auto-run, outside paths are auto-denied, and everything else waits for Allow or Deny.
- Secrets never appear in the ledger. A restart with pending actions denies them.
- Subscription mode is opt-in only, carries the recorded acknowledgement, and never touches credentials.
- The session cookie is only ever sent to `theterminal.localhost`.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI.
