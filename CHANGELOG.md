# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no tagged releases yet.

## Unreleased

### Added
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

### Changed
- The Guided layout is now the default: the board with the Conversation next to it, and no bottom panel. Choose Operator from the Layout menu in the status bar for the Terminal, agent feed and ledger below the board.
- Runs recorded before this version show no Changes list or diffs, because the commit they started from was not kept. Their files can still be browsed under Files, and the emergency override still works for them.
- Agent programs receive an allowlisted environment only. Other secrets in your shell are no longer passed to them.
- Streamed agent text is held back just enough to redact secrets that arrive split across chunks, including private key blocks, YAML secret blocks and partial markers around tool calls.

### Security
- Git hardening for the Changes view, diffs and the emergency override's discard: git never recurses into submodules, ignores replacement objects (`git replace`), and compares a run's changes with the commit it started from, recorded when its working copy was created, rather than a branch the agent could move. Git is not run at all if The Terminal's own empty git configuration or hooks folder was modified.
- Upgraded zod to 4.6.6 (memory exhaustion on oversized constrained collections) and Vitest to 4.1.12 (code injection and path traversal in Vitest and `@vitest/mocker`; Vitest no longer depends on the vulnerable tinypool). Existing ledger entries still parse, and API validation errors still never echo the request.

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
