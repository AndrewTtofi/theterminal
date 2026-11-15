# The share view

This page describes the share view: how you show a project to collaborators or investors without showing them the workspace, what ends up on the page, what is kept off it, and how a link to it works. It also describes the daily digest, which is the same text you read inside the workspace and the person you share with reads on the page.

## What the share page is

The share page is **one HTML file** built on your computer from the ledger. It carries the plan summary, the board's progress, the human decisions with their owner, the tech stack, the agent workforce and what it cost, what is waiting on a human, the readiness gates, the last days as daily digests and the ledger's audit status.

The file is self-contained, which means it has:

- **No script.** Nothing on the page runs.
- **No external request.** No fonts, images, trackers or links to load. Everything the page needs is inside the file.
- **A content security policy that forbids both.** The policy is `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`. In plain words, even if something odd got into the file, the browser would refuse to run it or to contact anyone.

Why it is built this way. The file works offline, so the share view keeps working with no connection. It can be emailed, kept by an auditor or opened years later. And because it cannot run anything or phone home, sending it is as safe as sending a PDF.

There is no hosted service yet. Sharing beyond your own computer or local network comes in a later plan (see "What later plans add").

## The sections

The page has these sections, always in this order:

| Section | What it shows | Where it comes from |
|---|---|---|
| Overview | Project name, the pitch, `Owner`, when it started, when the page was generated | The project record |
| Progress | The five stages, with the current one and how much of it is done | The board's cards |
| Headline numbers | Work done by agents, spend to date, the cost per day to run, human decisions made and waiting, the state of checks | Agent runs, the ledger and, when a GitHub connection exists, its checks |
| What it does and why | The approved plan summary and your idea | Plan intake |
| Tech stack | One row per choice, with a plain-language reason, a licence or terms line and the ledger entry that decided it | Your intake decisions and platform answer, the kinds of connection you enabled and the agent programs that ran |
| Agent workforce | One row per agent program with its runs and its cost | Agent runs |
| Waiting on a human | Actions an agent has asked to run and intake decisions you have not made yet | Pending actions and open intake |
| Decisions made | Each human decision with its owner, date, reason and ledger reference | Intake decisions, gate sign-offs and waivers, and actions you allowed or denied |
| Readiness | Each readiness gate: signed off, waived, open or not reached | Gate decisions and the gates' own checks |
| Daily digests | One narrated summary per day for the last 7, 14 or 30 days | The ledger (see "Daily digests") |
| Earlier history | One line per older day: entries, agent actions, decisions, cards moved | The ledger |
| Audit status | Whether the ledger is intact, how many entries, and its latest entry | The ledger's integrity check |

A section with nothing to show says so in one line, for example "Nothing is waiting on a human." or "No decisions recorded yet."

The page always calls the owner `Owner`. It never shows a name.

### Honest labels

- A cost The Terminal worked out from recorded usage is shown with the word **estimate**. Hover over it to read why: "Not a figure from the provider. Computed by The Terminal from recorded usage." A cost only loses that word when every run behind it reported its own number.
- Where nothing was reported, the page says **not reported**. It never shows `$0.00` for that.
- Every day is shown with **(UTC)** next to it.

### The tech stack

The tech stack is not typed in by hand. Its rows are derived:

- **Scope, Hosting, Access, Payments, Personal data** come from the intake decisions you made. The reason is the one you gave, or, if you gave none, the plain-language trade-off of the option you chose.
- **Platforms** comes from the plan.
- **AI agents, Cloud, Code hosting, Tools (MCP)** come from the connections you enabled. Only the kind and the provider are shown, for example "Cloud · AWS". Two connections of one provider collapse into one row. Hardware is not a row.
- **Agent programs** has one row for each agent program that ran, with how many runs.

Each row has a licence or terms line where the workspace knows it, and the ledger entry that decided it.

## What is included and what is not

Everything on the page is text that has been cleaned (see the next section). Some things never get onto the page at all. The page's footer lists them under **Not included**, and so does the preview, beside the page. The list is:

1. Credentials, API keys and tokens (they live only in your keychain and are never in the ledger)
2. File contents and diffs
3. Raw agent output and the raw input of every action
4. What agents said (their messages)
5. Your prompts to agents (shown only when you tick Include my prompts)
6. This computer's hardware (shown only when you tick Include this computer)
7. Connection names and account details: regions, project ids, repository names
8. File paths outside the project, your username and email addresses
9. Anything from other projects

Two things are off by default and you can switch each one on:

- **Include my prompts to agents.** The prompts you gave agents then appear in the daily digests, under that day's **Asks**, after they have been cleaned. Without it they never appear anywhere on the page.
- **Include this computer's hardware.** One line is added to the tech stack: the processor, memory and graphics card.

Prompts and hardware are never included unless you choose to include them.

When you switch one on, its line disappears from the Not included list, so the list always matches the page.

There is also **Digest days**: 7, 14 or 30 days of daily digests. Older days are shown only as one line each in Earlier history. The default is 7.

Connection names, config values and other projects are never available, whatever you tick.

## How the page is cleaned

Redaction is pattern matching, and patterns can miss. So the page is cleaned in several passes, and then checked, and you read it before it goes anywhere.

Every piece of text goes through the same steps, in this order:

1. **Redact** known secrets and anything that looks like a key or token. They become `[REDACTED]`.
2. **Replace email addresses** with `[email]`. This happens before usernames are scrubbed, so an address whose first part is your username goes whole, domain included, instead of leaving half of it behind.
3. **Scrub** paths and names. The data folder becomes `<data>`, your home folder becomes `~` and then your username becomes `<user>`.
4. **Redact again**, in case scrubbing joined something back together.
5. **Cut to length**, last, so that a cut can never leave half of a secret behind. No single text on the page is longer than 4,000 characters.

The list of known secrets is read every time, so a connection you add later is covered too.

For example, a pitch that reads "by alice at /Users/alice, someone@example.test" appears on the page as "by <user> at ~, [email]".

**The final check.** After the whole page is built, it is cleaned once more. If that changes a single character, the page is not generated and you see "The page could not be cleaned of sensitive text and was not generated." A page that cannot be proven clean is never produced, and nothing is kept.

**The same check runs every time the page is served.** Whenever a saved snapshot is opened, downloaded or served on a link, its text is checked again. If cleaning it now would change anything, for example because you have since stored a secret that happens to appear in it, the page and the link refuse to show it. Nothing that would leak a stored secret is ever shown.

## Preview and confirm

Nothing is saved or shared until you have seen it.

1. Open **Share** in the activity bar, choose what to include and press **Preview share page**.
2. The **Share** tab shows the page exactly as it will be shared, in a sandboxed frame, with the **Not included** list beside it. Above it you see the number of bytes, the first 12 characters of its hash and when the preview expires.
3. Tick **I have read this page and I am happy to share everything on it.** and press **Confirm and save snapshot**.

What to know about this:

- **A preview lasts ten minutes.** After that, or if the project changed in the meantime, you see "The preview has changed or expired. Preview again before confirming." and the preview is cleared. A change in the project after the preview never changes the page you confirm: what is shared is always exactly what was previewed.
- **Only you can confirm.** An agent or any system actor cannot.
- **The hash.** The page is fingerprinted with SHA-256. Confirming only works if the hash matches the preview you are holding.
- **What the ledger records.** Confirming adds a `share.confirmed` entry with the hash, the size in bytes, the sections, your options and the ledger position at that moment. The ledger shows it as "Owner confirmed a share page (12 sections, …)". So "what was shared" can always be answered later from the ledger.
- **Where the file lives.** The confirmed page is saved as a file in the project's `share` folder inside your data folder, readable only by you. It is a snapshot: it never changes.
- **It is checked before it is used again.** Each time the file is opened, downloaded or served on a link, its hash is compared with the one in the ledger. If the file is missing, you see "This snapshot's file is missing." If it no longer matches, you see "This snapshot's file no longer matches the ledger. It will not be shared." and it is not served.
- **A page that is too large is refused.** The limit is 8 MiB. If you hit it, you see "The page is too large to share. Choose fewer digest days."
- **Read-only ledger.** If the ledger is read-only because its chain is broken, you can still preview, but you cannot confirm or create a link.
- **Previews are held in memory only.** The Terminal keeps at most 20 at a time and drops the oldest first.

In **Saved snapshots** in the Share view you can **Open** a snapshot in a new tab, **Download** it as `theterminal-share-<8 characters>.html` or share it on your network.

## Evidence references

A page cannot link back into your workspace, so each decision and tech stack row carries a coordinate into the ledger: `#<seq> · <hash12>`, for example `#412 · 9f3a1c07be22`. That is the entry's position in the ledger and the first 12 characters of its hash.

To check one, export the audit file of the project (it is a plain `.ndjson` text file named `theterminal-ledger-<id>.ndjson`) and find the entry with that position. Its hash must start with the same 12 characters. Because each entry's hash includes the one before it, a changed or invented entry cannot keep a matching reference. The page's Audit section says this too.

## Present mode and PDF

- **Present.** The page has a **Present** link at the top. It shows one section per screen, in larger type, and you scroll from section to section. **Exit** takes you back. There is no script: this is done by the page's styles alone.
- **PDF.** Open the confirmed page in a new tab and use your browser's Print, then choose Save as PDF. The page has its own print layout: the controls are hidden and sections are not split across pages. The Terminal does not make PDFs itself, so there is nothing extra to install.

## Links

A confirmed snapshot can be served to other people on the same network for a while, as a link. This is for "show it to someone in the same room or office while my laptop is on". It is not a way onto the internet.

### Creating one

Open a saved snapshot and choose **Share on your network…**.

- **Address.** You pick from the addresses of this computer: `This computer only` (127.0.0.1, which only you can reach) or one `Local network (<address>)` entry for each network connection the computer has. IPv6 addresses are not offered. `0.0.0.0`, which means "every address on this machine", is never offered or accepted, because you could then be sharing on a network you did not choose. An address that is not on the list is refused.
- **Valid for.** 1 hour, 8 hours, **24 hours (default)** or 7 days.
- **One link per project at a time.** If one is already live you see "A link is already live for this project. Revoke it first."
- **The link is shown once.** After you press **Create link**, the full address appears with a **Copy** button and the note "This link is shown once. Copy it now." It cannot be shown again. Make a new one if you lose it.

The link looks like `http://<address>:<port>/<token>`. The port is 4400, or the next free one above it (up to 4420).

Anyone with the link can read that snapshot, and nothing else, until it expires or you revoke it.

A link binds only to the address you chose, expires, can be revoked, and is closed when The Terminal shuts down.

### The token

The token is 32 random bytes. The Terminal keeps only its **digest** (a one-way fingerprint) and records that digest in the ledger. Neither the ledger nor the computer's memory can reproduce the link.

### What the link server answers

The link server is a separate, tiny listener. The workspace itself stays on this computer only and is never reachable from the network. The link server knows one thing: one snapshot's bytes and one token digest. It has no sign-in, no workspace and no access to your files.

- `GET` or `HEAD` with the right token returns the page.
- Everything else answers `404` with an empty reply: a wrong token, an unknown path, and the workspace's own addresses (for example `/api/ledger`). A wrong token and an unknown path look the same.
- Other methods (such as `POST`) answer `405`.
- A request addressed to a name or port other than the link's own answers `403`.
- The page is served with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and the same content security policy as above.

### When a link ends

A link stops, and the ledger records why:

| Cause | Ledger entry |
|---|---|
| The time ran out | `share.expired` |
| You pressed **Revoke** | `share.revoked` with reason `owner` |
| Twenty wrong guesses were made in the link's life | `share.revoked` with reason `too_many_failures` (after that, even the right token no longer works) |
| You closed The Terminal | `share.stopped` with reason `shutdown` |
| The Terminal started and found a link still marked live | `share.stopped` with reason `restart` (no listener is reopened) |

**Twenty wrong guesses revoke the link, by design.** A guess counts when it is the right shape for a token (43 letters, digits, `-` or `_`) and is wrong; things like a browser asking for `/favicon.ico` do not count. This means anyone who can reach the link's address can end it by sending 20 wrong guesses. That is deliberate and it fails safe: the worst a stranger can do is switch your link off, and you make a new one.

After a restart, links that were live are shown as **stopped**. Their listeners died with the old process, and the ledger records `share.stopped` the next time it is writable. Nothing is ever shown as live that is not.

So a link only lives **while The Terminal is running on this computer**. The status bar shows `Sharing: 1 link live` (or `Sharing: 2 links live`) while any is live, counted from the links actually being served, and the Share view lists live links with a **Revoke** button.

### What the ledger knows

The ledger records the token's digest, the expiry, the scope (this computer or local network) and the port. It **never records the address**, because the address of your network is not the ledger's business.

## Daily digests

A daily digest is the day, written out. You can read it in the **Daily digest** tab (open it from the Share view) and the same text appears on the page under **Daily digests**, so you read before you share what the other person will read.

How it is made:

- **UTC days.** A day is a calendar day in UTC, and the page says `(UTC)`. So the same ledger gives the same digest on every computer, whatever its time zone.
- **No model, no clock, no network.** A digest is a fixed template filled from the ledger. Same ledger in, same digest out.
- **Only certain entries are listed.** The digest lists headlines for: projects created, cards created, moved or changed in status, agent runs starting and finishing, actions requested and the ones a human decided, rate limits, intake started, decided, completed or reopened, gates blocked, signed off or waived, connections added or removed, overrides (command, discard, completed) and share events (confirmed, link created, revoked, expired, stopped). Everything else, including every message and every output, is counted but never listed. An action decided by policy is counted but not listed; one you decided is listed.
- **Prompts never.** A digest says "Owner started a Claude Code agent on "Login"", never what the prompt said. Prompts can appear on the page only under **Asks**, and only when you ticked Include my prompts.
- **At most 100 items per day**, then "and <n> more".

The summary sentence has a fixed shape:

> 10 ledger entries: 1 agent action requested, 1 allowed and 0 denied by a human, 1 decision by the Owner, 1 card moved, 1 agent run started and 1 finished. Agent spend recorded that day: $0.25 (estimate).

The last sentence appears only on days when a cost was recorded. The counts of entries, actions, decisions, cards and runs started are singular or plural to match ("1 ledger entry", "2 ledger entries", "1 agent action", "2 agent actions"); "allowed", "denied" and "finished" are plain numbers. Actions are counted whoever decided them, so a day with an action decided by policy shows it in "agent actions requested" but not under "allowed" or "denied by a human".

## What is not on the page yet

Some things a share view could show are missing on purpose, because they need pieces that do not exist yet.

- **Cloud sharing, accounts for people you share with (Viewers), named owners and presence** come in Plan 8. Until then the page says `Owner`, never a name, and a link lives only as long as your computer is on.
- **A live demo link and uptime figures** need deployment and monitoring records, which come with the operate pack. For now the only health signal is the state of your checks, if you have a GitHub connection.
- **Which model ran each time.** The ledger records the agent program (Claude Code, Codex CLI, Gemini CLI), so that is what the workforce table shows. The model name per run is not recorded yet.
- **Editing the page by hand.** A share page is always generated from the ledger, never written or edited.
- **Other languages.** The page is in English.
