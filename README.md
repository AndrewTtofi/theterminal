# The Terminal

An open-source, local-first workspace where AI agents do the work and humans set intent, decide, approve and audit.

Every agent action goes through a gate. Anything that could change your machine, your code or your accounts waits for a human decision. Every decision is recorded in an append-only, hash-chained ledger, so you can always see what happened, who approved it and why.

> **Status: early development.** The core (ledger, board, agent runtime with approvals, Claude/Codex/Gemini adapters) works and is tested on macOS and Windows. There are no installers yet, and interfaces may change.

## What it does today

- **Glass box ledger.** Projects, board moves, agent runs and every approval or denial are events in a tamper-evident SQLite ledger. Views are rebuilt from it.
- **Agents behind a gate.** Claude (Agent SDK), Codex (`codex app-server`) and Gemini CLI (ACP) run in a per-run git worktree. Reads inside the worktree are allowed. Everything else asks you first. Secrets are redacted from everything the agent reports.
- **Your own subscriptions or API keys,** chosen per provider.
- **Local only.** The server listens on your machine at its own local address, protected by a session token and Host and Origin checks.

The full design is in [`docs/specs/2026-11-13-agent-workspace-design.md`](docs/specs/2026-11-13-agent-workspace-design.md), and the implementation plans are in [`docs/plans/`](docs/plans/).

## Requirements

- Node.js 22 or newer
- pnpm 12 (`corepack enable` picks up the pinned version)
- Git
- macOS or Windows. Linux works for development, but CI does not cover it yet.

## Run it from source

```sh
pnpm install
pnpm build
node packages/core/dist/cli.js start
```

The command prints the local address to open in your browser. Options: `--port N`, `--data-dir PATH`.

For development with live reload:

```sh
pnpm dev
```

## Tests

```sh
pnpm test   # build, then unit tests for every package
pnpm e2e    # Playwright end-to-end tests (fake agents, no real accounts)
```

Live tests against real providers are opt-in and skipped by default (`THETERMINAL_LIVE_CLAUDE=1`, `THETERMINAL_LIVE_CODEX=1`, `THETERMINAL_LIVE_GEMINI=1`).

## Project layout

| Path | What it is |
|---|---|
| `packages/shared` | Domain types, event schemas, constants shared by server and UI |
| `packages/core` | Server: ledger, projections, agent runtime, adapters, HTTP and WebSocket API, CLI |
| `apps/ui` | React workspace UI |
| `e2e` | Playwright end-to-end tests |
| `docs` | Design spec and implementation plans |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. If you work with a coding agent, also point it at [AGENTS.md](AGENTS.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE)
