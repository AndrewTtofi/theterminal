# Guidelines for coding agents

This file is for AI coding agents (and the people running them) that contribute to The Terminal. It complements [CONTRIBUTING.md](CONTRIBUTING.md): read that first. Everything there applies to you too.

The Terminal exists so that humans can trust agents. Contributions made with agents must be held to the same bar the product holds agents to: visible, reviewable, and approved by a human.

## Ground rules

1. **A human owns every contribution.** The person who opens the pull request has read the whole diff, understands it, and answers for it in review. Do not open pull requests, issues or comments autonomously.
2. **Say how the change was made.** In the pull request description, name the agent or tool that helped and what it did (for example "drafted the tests and the fix; I reviewed and edited"). Do not add co-author trailers to commits.
3. **Stay in scope.** Do the task you were given. Do not refactor, rename or reformat code outside it, and do not "improve" unrelated files.
4. **Never weaken a safeguard to make something pass.** That includes tests, redaction, the approval gate, auth checks, the child environment allowlist, and the fail-closed paths. If one seems wrong, stop and explain it in the pull request instead of changing it.

## Before you write code

- Read the relevant part of the design spec (`docs/specs/`) and the plan for the area (`docs/plans/`). The spec is the authority.
- Read the files you will change, including their tests, and follow their existing patterns.
- If the task is ambiguous, ask the human. Do not guess on anything touching security, the ledger or credentials.

## While you work

- **Test first.** Write a failing test, run it, see it fail for the right reason, then implement. Run the full suite (`pnpm test`) and, for UI or server changes, `pnpm e2e` before you finish.
- **Keep secrets out of everything.** Never print, log, commit or paste real credentials. Use fakes that contain `TESTKEY`. Never read files outside the repository: no home directory, no keychain, no credential files.
- **No shell strings.** Spawn processes with argument arrays and environments from `buildChildEnv`.
- **Ledger invariants.** State changes go through `commitEvent`, and projections must rebuild exactly from the ledger.
- **Cross-platform.** CI runs on macOS and Windows. Use `node:path`, never hard-code `/` or `\`, and do not assume a case-sensitive file system or environment.
- **No new dependencies** unless the human approved one: pinned exact version, compatible licence, no new install scripts.

## Before you hand back

Report to the human, plainly:

- what you changed and why;
- the exact test commands you ran and their results (failures included);
- anything you were unsure about or left undone;
- any place where you departed from the spec or plan.

Do not claim something works unless you ran the check that shows it.

## Commit and pull request hygiene

- Conventional commit subjects (`fix(core): …`).
- The commit author is the human contributor, with no AI attribution trailers.
- No personal data: names, emails, absolute paths from your machine, tokens.
- Keep each pull request to one change, and fill in the pull request template, including the agent disclosure.
