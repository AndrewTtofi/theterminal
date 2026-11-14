# Security policy

The Terminal runs AI agents on your machine and handles credentials for your AI providers and accounts. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what the issue is and what an attacker could do with it;
- steps to reproduce, or a proof of concept;
- the version or commit you tested.

You will get an acknowledgement as soon as possible. Please give a reasonable amount of time for a fix before any public disclosure.

## Scope

Of particular interest:

- secrets reaching the ledger, logs, API responses, the UI or agent output;
- agent actions that bypass the approval gate;
- escaping the per-run worktree, or reaching files outside it without approval;
- authentication, Host or Origin check bypasses on the local server;
- tampering with the ledger without detection;
- anything that makes a child process inherit more environment than the allowlist.

## Supported versions

The project is in early development. Only the latest commit on `main` receives security fixes.
