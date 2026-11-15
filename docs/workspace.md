# The workspace

This page describes the workspace you see when you open The Terminal: where things are, how to review what an agent changed without ever editing code yourself, and the one emergency tool that steps outside the safety rules. It describes what ships today.

## The shell

The window is laid out like a code editor.

- **Activity bar** (far left). One button per view: Board, Agents, Changes, Needs you, Ledger, Connections, GitHub, Capacity and Learn.
- **Side bar.** The list for the selected view. Click the same button again to hide it.
- **Tabs** (centre). The board is the home tab. Things you open (a story, a diff, a file, an agent feed, the Terminal, the Conversation) open as tabs next to it.
- **Bottom panel.** Where the ledger, the agent feed and the Terminal sit.
- **Status bar.** Running agents, today's cost, pending decisions and connection health.

### Layouts

There are two presets. **Guided** is the default: the board with the Conversation next to it. **Operator** puts the board and Capacity on top, with the Terminal, the agent feed and the ledger in a panel below. You can switch between them at any time.

If you move things around, the layout is shown as **Custom**. You can save a layout under a name and bring it back later. You can keep up to 10 saved layouts.

Decisions and gates appear in every layout. A layout only changes where panels sit, never what you are asked to approve.

When a tab points to something that no longer exists, it is closed automatically the next time the workspace loads. That cleanup does not rename your layout.

## The Changes view

Open **Changes** in the activity bar to see what an agent changed in a run.

**It is read-only.** People never edit code here. There is no editor: people never edit a run's files directly. The only way a person can change them is the emergency override, which is recorded in red. Otherwise, review, then ask an agent to change things.

### What you see

- The changes are compared with the commit the run started from, recorded when its working copy was created. The Terminal does not work it out later from branches, because an agent can move a branch (or replace a commit) in the repository it shares, and the view would then hide or invent changes. Both files the agent changed that git already tracks and new files it created are listed, as added, modified or deleted.
- Click a file to open its diff. Click a name in the file tree to open the file itself.
- Binary files are listed but their contents are not shown.
- Names that look like a secret (or a private path) are hidden and marked as such.

### Runs from before this version

A run recorded before The Terminal kept the commit it started from has no Changes list or diffs. You see "What this run changed cannot be shown…" instead of a guess. The same happens if that commit is no longer in the repository. Its files can still be browsed under **Files**, and the emergency override still works for it.

### While a run is in progress

You see "Changes show when the run is stopped or finished." Reading a working copy while an agent is changing it could be misleading, and it is not safe to do while the agent can still alter git's settings, so The Terminal refuses to read it until the run has stopped or finished. This applies to the changed-files list, the file tree, diff tabs and file tabs: none of them asks for anything while the run is live, and they load on their own once it ends. When you stop a run, the agent's program can take a few seconds more to end; the views wait for it (up to 10 seconds) and then load. The agent feed and the Terminal tab still show what the agent is doing.

### Limits

Large changes are cut off rather than slowing the app down.

| What | Limit |
| --- | --- |
| Changed files listed | 500. Beyond that the view says "Too many changes" instead of listing them. |
| A diff is shown only when it is | 5,000 changed lines or fewer, and 1 MiB or less |
| A file you open | 1 MiB or less |
| Lines painted in a diff or file | 20,000 |
| Entries in one folder of the file tree | 2,000 |

When something is over a limit, the view says so and tells you what was left out.

Two things the view does not catch yet, and accepts for now: a change that only alters line endings or a file's executable bit is not listed if the agent set `core.autocrlf=true` or `core.fileMode=false` in the shared repository's settings; and the commit a run starts from is read from its working copy just after it is created, so an agent of another live run in the same project could, in that moment, move the new run's branch.

### Viewing never runs the repository's code

A repository can contain settings that make git run programs. Looking at changes does not allow that. Git hooks, filters, attributes and included git settings are all switched off while The Terminal reads a run's files. A repository whose git settings include other files is refused, with a message, rather than read. Git never goes into submodules (a nested repository's own settings are never checked, so it is never entered), and replacement objects (`git replace`) are ignored. The view also never reads the run's own git index, which the agent controls: marks in it (`skip-worktree`, `assume-unchanged`, a sparse checkout) would make git call a changed file unchanged. The changes are read through a fresh index built from the run's last commit and thrown away afterwards; a file the agent staged but did not commit is therefore listed as new, like any other file not in a commit.

The Terminal also gives git an empty configuration file and an empty hooks folder of its own. If something has written to either, git is not run at all and you see a message: "The Terminal's shared git configuration was modified…" (restart The Terminal to repair it) or "The Terminal's empty hooks folder was modified…" (empty it and try again).

## Terminal tab

The Terminal tab shows the commands agents ran and what came of them: the command, whether it was allowed or denied, and its recorded output. It is built from the ledger, so it is a record, not a live shell. There is no way to type into it. Colour and cursor codes are removed and hidden characters are shown visibly. It paints the newest 500 lines and follows the end unless you scroll up.

## Agent feed

The agent feed shows what one agent is doing, from the ledger, newest at the bottom. It keeps the latest 500 entries on screen and follows the end unless you scroll up. Use the follow control to pause or resume that.

## Conversation tab

The Conversation tab lists what you asked agents and how they answered, with a count of the actions each run took and whether they were allowed or denied. Each run shows its cost with its basis, for example `$0.10 (estimate)` or `(reported)`. A run that reported no cost says "cost not reported", never `$0.00`.

Only recent entries are loaded. When older ones are not, the tab says so, because earlier asks may be missing answers or action counts. **Load older** fetches more.

Spend totals always say how they were worked out. "Estimate" means The Terminal calculated it from token counts. "Reported" means the provider gave the figure. If any run reported nothing, the total says "actual spend may be higher".

## Needs you

The Needs you list shows decisions waiting for you, each as a card showing the project and what is being asked, along with any notices from plan intake. Approving or denying is recorded in the ledger as before.

The Needs you tab gives each decision of the open project more context: the change the agent proposes (the old and new text it sent, as `-` and `+` lines) and the last two things it said before asking. It does not show what the run has changed so far. A run waiting on a decision is still live, and The Terminal does not read a live run's working copy (see "While a run is in progress" above), so the card says "Changes show when the run is stopped or finished." Once the run has stopped or finished, its changes are in the Changes view.

## Learn

The Learn view is a set of short plain-language topics about how the workspace works. A search box filters them. Topics relevant to what you are looking at come first, under "For what you are looking at", and the rest are under "Everything else". Topics you have opened are marked as read. That mark is kept in your browser only.

## The ledger and paging

The ledger panel and the other views load the newest entries first. When older entries exist, a **Load older** button fetches the next page. Until you do, anything that depends on older entries (such as a run's start) may be incomplete, and the view says so.

## Emergency override

The override is for when an agent has left a working copy in a state you need to fix yourself and you cannot wait for it. Read this section before using it.

### What it is

An override runs **one program as you**. It is **outside the approval gate and outside the sandbox**, and the program can change files. It is not a safer way to do things. It is a way to do them yourself.

### How it runs

- The program is started directly, **not through a shell**, so shell syntax such as pipes and `&&` does not work. You give a program and its arguments.
- It gets the same cut-down environment agents get, with **no connection keys** (no API keys, tokens or cloud credentials).
- It runs in the run's working folder, or a folder inside it.
- It is **killed after 10 minutes**. Its output is redacted for secrets, cleaned of hidden characters and cut to a limit before it is recorded.

### Before it starts

1. You enter the program, its arguments and the folder.
2. You write a **reason of 10 to 500 characters**. The reason is checked for secrets and refused if it contains one.
3. A confirm step shows the exact command and folder. Nothing runs until you confirm.

### When it is refused

An override is refused while the run is in progress or still finishing. Stop the run and wait for it to settle first.

### What is recorded

Every override is recorded in the ledger in two phases, when it starts and when it ends, with the command, folder, reason and redacted output. It is shown **red with an OVERRIDE label**, and it is **never filtered out** of the ledger or the Terminal tab. This is deliberate: the ledger is the proof of what was done outside the gate, and a record the Owner can hide would not be proof.

### Discard

**Discard** throws away a run's uncommitted work. It runs `git read-tree HEAD`, `git reset --hard --no-recurse-submodules HEAD` and `git clean -fd` in the working copy; the first rebuilds the index, so a file the agent marked skip-worktree or assume-unchanged (which `reset --hard` alone would leave as it is) is reset too. Commits the agent already made are kept. Discard has its own confirm step and its own required reason, and it is recorded in the same way.

### What it does not protect you from

An override does not stop code the agent planted from being run by a legitimate program you start. Some examples:

- Git hooks, when you run git in the agent's folder yourself.
- Python, when it imports a file from the current folder.
- npm scripts and other build tools that run project-defined commands.

The Terminal's own reading of changes switches these off. A program you run as an override does not. Look at what an agent changed before you run tools in its folder.

## What later releases add

Not in this release: connecting other machines, a share view for people who are not the Owner, roles and presence, and installers that are signed. Humans do not edit code in any release; they review and decide.
