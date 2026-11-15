# Home screen and project sources: design

## Intent

The owner doesn't want to watch agents work. They want oversight: what their agents are doing, how far along each job is, what needs their approval, and what got done, in plain language. They also need a way to give a project their own information. Today a project starts as an empty folder, and nothing on screen can add files to it.

The owner reviewed a sketch of this design and said it is "much better than the current one".

## Goals

- **A Home view is the first thing you see.** It shows:
  - one box to tell an agent what you want;
  - approvals;
  - a progress card per running job, with a percentage;
  - a plain-language list of what finished today;
  - the project's files.
- **The Board is optional.** It is hidden from the activity bar by default, and a switch in Settings brings it back.
- **A project can start from three sources:**
  - files or a folder you add;
  - one of your GitHub repositories;
  - a folder on this computer.

  It can also start empty. You can add more files to any project later.
- **Accepted work can go back to its source:**
  - to a local-folder project's original folder, by an explicit "Apply to my folder";
  - to GitHub as a pull request, by "Publish to GitHub".
- **Progress everywhere:** every running job shows a progress bar and a percentage on Home, in the Agents side bar and on its detail page. There is also one overall bar for all the work.
- **A customisable Home:** each person decides what Home shows and in what order, using an editor in the app.

## Non-goals

- No removal of existing views or features. Agents, Changes, Ledger and the rest stay where they are. Home sits on top of them.
- No editing of files by people. Changes remain read-only, as the main spec says.
- No live two-way sync with a local folder. Files are copied in when the project is created or when you add them, and copied back only when you apply.
- No new AI providers.

## Anti-goals (a failure even if it works)

- **No fake progress.** A percentage is shown only when it comes from the job's own steps. Without steps the card says "Working…" with no number, and never a made-up or time-based estimate.
- **No code or logs on Home.** Raw output, diffs and terminal text appear only one click deeper.
- **The approval gate is never weakened.** Approving from Home is the same decision as everywhere else: same rules, same ledger record, same roles.
- **Importing never touches the user's original files.** The only writes to a local folder happen through "Apply to my folder", after the user confirms.
- **Imported files never leak secrets.** Files are not sent anywhere they weren't before, and agents only see them inside the project's working copy.

## Home view

- **Placement:** a new `home` view, first in the activity bar, and the default tab in both layout presets (Guided and Operator). It replaces the Board as the home tab.
- **Scope:** Home shows the selected project. A top strip shows totals across every project: working, need you, done today and today's cost. Clicking a total filters to it.
- **Ask box:** "Tell an agent what you want…" with the blinking cursor, an **Add files** button, an agent picker and **Go**.
  - It starts a run exactly as the Agents view does today, with the same API and the same rules.
  - Collaborators below maintainer don't see it, as today.
- **Needs your approval:**
  - Each pending decision is one plain sentence, built from the existing narration.
  - Under it is the agent's own one-line reason, if it gave one.
  - The buttons are **Approve**, **Deny** and **Ask why**. **Ask why** opens the full decision card, the same card as today.
  - Gates and plan decisions appear here too.
- **Working now:** one card per running or paused run, with:
  - a title (the job's name, see below);
  - a percentage and a progress bar;
  - a "Now:" line, or the checklist of steps;
  - the agent, elapsed time and cost.

  A run waiting on you turns amber and says why. Clicking a card opens a summary timeline: the run's narrated steps in plain language. The timeline links to Changes, the agent feed and the Terminal for anyone who wants the raw work.
- **Finished today:** one line per run that ended today: its title, its final summary and its outcome (done, failed or stopped).
- **Project files:** the top-level entries of the project's current files, from the project repo's latest commit; there is no editing. It names where they came from ("from GitHub: owner/repo", "from a folder", "added files"). A drop zone adds more.

### Customising Home

The owner confirmed that Home should be customisable.

- **Blocks:** Home is made of blocks:
  - Ask box;
  - Needs your approval;
  - Working now;
  - Overall progress;
  - Finished today;
  - Project files;
  - Previews (added by the preview work later, hidden until it exists).
- **Edit Home:** a button switches Home into an editor where you:
  - turn blocks on or off;
  - drag them into any order, or use the keyboard: move up and move down buttons on each block;
  - choose one or two columns for Working now.

  **Done** saves it, and **Reset** returns to the default order.
- **Where it is saved:** per device in localStorage (`tt.home.v1`), like themes and the layout, and validated on load. A broken or old value gives the default.
- **Needs your approval always shows.** It can be moved but not turned off, because the approval gate must stay visible. If it is moved below the fold, the top strip's "need you" count still links to it.

## Progress and summaries

- **Steps:** at the start of a run, The Terminal's instructions to the agent ask it to state a plan of 3 to 7 short steps, and to report each step as it starts and finishes, using one plain line format:
  - `[[plan: step one | step two | …]]` once;
  - then `[[step 2/5 done]]` (or `started`) as it goes.
- **Reading the lines:** the runner reads these lines out of the agent's own messages, for all three adapters.
  - No MCP tool and no new approval exception, so the gate is unchanged.
  - Lines that don't match exactly are ignored.
  - The step texts pass the usual redaction and visible-control handling, are clipped to 80 characters, and are limited to 7 steps.
  - Each change is recorded as an `agent.progress` ledger event through `commitEvent`.
- **The percentage:** completed steps divided by total steps, recomputed from the ledger. On Home it is labelled as the agent's own report.
- **Linked machines:** `agent.progress` is added to the mirrored event types, through the existing signed-frame validation, so runs on a linked machine show progress too.
- **Without steps:** if the agent never reports a plan, the card shows "Working…" with no number, under the "no fake progress" anti-goal.
- **States:** cards show running runs. A running run with a pending decision is shown amber, as "Waiting for you". There is no new run state.
- **Approvals:** the "Needs your approval" list holds pending action decisions, intake decisions and gates. The one-line reason under an approval is shown only when the agent stated one in its progress plan. Otherwise the line is left out; it is never replaced with the gate's own reason text.
- **Summaries:**
  - **Job title:** the first step of the plan if there is one, otherwise the first line of the prompt, clipped to 60 characters.
  - **"Now:" line:** the latest narrated action.
  - **Final summary:** the agent's final message, clipped to 200 characters, falling back to the narration of `agent.finished`.

  None of these is generated by an extra model call.

## Accepting a run's work

Today each run's work stays on its own `run/<id>` branch, and nothing brings it back. This design adds one explicit step:

- **Accept these changes:** shown on a finished run's card and in Changes, for maintainers and above.
  - It merges the run's branch into the project repo as a merge commit, recorded as a `run.accepted` ledger event.
  - If the merge conflicts, it is refused with a plain message, and nothing changes. The person can ask an agent to redo the work on top of the latest files.
- **Effect on Home:** project files on Home, and new runs, start from the project repo's latest commit, so accepted work shows up there.
- **Write-back:** "Apply to my folder" and "Publish to GitHub" work only on accepted work.

## Project sources

All three sources produce the same thing: the project's own git repository (`<data>/projects/<id>/repo`), with the imported files as its first commit. Agents keep working on per-run worktrees from it, exactly as today. Each import is a ledger event with counts and sizes, never file contents.

- **Add files:** you pick files or a folder, or drag them onto Home.
  - **Sending:** the UI streams them to the server, keeping their relative paths.
  - **Committing:** the server writes them into the project repo and commits them as "Added N files", recording the person.
  - **Limits:** 2,000 files, 200 MB in total and 50 MB per file.
  - **Paths that are refused:** absolute paths, `..`, symlinks, names the platform can't store, and anything under `.git`.
  - **Possible secrets:** names that look like secrets (`.env`, `*.pem`, `id_rsa` and the patterns the Changes view already hides) are refused with a plain message naming them, unless the person ticks "include files that may contain secrets" for that upload.
- **From GitHub:** you pick one of your repositories. The list comes from the GitHub API with the GitHub connection's token: the repositories that token can see.
  - **Download:** the server downloads the default branch as an archive over HTTPS, from its own HTTP client with the token in the `Authorization` header. git is never handed the token, and the git environment allowlist is unchanged.
  - **Unpacking:** the archive is unpacked with the same limits and refusals as Add files, then committed.
  - **Recorded:** the project records `owner/repo` and the default branch (a `project.source_set` ledger event).
  - **The GitHub view:** it still shows the connection's own repository. Following the selected project is left for later.
- **A folder on this computer:** owner only, and only on the machine The Terminal runs on.
  - **Choosing it:** the desktop app opens the system folder picker. The headless server takes a path typed by the owner.
  - **Copying in:** the folder is copied in with the same limits and refusals as Add files. `.git` inside it is skipped, so the project gets a fresh history, and its `.gitignore` is respected.
  - **Remembered path:** the original path is stored in the project's settings, where only the owner sees it, following the existing rules for private paths.
- **Apply to my folder:** for a local-folder project, after you approve a run's changes, the owner can choose **Apply to my folder**.
  - **Confirming:** it shows the list of files that will be added, changed or deleted, and asks once more.
  - **Writing:** it writes only those files. If a file in the original has changed since it was copied in, that file is skipped and the skip is reported. It never deletes anything outside the list.
  - **Record:** it is a ledger event.
- **Publish to GitHub:** for a GitHub project, the owner can publish accepted work as a pull request.
  - **How:** the server creates a new branch `the-terminal/<short id>` through the GitHub API, adds the commits with the API's git data endpoints, and opens a pull request against the default branch. It never pushes to the default branch.
  - **Confirming:** it shows the file list, asks once more, and records a ledger event with the pull request's address.
- **Start empty:** stays available, as today.
- **Collaborators:** maintainers and above can add files and create projects from GitHub. Only the owner can use a local folder or Apply to my folder.

## The Board

- It is hidden from the activity bar by default and is no longer the home tab.
- Settings gets a **Workspace** section next to Appearance, with a **Show the Board** switch. The setting is stored per device, like the layout.
- Cards, stages and gates keep working underneath; runs can still be linked to cards. Nothing about the Board's data changes.

## Constraints

- AGENTS.md and the main spec apply: state changes go through `commitEvent`, nothing uses a shell string, the child environment comes from `buildChildEnv`, it works on macOS and Windows, tests come first, there are no new runtime dependencies without approval, and no safeguard is weakened.
- Uploads are streamed. Nothing holds 200 MB in memory.
- **Existing behaviour stays the same:** the Agents view, decision cards, gates, roles and every existing route work as they do now. Existing e2e tests are updated only where the home tab changed from Board to Home.

## Left to the builder

- The exact layout and spacing of Home, within the sketch the owner approved: approvals first, cards in a grid, finished list, files with a drop zone.
- Which upload transport to use (multipart or a series of requests) and the API shape, provided it streams and enforces the limits on the server.
- The wording of the step-plan instruction for each agent.
- Splitting this into plan tasks.

## Calls made without the owner (check these)

- The percentage comes only from steps the agent reports; no estimate is shown otherwise.
- The upload limits are 2,000 files, 200 MB in total and 50 MB per file.
- Files that look like secrets are refused unless ticked per upload.
- A local folder is copied in, not linked, and written back only by an explicit Apply.
- GitHub imports take the default branch's latest files, without their history.
- The Board is hidden by default, with a switch in Settings → Workspace.
- Home shows one project at a time, with totals across all projects at the top.
- Home's layout is per device; Needs your approval can't be hidden.
