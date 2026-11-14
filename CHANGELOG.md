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
- Documentation: `docs/connections-and-credentials.md`.

### Changed
- Agent programs receive an allowlisted environment only. Other secrets in your shell are no longer passed to them.
- Streamed agent text is held back just enough to redact secrets that arrive split across chunks, including private key blocks, YAML secret blocks and partial markers around tool calls.

### Security
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
