# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no tagged releases yet.

## Unreleased

### Added
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
