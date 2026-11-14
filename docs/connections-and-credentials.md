# Connections and credentials

A connection is a link from The Terminal to a service you use: an AI provider today, and cloud accounts, GitHub and MCP servers later. This page explains where each piece of a connection is kept, what agents can and cannot see, and what to do when something goes wrong.

## Where each kind of value lives

| Value | Where it lives |
| --- | --- |
| Secrets (API keys, tokens) | Your operating system's keychain: macOS Keychain, Windows Credential Manager, or Linux Secret Service |
| Connection name, kind, provider, enabled flag, non-secret settings | The ledger (the append-only record in The Terminal's data folder) |
| Names of the secret fields a connection has | The ledger and the API |
| Secret values | Never in the ledger, the database, a file, a log or an API response |
| Secrets while The Terminal is running | In memory only, so they can be redacted from agent output |

The ledger and the API only ever hold field names, never values. A ledger entry can say that you replaced the `apiKey` of a connection. It never contains the key, not even part of it.

If the keychain is unavailable, saving a secret fails and nothing is written anywhere else. The Terminal still starts and still lists your connections. The status bar shows `Keychain unavailable` in place of the connections count.

### Keychain service name and account scheme

Every entry is filed under the keychain service `TheTerminal`. The account name is `connection/<connection id>/<field name>`, for example `connection/<id>/apiKey`. You can find and delete these entries in Keychain Access, Credential Manager or your Secret Service client.

### macOS prompts

macOS ties keychain access to the program that created the entry. If the Node binary that runs The Terminal changes (for example after you upgrade Node or switch version managers), macOS asks you to allow access again. Choose Always Allow. If you decline, saving and reading secrets fails until you allow it, and the status bar shows `Keychain unavailable`.

### Long values on Windows

Windows Credential Manager stores at most 2560 bytes per entry. The Terminal splits longer values into pieces of at most 2048 bytes. The first entry (`<account>`) holds a small marker, `chunks:<n>`, and the pieces are stored as `<account>#1`, `<account>#2` and so on. Reading puts them back together. Values are limited to 16 KiB in total. Deleting a connection's secret deletes all of its pieces.

## Two ways to use each AI provider

Each AI provider (Claude, Codex, Gemini) can run in one of two modes. You choose per provider.

- **API key mode.** You paste an API key into The Terminal. It is stored in the keychain and given to the agent program only for the run that needs it. You pay the provider per use.
- **Sign-in mode.** You use your own subscription or account: your Claude subscription, your ChatGPT plan, or your Google account. The Terminal starts the provider's own login command and never reads or stores the login. The provider's program saves its own credentials where it always does, exactly as if you had run the login in a terminal yourself.

### Signing in from the Connections view

In a provider's editor, under the sign-in option, **Sign in** opens a panel. It shows the provider's login link or device code, a spinner, then `Signed in` or `Sign-in failed`. You sign in on the provider's own page: The Terminal never sees your password or login tokens. The Terminal shows only the lines of the login command that are safe to show (links on the provider's own domain, device codes and status words), with secrets and file paths removed. Only one sign-in per provider runs at a time, and a sign-in that is not finished after 10 minutes is stopped. The ledger records only that you signed in (or that it failed), with no output, account name or email.

### Notes for each provider

- **Claude subscription mode** uses the Claude CLI's own stored login. A `CLAUDE_CODE_OAUTH_TOKEN` exported in your shell is not passed to the agent.
- **Codex** in ChatGPT mode keeps its login in its own home folder (`CODEX_HOME`). You can point The Terminal at a different folder in the connection editor. That folder path is stored only in the keychain.
- **Gemini in Google sign-in mode** saves its own login in a file in its home folder, not in the OS keychain, because its optional keychain helper is not built. The Terminal never reads that file.

## The environment variables fallback

The server's own `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GEMINI_API_KEY` environment variables are a fallback for development and live tests. If you have a connection for a provider, the connection wins over the variable.

To stop using the fallback, unset the variable in the shell that starts The Terminal and restart it, then add a connection instead. Connections do not need any environment variable.

## What agent programs can see

Agent programs get an allowlisted environment only. The Terminal builds it from scratch rather than passing along your shell's environment:

- Basic system variables: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TERM`, every `LC_*`, `TMPDIR`, `TEMP`, `TMP`, `TZ`, and the `XDG_*` folder variables. On Windows also the standard system and profile folder variables (`SystemRoot`, `USERPROFILE`, `APPDATA` and similar).
- Network settings: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (either case), and the certificate variables `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS`.
- Git is pointed at an empty global configuration so your own git settings do not apply.
- In API key mode, the one key for that provider. In sign-in mode, no key at all.

Nothing else is passed. Other secrets in your shell, such as cloud keys, npm tokens or GitHub tokens, are not passed to agents, and one provider's key is never given to another provider's agent.

`HTTP_PROXY` and `HTTPS_PROXY` are passed because agents often need them to reach the internet. Credentials in a proxy URL (the `user:password@` part) are redacted from anything the agent reports back.

## Redaction, and removed secrets

Anything you store through a connection is redacted from agent traffic as soon as you save it, with no restart. When you remove or replace a secret, it stays on the redaction list until The Terminal restarts, so an agent cannot echo an old value back into the record.

## Bundled agent programs

Codex and Gemini CLI are bundled with The Terminal. That adds about 460 MB to the install. A copy of either on your `PATH` is used only when the bundled one is missing for your platform.

## Usage numbers

Token counts are as the provider reports them. They are not comparable across providers: each provider counts differently, and some do not report them at all.

## Gemini keeps transcripts on disk

Gemini CLI stores its session transcripts and error dumps on disk, and they can contain the text of your prompts, file contents and command output. This is Gemini's own behaviour, not The Terminal's, and The Terminal does not control it.

- In Google sign-in mode the files are in `~/.gemini/tmp` (in the Gemini home folder you configured, if any).
- In API key mode each project has its own Gemini home, and the files are in `<data folder>/projects/<project id>/gemini-home/.gemini/tmp`.

To clear them, close The Terminal's running Gemini agents and delete the contents of those `tmp` folders. Gemini recreates them when it needs them. Deleting a project's `gemini-home` folder clears that project's API key mode history.

## Codex and MCP servers

Codex cannot use MCP servers in The Terminal in this version. Codex gives no approval step for MCP tool calls under the strict policy The Terminal runs it with, so an MCP tool call could not be shown to you for approval first. Rather than skip the approval, The Terminal does not offer MCP servers to Codex.

## What comes next

A later release (Plan 5B) adds:

- Cloud accounts (AWS, Google Cloud, Azure) with credentials given to a run only when you select them.
- A GitHub view with branches, pull requests and CI status, and a live `CI` item in the status bar.
- MCP servers through the approval gate, for Claude and Gemini.
- A capacity view that shows what each provider and your own hardware can do, with estimates labelled as estimates.
