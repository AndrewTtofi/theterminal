# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no tagged releases yet.

## Unreleased

### Added
- Brand: the `>_` mark, wordmark, app icons for macOS and Windows, a favicon and a brand guide (`docs/brand.md`).
- Ice is the new default look. Settings → Appearance (the gear at the bottom of the activity bar) has six built-in themes (Ice, Phosphor, Amber, Classic, Light, High contrast), and lets you duplicate, edit, import and export your own. Approval, danger and override colours always stay readable.
- VS Code-style workbench: activity bar, side bar, tabbed main area with the board as home, bottom panel, saved layout and a live status bar (running agents, today's cost, pending decisions, connections).
- Connections view: add Claude, Codex (OpenAI), Gemini and GitHub credentials. Secrets are stored in the OS keychain and never reach the ledger, API responses or logs. Each connection has a read-only connection test.
- Agent runs use the configured connection's key, and each use is recorded in the ledger. A stored key is redacted from agent output immediately and stays redacted after removal.
- Sign in to your own Claude, ChatGPT or Google subscription from the Connections view, using the provider's own login. The Terminal never sees the credentials.
- Codex and Gemini CLI are bundled, so nothing has to be installed separately.
- Token counts on finished runs.
- Desktop app (unsigned test builds): a macOS dmg (Apple Silicon and Intel) and a Windows installer, built by the "Release builds" workflow. Opening the app starts the local server and shows the workspace in its own window.
- Documentation: `docs/connections-and-credentials.md`.
- Cloud accounts (AWS, Google Cloud, Azure), given to a run only when you tick them. AWS runs get a 12-hour session token when the keys allow it, Google Cloud runs a 1-hour access token, and Azure runs the client secret; nothing is written to disk, and the ledger records which kind of credential a run got, never its value.
- MCP servers (local and remote) for Claude runs, with every tool call behind the approval gate. Secrets reach Claude Code through its environment, never its command line. Codex and Gemini runs cannot be given MCP servers yet.
- **Add another** in the Connections view, for providers that allow several connections (cloud accounts and MCP servers).
- A read-only GitHub view (branches, open pull requests, CI runs) and a live `CI` item in the status bar.
- A Capacity view: usage and budgets per provider with estimates labelled as estimates, observed rate limits, and hardware detection for this computer.
- Plan intake: describe an idea, answer a few plain-language questions, make the decisions that matter and approve a plan, which creates your first cards. Everything is recorded in the ledger. Typed text is checked for secrets, and home folders and usernames are rewritten to `~` and `<user>`.
- Plain-language headlines for ledger entries, built locally from fixed templates and never stored. Long commands are cut with "(and n more lines)" and hidden or text-reversing characters are shown visibly.
- Readiness gates on moves to Ship and Operate, and when spend passes your budget: seven gates, each cleared by a sign-off or by a waiver with a reason. Blocked attempts are recorded. You cannot create a card directly in Ship or Operate.
- Card stories: everything that happened to a card, with its plan, gate decisions and estimated cost, plus the ledger's integrity check.
- Audit export of the ledger as NDJSON, with an integrity header, gap lines for unreadable or missing entries, and a trailer.
- Documentation: `docs/glass-box.md`.
- Rich workspace: a read-only Changes view with diff and file tabs (limits shown plainly, secret-looking names hidden, nothing from the repository is ever run), agent feed, Terminal and Conversation tabs, Learn topics with context, Guided and Operator layouts with up to 10 saved layouts, and paging for the ledger.
- Emergency override: run one program as you, outside the approval gate and sandbox, after a confirm step and a reason that is checked for secrets. It is always recorded, in red with an OVERRIDE label, and can discard a run's uncommitted work.
- Documentation: `docs/workspace.md`.
- Share view: a one-file share page (no script, no external request) built from the ledger, with the plan, progress, decisions, tech stack, agent workforce and cost, readiness and audit status. Text is cleaned of secrets, paths, usernames and email addresses, and a page that cannot be proven clean is never produced.
- Preview and confirm: you read the exact page, with a list of what is not included, before it is saved. Prompts and hardware are included only if you choose. Confirming is recorded in the ledger, and the saved file is checked against the ledger every time it is used.
- Downloads of a confirmed share page, and printing it to PDF from your browser.
- Temporary share links on an address you choose, for 1 hour to 7 days: shown once, revocable, ended after 20 wrong guesses, closed when The Terminal shuts down and shown as stopped after a restart.
- Daily digests: a plain-language summary of each UTC day, built from the ledger without a model, in the Share view and on the share page.
- Documentation: `docs/share-view.md`.
- Linked machines: pair two Terminals over the local network with a one-time code, run agents on the other machine with its own models and connections, decide from either, and see both machines in Capacity. Local models through Ollama or llama.cpp. Works offline.
- Linked machines, details: remote runs are approved on the machine that runs them; their changes come back verified and wait for your review, never merged automatically; a refused import is recorded with its reason and not retried; a suspicious entry or a changed machine key ends the run; unlinking a machine first asks it to stop the runs this computer has on it, and a machine that unlinks you stops the runs it was executing for you; each machine may leave at most 4 uploads and 1 GiB waiting, expiring after 1 hour; finding computers runs only in the Machines view and the Link a machine panel; prompts are cleaned before they are sent. Documentation: `docs/linked-machines.md`.
- Collaboration: invite people as viewers, reviewers or maintainers with a one-time link (7 days, shown once). Each person joins with a passkey or a key kept in their browser (passkeys need a name, not an IP address), signs in over the network, sees who else is here, and appears by name in the ledger, the story, decisions and the Share page. Roles are enforced on every request, and role changes and removal apply at once. Collaborators see connections by name only, and their runs use API keys only. See `docs/collaboration.md`.
- Gates say who may sign them (a role or a named person), with defaults for each gate that the Owner can change per project.
- Remote access (off by default): a TLS listener with a self-signed certificate (fingerprint in every invitation link) or a Let's Encrypt certificate for your domain, renewed automatically. Network sessions are separate from local ones, and the local token is never accepted on the network.
- Sign-in lockouts (5 failures, 15 minutes), rate limits, and presence (in memory only).
- Self-hosting with Docker: a server image with remote access on, an encrypted file store for secrets with its key on a separate volume, a bootstrap link for the first Owner (valid one hour), and a health check. See `docs/self-hosting.md`.
- Documentation: `docs/collaboration.md`, `docs/self-hosting.md`, and new sections in `docs/connections-and-credentials.md`.

### Changed
- Signing in with your own Claude plan and Gemini CLI's Google sign-in are turned off, because those providers do not allow other apps to use them. API keys are the recommended way; Codex's Sign in with ChatGPT is unchanged. A server started with `THETERMINAL_RESTRICTED_SIGNIN=1` (or `--allow-restricted-signin`) turns them back on. While off, a mode chosen earlier is not used and runs use the API key.
- The desktop app ships the licence and notice files of Node.js, Codex CLI, Gemini CLI and the Claude Agent SDK, listed in `THIRD_PARTY_NOTICES.txt`.
- The Guided layout is now the default: the board with the Conversation next to it, and no bottom panel. Choose Operator from the Layout menu in the status bar for the Terminal, agent feed and ledger below the board.
- Runs recorded before this version show no Changes list or diffs, because the commit they started from was not kept. Their files can still be browsed under Files, and the emergency override still works for them.
- Agent programs receive an allowlisted environment only. Other secrets in your shell are no longer passed to them.
- Streamed agent text is held back just enough to redact secrets that arrive split across chunks, including private key blocks, YAML secret blocks and partial markers around tool calls.
- Dependency upgrades: zod 4.6.7; Vitest 5.0.5; Vite 8.3.5 with `@vitejs/plugin-react` 6.1.2 (the UI is now bundled by Rolldown); TypeScript 7.0.2 (the native compiler); React and React DOM 19.3.1 with their types. The GitHub Actions in CI moved to `actions/checkout` 7.0.1, `actions/setup-node` 7.1.0 and `pnpm/action-setup` 6.1.0. `@types/node` stays on 22, matching the oldest Node the server supports. Dependabot now opens one pull request per bump for the whole pnpm workspace.

### Security
- The Changes view, diffs and the emergency override's discard read a run's working copy with a hardened git: it never recurses into submodules, ignores replacement objects (`git replace`), compares a run's changes with the commit it started from (recorded when its working copy was created, rather than a branch the agent could move), and never reads the run's own index, so marks the agent can set in it (`skip-worktree`, `assume-unchanged`, a sparse checkout, an untracked cache) cannot hide a changed file from the views or from the discard, which rebuilds the index before it resets. If The Terminal's own empty git configuration or hooks folder was modified, the views and the discard answer with a message naming the cause instead of failing.
- Upgraded zod to 4.6.6 (memory exhaustion on oversized constrained collections) and Vitest to 4.1.12 (code injection and path traversal in Vitest and `@vitest/mocker`; Vitest no longer depends on the vulnerable tinypool). Existing ledger entries still parse, and API validation errors still never echo the request.
- The ledger's canonical JSON now covers a key literally named `__proto__` (which JSON such as an agent's tool input can contain) instead of silently dropping it from the hashed text, so an entry can no longer carry content its hash does not cover. Existing entries hash to exactly the same value and keep verifying; a stored entry that carries such a key without its hash covering it is reported as broken, as any other tampered entry is.

### Added (project)
- Contributor guide, agent contribution guidelines, security policy, code of conduct, pull request and issue templates, and a code owners file.

## Foundation and agent runtime (merged to `main`, November 2026)

### Added
- Append-only, SHA-256 hash-chained ledger in SQLite with tamper detection at startup. Projections are rebuilt from the ledger.
- Projects and a lifecycle board driven by ledger events.
- Local server at its own local address, with a session token, Host and Origin checks, default-deny routing and a live ledger WebSocket.
- React workspace: lifecycle board, project list, live ledger panel.
- Agent runtime: per-run git worktrees, a policy gate, human approvals (allow/deny), fail-closed behaviour and recovery at startup.
- Claude adapter on the Claude Agent SDK, with a pre-execution gate on every tool call. Subscription mode is opt-in.
- Codex adapter over `codex app-server`, with per-action approvals and an isolated home in API key mode.
- Gemini CLI adapter over ACP, with client-mediated file and terminal access and a strict policy.
- Per-provider sign-in mode (API key or the provider's own subscription login).
- Secret redaction for everything agents report: key/value forms, PEM blocks, URL credentials, JSON, YAML and headers, plus scrubbing of personal paths.
- "Needs you" strip showing pending decisions from every project.
- CI on macOS and Windows.
