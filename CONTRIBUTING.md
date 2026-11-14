# Contributing to The Terminal

Thanks for helping. This project is about trust: agents do the work, and humans can see and approve everything. Contributions are held to that standard.

## Before you start

- **Bugs:** open an issue using the bug template. Include steps to reproduce, what you expected, and your OS and Node version.
- **Features or larger changes:** open an issue first and describe the problem you want to solve. Changes to the ledger, the approval gate, redaction, authentication or credential handling need agreement before code.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## How changes get in

`main` is protected. Nobody pushes to it directly.

1. Fork the repository and create a branch from `main`.
2. Make your change with tests (see below).
3. Open a pull request against `main` and fill in the template.
4. CI must pass on macOS and Windows.
5. The maintainer reviews every pull request. A pull request is merged only after that review.

Keep pull requests focused: one change per pull request. Rebase on `main` rather than merging `main` into your branch.

## Development setup

```sh
corepack enable          # uses the pinned pnpm version
pnpm install
pnpm test                # build and run all unit tests
pnpm e2e                 # end-to-end tests
```

Requirements: Node.js 22+, Git, macOS or Windows (Linux works for development).

## Standards

**Tests are required.** Write the failing test first, then the code. Bug fixes include a test that fails without the fix. Do not weaken or delete an existing test to make a change pass. If a test is wrong, explain why in the pull request.

**TypeScript is strict ESM.** No `any` without a comment explaining why. Follow the patterns already in the file you are editing.

**Never run commands through a shell** (`shell: true`, `exec` with a string). Spawn with an argument array, and build every child process environment through `buildChildEnv` (an allowlist).

**The ledger is append-only.** Every state change goes through `commitEvent`. Never write projection tables directly. A projection must rebuild from the ledger to exactly the same state.

**Secrets never leave the keychain except to the process that needs them.** Ledger entries, API responses, error messages, logs and test fixtures hold field names, never values. Anything an agent reports passes through redaction (`clean()`). Redact before you truncate.

**Fail closed.** If a check cannot run (redaction throws, the keychain is unavailable, a path cannot be resolved), refuse the action rather than allowing it.

**Dependencies:** add one only when it clearly earns its place. Pin exact versions, and say in the pull request why it is needed and what its licence is (it must be compatible with Apache-2.0). Do not allow new install scripts without discussion.

## Commits

- Use conventional commit style: `feat(core): …`, `fix(ui): …`, `test(e2e): …`, `docs: …`.
- Write the subject in plain language, describing what changes for the user or the codebase.
- You are the author of what you submit and responsible for it, whatever tools you used. Do not add co-author trailers for tools or AI assistants.
- Never commit secrets, real API keys, personal paths, email addresses or other personal data, including in tests. Use obvious fakes such as `sk-ant-TESTKEY-0000000000`.

## Changelog

Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for any change a user would notice.

## Licence

By contributing, you agree that your contribution is licensed under the [Apache-2.0 licence](LICENSE) of this project.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
