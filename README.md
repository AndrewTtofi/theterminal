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

## Desktop app (unsigned test builds)

The desktop app is a macOS dmg (Apple Silicon and Intel) and a Windows installer. Opening it starts the local server and shows the workspace in its own window.

**Where to get it.** Download the installers from the artifacts of a run of the "Release builds" workflow (Actions tab, kept for 7 days), or from a draft release.

**These builds are unsigned.** Code signing and notarization come later, so your system warns you the first time you open the app:

- **macOS:** open the dmg and drag The Terminal to Applications. The first time you open it, macOS says it cannot verify the app. Go to System Settings → Privacy & Security and click **Open Anyway**. Or run this once in Terminal:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/The Terminal.app"
  ```

  macOS may ask for keychain access again after you install each new build.
- **Windows:** when SmartScreen warns you, click **More info**, then **Run anyway**. The installer is per-user, so it does not need admin rights.

**Claude Code is not included in these test builds yet.** Install Claude Code yourself to use Claude in the desktop app; Codex and Gemini CLI are included.

**Your data.** The app uses the same data folder as `theterminal start` (`~/Library/Application Support/TheTerminal` on macOS, `%APPDATA%\TheTerminal` on Windows), so projects and connections are shared. Only one of the two can run at a time: whichever starts second refuses with a message saying the data folder is in use.

The app id (`org.theterminal.desktop`) is still to be confirmed before signed builds ship. Changing it later resets macOS permissions and keychain access.

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
