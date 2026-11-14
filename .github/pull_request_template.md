## What and why

<!-- What does this change, and what problem does it solve? Link the issue. -->

## How it was tested

<!-- The exact commands you ran and their results. -->
- [ ] `pnpm test`
- [ ] `pnpm e2e` (for UI or server changes)

## Safety checklist

- [ ] No secrets, real keys, personal paths or email addresses anywhere, including tests
- [ ] No safeguard weakened (tests, redaction, approval gate, auth, env allowlist, fail-closed paths)
- [ ] State changes go through the ledger (`commitEvent`); projections still rebuild
- [ ] No `shell: true` or shell strings; child env built with `buildChildEnv`
- [ ] New dependencies (if any) are pinned, licence-compatible and explained below
- [ ] CHANGELOG.md updated under **Unreleased** if users would notice

## Agent disclosure

<!-- Did an AI agent or tool help? Name it and say what it did. "None" is fine. -->
