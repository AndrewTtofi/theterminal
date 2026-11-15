# Plan 11: Home and project sources, implementation plan

**Goal:** Make a plain-language Home the first screen (approvals, a progress card per job, what finished today, the project's files), let a project start from files, a GitHub repository or a local folder, and let accepted work go back to its source.

**Architecture:**
- **Progress:** the runner appends one fixed instruction to every prompt, reads `[[plan: …]]` and `[[step n/m …]]` lines out of the agent's own messages, and records each change as `agent.progress`. The run projection keeps the latest snapshot, so the percentage always rebuilds from the ledger. Pure helpers in `packages/shared` turn a run into a title, a "Now:" line, a percentage and a final summary.
- **Sources:** uploads, GitHub archives and local folders all pass through one staging step (`ImportStaging`) that enforces the limits and the path and secret rules, then one commit into the project repo through `WorktreeManager`. A `project_sources` projection remembers where the files came from.
- **Write-back:** "Accept these changes" snapshots the run's working copy and merges it into the project repo. "Apply to my folder" and "Publish to GitHub" send the difference between the last synced commit and `HEAD` back to the source.
- **UI:** a `home` dock panel and activity view built from blocks whose order lives in localStorage (`tt.home.v1`). The Board stays registered but is hidden unless Settings → Workspace turns it on (`tt.workspace.v1`).

**Tech Stack:** TypeScript, zod, Fastify 5, better-sqlite3, git (through `WorktreeManager.runGit`), Node `zlib` and `crypto`, React 18, dockview, Vitest, Playwright, Electron.

**Spec:** `docs/specs/2026-11-16-home-and-project-sources-design.md` is the authority for behaviour. The main spec `docs/specs/2026-11-13-agent-workspace-design.md` and `AGENTS.md` still apply.

## Global Constraints

- No new runtime or dev dependencies. Tar reading, multipart-free uploads and git-object hashing are written by hand on `node:zlib`, `node:crypto` and `node:stream`.
- State changes go through `commitEvent`. Projections rebuild exactly from the ledger: every new table or column is filled only in `applyEvent`, and new tables are added to `PROJECTION_TABLES`.
- No shell strings. Git runs only through `WorktreeManager.runGit`, which uses the allowlisted git environment. GitHub calls use the server's `fetch`, with the token only in the `Authorization` header. git never sees the token, and `GIT_ENV_NAMES` is unchanged.
- **Limits** (`IMPORT_LIMITS` in shared): at most `2000` files, `209_715_200` bytes (200 MB) in total and `52_428_800` bytes (50 MB) per file. They apply to every import and to every write-back.
- **Refused paths:** absolute paths, a `..` segment, symlinks and other non-regular files, names the platform can't store (see Task 2), anything under `.git` (`isGitSegment`), and a second path that differs from an earlier one only by case.
- **Possible secrets:** see `secretLikePath` in Task 2. They are refused with their names unless `includeSecrets` is true for that import.
- **Roles:** maintainers and above may add files, create projects from GitHub and accept runs. Only the Owner may import a local folder, pick a folder, apply to the folder or publish to GitHub. The folder routes and Apply also refuse the remote listener with `403 { error: "local_only" }`.
- **Owner-only path:** the folder's absolute path is stored in `project.source_set.path`. `trimForRole` removes it for everyone but the Owner, and no narration or share page contains it.
- **No fake progress:** a percentage is `Math.floor(100 * done / steps)` from `agent.progress` only. With no plan, the run shows "Working…" with no number and no `aria-valuenow`.
- **Storage keys** (each read and write wrapped in try/catch like `layout-store.ts`): `tt.home.v1` for the Home layout and `tt.workspace.v1` for `{ showBoard }`.
- New UI CSS uses `var(--…)` tokens only. The `styles-tokens` test covers every `apps/ui/src/**/*.css` (Task 14).
- Existing routes, decision cards, gates and roles behave as before. Existing e2e tests change only where they relied on the Board being the home tab.
- Cross-platform (macOS and Windows CI): `node:path` everywhere, no case-sensitivity assumptions. Tests come first. Commits have conventional subjects, the author AndrewTtofi with the noreply email, and no trailers.

## API contract (shared by Tasks 11, 12 and 16)

| Route | Role | Body or query | Answer |
|---|---|---|---|
| `GET /api/home` | viewer | `?projectId=` (absent: every project) | `HomeRuns` |
| `GET /api/projects/:id/files` | reviewer | | `ProjectFiles` |
| `GET /api/github/repos` | maintainer | | `{ repos: GitHubRepoChoice[] }` |
| `POST /api/projects/from-github` | maintainer | `{ repo, name?, includeSecrets? }` | 201 `ImportedProject` |
| `POST /api/projects/from-folder` | owner, local | `{ path, name?, includeSecrets? }` | 201 `ImportedProject` |
| `POST /api/host/pick-folder` | owner, local | `{}` | `{ path: string \| null }`, or 404 `folder_picker_unavailable` |
| `POST /api/projects/:id/uploads` | maintainer | `{ files, bytes, includeSecrets }` | 201 `{ uploadId }` |
| `PUT /api/uploads/:id/file` | maintainer | `?path=<relative>`, raw `application/octet-stream` body | 204 |
| `POST /api/uploads/:id/commit` | maintainer | `{}` | `ImportResult` |
| `DELETE /api/uploads/:id` | maintainer | | 204 |
| `POST /api/runs/:id/accept` | maintainer | `{}` | `{ commit }` |
| `GET /api/projects/:id/writeback` | owner | | `WritebackPreview` |
| `POST /api/projects/:id/apply` | owner, local | `{ head }` | `ApplyResult` |
| `POST /api/projects/:id/publish` | owner | `{ head }` | `{ branch, pullUrl }` |

**Error codes** (fixed codes; nothing from the request is echoed back):
- `limit_exceeded` (413) `{ limit: "files" | "bytes" | "file_bytes" }`
- `path_refused` (400) `{ reason }`
- `possible_secrets` (409) `{ names }`: at most 20 names, each passed through `redact` and `visibleControls`
- `merge_conflict` (409)
- `already_accepted` (409)
- `nothing_to_write` (409)
- `no_source` (404)
- `preview_stale` (409)
- `folder_unavailable` (409)
- `folder_refused` (400)
- `local_only` (403)
- `upload_not_found` (404)
- `upload_busy` (409)
- `folder_picker_unavailable` (404)
- the existing GitHub codes

`/api/status` gains `doneToday: number`.

## Rulings (where the spec leaves a choice)

1. **Step instruction:** one fixed text for all three agents (`STEP_PLAN_INSTRUCTION`, Task 6). It is appended to the prompt given to the adapter. `agent.started` records the person's prompt unchanged, so the job title and the ledger show what the person typed.
2. **Parsing:**
   - A marker counts only when it is a whole line (trimmed) of an `agent.message`. Tool output is never read.
   - A marker split across streamed chunks (Gemini) is joined through a carry of at most 400 characters.
   - The first plan wins; later plans are ignored.
   - A plan of more than 7 steps keeps its first 7. A step line counts only if its `m` equals the number of steps the agent stated and `n ≤ 7`.
   - `started` sets the current step, and `done` adds `n` to the done set. A line that changes nothing records nothing.
3. **One-line reason under an approval:** the text of the run's current step (`progress.steps[current - 1]`), when there is one. Otherwise the line is left out.
4. **Approvals on Home:** the block lists the pending decisions of every project (the project's name is shown when it is not the selected one), because a project choice must never hide a decision. Everything else on Home is the selected project's.
   - Action decisions get **Approve**, **Deny** and **Ask why**. Ask why focuses the existing Needs-you tab, whose cards are the full decision cards.
   - Intake decisions and gate prompts get one sentence and a **Review** button that opens the same tab. Gates need sign-offs and intake decisions need a choice, so there are no Approve or Deny buttons for them.
   - The Needs-you strip above the dock stays as it is. Both places call `model.onDecide`, so a second click gets `already_decided`.
5. **Top strip:** clicking "working" or "done today" switches Working now or Finished today to every project (cards labelled with their project); clicking the same total again switches back. "Need you" scrolls to the approvals block and focuses its heading. "Cost" is not a filter.
6. **Overall progress:** for the selected project (or every project while a filter is on), it is the sum of done steps over the sum of steps of running runs with a plan. Runs without a plan are listed as "N working without a plan" and add nothing to the number.
7. **Upload transport:** a series of requests (open, one streamed `PUT` per file, commit), on the link listener's raw-body pattern (`addContentTypeParser("application/octet-stream", … done(null, undefined))`), so nothing holds a whole upload in memory.
   - Each upload session belongs to the person who opened it. It expires after 1 hour, and at most 4 are open on the server at a time.
8. **Refusal unit:**
   - A refused path is skipped and counted, and reported in the result as `skipped: { path, reason }[]` (at most 50 listed). For an upload it is refused at its `PUT`.
   - Possible secrets refuse the whole import unless ticked.
   - A broken limit refuses the whole import, and nothing is committed.
9. **Secret-looking names:** the Changes view hides only names that a redaction pattern changes. So `secretLikePath` is that test plus a fixed list (Task 2).
10. **Commit identity:** imports commit as the repo's existing identity ("The Terminal"), with the message `Added N files` / `Imported from GitHub: owner/repo` / `Imported from a folder`. The person is the ledger entry's actor. No names or emails go into git.
11. **Accept:**
    - For a local run, the run's working copy is snapshotted with a scratch index (the tree the Changes view shows) into a commit `Run <id8>` whose parent is the worktree's `HEAD`. That commit is merged with `--no-ff` into the project repo's checked-out branch, with the message `Accept run <id8>`.
    - For a run on a linked machine, the imported `run/<id>` tip is merged.
    - On a conflict the merge is aborted and nothing changes.
12. **What write-back sends:** the difference between the source's `syncedCommit` and `HEAD`. That is every accepted run and every later added file since the import or the last Apply. It is shown in full before confirming.
    - A preview returns `head`. Apply and Publish refuse with `preview_stale` when `HEAD` or `syncedCommit` has moved since.
13. **"Changed since copied in"** is decided without running git in the person's folder. The file's git blob id is hashed in-process (`sha1("blob <size>\0" + bytes)`) and compared with the blob at `syncedCommit`. A file absent at `syncedCommit` but present now is also skipped.
14. **Publish:**
    - It sends one commit with the combined change: local history's parents do not exist on GitHub. The commit's parent is the imported `remoteCommit`, and it goes on a new branch `the-terminal/<8 lowercase hex>`, followed by a pull request against the recorded branch.
    - `syncedCommit` does not move, because the pull request is not merged. A later publish starts again from `remoteCommit`.
15. **GitHub import:**
    - The repository list is the first 100 repositories from `GET /user/repos?per_page=100&sort=updated`.
    - The download is `GET /repos/:repo/tarball/:sha` with `redirect: "manual"`. Only a `Location` on `https://codeload.github.com/` is followed, without the `Authorization` header.
    - The archive is gzip and tar only (no zip, which cannot be streamed), and at most 200 MB compressed.
    - It uses the first enabled GitHub connection's token (`githubToken()`), whether or not that connection names a repository.
16. **Folder import:**
    - The file list comes from `git ls-files --others --exclude-standard -z`, with a scratch, empty `--git-dir` under the data folder and `--work-tree` set to the folder, so the folder's own `.git` and its configuration are never read.
    - Nested repositories (entries ending in `/`) are skipped.
    - The folder must be absolute, an existing directory, and neither inside the data folder nor containing it.
17. **Folder picker:** the window gets no preload and no renderer IPC.
    - `POST /api/host/pick-folder` (Owner, local listener) makes the server child send `{ type: "pick_folder", id }` to its host over the existing Node IPC channel. The Electron main process shows `dialog.showOpenDialog(win, { properties: ["openDirectory"] })` and answers `{ type: "picked_folder", id, path }`.
    - One pick runs at a time, and a pick times out after 10 minutes.
    - The headless server has no IPC channel and answers `folder_picker_unavailable`. The UI then shows a typed path field.
    - The path reaches only the Owner, who could type any path anyway, so the picker is a convenience, not a trust boundary.
18. **Board hidden:**
    - The presets no longer contain a Board tab: Guided is Home and Conversation; Operator is Home and Capacity over the Terminal, Agent feed and Ledger.
    - With **Show the Board** on, the Board button appears in the activity bar and opens the Board tab as today.
    - Saved layouts holding a Board tab still restore.
    - The `home` side bar shows the project list (`ProjectsSideBar`).
19. **Home blocks in v1:** `ask`, `approvals`, `working`, `overall`, `finished`, `files`, in that default order, with 2 columns for Working now. Previews is not in the list until the preview work adds it. Unknown stored ids are dropped.
20. **Progress on a linked machine:** `agent.progress` is mirrored like `agent.message`. `remoteDisplay` re-cleans its step texts with this machine's redaction.
21. **Project files role:** top-level names come from the repo, so they need a reviewer, as run file lists do. Viewers see "Files are shown to reviewers and above."
22. **MB:** MB means MiB (the byte values in the Global Constraints).

## Review Focus

1. **Marker forgery or noise:** a tool's output, a file the agent reads, or prose that mentions `[[step 9/9 done]]` mid-line must change nothing. Only whole lines of the agent's own messages count, and the step must fit the stated plan (Task 6 test `ignores markers in action output and mid-line`).
2. **An abandoned or lying upload:** the client disconnects mid-file, sends more bytes than declared, or never commits. Nothing is committed, the staging folder is removed, and the limits hold on counted bytes, not on declared ones (Task 9 tests `counts streamed bytes, not content-length` and `sweeps expired uploads`).
3. **A hostile folder or archive:** a symlink pointing outside, an `../` tar entry, a `.git` directory with a planted config, `CON.txt`, two names differing by case, the data folder itself. Each is skipped or refused, and git never reads the folder's own `.git` (Task 5 and Task 7 tests).
4. **The person edited or removed files in their folder since the import, or the folder is gone.** Changed files are skipped and listed, and nothing outside the list is touched. A missing folder writes nothing and says `folder_unavailable` (Task 10 tests).
5. **Two hands at once:** Accept clicked twice, Apply from two tabs, a decision from Home and from the strip together. The second gets `already_accepted`, `preview_stale` or `already_decided`, and nothing is written twice (Task 10 and Task 11 tests).

---

### Task 1: Run progress and Home summaries (shared)

**Files:**
- Create: `packages/shared/src/home.ts`
- Modify:
  - `packages/shared/src/agents.ts` (the `agent.progress` schema; the optional `AgentRun` fields);
  - `packages/shared/src/link.ts` (mirrorable);
  - `packages/shared/src/narration.ts` (the `agent.progress` case);
  - `packages/shared/src/index.ts`.
- Test: `packages/shared/test/home.test.ts`, plus additions to `agents.test.ts`, `link.test.ts`, `narration.test.ts` and `ledger-compat.test.ts` if it lists types.

**Interfaces (produces):**
- `type RunProgress = { steps: string[]; done: number[]; current: number | null }` and `PROGRESS_LIMITS = { maxSteps: 7, stepChars: 80 }`.
- `agentPayloadSchemas["agent.progress"]`: strict `{ runId, steps: string(1..80)[] (1..7), done: int[] (unique, ascending, each 1..steps.length), current: int (1..steps.length) | null }`.
- `AgentRun` gains three optional fields, so existing fixtures stay valid:
  - `progress?: RunProgress | null`;
  - `lastMessage?: string | null`;
  - `acceptedCommit?: string | null`.
- `"agent.progress"` is added to `MIRRORABLE_TYPES` and `MIRRORED_PAYLOADS`.
- `progressPercent(p: RunProgress | null | undefined): number | null`.
- `clip(s: string, max: number): string`: at most `max` characters, ending in `…` when cut.
- `jobTitle(run: Pick<AgentRun, "prompt" | "progress">): string`: the first plan step, else the first non-empty line of the prompt, clipped to 60.
- `nowLine(a: ActionLike | null): string | null`: `actionPhrase(a)` with its first letter capitalised. The UI prefixes "Now:".
- `finalSummary(lastMessage: string | null | undefined, finishedHeadline: string): string`: the message clipped to 200, else the headline.
- `overallProgress(runs: Pick<AgentRun, "status" | "progress">[]): { percent: number | null; withPlan: number; withoutPlan: number }`: running runs only.
- `currentStep(p): string | null`.

- [ ] **Step 1: Write the failing tests.**
  - `progressPercent({steps:["a","b","c"],done:[1],current:2})` is `33`; with `done:[1,2,3]` it is `100`; `null` gives `null`.
  - The schema rejects 8 steps, an 81-character step, `done:[2,2]`, `done:[4]` with 3 steps, and an unknown key.
  - `jobTitle({prompt:"Fix the login\nmore", progress:null})` is `"Fix the login"`. A 70-character first line gives 60 characters ending in `…`. With a plan, the result is `steps[0]`.
  - `finalSummary(null, "Claude finished")` is `"Claude finished"`. A 250-character message gives 200 characters.
  - `overallProgress` of two running runs with 1/2 and 3/4 done and one without a plan gives `{ percent: 66, withPlan: 2, withoutPlan: 1 }`. A finished run is ignored.
  - `MIRRORABLE_TYPES` includes `"agent.progress"`, and `mirroredOriginSchema` accepts a valid progress origin.
  - Narration of `agent.progress` with `done:[1,2], current:null` of 3 steps reads `Claude finished step 2 of 3: "<step 2>"` (the agent's label through `adapterName`). With `current: 3` it reads `Claude started step 3 of 3: "<step 3>"`. The topic is `"agent"`.
- [ ] **Step 2:** `pnpm --filter @theterminal/shared exec vitest run test/home.test.ts test/agents.test.ts test/link.test.ts test/narration.test.ts`. It fails.
- [ ] **Step 3:** Implement. For narration, the latest change is: the highest `done` index when `current` is null, else `current`.
- [ ] **Step 4:** `pnpm --filter @theterminal/shared test`. All green.
- [ ] **Step 5:** Commit `feat(shared): run progress, job titles and summaries`.

### Task 2: Project sources, path rules and events (shared)

Runs after Task 1 (both edit `narration.ts` and `index.ts`).

**Files:**
- Create: `packages/shared/src/sources.ts`
- Modify: `packages/shared/src/events.ts`, `packages/shared/src/narration.ts` (cases, and `topicOf`: `run` → `"agent"`, the new `project.*` → `"board"`) and `packages/shared/src/index.ts`
- Test: `packages/shared/test/sources.test.ts`, plus `narration.test.ts`

**Interfaces (produces):**
- `IMPORT_LIMITS = { files: 2000, bytes: 209_715_200, fileBytes: 52_428_800 } as const`.
- `type PathRefusal = "absolute" | "dot_dot" | "git" | "unstorable" | "empty" | "too_long"`.
- `checkImportPath(p: string): { ok: true; path: string } | { ok: false; reason: PathRefusal }`.
  - Separators are normalised to `/`.
  - These are refused:
    - a leading `/` or `\`, or `X:`;
    - a `..` segment;
    - any segment for which `isGitSegment` would be true (`.git` in any case; repeat its rules here as a pure function);
    - empty segments;
    - Windows reserved names (`CON PRN AUX NUL COM1–9 LPT1–9`, with or without an extension, any case);
    - the characters `<>:"|?*` and C0 controls;
    - a segment ending in `.` or space;
    - a segment over 255 bytes;
    - a path over 1024 characters.
- `secretLikePath(p: string): boolean`: true when `redact(p) !== p` would be (passed in as `redactsTo?: (s) => string`, defaulting to identity, so shared stays free of core), or when the base name matches one of:
  - `.env`, `.env.*`;
  - `*.pem`, `*.key`, `*.p12`, `*.pfx`;
  - `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (not `.pub`);
  - `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`;
  - `credentials.json`, `*.keystore`;
  - a path ending `.aws/credentials`.
- `foldKey(p: string): string`: lower case, for case-collision checks.
- `type ProjectSourceKind = "github" | "folder"`; `type ProjectSourceView = { kind: "github"; repo: string; branch: string } | { kind: "folder"; path?: string } | null`.
- Types used by the API contract:
  - `HomeRun = { run: AgentRun; projectName: string; title: string; percent: number | null; now: string | null; summary: string | null; waiting: boolean; reason: string | null }`;
  - `HomeRuns = { working: HomeRun[]; finishedToday: HomeRun[] }`;
  - `ProjectFiles = { source: ProjectSourceView; added: boolean; head: string; entries: DirEntry[]; truncated: boolean }`;
  - `GitHubRepoChoice = { fullName: string; defaultBranch: string; private: boolean }`;
  - `ImportResult = { commit: string; files: number; bytes: number; skipped: { path: string; reason: string }[]; skippedCount: number }`;
  - `ImportedProject = { project: Project; result: ImportResult }`;
  - `WritebackPreview = { kind: ProjectSourceKind; head: string; files: { path: string; change: "add" | "modify" | "delete" }[] }`;
  - `ApplyResult = { written: number; deleted: number; skipped: string[] }`.
- `sourcePayloadSchemas`, each strict. `sha` is `/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`.
  - `project.source_set`: `{ projectId, kind, repo?, branch?, remoteCommit?, path?, syncedCommit }`.
    - With `kind: "github"`: `repo` is required and matches the client's `REPO_NAME`, and `branch` (1–255) and `remoteCommit` are required.
    - With `kind: "folder"`: `path` (1–4096) is required.
    - Any other combination is refused (`superRefine`).
  - `project.files_imported`: `{ projectId, from: "files" | "github" | "folder", commit, files, bytes, skipped, secretsIncluded }`, where `files`, `bytes` and `skipped` are non-negative integers.
  - `run.accepted`: `{ runId, commit, files }`.
  - `project.folder_applied`: `{ projectId, from, to, written, deleted, skipped }`.
  - `project.published`: `{ projectId, branch: /^the-terminal\/[0-9a-f]{8}$/, pullUrl: /^https:\/\/github\.com\/[^\s]{1,300}$/, from, to, files }`.
- Narration:
  - `project.files_imported`: `<who> added 12 files (3.4 MB) from GitHub` / `from a folder` / `to the project`;
  - `project.source_set`: `<who> linked the project to GitHub: owner/repo` / `to a folder on this computer`. Never the path.
  - `run.accepted`: `<who> accepted the changes of <agent>`;
  - `project.folder_applied`: `<who> applied 4 files to the folder (1 skipped)`;
  - `project.published`: `<who> opened a pull request on GitHub`.

- [ ] **Step 1: Write the failing tests.**
  - `checkImportPath` accepts `"src/a.ts"`, `"docs\\b.md"` (as `docs/b.md`) and `"ünïcode/ok.txt"`.
  - It refuses, each with its reason:
    - `"/etc/x"`, `"C:x"` → `absolute`;
    - `"a/../b"` → `dot_dot`;
    - `".git/config"`, `"x/.GIT/y"` → `git`;
    - `"con.txt"`, `"a/aux"`, `"a:b"`, `"a/b."`, `"a\u0001"` → `unstorable`;
    - `""`, `"a//b"` → `empty`.
  - `secretLikePath` is true for `.env`, `config/.env.local`, `server.pem`, `id_rsa`, `x/.aws/credentials` and `.npmrc`, and false for `id_rsa.pub`, `env.ts` and `README.md`. With `redactsTo` replacing `ghp_TESTKEY…`, a file named with that token is true.
  - The `project.source_set` schema rejects `kind:"github"` without `repo`, and `kind:"folder"` with `repo`.
  - The `project.published` schema rejects a branch `main` and a `pullUrl` on `http://`.
  - Narration of `project.source_set` with a folder path never contains the path string.
  - `eventPayloadSchemas` has every new type.
- [ ] **Step 2:** `pnpm --filter @theterminal/shared exec vitest run test/sources.test.ts test/narration.test.ts`. It fails.
- [ ] **Step 3:** Implement, and register `...sourcePayloadSchemas` in `events.ts` and the `EventType` union.
- [ ] **Step 4:** `pnpm --filter @theterminal/shared test`. All green.
- [ ] **Step 5:** Commit `feat(shared): project sources, import path rules and events`.

### Task 3: Home layout and workspace stores (ui)

**Files:**
- Create: `apps/ui/src/home/home-store.ts` and `apps/ui/src/shell/workspace-store.ts`
- Test: `apps/ui/test/home-store.test.ts` and `apps/ui/test/workspace-store.test.ts`

**Interfaces (produces):**
- `HOME_KEY = "tt.home.v1"`; `HOME_BLOCKS = ["ask", "approvals", "working", "overall", "finished", "files"] as const`; `type HomeBlockId`; `HOME_BLOCK_LABELS` ("Ask box", "Needs your approval", "Working now", "Overall progress", "Finished today", "Project files").
- `type HomeLayout = { version: 1; order: HomeBlockId[]; hidden: HomeBlockId[]; workingColumns: 1 | 2 }`; `DEFAULT_HOME: HomeLayout` (`HOME_BLOCKS` order, none hidden, 2 columns).
- `normalizeHome(v: unknown): HomeLayout`:
  - anything but a `version: 1` object gives the default;
  - unknown ids and duplicates are dropped;
  - missing ids are inserted at their default position;
  - `"approvals"` is removed from `hidden`;
  - columns other than 1 or 2 become 2.
- `loadHome(): HomeLayout`, `saveHome(l: HomeLayout): void`, `resetHome(): HomeLayout` (removes the key).
- `moveBlock(l, id, delta: -1 | 1): HomeLayout` and `toggleBlock(l, id): HomeLayout` (a no-op for `approvals`).
- `WORKSPACE_KEY = "tt.workspace.v1"`; `loadWorkspace(): { showBoard: boolean }` (default `false`), `saveWorkspace(w)`, and `useWorkspace(): { showBoard; setShowBoard(b) }`, which re-renders every subscriber in the tab (a module-level listener set).

- [ ] **Step 1: Write the failing tests.**
  - `normalizeHome("{")`, `normalizeHome({version:0})` and `normalizeHome(null)` each equal `DEFAULT_HOME`.
  - `normalizeHome({version:1, order:["files","x","files"], hidden:["approvals","files"], workingColumns:3})` has `order[0] === "files"`, contains all six ids once, has `hidden` equal to `["files"]` and `workingColumns` 2.
  - `toggleBlock(DEFAULT_HOME,"approvals")` is unchanged.
  - `moveBlock` of the first block by `-1` is unchanged.
  - With a throwing `localStorage` stub, `loadHome()` is the default and `saveHome` does not throw.
  - `loadWorkspace()` is `{showBoard:false}` by default and with corrupt JSON. After `saveWorkspace({showBoard:true})` it is `true`.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/home-store.test.ts test/workspace-store.test.ts`. It fails.
- [ ] **Step 3:** Implement on `layout-store.ts`'s pattern.
- [ ] **Step 4:** Run the tests again. They pass.
- [ ] **Step 5:** Commit `feat(ui): Home layout and workspace settings stores`.

### Task 4: Folder picker over the desktop IPC channel (core host, desktop)

**Files:**
- Create: `packages/core/src/server/folder-picker.ts` and `apps/desktop/src/folder-pick.ts`
- Modify:
  - `packages/core/src/host.ts` (message types);
  - `packages/core/src/cli.ts` (pass a picker into `createServer` when `process.send` exists: an option `pickFolder`, consumed by Task 11);
  - `packages/core/src/server/server.ts` (accept and keep the option only: `ServerOptions.pickFolder?: () => Promise<string | null>`);
  - `apps/desktop/src/server-process.ts` (`startServer({ …, onPickFolder })`);
  - `apps/desktop/src/main.ts`.
- Test: `packages/core/test/server/folder-picker.test.ts`, `apps/desktop/test/folder-pick.test.ts` and `apps/desktop/test/server-process.test.ts` (an addition)

**Interfaces (produces):**
- `host.ts`:
  - `ChildMessage = ReadyMessage | { type: "pick_folder"; id: string }`;
  - `HostMessage = { type: "shutdown" } | { type: "picked_folder"; id: string; path: string | null }`.
- `createFolderPicker(io: { send(m): void; on(listener): void }, opts?: { timeoutMs?: number; newId?: () => string }): () => Promise<string | null>`:
  - one pick at a time, so a second call while one is open rejects with `PickerBusyError`;
  - it resolves `null` on timeout (default `600_000`);
  - it ignores answers with another id, and an answer whose `path` is not a string of 1–4096 characters, absolute by `node:path`.
- `pickedPath(result: { canceled: boolean; filePaths: string[] }): string | null` in `folder-pick.ts`.
- `server-process.ts`: on a valid `pick_folder` message it awaits `onPickFolder()` and calls `child.send({ type: "picked_folder", id, path })`. `main.ts` supplies `() => dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }).then(pickedPath)`, and returns `null` when there is no window.

- [ ] **Step 1: Write the failing tests.**
  - With a fake io: a pick sends `{type:"pick_folder", id:"p1"}`, and an answer `{type:"picked_folder", id:"p1", path:<abs>}` resolves to that path.
  - An answer with id `"other"` is ignored.
  - `path: "relative"` resolves `null`.
  - A second concurrent pick rejects with `PickerBusyError`.
  - With `timeoutMs: 10` the pick resolves `null`.
  - `pickedPath({canceled:true, filePaths:["/x"]})` is `null`.
  - `server-process` with a fake child: a `pick_folder` message calls `onPickFolder` once and sends back the answer with the same id. A malformed message (`{type:"pick_folder"}` with no id) is ignored.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core exec vitest run test/server/folder-picker.test.ts` and `pnpm --filter @theterminal/desktop exec vitest run`. They fail.
- [ ] **Step 3:** Implement. The window keeps `sandbox`, `contextIsolation` and no preload. The harden tests are unchanged.
- [ ] **Step 4:** Run both suites. All green.
- [ ] **Step 5:** Commit `feat(desktop,core): native folder picker through the server's host channel`.

### Task 5: Streaming tar reader (core)

**Files:**
- Create: `packages/core/src/sources/tar.ts`
- Test: `packages/core/test/sources/tar.test.ts`, with a tiny ustar writer in `packages/core/test/sources/tar-fixture.ts`

**Interfaces (produces):**
- `type TarEntry = { path: string; kind: "file" | "dir" | "link" | "other"; size: number; mode: number }`, where `path` has its first segment (`owner-repo-sha/`) removed.
- `readTarGz(input: Readable, onEntry: (e: TarEntry, body: Readable) => Promise<void>, opts: { maxCompressedBytes: number; maxEntries: number }): Promise<void>`.
  - It gunzips with `zlib.createGunzip()`.
  - It parses 512-byte headers and checks each header's checksum (a bad one gives `TarInvalidError`).
  - It supports the ustar `prefix`, pax `x` records (`path`, `size`), GNU `L` long names, and ignores pax `g` headers.
  - Types `0`, `\0` and `7` are files and `5` is a directory; `1` and `2` are links (their bodies are not read), and anything else is `other`.
  - It stops at two zero blocks.
  - `onEntry` must consume or `resume()` the body. The reader applies backpressure (it awaits `onEntry`).
  - Over `maxCompressedBytes` or `maxEntries` it gives `TarLimitError`.

- [ ] **Step 1: Write the failing tests** (archives built in the test):
  - three files, including one in a subdirectory, come back with stripped paths and exact contents;
  - a 150-character path through pax `x` comes back whole;
  - a symlink entry is reported as `kind: "link"`, its body is never yielded, and the next file is still read;
  - a corrupted checksum rejects with `TarInvalidError`;
  - a stream over `maxCompressedBytes: 1024` rejects with `TarLimitError`;
  - a 5 MB file is read with memory use bounded: the body is a stream and the test reads it in chunks.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/sources/tar.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test again. It passes.
- [ ] **Step 5:** Commit `feat(core): streaming reader for gzip tar archives`.

### Task 6: Step reports in the runner, progress projection and mirroring (core)

**Files:**
- Create: `packages/core/src/agents/progress.ts`
- Modify:
  - `packages/core/src/agents/runner.ts`;
  - `packages/core/src/db.ts`: a new migration adding `agent_runs.progress TEXT`, `agent_runs.last_message TEXT` and `agent_runs.accepted_commit TEXT`;
  - `packages/core/src/events/projections.ts` (`agent.progress`, `last_message` on `agent.message`, `toRun`, and `doneToday` in `workspaceCounts`);
  - `packages/core/src/link/mirrored.ts` (`remoteDisplay.run` cleans `progress.steps` and `lastMessage`).
- Test:
  - `packages/core/test/agents/progress.test.ts`;
  - additions to `runner.test.ts`, `projections.test.ts`, `link/mirrored.test.ts` and `link/mirror.test.ts`.

**Interfaces:**
- Consumes Task 1's `RunProgress`, `PROGRESS_LIMITS` and the `agent.progress` schema.
- Produces:
  - `STEP_PLAN_INSTRUCTION: string`, starting `"\n\n---\nProgress for The Terminal:"`. It asks for one line `[[plan: step one | step two | …]]` of 3 to 7 short steps before starting, then `[[step n/m started]]` and `[[step n/m done]]` on lines of their own, each step under 80 characters, and no secrets in them.
  - `parseProgressLine(line: string): { kind: "plan"; steps: string[] } | { kind: "step"; n: number; of: number; state: "started" | "done" } | null`.
    - Plan: `/^\[\[plan: (.+)\]\]$/` on the trimmed line; split on `|` and trim; any empty step gives null.
    - Step: `/^\[\[step ([1-9]\d?)\/([1-9]\d?) (started|done)\]\]$/`.
  - `class ProgressTracker { constructor(cleanStep: (s: string) => string); feed(text: string): RunProgress | null; }`. It applies Ruling 2 and returns a new snapshot only when something changed.
  - `WorkspaceCounts.doneToday`: runs whose `finished_at` falls on the local day of `now`.
- In the runner:
  - `launch` passes `prompt + STEP_PLAN_INSTRUCTION` to `adapter.start`.
  - `Session` gains `progress: ProgressTracker`.
  - On a `message` event, after committing `agent.message`, it feeds the raw text and commits `agent.progress` when the tracker returns a snapshot.
  - `cleanStep = (s) => truncate(visibleControls(this.clean(s, Infinity, scrub, secrets)), 80)`.
  - A failure to commit progress fails the run like any other commit failure.

- [ ] **Step 1: Write the failing tests.**
  - `parseProgressLine("[[plan: a | b | c]]")` gives `{kind:"plan", steps:["a","b","c"]}`; `"  [[step 2/3 done]] "` gives a step; `"[[step 0/3 done]]"`, `"x [[step 1/3 done]]"` and `"[[plan: a || b]]"` give `null`.
  - `ProgressTracker`:
    - plan, then `1/3 started` → `current:1`;
    - `1/3 done` → `done:[1], current:null`;
    - a repeated `1/3 done` → `null`;
    - `2/4 started` (wrong total) → `null`;
    - a second plan → `null`;
    - a step before any plan → `null`;
    - a 9-step plan → 7 steps, then `8/9 started` → `null`, and `7/9 done` → `done:[7]`;
    - a marker split as `"[[step 1/3 do"` + `"ne]]\n"` across two feeds counts once;
    - a step text with `\u202e` and an `sk-ant-TESTKEY…` secret is recorded escaped and redacted, at most 80 characters.
  - Runner, with a FakeAdapter script `[{message:"[[plan: Read | Fix | Test]]"},{message:"[[step 1/3 started]]"},{message:"[[step 1/3 done]]"}]`:
    - the ledger holds three `agent.progress` entries;
    - `getRun(...).progress` equals `{steps:["Read","Fix","Test"], done:[1], current:null}`;
    - after `rebuildAllProjections` it is the same;
    - the adapter received a prompt ending in `STEP_PLAN_INSTRUCTION`;
    - `agent.started.payload.prompt` is the original prompt.
  - `ignores markers in action output and mid-line`: an `action_result` whose output is `"[[step 1/3 done]]"` and a message `"I will [[step 1/3 done]] later"` record no progress.
  - `getRun().lastMessage` is the last message's recorded text.
  - `workspaceCounts(db, now).doneToday` counts a run finished today and not one finished yesterday.
  - A mirrored `agent.progress` from the run's machine applies. `remoteDisplay.run` re-cleans a step holding a secret this machine knows.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/agents/progress.test.ts test/agents/runner.test.ts test/events/projections.test.ts test/link`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green. The adapters' own tests are unchanged: they get the prompt the runner gives them.
- [ ] **Step 5:** Commit `feat(core): agents report step progress, recorded as agent.progress`.

### Task 7: Import staging and repository commits (core)

**Files:**
- Create: `packages/core/src/sources/staging.ts` and `packages/core/src/sources/folder.ts`
- Modify: `packages/core/src/agents/worktrees.ts` (three methods, each serialised per project)
- Test: `packages/core/test/sources/staging.test.ts`, `packages/core/test/sources/folder.test.ts` and an addition to `test/agents/worktrees.test.ts`

**Interfaces:**
- Consumes Task 2's `IMPORT_LIMITS`, `checkImportPath`, `secretLikePath` and `foldKey`.
- Produces:
  - Errors: `ImportLimitError(limit: "files" | "bytes" | "file_bytes")`, `PossibleSecretsError(names: string[])`, `PathRefusedError(reason)`, `FolderRefusedError` and `FolderUnavailableError`.
  - `class ImportStaging`:
    - `constructor(dir: string, o: { includeSecrets: boolean; redact: (s: string) => string })`. The staging directory is `<data>/projects/<id>/staging/<uuid>`, or `<data>/staging/<uuid>` before the project exists.
    - `add(path: string, body: Readable): Promise<"added" | "skipped">`. It checks the path (a refusal is skipped with its reason), case collisions (skipped as `"duplicate"`) and the file count before writing. It streams to the file, counting bytes; over `fileBytes` or the running total it destroys the body, removes the partial file and throws `ImportLimitError`. A secret-like name is recorded and its body drained.
    - `skip(path: string, reason: string): void`.
    - `finish(): { files: string[]; bytes: number; skipped: { path; reason }[]; skippedCount: number }`. It throws `PossibleSecretsError` (the first 20 names, cleaned) when secret-like names were seen and `includeSecrets` is false.
    - `dispose(): void`, which removes the directory and never throws.
  - `listFolder(wt: WorktreeManager, dataDir: string, folder: string): Promise<{ files: string[]; nested: string[] }>`.
    - It refuses (`FolderRefusedError`) a relative path, the data folder, a folder inside it or one containing it, each compared after `realpathSync.native` with case folding on Windows.
    - It gives `FolderUnavailableError` when the folder is missing or not a directory.
    - It runs `ls-files --others --exclude-standard -z` with the scratch `--git-dir` from Ruling 16 (`<data>/.theterminal-scan/<uuid>`, made by `git init --bare` and removed after) and `maxBuffer` 32 MiB.
  - `stageFolder(staging, folder, files): Promise<void>`: `lstat` each file; a symlink or non-regular file is skipped as `"link"`; each regular file is streamed with `createReadStream`.
  - `WorktreeManager.commitFiles(projectId, stagingDir, files: string[], message: string): Promise<string>`.
    - It runs `initRepo`, then copies each staged file into the repo, refusing any target that `resolveInside(repo, path)` rejects.
    - It runs `git add --force --pathspec-from-file=<tmp> --pathspec-file-nul` and `git commit --no-verify -m <message>`, and returns `HEAD`.
    - With nothing changed it returns `HEAD` without committing.
  - `WorktreeManager.materialise(projectId, commit, paths: string[], dir: string): Promise<void>`: `checkout <commit> -- <paths>` with `workTree: dir` and a scratch `indexFile`.
  - `WorktreeManager.snapshotRun(projectId, runId): Promise<string>`: the worktree's full tree through a scratch index (`add -A`, `write-tree`, `commit-tree -p HEAD -m "Run <id8>"`), returning the commit id.

- [ ] **Step 1: Write the failing tests.**
  - Staging:
    - three files are added, and `finish()` lists them;
    - `../x` and `.git/config` are skipped with `dot_dot` and `git`;
    - `A.txt` after `a.txt` is skipped as `duplicate`;
    - a 2001st file gives `ImportLimitError("files")`;
    - a stream of `fileBytes + 1` bytes gives `ImportLimitError("file_bytes")` and leaves no partial file;
    - `.env` with `includeSecrets:false` makes `finish()` throw `PossibleSecretsError([".env"])`, and with `true` it is kept;
    - `dispose()` removes the directory.
    - Use small limits through an optional `limits` override in tests only.
  - Folder (a temporary folder):
    - `.gitignore` with `dist/` excludes `dist/a.js`;
    - the folder's own `.git` with a planted `core.fsmonitor` config is never read, and no fsmonitor program runs (reuse `fixtures/submodule-trap.ts`'s approach);
    - a symlink to a file outside is skipped as `link`;
    - a nested repo is listed in `nested`;
    - passing `dataDir` or its parent gives `FolderRefusedError`;
    - a missing path gives `FolderUnavailableError`.
  - Worktrees:
    - `commitFiles` makes one commit with message `Added 2 files` holding exactly the two files, including one named `.gitignore`-ignored (it is forced);
    - `materialise` writes the file bytes exactly, including a binary file with `\0` bytes;
    - `snapshotRun` captures an untracked file the run created.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/sources test/agents/worktrees.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): staged imports with limits and refusals, committed into the project repo`.

### Task 8: GitHub repositories client (core)

**Files:**
- Create: `packages/core/src/github/repos.ts`
- Modify: `packages/core/src/connections/service.ts` (`githubToken()`)
- Test: `packages/core/test/github/repos.test.ts` and an addition to `test/connections/service.test.ts`

**Interfaces (produces):**
- `ConnectionService.githubToken(): { connectionId: string; token: string } | null`: the first enabled GitHub connection with a token, whatever its `repo`.
- `class GitHubRepos`, with `constructor(deps: { fetch: typeof fetch; token: () => { connectionId; token } | null; timeoutMs?: number })`. The default timeout is 30 s per call; downloads have no total deadline but a 60 s idle timeout. Errors reuse `GitHubNotConnectedError`, `GitHubRejectedError`, `GitHubRepoNotFoundError` and `GitHubUnavailableError`.
  - `listRepos(): Promise<GitHubRepoChoice[]>`.
  - `head(repo: string): Promise<{ branch: string; commit: string }>`: `GET /repos/:repo`, then `GET /repos/:repo/commits/:branch`.
  - `tarball(repo: string, commit: string, signal: AbortSignal): Promise<Readable>`, following Ruling 15. A `Location` anywhere else gives `GitHubUnavailableError`, and the second request carries no `Authorization`.
  - `publish(repo: string, i: { base: string; into: string; branch: string; files: { path: string; mode: "100644" | "100755"; content: Buffer | null }[]; title: string; body: string }): Promise<{ branch: string; pullUrl: string }>`. It makes blobs (base64), then a tree with `base_tree` set to the base commit's tree (`sha: null` for deletes), then a commit with parent `base`, then `POST /git/refs` with `refs/heads/<branch>`, then `POST /pulls` with `head: i.branch` and `base: i.into`.
    - `pullUrl` must match `^https://github\.com/`.
- Every request goes to `https://api.github.com`, with `X-GitHub-Api-Version: 2022-11-28`. The token appears only in `Authorization: Bearer …`. Responses are read through a bounded body, as in `client.ts`: copy its `boundedText`, or export it from there without changing its behaviour.

- [ ] **Step 1: Write the failing tests** (a recording fake `fetch`):
  - `listRepos` maps `full_name`, `default_branch` and `private`, and drops every other key;
  - `tarball` gets `302` with `Location: https://codeload.github.com/o/r/legacy.tar.gz/x`, makes a second request without `Authorization`, and returns the body;
  - a `Location` of `https://evil.example/` rejects with `GitHubUnavailableError`;
  - `publish` makes requests in the order blobs → trees → commits → refs → pulls; the ref is `refs/heads/the-terminal/ab12cd34`; no request targets `/git/refs/heads/main` or uses `PATCH`; and the token never appears in any URL;
  - `401` gives `GitHubRejectedError`, and `404` gives `GitHubRepoNotFoundError`;
  - `githubToken()` returns the token of an enabled connection with no `repo`, and `null` when the connection is disabled.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/github test/connections/service.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core tests. All green.
- [ ] **Step 5:** Commit `feat(core): list, download and publish to the person's GitHub repositories`.

### Task 9: Sources projection and SourceService (core)

**Files:**
- Create: `packages/core/src/sources/service.ts`
- Modify:
  - `packages/core/src/db.ts`: a new migration with `project_sources (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, repo TEXT, branch TEXT, remote_commit TEXT, path TEXT, synced_commit TEXT NOT NULL)` and `project_imports (project_id TEXT PRIMARY KEY, files INTEGER NOT NULL)` for "added files";
  - `packages/core/src/events/projections.ts`: the reducers for `project.source_set`, `project.files_imported`, `run.accepted` (sets `accepted_commit`), `project.folder_applied` (moves `synced_commit` to `to`) and `project.published` (no state); `PROJECTION_TABLES`; `getProjectSource(db, id)`;
  - `packages/core/src/ledger/trim.ts`: `FIELDS_BY_TYPE["project.source_set"] = ["path"]`.
- Test: `packages/core/test/sources/service.test.ts`, plus additions to `projections.test.ts` and `ledger/trim.test.ts`

**Interfaces:**
- Consumes Tasks 2, 5, 7 and 8, and `BoardService.createProject`.
- Produces `class SourceService`, with `constructor(deps: { db; ledger; worktrees; board: BoardService; github: GitHubRepos; dataDir: string; redact: (s: string) => string; newId?: () => string; now?: () => Date })`.
  - `createFromGitHub(actor, i: { repo: string; name?: string; includeSecrets?: boolean }): Promise<ImportedProject>`. It runs `head`, then `tarball`, then `readTarGz` into staging (links skipped as `link`). Only after `finish()` does it run `createProject` (the default name is the repository name), `commitFiles` with `Imported from GitHub: owner/repo`, and `commitEvents` of `project.source_set` and `project.files_imported`.
  - `createFromFolder(actor, i: { path: string; name?: string; includeSecrets?: boolean }): Promise<ImportedProject>`: the same, through `listFolder` and `stageFolder`. The default name is the folder's base name, made fit by `RecordedText`.
  - Uploads:
    - `openUpload(actor, projectId, i: { files: number; bytes: number; includeSecrets: boolean }): { uploadId: string }`. The declared totals are checked against `IMPORT_LIMITS` first. More than 4 open uploads gives `UploadBusyError`.
    - `putUploadFile(actor, uploadId, path, body: Readable): Promise<void>`. Another person's upload, or an unknown one, gives `UploadNotFoundError`. A refused path gives `PathRefusedError`, and the body is not read.
    - `commitUpload(actor, uploadId): Promise<ImportResult>`: `Added N files`, then `project.files_imported` with `from: "files"`.
    - `cancelUpload(actor, uploadId): void` and `sweep(now): void`, which removes uploads older than 1 hour.
  - `projectFiles(projectId): Promise<ProjectFiles>`: `ls-tree -z HEAD`, top level only, directories first, at most `MAX_DIR_ENTRIES`. `source.path` is included only for the Owner (the route passes the principal).
  - Any failure after staging disposes the staging folder. A failure after the project was created leaves the project empty and is reported; that is acceptable, since nothing was lost.

- [ ] **Step 1: Write the failing tests.**
  - `createFromFolder` on a temporary folder with `a.txt`, `src/b.ts` and `.env`:
    - without `includeSecrets` it rejects with `PossibleSecretsError([".env"])`, creates no project and leaves no staging directory;
    - with it, it creates a project whose repo `HEAD` tree lists all three, records `project.source_set` with `kind:"folder"` and `path`, and records `project.files_imported` with `files:3`, the right `bytes` and `secretsIncluded:true`.
  - `createFromGitHub` with a fake `GitHubRepos` serving a fixture tarball records `repo`, `branch` and `remoteCommit`, and skips a symlink entry (`skippedCount: 1`).
  - Uploads:
    - open, put two files, commit: one commit `Added 2 files`;
    - a put after commit gives `UploadNotFoundError`;
    - another person's put gives `UploadNotFoundError`;
    - `counts streamed bytes, not content-length`: a put that streams more than `fileBytes` is refused whatever the declared size;
    - `sweeps expired uploads`: after `sweep(now + 61 min)` the staging folder is gone.
  - `trimForRole` of a folder `project.source_set` for a reviewer has no `path`, and the Owner's copy keeps it.
  - After `rebuildAllProjections`, `getProjectSource` is the same.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/sources test/events/projections.test.ts test/ledger/trim.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): projects from files, GitHub or a folder`.

### Task 10: Accept, Apply to my folder, Publish to GitHub (core)

**Files:**
- Create: `packages/core/src/sources/writeback.ts`
- Test: `packages/core/test/sources/writeback.test.ts`

**Interfaces:**
- Consumes Task 7's `snapshotRun` and `materialise`, Task 8's `publish`, and Task 9's `getProjectSource`.
- Produces `class WritebackService`, with `constructor(deps: { db; ledger; worktrees; github: GitHubRepos; dataDir; newId? })`. Errors: `MergeConflictError`, `AlreadyAcceptedError`, `NotAcceptableError` (a running run, or no base), `NothingToWriteError`, `NoSourceError` and `WritebackStaleError`.
  - `accept(actor, runId): Promise<{ commit: string }>`.
    - It refuses a running or settling run (reuse `RunActiveError`), a run with `acceptedCommit` (`AlreadyAcceptedError`) and a run without `base`.
    - It merges per Ruling 11. If `git merge` fails it runs `git merge --abort` and throws `MergeConflictError`.
    - It then commits `run.accepted` with `files` (from `diff --name-only base..snapshot`). If that commit throws, it runs `git reset --hard <previous HEAD>`.
  - `preview(projectId): Promise<WritebackPreview>`: `diff --name-status -z --no-renames <syncedCommit> HEAD`. With an empty list it throws `NothingToWriteError`, and over `IMPORT_LIMITS` it throws `ImportLimitError`.
  - `apply(actor, projectId, head: string): Promise<ApplyResult>`.
    - It needs a folder source; `head` must equal `HEAD` and the preview's `syncedCommit` must be unchanged (`WritebackStaleError`).
    - It needs the folder to be present (`FolderUnavailableError`).
    - It materialises the added and modified paths into `<data>/projects/<id>/apply/<uuid>`.
    - For each path it compares the folder file's in-process git blob id with `ls-tree <syncedCommit>` (Ruling 13), and skips it when they differ. It writes through a temp file and `rename`, refusing any target whose real parent is outside the folder. A delete goes ahead only when the file is unchanged.
    - It commits `project.folder_applied` (`from` = synced, `to` = `HEAD`).
  - `publish(actor, projectId, head: string): Promise<{ branch; pullUrl }>`. It needs a GitHub source and checks `head` the same way. It materialises, reads modes from `ls-tree HEAD`, calls `github.publish` with `base` = `remoteCommit`, `into` = the recorded branch, branch `the-terminal/<8 hex of newId>`, title `Changes from The Terminal` and a body naming the number of accepted runs and files, then commits `project.published`.
  - `gitBlobId(file: string): Promise<string>` (exported for tests): streaming `sha1`.

- [ ] **Step 1: Write the failing tests** (temporary repos, a fake adapter writing files, a fake `GitHubRepos`):
  - Accept:
    - accept merges a run that wrote `a.txt`: `HEAD` contains `a.txt`, `getRun().acceptedCommit` is set, and a second accept gives `AlreadyAcceptedError`;
    - two runs editing the same line: the second accept gives `MergeConflictError`, and `HEAD` and the working tree are unchanged (`git status --porcelain` is empty);
    - accepting a running run gives `RunActiveError`.
  - Apply:
    - `apply` after accept writes `a.txt` to the folder with exact bytes;
    - a folder file edited after the import is skipped and listed in `skipped`, and its content is untouched;
    - a delete of an unchanged file removes it, and a file not in the list is never touched;
    - a stale `head` gives `WritebackStaleError`;
    - a renamed-away folder gives `FolderUnavailableError`, and nothing is written;
    - after an apply, `preview` gives `NothingToWriteError`.
  - Publish:
    - `publish` calls the fake with base = `remoteCommit` and a branch matching `/^the-terminal\/[0-9a-f]{8}$/`, and records `project.published` with the returned `pullUrl`;
    - a project without a source gives `NoSourceError`.
  - `gitBlobId` of a file with `hello\n` equals `ce013625030ba8dba906f756967f9e9ca394464a`.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/sources/writeback.test.ts`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): accept a run's changes and write them back to the folder or GitHub`.

### Task 11: Routes and wiring (core server)

**Files:**
- Create: `packages/core/src/server/sources-routes.ts` and `packages/core/src/server/home-routes.ts` (including `homeRuns(db, o: { projectId?: string; now?: Date; clean }): HomeRuns`)
- Modify:
  - `packages/core/src/server/auth.ts` (`ROUTE_ROLES` entries per the contract);
  - `packages/core/src/server/routes.ts` (`sendError` mappings per the contract's codes);
  - `packages/core/src/server/server.ts` (construct `GitHubRepos`, `SourceService` and `WritebackService`; register the routes; pass `pickFolder`; sweep uploads on start and every 10 minutes);
  - `packages/core/src/server/connection-routes.ts` (`doneToday` in `/api/status`).
- Test: `packages/core/test/server/sources-routes.test.ts`, `packages/core/test/server/home-routes.test.ts`, and additions to `route-roles.test.ts` and `no-secrets.test.ts`

**Interfaces:**
- Consumes Tasks 4, 6, 9 and 10.
- Produces the routes in the API contract.
- `homeRuns`:
  - `working` holds the running runs, newest first. `waiting` is true when the run has a pending action, and `reason` comes from Ruling 3. `now` is the `nowLine` of the run's latest action.
  - `finishedToday` holds the runs finished on the local day, newest first. `summary` is `finalSummary(lastMessage, narrate(agent.finished entry).headline)`.
  - Runs on a linked machine go through `remoteDisplay`.
- Uploads: `PUT /api/uploads/:id/file` registers inside a scoped plugin with the raw-body parser, as `link/protocol/runs.ts` does, and calls `putUploadFile(actor, id, query.path, request.raw)`. On an error it closes the connection after the reply, as there.
- The local-only check is a preHandler helper `localOnly` (403 `local_only` unless `request.listener === "local"`) on `from-folder`, `pick-folder` and `apply`.

- [ ] **Step 1: Write the failing tests** (`app.inject` with principals from `fixtures/principal.ts`):
  - `assertRoutesHaveRoles` passes, and `route-roles` lists every new key with its role;
  - Roles and listeners:
    - a reviewer's `POST /api/projects/:id/uploads` gets 403 `{ error: "forbidden", required: "maintainer" }`;
    - a maintainer's `POST /api/projects/from-folder` gets 403 with required `owner`;
    - the Owner's `from-folder` on the remote listener gets 403 `local_only`.
  - **The local folder path never reaches anyone but the Owner.** After the Owner creates a project from the folder `<tmp>/my-folder`:
    - the reviewer's and the maintainer's `GET /api/ledger/export` bodies don't contain the folder path string;
    - neither do the frames they receive on the events socket while that `project.source_set` event is committed;
    - nor do their `GET /api/projects/:id/source` responses;
    - the Owner's responses do contain it.
  - `pick-folder` without a picker gives 404 `folder_picker_unavailable`. With a stub picker returning `/abs`, it gives `{ path: "/abs" }`.
  - Uploads:
    - open, PUT two files with raw bodies, commit: 200 `ImportResult` with `files: 2`;
    - a PUT with `?path=../x` gives 400 `path_refused` with `reason: "dot_dot"`;
    - a PUT of `fileBytes + 1` gives 413 `limit_exceeded` with `limit: "file_bytes"`;
    - a commit with `.env` and no `includeSecrets` gives 409 `possible_secrets` with `names: [".env"]`.
  - `GET /api/home?projectId=` returns a running run with `percent: 33` after a fake script reports 1 of 3. A run waiting on a decision has `waiting: true` and `reason` equal to the current step.
  - `GET /api/home` with no `projectId` includes runs of two projects.
  - `GET /api/status` includes `doneToday`.
  - `GET /api/projects/:id/files` as a reviewer of a folder project has `source.kind: "folder"` and no `path`; as the Owner it has `path`.
  - `POST /api/runs/:id/accept` twice gives 200, then 409 `already_accepted`.
  - `no-secrets`: a GitHub token `ghp_TESTKEY…` never appears in any response body, log line or ledger entry after an import and a publish against a fake GitHub.
- [ ] **Step 2:** `pnpm --filter @theterminal/core exec vitest run test/server`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/core test`. All green.
- [ ] **Step 5:** Commit `feat(core): routes for Home, project sources, accept and write-back`.

### Task 12: API client and app model (ui)

**Files:**
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/App.tsx` and `apps/ui/src/shell/model.ts`
- Test: additions to `apps/ui/test/api.test.ts` and `apps/ui/test/App.test.tsx`

**Interfaces:**
- Consumes the API contract and Tasks 1–2's types.
- Produces:
  - `api` methods:
    - `getHome(projectId: string | null)`;
    - `projectFiles(id)`;
    - `githubRepos()`;
    - `createFromGitHub(i)`;
    - `createFromFolder(i)`;
    - `pickFolder()`;
    - `openUpload(id, i)`;
    - `putUploadFile(uploadId, path, file: Blob)`: `fetch` with `method: "PUT"`, `content-type: application/octet-stream` and `body: file`;
    - `commitUpload(uploadId)`;
    - `cancelUpload(uploadId)`;
    - `acceptRun(id)`;
    - `writebackPreview(id)`;
    - `applyToFolder(id, head)`;
    - `publishToGitHub(id, head)`.
  - `Status.doneToday?: number`.
  - `errorMessage` sentences:
    - `limit_exceeded`: "That is more than The Terminal takes at once: up to 2,000 files, 200 MB in total and 50 MB per file.";
    - `possible_secrets`: "These files may contain secrets: <names>. Tick “include files that may contain secrets” to add them anyway.";
    - `merge_conflict`: "These changes clash with newer work. Ask an agent to redo them on top of the latest files.";
    - `preview_stale`: "The files changed since you looked. Review the list again.";
    - `folder_unavailable`: "The original folder can't be found.";
    - `local_only`: "This works only on the computer The Terminal runs on.".
  - `WorkbenchModel` gains:
    - `home: { data: HomeRuns | null; error: string | null; scope: "project" | "all"; setScope(s): void; refresh(): void }`;
    - `projectFiles: { data: ProjectFiles | null; error: string | null; refresh(): void }`;
    - `onAcceptRun(runId): Promise<boolean>`;
    - `onProjectCreated(p: Project): void`, which selects it.
  - `App` reloads `home` on any `agent.*`, `run.*` or `link.mirrored` entry, debounced 500 ms, and `projectFiles` on any `project.*` or `run.accepted` entry of the selected project.

- [ ] **Step 1: Write the failing tests.**
  - `putUploadFile` sends `PUT /api/uploads/u1/file?path=src%2Fa.ts` with the blob as the body.
  - `errorMessage(new ApiError(409, "possible_secrets", { names: [".env", "k.pem"] }))` names both.
  - In `App`, an `agent.progress` entry over the socket triggers one `getHome` call within 600 ms. Changing the scope to `"all"` calls `getHome(null)`.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/api.test.ts test/App.test.tsx`. It fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): API and model for Home and project sources`.

### Task 13: Home first, the Board optional, Settings → Workspace (ui shell)

**Files:**
- Create: `apps/ui/src/views/WorkspaceSettings.tsx` and `apps/ui/src/views/HomeView.tsx` (a stub rendering `<div className="home-view" />`, filled by Task 15)
- Modify:
  - `apps/ui/src/shell/views.ts` (`home` first: "Home");
  - `ActivityBar.tsx` (a house icon; `board` hidden unless `showBoard`);
  - `dock-layout.ts` (the presets per Ruling 18; the `home` panel titled "Home");
  - `Workbench.tsx` (`PANELS.home`; the default view `"home"`; `showView("home")` focuses the `home` tab);
  - `SideBar.tsx` (`home: ProjectsSideBar`);
  - `SettingsSideBar.tsx` (Appearance, then Workspace).
- E2E: `e2e/support.ts` (a fixture option that sets `tt.workspace.v1` to `{"showBoard":true}` through `addInitScript` for specs that use the Board, and helpers that open the Board tab first), `e2e/shell.spec.ts`, and any spec whose first step assumed the Board tab.
- Test: `apps/ui/test/ActivityBar.test.tsx`, `dock-layout.test.ts`, `Workbench.test.tsx` and `WorkspaceSettings.test.tsx`

**Interfaces:** Consumes Task 3's `useWorkspace`.

- [ ] **Step 1: Write the failing tests.**
  - The activity bar's buttons start with "Home". "Board" is absent by default and present after `setShowBoard(true)`.
  - The `buildPreset("guided")` tabs are `["Home", "Conversation"]`. Operator's main tabs are `["Home", "Capacity"]`, with the bottom unchanged.
  - The Workbench opens with Home pressed.
  - A saved layout containing `board` still restores.
  - The Workspace switch "Show the Board" is a `role="switch"` and persists after a reload of the store.
  - `e2e/shell.spec.ts`: the activity bar lists `["Home", "Agents", …]` (the twelve, with Board hidden), and the default tabs are `["Home", "Conversation"]`. With the Board shown, the Board button opens the Board tab with five columns.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui exec vitest run` on those files. They fail.
- [ ] **Step 3:** Implement. Update the e2e specs only where they relied on the Board being the home tab.
- [ ] **Step 4:** `pnpm test` and `pnpm e2e`. All green.
- [ ] **Step 5:** Commit `feat(ui): Home is the first view; the Board is optional`.

### Task 14: Progress bars in Agents and on the run's page (ui)

**Files:**
- Create: `apps/ui/src/components/ProgressBar.tsx` and `apps/ui/src/components/progress.css`
- Modify:
  - `apps/ui/src/components/AgentPanel.tsx` (each run row);
  - `apps/ui/src/views/AgentFeedPanel.tsx` (a header showing the followed run's bar and checklist);
  - `apps/ui/test/styles-tokens.test.ts` (it scans every `src/**/*.css`; the `:root` rule applies only to `styles.css`).
- Test: `apps/ui/test/ProgressBar.test.tsx`, plus additions to `AgentPanel.test.tsx` and `AgentFeedPanel.test.tsx`

**Interfaces (produces):**
- `ProgressBar({ percent, label }: { percent: number | null; label: string })`.
  - With a number: a `role="progressbar"` with `aria-valuenow`, `aria-valuemin={0}`, `aria-valuemax={100}`, the visible text `"33%"`, and the caption "as the agent reports it".
  - With `null`: the text "Working…", no `role="progressbar"` value and no number.
- `StepChecklist({ progress }: { progress: RunProgress })`: an `<ol>` with each step marked done (`✓`, `aria-label="done"`), current (`aria-current="step"`) or to do.

- [ ] **Step 1: Write the failing tests.**
  - `percent 33` renders `aria-valuenow="33"` and `33%`.
  - `percent null` renders "Working…" and no element with `aria-valuenow`.
  - An AgentPanel row for a running run with progress shows its bar. A finished run shows no bar.
  - The AgentFeedPanel following a run with a plan shows the checklist, with step 2 `aria-current`.
  - `styles-tokens` fails on a `#fff` literal placed in a temporary CSS fixture string passed to its checker function (refactor the check into `checkCss(text)`).
- [ ] **Step 2:** Run them. They fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): progress bars for running jobs`.

### Task 15: Home view, its blocks and the editor (ui)

**Files:**
- Create:
  - `apps/ui/src/home/TotalsStrip.tsx`;
  - `AskBox.tsx`;
  - `ApprovalsBlock.tsx`;
  - `WorkingBlock.tsx`;
  - `OverallBlock.tsx`;
  - `FinishedBlock.tsx`;
  - `FilesBlock.tsx` (the listing only; Task 16 adds the drop zone and write-back);
  - `HomeEditor.tsx`;
  - `RunTimelinePanel.tsx` (a dock component `timeline`, id `timeline:<runId>`);
  - `home.css`.
- Modify: `apps/ui/src/views/HomeView.tsx`, and `apps/ui/src/shell/Workbench.tsx` (`PANELS.timeline` only)
- Test: `apps/ui/test/HomeView.test.tsx`, `apps/ui/test/HomeEditor.test.tsx` and `apps/ui/test/ApprovalsBlock.test.tsx`

**Interfaces:** Consumes Tasks 1, 3, 12 and 14.

**Behaviour:**
- **Totals strip:** "working" (`status.runningAgents`), "need you" (the Workbench's `waiting`), "done today" (`status.doneToday`) and "today" (`formatUsd(todayCostUsd)`), with Ruling 5's clicks.
- **Ask box:**
  - `<textarea placeholder="Tell an agent what you want…">` with the blinking `.cursor` while empty and focused;
  - an agent `<select>` of the available adapters (`adapterLabel`);
  - **Add files**, which opens a file input; Task 16 wires it;
  - **Go**, which calls `model.onStartRun(adapter, prompt, [], null)` and keeps the prompt when that resolves false.
  - It is not rendered below maintainer.
- **Approvals** (Ruling 4):
  - each pending action is one sentence: `${adapterLabel} wants to ${actionPhrase(a)}`, with the project name when it is another project;
  - then the reason line when `HomeRun.reason` is set;
  - then the buttons **Approve** (`onDecide(id, "allow")`), **Deny** (it asks for a reason inline, as `DecisionCard` does) and **Ask why** (`dock.focus("needs_you")`). Below reviewer, the sentence shows without buttons;
  - intake and gate rows have **Review**.
  - With nothing pending: "Nothing needs you right now."
  - It always renders, wherever it is in the order.
- **Working now:** a grid (`--home-columns: 1 | 2`) of cards: the title, `ProgressBar`, "Now: …" or the `StepChecklist`, then the agent, elapsed time (`m min`) and `formatUsd(cost)` or "cost so far unknown".
  - A waiting card has the class `waiting` and the line "Waiting for you: <reason or the decision sentence>".
  - Clicking a card opens `timeline:<runId>`: `narrate()` of the run's entries from `projectEntries` (or "Open the Agents view for older steps" when older entries were not loaded), with buttons Changes (`showView("changes")` after `onSelectRun`), Agent feed and Terminal.
- **Overall progress:** `ProgressBar` of `overallProgress` (Ruling 6), plus "N working without a plan" when there are any.
- **Finished today:** one line per run: the title, then `—` and the summary, then the outcome ("done", "failed" or "stopped"). Diffs, output and commands never appear on Home.
- **Project files:** the source line ("from GitHub: owner/repo", "from a folder", "added files", or "No files yet") and the top-level entries (folders first), or the reviewer note from Ruling 21.
- **Edit Home:** the button toggles the editor in place.
  - Each block gets a checkbox; the checkbox for "Needs your approval" is disabled with the title "Always shown". Each block also gets **Move up** and **Move down** buttons, and a drag handle using HTML5 drag-and-drop that reorders through `moveBlock`.
  - "Working now columns" has the choices 1 and 2.
  - **Done** saves (`saveHome`). **Reset** applies `resetHome()`.

- [ ] **Step 1: Write the failing tests.**
  - With `home.data` holding one running run at 33 % and one finished, Home shows a card with `aria-valuenow="33"` and a Finished today line "<title> — <summary> — done", and no `<pre>` or `.diff` element.
  - A run without a plan shows "Working…".
  - Clicking **Approve** calls `onDecide("a1","allow")` once. A second click while the first is in flight sends nothing.
  - A viewer sees the sentence and no Approve button.
  - **Ask why** focuses the `needs_you` panel.
  - The reason line is absent when `reason` is null.
  - Clicking "working" in the strip calls `home.setScope("all")`.
  - In the editor: unchecking "Project files" and clicking Done hides it, and `tt.home.v1` holds `hidden: ["files"]`. The approvals checkbox is disabled. Move down on "Ask box" makes Approvals first. Reset restores the default order.
  - A corrupt `tt.home.v1` renders the default Home.
  - A maintainer sees the ask box; a reviewer does not.
- [ ] **Step 2:** `pnpm --filter @theterminal/ui exec vitest run test/HomeView.test.tsx test/HomeEditor.test.tsx test/ApprovalsBlock.test.tsx`. It fails.
- [ ] **Step 3:** Implement. The layout follows the approved sketch: approvals first among the content blocks, cards in a grid, the finished list, then files.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): Home with approvals, working cards, finished today and files, customisable per device`.

### Task 16: Adding files, new projects from a source, Accept and write-back (ui)

**Files:**
- Create: `apps/ui/src/upload.ts`, `apps/ui/src/components/NewProjectDialog.tsx` and `apps/ui/src/components/WritebackDialog.tsx`
- Modify:
  - `apps/ui/src/components/ProjectList.tsx` (a "New project…" button opening the dialog; the name-only form stays as "Start empty");
  - `apps/ui/src/home/FilesBlock.tsx` (the drop zone, Apply and Publish);
  - `apps/ui/src/home/AskBox.tsx` (Add files);
  - `apps/ui/src/home/FinishedBlock.tsx` and `apps/ui/src/views/ChangesSideBar.tsx` (**Accept these changes**).
- Test: `apps/ui/test/upload.test.ts`, `NewProjectDialog.test.tsx`, `WritebackDialog.test.tsx`, and additions to `ChangesSideBar.test.tsx` and `HomeView.test.tsx`

**Interfaces:**
- Consumes Task 12's API.
- Produces:
  - `type PickedFile = { path: string; file: File }`.
  - `collectDropped(items: DataTransferItemList): Promise<PickedFile[]>`: `webkitGetAsEntry` traversal, keeping relative paths.
  - `filesFromInput(list: FileList): PickedFile[]`: `webkitRelativePath || name`.
  - `precheck(files: PickedFile[], includeSecrets: boolean): { ok: true } | { ok: false; message: string }`: the limits, `checkImportPath` and `secretLikePath`, all before anything is sent.
  - `uploadFiles(projectId, files, includeSecrets, onProgress: (sent: number, total: number) => void, signal): Promise<ImportResult>`: open, then one PUT at a time, then commit. On failure or abort it cancels the upload.

**Behaviour:**
- **New project dialog:** four choices.
  - **Start empty:** a name.
  - **Add files or a folder:** a name, then pick or drop, then upload into the new project.
  - **From GitHub:** a name and a repository `<select>` from `githubRepos()`. Without a GitHub connection it says "Connect GitHub in Connections first."
  - **A folder on this computer:** the Owner only, shown only when the listener is local (`location.hostname` is the app host or loopback). **Choose folder…** calls `pickFolder()`; on `folder_picker_unavailable` a typed path field shows instead.
  - Each choice that imports has the checkbox "include files that may contain secrets".
  - The result shows the counts and the skipped names.
- **Drop zone:** on Project files, for maintainers and above. It shows the upload's progress ("Sending 12 of 40 files") and the result.
- **Accept these changes:** on a finished, not yet accepted run, for maintainers and above. It shows "Accepted" afterwards. A `merge_conflict` shows its sentence.
- **Write-back** (the Owner only):
  - **Apply to my folder** is shown for a folder source on the local listener, and **Publish to GitHub** for a GitHub source.
  - Each opens `WritebackDialog`. The dialog loads the preview, lists the files as added, changed or deleted, and asks "Write these N files to your folder?" / "Open a pull request with these N files?".
  - **Confirm** sends `head`.
  - Apply's result lists the skipped files ("Skipped because they changed in your folder: …"). Publish's result links to the pull request (`rel="noreferrer"`).

- [ ] **Step 1: Write the failing tests.**
  - `precheck` with a `.env` and `includeSecrets:false` names `.env`. With 2001 files it gives the limit sentence. A path `../x` is refused.
  - `uploadFiles` with a mocked API calls open, then PUT ×2 in order, then commit. When the second PUT fails, it calls `cancelUpload`.
  - The dialog's GitHub choice lists the repos and creates a project, selecting it.
  - A non-owner sees no folder choice.
  - On `folder_picker_unavailable`, a "Folder path" input appears.
  - `WritebackDialog` lists 3 files, Confirm sends the preview's `head`, and a `preview_stale` error shows its sentence and reloads the preview.
  - ChangesSideBar shows **Accept these changes** for a finished run as a maintainer, and not as a reviewer.
- [ ] **Step 2:** Run them. They fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @theterminal/ui test`. All green.
- [ ] **Step 5:** Commit `feat(ui): add files, start projects from GitHub or a folder, accept and write back`.

### Task 17: End-to-end: Home, progress and sources

**Files:**
- Create: `e2e/home.spec.ts`, `e2e/sources.spec.ts` and `e2e/fixtures/project-folder/` (`readme.md`, `src/app.txt`, `.env` holding `TESTKEY`, `.gitignore` with `dist/`, `dist/out.txt`)
- Modify: `e2e/global-setup.ts` (a fake script with the steps `[[plan: Read | Change | Check]]`, `[[step 1/3 done]]`, a `file_write` proposal writing `src/app.txt`, then `[[step 2/3 done]]`)

- [ ] **Step 1: Write the failing e2e tests.**
  - **Home:**
    - a fresh start shows Home pressed;
    - start a run from the ask box: a card appears, and after the plan it shows `33%`;
    - the write proposal appears under "Needs your approval" as one sentence with the reason "Change";
    - **Approve** settles it, and the strip's need-you count goes to 0;
    - the card reaches `67%` and then lands in Finished today with "done".
  - **Edit Home:** hide Project files, Done, reload: it is still hidden; Reset brings it back.
  - **Sources:**
    - New project → A folder on this computer (typed path, since the e2e server is headless): it is refused naming `.env`; tick the box and it imports `readme.md`, `src/app.txt` and `.env` but not `dist/out.txt`;
    - Project files says "from a folder";
    - run the fake agent and approve its write, then **Accept these changes**, then **Apply to my folder** on a temporary copy of the fixture: the folder's `src/app.txt` has the agent's content;
    - drop two files onto Project files: the list shows them, and the ledger shows "added 2 files".
- [ ] **Step 2:** `pnpm e2e -- e2e/home.spec.ts e2e/sources.spec.ts`. It fails until Tasks 11–16 are in.
- [ ] **Step 3:** Fix only what the e2e tests reveal, in the task that owns the code.
- [ ] **Step 4:** `pnpm test` and `pnpm e2e`. All green on macOS and Windows CI.
- [ ] **Step 5:** Commit `test(e2e): Home, step progress, folder import, accept and apply`.

## Order and parallelism

Each wave's tasks touch disjoint files and can run in parallel worktrees. A wave starts when the waves before it are merged.

- **Wave 1:** Task 1 (shared progress), Task 3 (UI stores), Task 4 (folder picker) and Task 5 (tar reader).
- **Wave 2:** Task 2 (shared sources; after Task 1 for `narration.ts` and `index.ts`), Task 6 (runner and progress projection) and Task 8 (GitHub client).
- **Wave 3:** Task 7 (staging and repo commits) and Task 12 (UI API and model; it codes against the API contract).
- **Wave 4:** Task 9 (sources projection and service), Task 13 (shell, Board optional) and Task 14 (progress bars).
- **Wave 5:** Task 10 (accept and write-back) and Task 15 (Home view).
- **Wave 6:** Task 11 (routes and wiring) and Task 16 (sources UI).
- **Wave 7:** Task 17 (end-to-end).

Files shared across waves, never within one:
- `db.ts` and `projections.ts`: Tasks 6, then 9;
- `narration.ts`: Tasks 1, then 2;
- `server.ts`: Tasks 4, then 11;
- `Workbench.tsx`: Tasks 13, then 15;
- `FilesBlock.tsx` and `AskBox.tsx`: Tasks 15, then 16.
