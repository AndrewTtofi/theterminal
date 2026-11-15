# Plan 4: Rich Workspace Implementation Plan

**Goal:** The Owner can see everything an agent did to the project without ever editing it: a Changes view lists the files each run touched, a diff tab shows every change line by line, a Files tab shows any file in a run's working copy, a Terminal tab shows every command an agent ran with its output, and a live Agent feed follows every run. A Conversation tab is where the Owner asks an agent for a change. Decisions and gates get their context (what the agent proposes to write, what it said just before; what the run has changed shows once the run is stopped or finished, since a live run's working copy is never read). A Learn view explains, in plain words, whatever the Owner is looking at. The workspace has the two layout presets the spec names (Guided, Operator) and saved layouts. The emergency override, the one way a human acts directly instead of through an agent, exists in exactly two forms, requires a reason, and is recorded in red everywhere the ledger is shown.

**Architecture:**
- **Read-only by construction.** Every file, directory and diff the UI shows comes from four `GET` routes under `/api/runs/:id/`, each resolving its `path` through the existing `WorktreeManager.resolveInside` against the run's worktree (`<dataDir>/<run.worktree>`), so nothing outside the worktree, nothing under `.git`, and nothing through a symlink that leaves it can be read. There is no route that writes a file. Diffs come from `git` run with `execFile` and argument arrays (no shell, `--no-pager`, `--no-ext-diff`, `--no-textconv`, `-c core.fsmonitor=false`), through the manager's git runner and its `gitEnv`, and are compared to the run branch's fork point from the project repository's `HEAD` (`git merge-base`). Everything served is cleaned the way the runner cleans agent text (redact, scrub paths, redact, then truncate) before any size cap applies.
- **Unified diffs are rendered by our own parser.** `git` already emits unified diffs; `parseUnifiedDiff` in `@theterminal/shared` turns one into hunks and typed lines, and a React component paints them. No diff library and no Monaco (see Decisions).
- **The emergency override is a service with two actions**, `command` (a program run in a run's worktree) and `discard` (reset the worktree to its last commit), both recorded in two phases (`override.command` or `override.discard`, then `override.completed`) with a mandatory reason, refused while the run's agent is still running, executed with `execFile` from a PATH-resolved absolute program path and the allowlisted child environment (no credentials), with output cleaned before truncation. Narration gives `override.*` entries their own topic and `attention: true`; every place that lists entries paints them with the `override` class (red).
- **The feed and the terminal are derived from the ledger stream the UI already has** (`agent.*` and `override.*` entries of the selected project), not from polling run details, so they are live by the same mechanism as everything else. The ledger panel pages (newest first) instead of holding every entry.
- **Layouts are dockview serialisations.** Two presets are code (`PRESETS.guided`, `PRESETS.operator`); saved layouts are named serialisations in `localStorage`; the Needs-you strip and status bar remain outside the dock, so no preset or saved layout hides a decision or a gate.
- **Learn is a fixed catalog** (`LEARN_TOPICS` in `@theterminal/shared`), ranked by the current context (view, stage, action kind, gate). Decision and gate cards link to the topic that explains them.

**Tech Stack:** existing stack only (TypeScript strict ESM, zod 4, better-sqlite3, Fastify 5, React 18 + `dockview-react` 8.8.3, Vitest 4, Playwright). No new dependencies: `dockview-react` stays at 8.8.3 (8.9.0 was published 2026-11-08, under two weeks before this plan); `node:child_process` `execFile` for git and overrides; `node:fs` for listings and file reads.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §2 goal 3 (glass box: raw detail underneath) and anti-goal "black box", §3 (code views and the terminal are inspection tools; changes go through an agent; emergency override logged in red), §4.3 (panels: conversation, live agent feed, needs-you, ledger, learn, code and diffs read-only, terminal read-only, cost and usage; presets Guided and Operator; saved layouts; decisions can't be hidden), §5 (learn on the way), §7 (building blocks: Monaco and xterm.js considered, see Decisions), §10.2 (agents confined to the worktree), §12 calls 1 and 2. Builds on Plans 1, 2, 2B, 5A, 5B and 3 (`docs/plans/`): 5B's `DockPanelId` `capacity`, `/api/status` shape, `connectionIds` on runs and the access picker; Plan 3's `narrate`/`NarrationTopic`, `commitEvents`, `HumanRequiredError`, `SecretInTextError`, `GateCard`, `StoryPanel`, `story:<cardId>` and `intake` panels, `model.gate`, `model.narration`, `onStartRun(adapter, prompt, cardId?, connectionIds?)` and `ledger.list({ cardId, runIds })` are assumed to exist. This branch is cut from `main` after Plan 3 merges.

## Decisions

- **Decision (controller default): no diff library and no Monaco; `git` produces unified diffs on the server and the UI parses and paints them with its own ~100-line parser and component.** Why: the diff *text* comes from git, so no diff algorithm is needed in the browser; a parser for the unified format is smaller than any dependency (candidates checked with `npm view … time` on 2026-11-15: `diff` 9.0.0 BSD-3 is an algorithm we do not need; `parse-diff` 0.12.0 MIT had no release between 2023 and April 2026; `react-diff-viewer-continued` and `@git-diff-view/react` bring their own styling and React trees for a read-only view); Monaco's diff editor is several megabytes, needs worker wiring under Vite, and is an *editor*, which this workspace must not have (spec §3, the author's VS Code-layout-only preference). A proposed edit on a decision card is shown as the recorded old and new text with `-`/`+` prefixes, not computed as a diff, so no algorithm is needed there either.
- **Decision (controller default): no xterm.js; the Terminal tab renders the recorded commands and outputs as text with ANSI escapes stripped and control characters made visible.** Why: the terminal is an inspection tool (spec §3) over output the ledger already holds; nothing is interactive and nothing streams byte by byte, so a terminal emulator adds 300 kB and a canvas for no information. If a later plan streams a live PTY, xterm.js can be reconsidered then.
- **Decision (controller default): a run's changes are the working tree of its worktree compared to the fork point of its branch from the project repository's `HEAD` (`git merge-base HEAD <repo HEAD>`), plus untracked files.** Why: a run works on branch `run/<id>` created from the repository's head (Plan 2); comparing to the fork point shows everything the run did whether or not the agent committed; untracked files are what a fresh file looks like before a commit, so they must appear or the view lies. When the fork point cannot be found the route fails closed (`no_base`) rather than guessing.
- **Decision (controller default): file and directory browsing is confined to the run's worktree through `resolveInside`, which already refuses `..`, `.git`, dangling symlinks and anything that resolves outside; `.git` is never listed or served; nothing is cached on the server.** Why: the existing function is the one place that knows how to fail closed on every platform (case folding on Windows, realpath on the longest existing ancestor), and the policy gate already trusts it; a second implementation would be a second place to get wrong.
- **Decision (controller default): the emergency override covers exactly two actions, both on one run's worktree: (1) `command`: run a program the Owner names, with arguments, as a child process in the worktree (or a subdirectory of it); (2) `discard`: reset the worktree to its last commit (`git checkout -- .` then `git clean -fd`). It does not cover: deciding an agent's action, stopping a run, waiving a gate (Plan 3's own event), or editing or creating a file by hand (no such route exists, and none will).** Why: spec §3 reserves the override for "direct human intervention" and the author's rule is that humans never author code; stopping and undoing are interventions, authoring is not. A command runner covers the real emergencies (kill a process, revert a commit, stop a deployment) without The Terminal choosing which commands count. Both actions need a reason of 10 to 500 characters (checked for secrets like intake text), are refused while the run's agent is still running (`run_active`: the Owner stops it first, so an agent and a human never work in the same tree at once), run with `execFile` and never a shell, resolve the program on PATH only (never the current directory, never a path inside the worktree or the data directory, never a Windows `.cmd`/`.bat`, which Node cannot run without a shell), receive the allowlisted base environment and no connection credentials, are killed after 10 minutes, and record both the request and the outcome. Everything about them is painted red, and the narration prefixes `OVERRIDE:`.
- **Decision (controller default): performance limits.** Changed-file list: 500 files (`truncated: true` beyond, the UI says so). One file's diff: shown only when added + deleted lines ≤ 5,000 and the diff text ≤ 1 MiB after cleaning (`tooLarge: true` otherwise; the UI offers the file view and "ask an agent to summarise"). Files: read only when ≤ 1 MiB (`tooLarge` otherwise); binary (a NUL byte in the first 8 KiB) files are not shown; the UI paints at most 20,000 lines. Directory listings: 2,000 entries. Git calls: 30 s timeout, 2 MiB output buffer; exceeding either is `tooLarge`, never a crash. Ledger panel: the newest 500 entries are loaded, 200 are painted, `Show older entries` paints 200 more and fetches 500 more with `beforeSeq` when the loaded ones run out. Feed and Terminal: the newest 500 items. Override output: 16,000 characters after cleaning, 1 MiB buffer before. Why: the UI runs on the Owner's laptop against a ledger that only grows; every cap is a fixed number so behaviour at the cap is testable, and every cap is applied after redaction so a cut can never expose what a pattern would have matched.
- **Decision (controller default): presets.** `Guided` (default for a fresh browser): main group `Board` and `Conversation`, no bottom group. `Operator`: main group `Board`, `Capacity`; bottom group (30 %) `Terminal`, `Agent feed`, `Ledger`. Up to 10 saved layouts, names of 1 to 40 characters, in `localStorage`. Why: spec §4.3 names the presets and their contents ("board plus conversation"; "board, code, terminal, feed, ledger, cost"); code tabs (diffs, files) are per run and open on demand, and "cost" is the Capacity tab since 5B. The existing default (Board + feed + ledger) is Operator without Capacity, so the e2e specs that need the Ledger tab choose Operator first.
- **Decision (controller default): the Conversation tab is a thread of runs (the Owner's prompt, the agent's messages, a one-line result) with an `Ask an agent` form; it does not continue a run.** Why: none of the three adapters exposes a resumable session through the gate today, so a follow-up is a new run on the same card, which is also what the ledger can show honestly.

## Out of scope (later plans)

- Linked machines, a project spanning two Terminals, runs on another machine's worktree: Plan 6. The routes here take a run id and read this machine's data directory only.
- The share view, present mode, PDF, the tech-stack table and daily digests (§4.4): Plan 7. Plan 4 gives it the diff and file routes and the narration of overrides.
- Roles, presence ("who is in the project and what they are looking at"), gates requiring a person or role, collaborators' view of code (§4.5): Plan 8. Every actor here is `{ kind: "human", id: "owner" }`; the UI shows the acting human's name on every entry (today always `Owner`), and the status bar leaves no slot that Plan 8 cannot add.
- Installers: Plan 9. Nothing here depends on how the app is installed.
- Monitoring and observability panels: the observability lifecycle pack. Agents proposing decision cards; multi-turn agent sessions; the capacity router pausing runs on budget.
- A live PTY and xterm.js; Monaco; a code editor of any kind (never).

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Fixtures write files such as `notes.txt` containing `key=zq-TESTKEY-e2e-opaque-0000000000`; recorded paths are relative to the worktree.
- **Every new route sits behind the default-deny auth** (`registerAuth`): `/api/runs/:id/changes`, `/diff`, `/files`, `/file`, `/override/*` answer 401 without the cookie or bearer token.
- **Read-only by construction.** No route under this plan writes into a worktree except the two override routes, which are `POST`, require a reason, and record two ledger entries each. The UI has no editor, no "save" and no file upload.
- **Every served path goes through `resolveInside`** against the run's worktree; `.git` is never listed or served; a path that fails resolution answers 404 `not_found` with no detail of why.
- **Git only through `execFile` with argument arrays**, via the manager's git runner and `gitEnv` (no `GIT_*` inheritance, empty global config, `GIT_CEILING_DIRECTORIES`), always with `--no-pager`, `-c core.fsmonitor=false`, `-c core.quotePath=false`, and on diffs `--no-ext-diff --no-textconv --no-renames`; 30 s timeout and 2 MiB buffer. No `shell: true` anywhere, including overrides.
- **Clean before you cut.** Every string served from a worktree or an override (diff text, file text, directory names, override output) passes the runner's cleaning for that run (redact known secrets, scrub the worktree, data dir, home and username, redact again) before any truncation or cap.
- **Overrides are human, reasoned, exclusive and recorded.** `HumanRequiredError` for any non-human actor; a reason of 10..500 characters that `redact` leaves unchanged (`secret_in_text` otherwise), the same for every argument; refused while the run is `running` (`run_active`) or another override is active (`override_busy`); `override.command`/`override.discard` committed before the process starts, `override.completed` after it ends (or is killed at 10 minutes or at shutdown); nothing recorded when the request is refused.
- **Red means override.** Every list of ledger entries (ledger panel, story, feed, terminal, Needs-you history) gives `override.*` entries the `override` class; narration gives them topic `override`, `attention: true` and the `OVERRIDE:` prefix.
- **Decisions and gates surface in every layout**, including both presets and every saved layout: the strip and the status bar stay outside the dock; floating groups stay disabled.
- **Limits are fixed numbers** (Decisions) exported as constants from `@theterminal/shared`, applied after cleaning, and reported in the response (`truncated`, `tooLarge`) rather than guessed at by the UI.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`** (unchanged); the fake adapter's new `write` step is part of that double.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-4-rich-workspace`, one commit per task, pushed when it lands, and merges through a pull request once CI is green on macOS and Windows. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1/2/2B/5A/5B/3 constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, 127.0.0.1 bind, every agent action gated before it runs, allowlisted child env via `buildChildEnv`/`baseChildEnv`, keychain-only secrets, live redaction, estimates labelled `estimate`, narration pure).

## Review Focus

1. **A path that leaves the worktree.** `GET /api/runs/:id/file?path=` with `../token`, `/etc/hosts`, `C:\Windows\win.ini`, `.git/config`, a symlink inside the worktree pointing outside it, and a dangling symlink. Expected: 404 `not_found` every time, an empty body otherwise, no file read; the same for `/files` and `/diff`. (Tests in Task 2.)
2. **A secret in a diff, a file or an override's output.** A run writes `notes.txt` containing a stored connection key; an override runs `node -e "console.log(process.env.PATH, 'key=<the key>')"`. Expected: the diff shows `+key=[REDACTED]`, the file view shows `key=[REDACTED]`, the recorded override output shows `[REDACTED]`, and no response body during the e2e contains the key. (Tests in Tasks 2, 3 and 11.)
3. **An override that must be refused.** While the fake run is still running (its shell step pending), `POST …/override/command`; then with a 5-character reason; then with `program: "./node_modules/.bin/x"` (inside the worktree); then with an argument containing the key; then a second override while one is running. Expected: 409 `run_active`, 400 `invalid_input`, 400 `program_not_allowed`, 400 `secret_in_text`, 409 `override_busy`, and `ledger.headSeq()` unchanged after each. (Tests in Task 3.)
4. **Things that are too big.** 600 changed files, one 10,000-line change, a 2 MiB file, a directory of 3,000 entries, a project with 3,000 ledger entries. Expected: `truncated: true` with 500 files and the note `Showing 500 of more files`; `tooLarge: true` with the counts and no text, while the list still loads; `tooLarge: true` for the file; 2,000 entries and `truncated`; the ledger panel paints 200, `Show older entries` paints 200 more and fetches the next 500 with `beforeSeq`; nothing hangs. (Tests in Tasks 2, 5 and 7.)
5. **A layout that hides panels.** The Guided preset (no bottom group), a saved layout with the bottom group closed, and a saved layout holding `diff:<run that no longer exists>:…`. Expected: a pending action's card and a gate card render in the strip and the status bar count updates in every case; the stale diff tab is closed on load and the rest of the layout restores. (Tests in Tasks 4 and 11.)

---

## File Structure

```
packages/shared/src/changes.ts            # RunChanges, FileDiff, DirListing, FileContent, limits, parseUnifiedDiff (Task 1)
packages/shared/src/override.ts           # OVERRIDE_REASON, override.* payload schemas, OVERRIDE_MEANS (Task 1)
packages/shared/src/learn.ts              # LEARN_TOPICS, topicsFor, ACTION_TOPIC, GATE_TOPIC (Task 1)
packages/shared/src/narration.ts          # (modify, Plan 3) override templates, topic "override" (Task 1)
packages/shared/src/events.ts, index.ts   # (modify) EventType gains override.* (Task 1)

packages/core/src/agents/worktrees.ts     # (modify) runGit, repoPath, GitOutputTooLargeError (Task 2)
packages/core/src/agents/runner.ts        # (modify) cleanFor(runId) (Task 2)
packages/core/src/agents/child-env.ts     # (modify) baseChildEnv extracted from buildChildEnv (Task 3)
packages/core/src/agents/fake-adapter.ts  # (modify) write step (Task 3)
packages/core/src/changes/changes.ts      # runWorktree, listChanges, fileDiff, listDir, readFile (Task 2)
packages/core/src/override/service.ts     # OverrideService and its errors (Task 3)
packages/core/src/server/changes-routes.ts  # GET /api/runs/:id/{changes,diff,files,file} (Task 2)
packages/core/src/server/override-routes.ts # POST /api/runs/:id/override/{command,discard} (Task 3)
packages/core/src/server/routes.ts        # (modify) ledger beforeSeq, error map (Tasks 2, 3)
packages/core/src/ledger/ledger.ts        # (modify) list({ beforeSeq }) (Task 2)
packages/core/src/server/server.ts, index.ts  # (modify) wiring (Tasks 2, 3)

apps/ui/src/api.ts                        # (modify) changes, file, dir, diff, override, beforeSeq (Tasks 4–6)
apps/ui/src/shell/views.ts                # (modify) VIEWS gains changes, learn (Task 4)
apps/ui/src/shell/{Dock,dock-layout,layout-store,Workbench,StatusBar,SideBar,ActivityBar,model}.tsx  # (modify) panels, presets, saved layouts, selectView/openLearn (Task 4)
apps/ui/src/components/text.ts            # visibleControls (moved), stripAnsi, basename (Task 4)
apps/ui/src/components/UnifiedDiff.tsx    # hunks → lines with numbers (Task 5)
apps/ui/src/views/ChangesSideBar.tsx      # run picker, changed files, file tree, override section (Tasks 5, 6)
apps/ui/src/views/DiffPanel.tsx, FilePanel.tsx  # diff:<runId>:<path>, file:<runId>:<path> (Task 5)
apps/ui/src/components/OverrideSection.tsx  # discard and command forms (Task 6)
apps/ui/src/components/LedgerPanel.tsx    # (modify) paging, override class (Tasks 6, 7)
apps/ui/src/views/{StoryPanel,LedgerSideBar}.tsx  # (modify) override class, paging (Task 6, 7)
apps/ui/src/views/AgentFeedPanel.tsx      # (rewrite) from entries; follow; autoscroll (Task 7)
apps/ui/src/views/TerminalPanel.tsx       # bottom tab (Task 7)
apps/ui/src/components/StartRunForm.tsx   # extracted from AgentPanel (Task 8)
apps/ui/src/components/AgentPanel.tsx     # (modify) uses StartRunForm (Task 8)
apps/ui/src/views/ConversationPanel.tsx   # main tab (Task 8)
apps/ui/src/views/BoardView.tsx           # (modify) spend line (Task 8)
apps/ui/src/views/NeedsYouPanel.tsx       # main tab (Task 9)
apps/ui/src/components/DecisionContext.tsx  # proposed change, last messages, changes so far (Task 9)
apps/ui/src/components/{DecisionCard,GateCard}.tsx  # (modify) More context, Learn more (Task 9)
apps/ui/src/views/LearnSideBar.tsx        # (Task 10)
apps/ui/src/learn-store.ts                # read topics in localStorage (Task 10)
apps/ui/src/App.tsx, styles.css           # (modify) data, handlers, red (Tasks 4–10)
docs/workspace.md, CHANGELOG.md, README.md  # (Task 11)
e2e/changes.spec.ts, e2e/override.spec.ts, e2e/workspace.spec.ts, e2e/global-setup.ts, e2e/shell.spec.ts and Plan 3's specs  # (Task 12)
```

---

### Task 1: Shared types, the unified-diff parser, override events, the Learn catalog, override narration

**Files:** Create `packages/shared/src/changes.ts`, `override.ts`, `learn.ts`. Modify `packages/shared/src/narration.ts`, `events.ts`, `index.ts`. Tests `packages/shared/test/{changes,override,learn,narration,domain}.test.ts`.

**Interfaces:**
```ts
// shared/changes.ts
export const MAX_CHANGED_FILES = 500, MAX_DIFF_LINES = 5000, MAX_DIFF_BYTES = 1_048_576, MAX_FILE_BYTES = 1_048_576, MAX_DIR_ENTRIES = 2000, MAX_RENDERED_LINES = 20000;
export type ChangeStatus = "added" | "modified" | "deleted" | "typechange" | "untracked" | "unchanged";
export type ChangedFile = { path: string; status: ChangeStatus; added: number | null; deleted: number | null; binary: boolean };  // counts null for binary and untracked
export type RunChanges = { runId: string; base: string; head: string; files: ChangedFile[]; truncated: boolean };            // base/head: full commit ids; files sorted by path
export type FileDiff = { runId: string; path: string; status: ChangeStatus; binary: boolean; tooLarge: boolean; added: number | null; deleted: number | null; text: string | null };
export type DirEntry = { name: string; kind: "file" | "dir" | "other"; size: number | null };   // other = symlink, socket, …; never followed
export type DirListing = { runId: string; path: string; entries: DirEntry[]; truncated: boolean };  // dirs first, then files, each by name; ".git" never listed
export type FileContent = { runId: string; path: string; size: number; binary: boolean; tooLarge: boolean; text: string | null };
export type DiffLine = { kind: "context" | "add" | "del" | "meta"; text: string; oldNo: number | null; newNo: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export function parseUnifiedDiff(text: string): DiffHunk[];
// shared/override.ts
export const OVERRIDE_REASON = z.string().min(10).max(500);
export const OVERRIDE_PROGRAM = /^[A-Za-z0-9_.+-]{1,100}$/;    // a bare program name; absolute paths are also accepted by the service
export const overridePayloadSchemas = {
  "override.command":   z.object({ overrideId: id, runId: id, program: z.string().min(1).max(260), args: z.array(z.string().max(1000)).max(64), cwd: z.string().min(1).max(500), reason: OVERRIDE_REASON }).strict(),
  "override.discard":   z.object({ overrideId: id, runId: id, reason: OVERRIDE_REASON, files: z.number().int().nonnegative() }).strict(),
  "override.completed": z.object({ overrideId: id, runId: id, ok: z.boolean(), exitCode: z.number().int().nullable(), signal: z.string().max(20).nullable(), timedOut: z.boolean(), durationMs: z.number().int().nonnegative(), output: z.string().max(16000) }).strict(),
};
export type OverrideEventType = keyof typeof overridePayloadSchemas;
export const OVERRIDE_MEANS = "An emergency override is you acting directly on the project instead of asking an agent. It is recorded in red in the ledger as an exception, with your reason.";
// shared/learn.ts
export const LEARN_SECTIONS = ["lifecycle", "agents", "deciding", "code", "connections"] as const;
export type LearnSection = (typeof LEARN_SECTIONS)[number];
export const LEARN_SECTION_LABELS: Record<LearnSection, string> = { lifecycle: "The lifecycle", agents: "Working with agents", deciding: "Deciding and gates", code: "Your code and changes", connections: "Connections and capacity" };
export type LearnTopic = { id: string; section: LearnSection; title: string; body: string; appliesTo: { views?: string[]; stages?: Stage[]; actionKinds?: ActionKind[]; gateIds?: GateId[] } };
export const LEARN_TOPICS: readonly LearnTopic[];
export function topicsFor(ctx: { view?: string; stage?: Stage; actionKind?: ActionKind; gateId?: GateId }): LearnTopic[];  // topics whose appliesTo matches any ctx field first (catalog order), then the rest
export const ACTION_TOPIC: Record<ActionKind, string>;   // topic id per kind
export const GATE_TOPIC: Record<GateId, string>;
```
Parser rules: `diff --git`, `index`, `---`, `+++`, `Binary files`, `\ No newline at end of file` and any unrecognised line → `meta` with both numbers null; `@@ -a,b +c,d @@…` starts a hunk (header = the whole line) and sets the counters (`,b`/`,d` default 1); ` ` → context (both numbers), `+` → add (new only), `-` → del (old only); a line before the first hunk is `meta` in a hunk with header `""`; the function never throws and returns `[]` for `""`.
Learn catalog (exact ids; `section` in brackets): `stage_plan`, `stage_design`, `stage_build`, `stage_ship`, `stage_operate` [lifecycle; `stages` set accordingly] · `agent_runs`, `worktrees`, `approvals`, `action_kinds` (`actionKinds`: all seven), `asking_for_changes` [agents; `views: ["agents", "board"]` and `["conversation"]`] · `readiness_gates` (`gateIds`: every gate except `over_budget`), `waivers`, `hash_chain`, `audit_export` [deciding; `views: ["needs_you", "ledger"]`] · `reading_a_diff`, `tracked_and_untracked`, `read_only_by_design`, `emergency_override` [code; `views: ["changes"]`] · `api_keys_and_keychain`, `estimates` (`gateIds: ["over_budget"]`), `cloud_session_tokens`, `mcp_servers`, `subscriptions_and_api_keys` [connections; `views: ["connections", "capacity", "github"]`]. Bodies are plain English of 120 to 1,200 characters written by the implementer, each saying what the thing is, why The Terminal does it that way and what the Owner should look at; `ACTION_TOPIC` maps every kind to `action_kinds`; `GATE_TOPIC` maps `over_budget` to `estimates` and every other gate to `readiness_gates`.
Narration (Plan 3's `narrate`, exact templates; `<Who>` as Plan 3; `<agent>` = `the <adapterName(runId)> agent` or `the agent`): `override.command` → `OVERRIDE: <Who> ran "<program> <args joined by " ", clipped to 80>" in <agent>'s working copy: <reason>`, detail = `JSON.stringify({ program, args, cwd }, null, 2)` · `override.discard` → `OVERRIDE: <Who> discarded <files> changed file(s) of <agent>'s run: <reason>` · `override.completed` → ok `Override finished (exit <exitCode>)`, timed out `Override killed after 10 minutes`, else `Override failed (<"exit " + exitCode | "signal " + signal>)`, detail = output. `NarrationTopic` gains `"override"`; every `override.*` entry has `topic: "override"` and `attention: true`; `refs` carry `runId` (and `overrideId` is added to `NarrationRefs`). `events.ts`: `EventType` gains `OverrideEventType`; `eventPayloadSchemas` spreads `overridePayloadSchemas`.

- [ ] **Step 1: Write failing tests:**
  - changes: a two-hunk git diff fixture parses to two hunks with the exact `oldNo`/`newNo` sequence (`@@ -1,3 +1,4 @@` → context 1/1, add null/2, context 2/3, context 3/4); a `Binary files a/x and b/x differ` diff → one hunk, header `""`, one `meta` line; `\ No newline at end of file` → `meta`; `parseUnifiedDiff("")` → `[]`; a hunk header without counts (`@@ -1 +1 @@`) counts from 1;
  - override: each schema accepts a valid payload; `reason` of 9 characters rejected; 65 args rejected; `output` of 16,001 rejected; `signal: "SIGKILL"` accepted;
  - learn: ids unique and every `appliesTo` reference is a known stage/kind/gate; every stage, every `ACTION_KIND` and every `GATE_ID` appears in at least one topic; every body is 120..1200 characters; `topicsFor({ view: "changes" })[0].id` is `reading_a_diff`; `topicsFor({ gateId: "over_budget" })[0].id` is `estimates`; `topicsFor({})` is the catalog in order;
  - narration: the three templates with a ctx resolving `Fake`; `narrate` on `override.completed` with `timedOut: true` → the killed sentence; topic `override`, `attention: true`, `refs.runId` set; the purity scan from Plan 3 still passes with `./override.js` and `./learn.js` added to the allowed imports;
  - domain: `eventPayloadSchemas` has a schema for every `EventType` including `override.*`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): run changes and unified-diff parsing, emergency override events, the Learn catalog, override narration`

---

### Task 2: Changes, diffs, files: read-only routes confined to the run's worktree

**Files:** Create `packages/core/src/changes/changes.ts`, `packages/core/src/server/changes-routes.ts`. Modify `packages/core/src/agents/worktrees.ts`, `agents/runner.ts`, `ledger/ledger.ts`, `server/routes.ts`, `server/server.ts`, `index.ts`. Tests `packages/core/test/changes/changes.test.ts`, `packages/core/test/server/changes-routes.test.ts`, `packages/core/test/agents/{worktrees,runner}.test.ts`, `packages/core/test/ledger/ledger.test.ts`.

**Interfaces:**
```ts
// worktrees.ts
export type GitRunner = (args: string[], cwd: string, opts?: { timeoutMs?: number; maxBuffer?: number }) => Promise<string>;   // the existing injected shape, extended
export class GitOutputTooLargeError extends Error {}   // thrown by the default runner on ENOBUFS / maxBuffer
export const GIT_COMMON_ARGS = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"] as const;
class WorktreeManager { …
  runGit(cwd: string, args: string[], opts?: { timeoutMs?: number /* 30000 */; maxBuffer?: number /* 2 MiB */ }): Promise<string>;  // GIT_COMMON_ARGS + args, through the manager's runner and gitEnv
  repoPath(projectId: string): string;        // join(dataDir, "projects", projectId, "repo"); assertId
}
// runner.ts
class AgentRunner { …
  cleanFor(runId: string): (s: string, max: number) => string;  // the live session's scrubber, else runScrubber(join(dataDir, run.worktree)); NotFoundError for an unknown run
}
// ledger.ts
list(q: { …; beforeSeq?: number }): LedgerEntry[];   // with beforeSeq: seq < beforeSeq, the newest `limit` of them, returned in ascending order; afterSeq and beforeSeq may combine
// changes/changes.ts
export class WorktreeMissingError extends Error {}   // "the run's working copy no longer exists"
export class NoBaseError extends Error {}            // "could not determine what this run changed"
export type ChangesDeps = { db: Db; dataDir: string; worktrees: WorktreeManager; clean: (runId: string, s: string, max: number) => string };
export function runWorktree(deps: ChangesDeps, runId: string): { run: AgentRun; abs: string };   // NotFoundError; abs = join(dataDir, run.worktree) when it is an existing directory, else WorktreeMissingError
export async function listChanges(deps: ChangesDeps, runId: string): Promise<RunChanges>;
export async function fileDiff(deps: ChangesDeps, runId: string, path: string): Promise<FileDiff>;   // NotFoundError when resolveInside rejects the path
export function listDir(deps: ChangesDeps, runId: string, path: string): DirListing;                // NotFoundError when rejected or not a directory
export function readFile(deps: ChangesDeps, runId: string, path: string): FileContent;              // NotFoundError when rejected or not a regular file
// changes-routes.ts (all behind auth; `path` query defaults to "" for /files)
GET /api/runs/:id/changes            → RunChanges
GET /api/runs/:id/diff?path=<rel>    → FileDiff
GET /api/runs/:id/files?path=<rel>   → DirListing
GET /api/runs/:id/file?path=<rel>    → FileContent
```
Git calls (every one through `runGit`, in the worktree unless noted): `repoHead` = `rev-parse --verify HEAD` in `repoPath(run.projectId)`; `base` = `merge-base HEAD <repoHead>` (failure → `NoBaseError`); `head` = `rev-parse HEAD`; tracked = `diff --numstat -z --no-renames --no-ext-diff --no-textconv <base>` joined with `diff --name-status -z --no-renames <base>` by path (`A` added, `M` modified, `D` deleted, `T` typechange; `-\t-` → `binary: true`, counts null); untracked = `ls-files --others --exclude-standard -z` (`status: "untracked"`, counts null, `binary` from the file's first 8 KiB). The list is cut at `MAX_CHANGED_FILES` after sorting (`truncated: true`). `fileDiff`: the path must pass `resolveInside`; a tracked path → `diff --no-color --no-ext-diff --no-textconv --no-renames -U3 <base> -- <path>` with `status` from the list (`unchanged` when absent, `text: ""`); an untracked path → a synthesised diff `--- /dev/null\n+++ b/<path>\n@@ -0,0 +1,<n> @@\n` plus every line prefixed `+`; `tooLarge` when added + deleted > `MAX_DIFF_LINES`, when the runner throws `GitOutputTooLargeError`, or when the cleaned text exceeds `MAX_DIFF_BYTES`; `text` = `clean(runId, raw, MAX_DIFF_BYTES)`. `listDir`: `readdirSync(resolved, { withFileTypes: true })`, `.git` dropped, `kind` from `isDirectory()`/`isFile()`, `size` via `statSync` for files only, sorted, cut at `MAX_DIR_ENTRIES`, names cleaned with `clean(runId, name, 255)`. `readFile`: `statSync` ≤ `MAX_FILE_BYTES` else `tooLarge`; a NUL in the first 8 KiB → `binary: true, text: null`; else `text = clean(runId, utf8, MAX_FILE_BYTES)`. Route errors: `WorktreeMissingError` → 404 `worktree_missing`; `NoBaseError` → 409 `no_base`; `NotFoundError` → 404 `not_found`. `ledgerQuery` gains `beforeSeq: z.coerce.number().int().min(1).optional()`. `server.ts` registers the routes with `clean: (runId, s, max) => runner.cleanFor(runId)(s, max)`.

- [ ] **Step 1: Write failing tests** (a server with the fake adapter whose script has Task 3's `write` step is not available yet: these tests create a run through the runner with a fake adapter and then write into `join(dataDir, run.worktree)` directly, committing with `runGit` where a tracked change is needed):
  - worktrees: `runGit` prepends `GIT_COMMON_ARGS` (assert the injected runner's args); the default runner maps a `maxBuffer` error to `GitOutputTooLargeError`;
  - runner: `cleanFor(runId)` scrubs the run's worktree path to `.` after the run has finished; unknown run → `NotFoundError`;
  - ledger: `list({ beforeSeq: 10, limit: 3 })` returns seqs 7, 8, 9 ascending; `list({ afterSeq: 2, beforeSeq: 5 })` returns 3, 4;
  - changes: an untracked `notes.txt` → one file `untracked`; after `git add`+`commit` and an edit → `modified` with `added: 1, deleted: 1`; a deleted tracked file → `deleted`; a file with a NUL byte → `binary: true`; 600 untracked files → 500 and `truncated: true` **(Review Focus 4)**; `fileDiff` of the untracked file begins `--- /dev/null` and shows `+key=[REDACTED]` when the file holds a key in `extraSecrets` **(Review Focus 2)**; a 10,000-line change → `tooLarge: true`, `text: null`, counts present **(Review Focus 4)**; `fileDiff` of an unchanged tracked file → `status: "unchanged"`, `text: ""`; `listDir("")` lists `notes.txt` and never `.git`; `readFile` of a 2 MiB file → `tooLarge` **(Review Focus 4)**; `readFile` of a file containing the worktree's absolute path shows `.`; **(Review Focus 1)** `../token`, an absolute path, `.git/config`, a symlink to a file outside the worktree (`describe.skipIf(process.platform === "win32")`), a dangling symlink → `NotFoundError` for `readFile`, `listDir` and `fileDiff`; a deleted worktree directory → `WorktreeMissingError`;
  - routes: each row with status codes; 404 bodies are exactly `{ error: "not_found" }`; `GET /api/ledger?beforeSeq=` pages; without the cookie → 401.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): read-only changes, diffs, files and directories of a run's working copy; ledger paging`

---

### Task 3: The emergency override service and routes

**Files:** Create `packages/core/src/override/service.ts`, `packages/core/src/server/override-routes.ts`. Modify `packages/core/src/agents/child-env.ts`, `agents/fake-adapter.ts`, `server/routes.ts`, `server/server.ts`, `index.ts`. Tests `packages/core/test/override/service.test.ts`, `packages/core/test/server/override-routes.test.ts`, `packages/core/test/agents/{child-env,fake-adapter}.test.ts`.

**Interfaces:**
```ts
// child-env.ts
export function baseChildEnv(dataDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv;  // the allowlist copy + GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM=1, GIT_TERMINAL_PROMPT=0; calls assertEmptyGitconfig; buildChildEnv now starts from it (behaviour unchanged)
// fake-adapter.ts
export type FakeStep = … | { write: { path: string; content: string } };   // writes join(o.cwd, path) (refuses ".." segments and absolute paths with an Error), creating parent dirs
// override/service.ts
export class RunActiveError extends Error {}          // "an agent is still working in this run"
export class OverrideBusyError extends Error {}       // "an override is already running for this run"
export class ProgramNotFoundError extends Error {}    // "program not found on PATH"
export class ProgramNotAllowedError extends Error {}  // "program cannot be run as an override"
export const OVERRIDE_TIMEOUT_MS = 600_000, OVERRIDE_OUTPUT_CHARS = 16_000, OVERRIDE_BUFFER = 1_048_576;
export type OverrideDeps = { db: Db; ledger: Ledger; dataDir: string; worktrees: WorktreeManager; changes: ChangesDeps;
  clean: (runId: string, s: string, max: number) => string; which?: (cmd: string) => string | null; execFile?: typeof import("node:child_process").execFile;
  timeoutMs?: number; newId?: () => string; now?: () => Date };
export class OverrideService {
  constructor(deps: OverrideDeps);
  async command(actor: Actor, runId: string, input: { program: string; args: string[]; cwd?: string; reason: string }): Promise<{ overrideId: string }>;  // resolves once the process has started and override.command is committed
  async discard(actor: Actor, runId: string, reason: string): Promise<{ overrideId: string; files: number }>;   // resolves after override.completed
  active(runId: string): boolean;
  async shutdown(): Promise<void>;   // SIGKILL every active process, wait ≤ 5 s, record each as completed { ok: false, signal: "SIGKILL" }
}
// override-routes.ts
POST /api/runs/:id/override/command   { program, args?: string[], cwd?: string, reason }  → 201 { overrideId }
POST /api/runs/:id/override/discard   { reason }                                         → 200 { overrideId, files }
```
The service reuses Plan 3's `HumanRequiredError` and `SecretInTextError` from `packages/core/src/intake/service.ts` (already mapped to 403 `human_required` and 400 `secret_in_text`). Rules, in this order for `command`: `actor.kind !== "human"` → `HumanRequiredError`; body schema (`program` 1..260, `args` ≤ 64 × ≤ 1000, `cwd` ≤ 500, `reason` `OVERRIDE_REASON`, strict); `reason` and every arg trimmed and refused with `SecretInTextError` when `redact` changes them; `runWorktree` (NotFound / WorktreeMissing); `run.status === "running"` → `RunActiveError`; `active(runId)` → `OverrideBusyError`; `cwd` (default `"."`) through `resolveInside`, must be a directory, else `NotFoundError`; program: an absolute path is taken as is, a bare name must match `OVERRIDE_PROGRAM` and resolve with `which` (PATH only), else `ProgramNotFoundError`; the resolved real path must not lie inside the worktree or `dataDir` and must not end in `.cmd`/`.bat` (case-insensitive), else `ProgramNotAllowedError`. Then commit `override.command` (`program` as typed, `args`, `cwd` relative to the worktree with `/`, `reason`), then `execFile(resolved, args, { cwd, env: { ...baseChildEnv(dataDir), GIT_CEILING_DIRECTORIES: dirname(worktreeAbs) }, windowsHide: true, timeout, killSignal: "SIGKILL", maxBuffer: OVERRIDE_BUFFER })` with `child.stdin.end()` right after spawn (nothing is ever typed into an override); on exit commit `override.completed { ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, durationMs, output: clean(runId, stdout + (stderr ? "\n[stderr]\n" + stderr : ""), OVERRIDE_OUTPUT_CHARS) }` (a `maxBuffer` kill counts as `ok: false`, `signal: "SIGKILL"`). `discard`: the same checks through `RunActiveError`/`OverrideBusyError`, `files = listChanges(…).files.length`, commit `override.discard`, then `runGit(wt, ["checkout", "--", "."])` and `runGit(wt, ["clean", "-fd"])`, then `override.completed` with their combined output (`ok: false` with the error text as output when either throws). Route errors: `RunActiveError` → 409 `run_active`; `OverrideBusyError` → 409 `override_busy`; `ProgramNotFoundError` → 400 `program_not_found`; `ProgramNotAllowedError` → 400 `program_not_allowed`. `server.ts` constructs the service, exposes it to `close()` (`await overrides.shutdown()` before the runner's shutdown) and registers the routes.

- [ ] **Step 1: Write failing tests:**
  - child-env: `baseChildEnv` returns exactly the allowlisted names plus the three git variables; `buildChildEnv` results are unchanged (the 5A/5B assertions still pass);
  - fake-adapter: a `write` step creates the file under `o.cwd`; `path: "../x"` throws;
  - service (fake adapter run that has finished; `which` injected to return `process.execPath` for `node`): `command("node", ["-e", "console.log('hi')"])` → `override.command` then `override.completed { ok: true, exitCode: 0 }` whose output is `hi\n`; an arg echoing a stored secret → the recorded output is `[REDACTED]` **(Review Focus 2)**; `node -e "process.exit(3)"` → `ok: false, exitCode: 3`; `timeoutMs: 200` with `node -e "setTimeout(()=>{},5000)"` → `timedOut: true, signal: "SIGKILL"`; `cwd: "sub"` after creating it runs there (`process.cwd()` printed and scrubbed to `./sub`), `cwd: "../"` → `NotFoundError`; **(Review Focus 3)** a run still `running` → `RunActiveError`; `reason: "short"` → ZodError; `program: "./node_modules/.bin/x"` and `program: <a file inside the worktree>` → `ProgramNotAllowedError`; `program: "nope-not-here"` → `ProgramNotFoundError`; an arg containing `sk-ant-TESTKEY-0000000000` → `SecretInTextError`; a second `command` while the first runs → `OverrideBusyError`; a resolved `x.cmd` (injected `which`) → `ProgramNotAllowedError`; actor `{ kind: "system", id: "runner" }` → `HumanRequiredError`; after each refusal `ledger.headSeq()` is unchanged; `discard` on a worktree with one untracked and one modified file → `override.discard { files: 2 }`, then `override.completed { ok: true }`, and `listChanges` is empty; `shutdown()` during a long command records `completed { ok: false, signal: "SIGKILL" }`;
  - routes: 201 with `overrideId` and the two entries in `/api/ledger`; each refusal's status and code; `GET /api/runs/:id` still answers while an override runs; without the cookie → 401.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): emergency override: a command or a discard in a run's working copy, reasoned, exclusive and recorded in two phases`

---

### Task 4: Shell: Changes and Learn views, new panels, presets and saved layouts

**Files:** Modify `apps/ui/src/shell/{views,Dock,dock-layout,layout-store,Workbench,StatusBar,SideBar,ActivityBar,model}.ts(x)`, `apps/ui/src/api.ts`, `apps/ui/src/App.tsx`, `apps/ui/test/test-dock.tsx`, `apps/ui/src/styles.css`. Create `apps/ui/src/components/text.ts`. Tests `apps/ui/test/{ActivityBar,Workbench,StatusBar,dock-layout,layout-store,text}.test.tsx`.

**Interfaces and copy:**
```ts
// views.ts
export const VIEWS = ["board", "agents", "changes", "needs_you", "ledger", "connections", "github", "capacity", "learn"] as const;
// VIEW_LABELS gains changes: "Changes", learn: "Learn"; ActivityBar icons: a diff glyph and a book glyph
// Dock.tsx
export type DockPanelId = "board" | "agent_feed" | "ledger" | "capacity" | "intake" | "conversation" | "needs_you" | "terminal"
  | `connection:${string}` | `story:${string}` | `diff:${string}:${string}` | `file:${string}:${string}`;   // diff/file: <runId>:<encodeURIComponent(path)>
// DEFAULTS gains conversation { title: "Conversation", where: "main" }, needs_you { "Needs you", "main" }, terminal { "Terminal", "bottom" }; BOTTOM_IDS gains "terminal"
export const diffPanelId = (runId: string, path: string) => `diff:${runId}:${encodeURIComponent(path)}` as const;  // and filePanelId; parsePanelPath(id) → { runId, path } | null
// dock-layout.ts
export type PresetId = "guided" | "operator";
export const PRESET_LABELS: Record<PresetId, string> = { guided: "Guided", operator: "Operator" };
export function buildPreset(api: DockviewApi, preset: PresetId): void;   // guided: main [board, conversation] (board active); operator: main [board, capacity], bottom 30 % [terminal, agent_feed, ledger] (ledger active)
export function buildDefault(api: DockviewApi): void;                    // = buildPreset(api, "guided")
export function staleRunPanels(panelIds: readonly string[], runIds: readonly string[]): string[];   // diff:/file: panels whose runId is unknown
// layout-store.ts
export const LAYOUTS_KEY = "tt.layouts.v1", LAYOUT_NAME_KEY = "tt.layout.name.v1", MAX_SAVED_LAYOUTS = 10;
export function listSavedLayouts(): string[]; export function saveNamedLayout(name: string, json: unknown): void;  // RangeError over the cap or a name outside 1..40
export function loadNamedLayout(name: string): unknown | null; export function removeNamedLayout(name: string): void;
export function currentLayoutName(): string;  // "Guided" | "Operator" | <saved name> | "Custom"; set by applying a preset or saved layout; any later onDidLayoutChange sets "Custom"
// Dock.tsx DockApi gains
applyPreset(preset: PresetId): void; applySaved(name: string): void; saveAs(name: string): void; currentName(): string; onNameChange(fn: (name: string) => void): () => void;
// model.ts ShellContextValue gains
selectView(view: ViewId): void; openLearn(topicId: string): void;   // openLearn selects "learn" and sets learnTopic
// text.ts
export function visibleControls(s: string): string;   // moved from DecisionCard (which imports it)
export function stripAnsi(s: string): string;         // removes CSI (\u001b[ … final byte) and OSC (\u001b] … BEL or ST) sequences
export function basename(path: string): string;       // last "/" segment
```
- The status bar's right side becomes: `<select aria-label="Layout">` listing `Guided`, `Operator`, every saved name and, when the current layout matches none, a disabled first option `Custom`; a button `Save layout` that reveals an input `aria-label="Layout name"` and a `Save` button (saving applies the name; a tenth-plus save shows `You can keep up to 10 layouts`); the existing `Reset layout` button (applies `Guided` and clears `tt.layout.v1`). The stale-panel pruning of 5A extends to `staleRunPanels(dock.panelIds(), model.runs.map(r => r.id))` once runs have loaded for the selected project; panels of other projects' runs are left alone, so the prune happens only when `model.runs` is non-empty and only for ids whose `diff:`/`file:` run is absent from **every** project (App keeps `knownRunIds` across selections and passes it as `model.knownRunIds: Set<string>`).
- `Workbench` passes `selectView` and `openLearn` through `ShellContext`; `learnTopic: string | null` is Workbench state read by Task 10's side bar.
- `TestDock` gains the new `DockApi` members (presets switch its `open` list between `[board, conversation]` and `[board, capacity, terminal, agent_feed, ledger]`).

- [ ] **Step 1: Write failing tests:**
  - ActivityBar renders the nine labels in order with `Changes` third and `Learn` last;
  - dock-layout: `staleRunPanels(["diff:r1:a", "file:r2:b", "board"], ["r1"])` is `["file:r2:b"]`; `diffPanelId("r1", "src/a b.ts")` round-trips through `parsePanelPath`;
  - layout-store: save/list/load/remove round trip; an 11th save throws `RangeError`; a 41-character name throws; `currentLayoutName()` is `Guided` on a fresh store;
  - StatusBar: the select shows `Guided`, `Operator` and a saved `Mine`; choosing `Operator` calls `applyPreset("operator")`; `Save layout` → typing `Mine` → `Save` calls `saveAs("Mine")`;
  - Workbench (TestDock): a fresh load shows panels `board` and `conversation` and not `ledger`; **(Review Focus 5)** with the Guided preset and view `connections`, a pending action renders `article[aria-label="Decision: Run: nvidia-smi"]` and the Needs-you badge; `openLearn("reading_a_diff")` selects the Learn view;
  - text: `stripAnsi("\u001b[31mred\u001b[0m")` is `red`; an OSC title sequence is removed; `visibleControls("\u202e")` is `\u202e` as the JSON escape (the DecisionCard test still passes);
  - the existing App, Workbench and shell tests pass with the new view list (update the "seven" assertions to nine).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Changes and Learn views, Conversation, Needs-you and Terminal panels, Guided and Operator presets, saved layouts`

---

### Task 5: Changes side bar, diff tabs and file tabs

**Files:** Create `apps/ui/src/components/UnifiedDiff.tsx`, `apps/ui/src/views/ChangesSideBar.tsx`, `DiffPanel.tsx`, `FilePanel.tsx`. Modify `apps/ui/src/api.ts`, `shell/model.ts`, `shell/{Workbench,SideBar}.tsx`, `App.tsx`, `styles.css`. Tests `apps/ui/test/{UnifiedDiff,ChangesSideBar,DiffPanel,FilePanel}.test.tsx`.

**Interfaces and copy:**
```ts
// api.ts
getRunChanges(runId): Promise<RunChanges>; getRunDiff(runId, path): Promise<FileDiff>; listRunDir(runId, path): Promise<DirListing>; getRunFile(runId, path): Promise<FileContent>;
// errorMessage: worktree_missing → "This run's working copy no longer exists on this computer"; no_base → "Could not work out what this run changed"
// model.ts
changesRunId: string | null; onSelectChangesRun(runId: string | null): void;     // defaults to selectedRunId when null
changes: RunChanges | null; changesError: string | null;                          // reloaded on any agent.* / override.* entry whose runId is changesRunId
runChanges(runId: string): Promise<RunChanges>;                                   // memoised 10 s per run (Task 9 uses it)
dir(runId, path): Promise<DirListing>; file(runId, path): Promise<FileContent>; diff(runId, path): Promise<FileDiff>;
onOpenDiff(runId, path): void;   // dock.open(diffPanelId(runId, path), basename(path), "main")
onOpenFile(runId, path): void;
// UnifiedDiff.tsx
export function UnifiedDiff(props: { text: string }): JSX.Element;   // <pre class="diff"> with one <div class="line <kind>"> per DiffLine: <span class="ln">old</span><span class="ln">new</span><span class="text">; hunk headers as class "hunk"
```
- Side bar (`Changes`): a `select` `aria-label="Run"` listing the project's runs newest first as `<Adapter> · <prompt clipped 40> · <status>` with `(no runs yet)` when empty; header line `<n> file(s) changed · +<added> −<deleted>` (binary and untracked counted as files only) and `Read-only. Agents change code; you review it.` with a `Learn more` link (`openLearn("reading_a_diff")`); `Showing 500 of more files` when `truncated`; `ul[aria-label="Changed files"]` rows `<status letter> <path> +a −d` (letters `A M D T U`, `binary` word for binary) as buttons that call `onOpenDiff`; a section `Files` with a lazy tree (`ul[aria-label="Files"]`, directories as `<details>` loading their listing on first open, `kind: "other"` entries shown greyed with title `Not followed`, `Showing 2,000 of more entries` when truncated), file rows call `onOpenFile`; errors by `errorMessage`.
- `DiffPanel` (`section[aria-label="Diff: <path>"]`): header `<path>` · `<status>` · `+a −d` · `New file, not yet committed` for `untracked` · `Compared with <base first 8> (this run's starting point)`; `binary` → `Binary file: no text to show`; `tooLarge` → `This change is too large to show here (<added> added, <deleted> deleted lines). Open the file instead, or ask an agent to summarise it.` with an `Open file` button; `status: "unchanged"` → `This file has not changed in this run.`; a text ending in `…[truncated]` → the note `The end of this diff was cut at 1 MiB.`; otherwise `UnifiedDiff`.
- `FilePanel` (`section[aria-label="File: <path>"]`): header `<path>` · `<size> bytes` · `Read-only`; `binary` → `Binary file: no text to show`; `tooLarge` → `This file is larger than 1 MiB and is not shown. Ask an agent about it.`; else `<pre class="file">` with numbered lines, at most `MAX_RENDERED_LINES` and the note `Showing the first 20,000 lines of <n>`.
- Both panels load on mount and reload when an `agent.*` or `override.*` entry names their run.

- [ ] **Step 1: Write failing tests:** `UnifiedDiff` paints the fixture's add line with class `add`, new number `2` and no old number; the side bar lists `A notes.txt`, clicking it calls `onOpenDiff("run1", "notes.txt")`; `truncated` shows the 500 note; the tree opens `src` (calls `dir("run1", "src")`) and clicking `src/a.ts` calls `onOpenFile`; `DiffPanel` renders each of the four special states' copy and the `UnifiedDiff` otherwise; `FilePanel` renders `tooLarge` copy, `binary` copy, and 20,000 of 25,000 lines with the note **(Review Focus 4)**.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Changes view with changed files and a read-only file tree; diff and file tabs`

---

### Task 6: Emergency override in the UI, in red everywhere

**Files:** Create `apps/ui/src/components/OverrideSection.tsx`. Modify `apps/ui/src/views/ChangesSideBar.tsx`, `components/LedgerPanel.tsx`, `views/StoryPanel.tsx` (Plan 3), `api.ts`, `shell/model.ts`, `App.tsx`, `styles.css`. Tests `apps/ui/test/{OverrideSection,ChangesSideBar,LedgerPanel,StoryPanel}.test.tsx`.

**Interfaces and copy:**
```ts
// api.ts
overrideCommand(runId, i: { program: string; args: string[]; cwd?: string; reason: string }): Promise<{ overrideId: string }>;
overrideDiscard(runId, reason: string): Promise<{ overrideId: string; files: number }>;
// errorMessage: run_active → "Stop the agent first: it is still working in this run"; override_busy → "An override is already running for this run";
//   program_not_found → "That program was not found on this computer's PATH"; program_not_allowed → "Programs inside the project folder, and Windows batch files, cannot be run as an override";
//   secret_in_text → "That text looks like it contains a key or password. Nothing was recorded." (Plan 3's wording if it already exists)
// model.ts
onOverrideCommand(runId, i): Promise<boolean>; onOverrideDiscard(runId, reason): Promise<boolean>;   // false on failure, with the error shown
```
- `OverrideSection` (`<details class="override">`, summary `Emergency override`): the sentence `OVERRIDE_MEANS`, then `Stop the agent first.` while the run is `running` (both forms disabled), a `Learn more` link (`openLearn("emergency_override")`). Form `Discard this run's changes`: button `Discard…` reveals `Why? (required, at least 10 characters)` input and the button `Discard <n> file(s)` (enabled at 10 characters), which calls `onOverrideDiscard`. Form `Run a command in this run's working copy`: inputs `Program` (placeholder `git`), `Arguments (one per line)` textarea, `Folder (optional, inside the working copy)`, `Why? (required, at least 10 characters)`, the note `Runs without a shell and without any of your connections' credentials. Output is recorded in the ledger.`, button `Run as override` (enabled when program and reason are valid). After a successful call the form clears and shows `Recorded. Watch the Ledger or the Terminal for the result.`
- Red: `LedgerPanel`, `StoryPanel`'s lists and Task 7's feed and terminal give entries whose type starts with `override.` the class `override`; `styles.css` defines `--override: #f14c4c` and `.override { border-left: 3px solid var(--override); } .override .headline, .override > summary { color: var(--override); }`; the `Decisions and why` section of the story lists `override.command` and `override.discard` entries.

- [ ] **Step 1: Write failing tests:** the discard button is disabled until 10 characters, then calls `onOverrideDiscard("run1", reason)`; the command form sends `{ program: "git", args: ["status"], reason }` and clears; a running run disables both forms with the sentence; a `run_active` failure shows its message; `LedgerPanel` gives an `override.command` entry the `override` class and the `OVERRIDE:` headline; `StoryPanel` lists the discard under `Decisions and why` in red.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): emergency override forms with a mandatory reason; overrides shown in red wherever the ledger is shown`

---

### Task 7: Live agent feed from the ledger, the Terminal tab, ledger paging

**Files:** Rewrite `apps/ui/src/views/AgentFeedPanel.tsx`; create `apps/ui/src/views/TerminalPanel.tsx`. Modify `apps/ui/src/components/LedgerPanel.tsx`, `views/LedgerSideBar.tsx`, `shell/model.ts`, `App.tsx`, `api.ts` (`listLedger(projectId, q: { afterSeq?; beforeSeq?; limit? })`), `styles.css`. Tests `apps/ui/test/{AgentFeedPanel,TerminalPanel,LedgerPanel,App}.test.tsx`.

**Interfaces and copy:**
```ts
// model.ts
projectEntries: LedgerEntry[];   // the selected project's stream, independent of the ledger scope (App already keeps it apart from allEntries)
feedRunId: string | null; onFollowRun(runId: string | null): void;   // null = all runs of the project
ledgerHasOlder: boolean; onLoadOlderLedger(): Promise<void>;          // fetches 500 with beforeSeq = the oldest loaded seq and prepends
// LedgerPanel.tsx
export function LedgerPanel(props: { entries: LedgerEntry[]; topics?: NarrationTopic[]; ctx?: NarrationContext; hasOlder?: boolean; onLoadOlder?: () => void }): JSX.Element;
export const LEDGER_PAGE = 200;
// TerminalPanel.tsx
export type TerminalItem = { key: string; kind: "command" | "typed" | "denied" | "output" | "override" | "override_output"; text: string; runId: string; ok?: boolean };
export function terminalItems(entries: LedgerEntry[], runId: string | null): TerminalItem[];   // pure; newest 500
```
- Feed (`section[aria-label="Agent feed"]`): a `select` `aria-label="Follow"` with `All runs` and one option per run (`<Adapter> · <prompt clipped 40>`); items are `projectEntries` whose type starts with `agent.` or `override.`, filtered by `feedRunId` through `payload.runId`, newest last, at most 500 (the note `Showing the latest 500` above when cut); each item: time, `narrate(e, model.narration).headline`, `<details><summary>Raw</summary>` with the detail and payload (Plan 3's shape), `attention` and `override` classes; a running run's items end with a live marker `Working…`; autoscroll keeps the bottom visible unless the Owner has scrolled up more than 40 px, in which case a button `Jump to latest (<n> new)` appears. `Nothing to show yet. Start an agent in the Agents view or the Conversation tab.` when empty.
- Terminal (`section[aria-label="Terminal"]`): the same follow select; `terminalItems`: `agent.action.requested` of kind `shell` → `command` `$ <input.command>` (tool `codex.stdin` → `typed` `> <input.reason>`); its `agent.action.decided` deny → `denied` `denied: <reason>`; its `agent.action.completed` → `output` (the output, `ok` from the payload); `override.command` → `override` `# OVERRIDE <program> <args joined " ">`; `override.completed` → `override_output`; every text through `stripAnsi` then `visibleControls`; items of `[REDACTED]`-containing commands keep the marker as is. Footer: `Read-only. Agents run commands and you approve them. To run something yourself, use the emergency override in the Changes view.`
- Ledger panel: paints the newest `shown` entries (`LEDGER_PAGE`, growing by `LEDGER_PAGE` on `Show older entries`); when `shown ≥ entries.length` and `hasOlder`, the button calls `onLoadOlder` instead. App loads the newest page (`beforeSeq: headSeq + 1, limit: 500`) for the project scope and the all-projects scope, subscribes from `headSeq`, and sets `ledgerHasOlder = page.length === 500`.

- [ ] **Step 1: Write failing tests:** the feed renders `The Fake agent wants to run the command "nvidia-smi"` from entries and hides another run's items when following `run1`; 600 entries → 500 items and the note **(Review Focus 4)**; an `override.command` item has class `override`; `terminalItems` for a shell request, deny and completion yields `$ nvidia-smi`, `denied: …`, the output; an `\u001b[32mOK\u001b[0m` output becomes `OK`; `LedgerPanel` with 450 entries paints 200, then 400, then 450, then the button calls `onLoadOlder` when `hasOlder` **(Review Focus 4)**; App's initial ledger request carries `beforeSeq` and `limit=500` and `ledgerHasOlder` is true for a full page.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): live agent feed and read-only terminal derived from the ledger; ledger paging`

---

### Task 8: The Conversation tab and the project's spend line

**Files:** Create `apps/ui/src/components/StartRunForm.tsx`, `apps/ui/src/views/ConversationPanel.tsx`. Modify `apps/ui/src/components/AgentPanel.tsx`, `views/BoardView.tsx`, `shell/model.ts`, `App.tsx`, `styles.css`. Tests `apps/ui/test/{StartRunForm,ConversationPanel,AgentPanel,BoardView}.test.tsx`.

**Interfaces and copy:**
```ts
// StartRunForm.tsx (the form half of AgentPanel, with Plan 3's card select and 5B's access picker)
export function StartRunForm(props: { adapters: AdapterId[]; providers?: …; cards: Card[]; connections: Connection[]; defaultCardId?: string | null; submitLabel?: string /* "Start agent" */;
  onStart(adapter: AdapterId, prompt: string, cardId: string | null, connectionIds: string[]): Promise<boolean | void> | void }): JSX.Element;
// ConversationPanel.tsx
export function conversationThread(runs: AgentRun[], entries: LedgerEntry[], cards: Card[]): { run: AgentRun; cardTitle: string | null; messages: string[]; actions: { total: number; allowed: number; denied: number } }[];  // pure; runs oldest first
```
- `AgentPanel` keeps its `aria-label="Agents"`, the `Agent` combobox, the `Prompt` label and `Start agent` button by rendering `StartRunForm`.
- Conversation (`section[aria-label="Conversation"]`): `Select or create a project.` without one; otherwise the thread: per run an `article` with `You asked <Adapter> on "<card title>"` (or `You asked <Adapter>`) and the time, the prompt in a `<blockquote>`, each `agent.message` as `<p class="agent-says">`, and a result line `<status> · <total> action(s), <allowed> allowed, <denied> denied · $<cost> (estimate)` (`cost not reported` when null) with buttons `Changes` (sets `changesRunId` and selects the Changes view) and, with a card, `Story` (`onOpenStory`). Below, `Ask an agent` = `StartRunForm` with `submitLabel: "Ask"` and the note `Agents do the work. Describe what should change; the agent will ask before anything that affects your files or accounts.` The thread autoscrolls like the feed.
- `BoardView` header gains `Agent spend: $<sum of runs.costUsd with two decimals> (estimate) · <n> run(s)` or `No agent spend recorded yet`.

- [ ] **Step 1: Write failing tests:** `conversationThread` orders two runs oldest first with their messages and action counts; the panel renders `You asked Fake on "Login"` and the result line with `1 allowed, 1 denied`; `Ask` calls `onStartRun("fake", "Add a logout button", "c1", [])`; `Changes` calls `onSelectChangesRun("run1")` and selects the view; the Board header shows `Agent spend: $0.30 (estimate) · 2 run(s)`; the existing AgentPanel tests pass.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Conversation tab: the thread of asks and answers, and asking an agent for a change`

---

### Task 9: Needs-you panel with context; richer decision and gate cards

**Files:** Create `apps/ui/src/views/NeedsYouPanel.tsx`, `apps/ui/src/components/DecisionContext.tsx`. Modify `apps/ui/src/components/DecisionCard.tsx`, `components/GateCard.tsx` (Plan 3), `shell/Workbench.tsx`, `shell/model.ts`, `App.tsx`, `styles.css`. Tests `apps/ui/test/{DecisionContext,NeedsYouPanel,DecisionCard,GateCard,Workbench}.test.tsx`.

**Interfaces and copy:**
```ts
// DecisionContext.tsx
export type ProposedChange = { path: string | null; kind: "replace_file" | "edit" | "none"; content?: string; oldText?: string; newText?: string };
export function proposedChange(action: Pick<AgentAction, "kind" | "input">): ProposedChange;
// file_write: path from file_path | path | filePath; content from content | new_content | text → replace_file; file_edit: old_string | old_text | oldText and new_string | new_text | newText → edit; anything else → none
export function DecisionContext(props: { action: PendingAgentAction; entries: LedgerEntry[] | null; changes: RunChanges | null; onSeeChanges(runId: string): void }): JSX.Element;
// DecisionCard props gain onMore?: () => void (button "More context" → dock.focus("needs_you")), and a "Learn more" link → openLearn(ACTION_TOPIC[kind])
// GateCard gains a "Learn more" link → openLearn(GATE_TOPIC[gateId])
```
- `DecisionContext`: `Proposed change to <path>` with a `<pre class="proposed">`: `replace_file` → every content line prefixed `+`; `edit` → old lines prefixed `-` then new lines prefixed `+`; at most 200 lines per block with `… <n> more lines in Details`; nothing for `none`. `Before this, the agent said:` with the last two `agent.message` texts of the run from `entries` (omitted when `entries` is null or has none). `This run has changed <n> file(s) so far` with a `See changes` button when `changes` is given, `Nothing changed yet` for 0. In practice a pending action's run is live, and the core refuses a live run's changes (409 `run_active`, kept as a safeguard): the panel asks nothing for a run the runs list says is running and shows `Changes show when the run is stopped or finished.` (`changesNote`) in place of the count; the count only appears for a run that is no longer running.
- `NeedsYouPanel` (`section[aria-label="Everything that needs you"]`): sections `Decisions` (every pending action across projects as `DecisionCard` + `DecisionContext`; `entries` and `changes` only for the selected project's runs, with a note `Open this project to see more context` and a button `Open project` otherwise), `Gates` (Plan 3's gate cards when `model.gate`), `Plan` (`Your plan needs <n> decision(s)` with `Open intake`), and `Nothing needs you right now.` when all are empty. The strip keeps its compact cards and gains `More context` on each.

- [ ] **Step 1: Write failing tests:** `proposedChange` for Claude's `{ file_path, content }`, Claude's `{ file_path, old_string, new_string }`, the fake's `{ path }` → `none` with the path, a shell input → `none`; the context paints `-old` and `+new` lines and cuts a 300-line content at 200 with the note; `Before this, the agent said:` shows the last two messages; `See changes` calls `onSeeChanges("run1")`; the panel shows the project note for another project's action; the strip card's `More context` focuses `needs_you` (TestDock); `Learn more` on a shell decision calls `openLearn("action_kinds")`, on a gate `openLearn("readiness_gates")`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Needs-you tab with the proposed change, what the agent said and what the run changed; Learn links on decisions and gates`

---

### Task 10: The Learn view

**Files:** Create `apps/ui/src/views/LearnSideBar.tsx`, `apps/ui/src/learn-store.ts`. Modify `apps/ui/src/shell/{SideBar,Workbench}.tsx`, `styles.css`. Tests `apps/ui/test/{LearnSideBar,learn-store}.test.tsx`.

**Interfaces and copy:**
```ts
// learn-store.ts
export const LEARN_READ_KEY = "tt.learn.read.v1";
export function readTopics(): Set<string>; export function markRead(id: string): void;   // localStorage, fail quietly
// LearnSideBar.tsx: props from ShellContext: the active view (Workbench passes `contextView`) and `learnTopic`
```
- Side bar (`Learn`): a search input `aria-label="Search topics"` (matches title and body, case-insensitive); the heading `For what you are looking at` over the topics `topicsFor({ view })` ranks first (those whose `appliesTo` matched), then `Everything else` grouped by `LEARN_SECTION_LABELS` in `LEARN_SECTIONS` order; each topic a `<details>` with the title in `<summary>` and the body in `<p>`; opening one marks it read (a `✓` and class `read`); the topic named by `learnTopic` is open, first and scrolled into view (`scrollIntoView` guarded for jsdom); a footer `Short explanations so you can decide and audit well. They are written into The Terminal, not generated.`

- [ ] **Step 1: Write failing tests:** with `contextView: "changes"` the first topic is `Reading a diff` (the `reading_a_diff` title); searching `keychain` leaves only matching topics; opening a topic calls `markRead` and shows `✓`; `learnTopic: "estimates"` renders it open and first; the store round-trips and survives a storage error.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Learn view with context-ranked topics`

---

### Task 11: Documentation and changelog

**Files:** Create `docs/workspace.md`. Modify `CHANGELOG.md` (an `Added` block for this plan under Unreleased), `README.md` (one paragraph in "What it does today": review changes and files read-only, follow runs, the override). Tests: none beyond `pnpm test` staying green; the doc is reviewed by reading.

`docs/workspace.md` covers: the shell (activity bar views, side bars, tabs, bottom panel, status bar); presets and saved layouts and that decisions and gates surface in all of them; the Changes view (what a run's changes are compared with, tracked and untracked, binary, the limits and what `tooLarge` and the truncation notes mean); diff and file tabs being read-only by construction (the four routes, `resolveInside`, `.git` never served, cleaning before cutting); the Terminal (recorded output, ANSI stripped, no live PTY); the Conversation tab; the Needs-you tab's context; Learn; the emergency override (exactly what it covers and does not, the refusal rules, the environment it gets, the two recorded phases, why it is red); the ledger's paging; what later plans add (linked machines, the share view, roles and presence, installers).

- [ ] **Step 1:** Write the sections. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: the rich workspace: changes and diffs, terminal, conversation, learn, layouts and the emergency override`

---

### Task 12: End-to-end: changes and diffs, the override, presets, the Needs-you tab and Learn

**Files:** Create `e2e/changes.spec.ts`, `e2e/override.spec.ts`, `e2e/workspace.spec.ts`. Modify `e2e/global-setup.ts` (the fake script gains, after the shell step, `{ write: { path: "notes.txt", content: "key=zq-TESTKEY-e2e-opaque-0000000000\nhello\n" } }` and `{ message: "I wrote notes.txt." }`), `e2e/shell.spec.ts` (nine views; the default layout is `Board` and `Conversation`; the Ledger-tab test chooses `Operator` first), Plan 3's `e2e/{intake,gates,story}.spec.ts` and 5A/5B specs that assert on the `Ledger` or `Agent feed` tab (choose `Operator` in a shared helper `operatorLayout(page)` before asserting).

- [ ] **Step 1: Write the failing e2e tests:**
  - changes: store the Claude test key as in `connections.spec.ts`; Agents → start the fake agent → allow the shell step → wait for `completed`; `Changes` → the run is selected, `1 file(s) changed`, row `U notes.txt`; click it → tab `notes.txt` with `New file, not yet committed`, a line `+key=[REDACTED]` and a line `+hello` **(Review Focus 2)**; `Files` → `notes.txt` → tab shows `key=[REDACTED]` and `Read-only`; `GET /api/runs/<id>/file?path=../token` from the page context → 404 **(Review Focus 1)**; every response body during the spec is checked for the key;
  - override: while the fake run's shell step is pending, `Changes` → `Emergency override` shows `Stop the agent first.` and the forms are disabled **(Review Focus 3)**; allow the step and wait for `completed`; `Run a command…` with program `node`, arguments `-e` and `console.log("override says hi")`, reason `Checking the override path end to end` → `Recorded.`; `Operator` layout → `Terminal` shows `# OVERRIDE node -e console.log("override says hi")` in red (class `override`) and `override says hi`; `Ledger` shows `OVERRIDE: Owner ran "node -e console.log(\"override says hi\")" in the Fake agent's working copy: Checking the override path end to end` and `Override finished (exit 0)`, both with class `override`; then `Discard…` with a reason → `Changes` shows `0 file(s) changed` and the ledger shows `OVERRIDE: Owner discarded 1 changed file(s)…`;
  - workspace: a fresh context shows tabs `Board` and `Conversation` only and the `Layout` select reads `Guided`; `Conversation` shows `You asked Fake` with the prompt and `I wrote notes.txt.` after a run; `Ask` starts a run (`Needs you: 1` appears); with the Guided layout and `Connections` selected, the decision card is visible in the strip **(Review Focus 5)**; `More context` opens the `Needs you` tab showing `Before this, the agent said:`; choose `Operator` → `Terminal`, `Agent feed`, `Ledger` tabs; close `Ledger`, `Save layout` as `Mine`, reload → `Mine` is selected and `Ledger` is absent; `Reset layout` → `Guided`; `Learn` → with `Changes` selected first, the first topic is `Reading a diff`; a saved layout holding `diff:gone:x` (set through `localStorage` in the test) restores without that tab **(Review Focus 5)**;
  - `GET /api/runs/<id>/changes` and `POST /api/runs/<id>/override/discard` without the cookie → 401.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows. Open the pull request from `plan-4-rich-workspace` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): changes and diffs, the emergency override, layouts, the Needs-you tab and Learn`

---

## Done when

- The Owner opens any run's changes, reads every diff and every file of its working copy, and can neither edit nor fetch anything outside the worktree; secrets are `[REDACTED]` in diffs, files and outputs; large things say they are large instead of hanging.
- The Terminal shows every command agents ran and what came back; the Agent feed follows every run live; the Conversation tab is where the Owner asks for a change, and the Board shows the project's agent spend.
- The emergency override exists in exactly two forms, needs a reason, is refused while an agent is working, runs without a shell or credentials, and is recorded in two phases and painted red in every list of ledger entries.
- Decisions carry the proposed change and what the agent said just before. What the run has changed shows once the run is stopped or finished: a run waiting on a decision is live, and the core refuses every view of a live run's working copy (409 `run_active`, a safeguard added in the Task 2 review), so the Needs-you tab says so in place of the count and asks for nothing. Decisions and gates link to a Learn topic, and the Learn view ranks topics by what the Owner is looking at.
- Guided and Operator presets and up to ten saved layouts exist; no layout hides a decision or a gate.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI; the work is merged to `main` through a pull request.
