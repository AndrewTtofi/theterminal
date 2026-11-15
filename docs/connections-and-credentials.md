# Connections and credentials

A connection is a link from The Terminal to a service you use: an AI provider, a cloud account, GitHub or an MCP server. The Connections view also holds a `This computer` entry that hardware detection writes. This page explains where each piece of a connection is kept, what agents can and cannot see, and what to do when something goes wrong.

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

### Linux

On Linux, The Terminal needs a running Secret Service provider, for example GNOME Keyring or KWallet. Without one, the status bar shows `Keychain unavailable` and saving a secret fails.

### Long values

On every platform, The Terminal splits any value longer than 2048 bytes into pieces of at most 2048 bytes, because keychains limit the size of an entry. Windows Credential Manager has the tightest limit, 2560 bytes per entry. The first entry (`<account>`) holds a small marker, `chunks:<n>`, and the pieces are stored as `<account>#0`, `<account>#1` and so on. Reading puts them back together. Values are limited to 16 KiB in total. Deleting a connection's secret deletes all of its pieces.

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
- The variables of the cloud accounts you ticked for that run, and nothing from any other cloud account (see [Cloud accounts](#cloud-accounts)).

Nothing else is passed. Other secrets in your shell, such as cloud keys, npm tokens or GitHub tokens, are not passed to agents, and one provider's key is never given to another provider's agent.

`HTTP_PROXY` and `HTTPS_PROXY` are passed because agents often need them to reach the internet. Credentials in a proxy URL (the `user:password@` part) are redacted from anything the agent reports back.

## Redaction, and removed secrets

Anything you store through a connection is redacted from agent traffic as soon as you save it, with no restart. When you remove or replace a secret, it stays on the redaction list until The Terminal restarts, so an agent cannot echo an old value back into the record.

Values made for a run, such as an AWS session token or a Google Cloud access token, go on the redaction list before the agent starts. They stay on it until The Terminal restarts, so they are redacted from every later run too, not only from the run that received them.

## Bundled agent programs

Three agent programs are bundled with The Terminal, so nothing else needs installing:

- Claude Code, which ships inside the Claude Agent SDK's platform package (about 330 MB)
- Codex CLI (about 360 MB)
- Gemini CLI (about 100 MB)

Together they add roughly 800 MB to the install; the exact sizes depend on your platform. A copy of a program on your `PATH` is used only when the bundled one is missing for your platform.

## Usage numbers

Token counts and costs are explained in [Capacity](#capacity).

## Gemini keeps transcripts on disk

Gemini CLI stores its session transcripts and error dumps on disk, and they can contain the text of your prompts, file contents and command output. This is Gemini's own behaviour, not The Terminal's, and The Terminal does not control it.

- In Google sign-in mode the files are in `~/.gemini/tmp` (in the Gemini home folder you configured, if any).
- In API key mode each project has its own Gemini home, and the files are in `<data folder>/projects/<project id>/gemini-home/.gemini/tmp`.

To clear them, close The Terminal's running Gemini agents and delete the contents of those `tmp` folders. Gemini recreates them when it needs them. Deleting a project's `gemini-home` folder clears that project's API key mode history.

## Codex and MCP servers

Codex cannot use MCP servers in The Terminal in this version. See [MCP servers](#mcp-servers) for why.

## Gemini and MCP servers

Gemini cannot use MCP servers in The Terminal in this version. See [MCP servers](#mcp-servers) for why.

## Cloud accounts

You can connect AWS, Google Cloud and Azure accounts. You can have several connections for each provider: in the Connections view, **Add another** next to a provider you have already connected opens an empty editor for a further connection. A run is given a cloud account only when you tick it for that run (see [Giving a run access](#giving-a-run-access)), and at most one connection per cloud provider per run: if you tick two connections of one cloud provider, the run is refused.

The secret fields are kept in the keychain like every other secret. Each connection has a connection test that only reads: AWS checks who the keys belong to, Google Cloud and Azure read the project or subscription you entered.

### What each provider needs

| Provider | Fields | Secret fields |
| --- | --- | --- |
| AWS | Access key ID, secret access key, region (for example `us-east-1`) | Access key ID, secret access key |
| Google Cloud | Service account key (the JSON key file's contents), project ID | Service account key |
| Azure | Tenant ID, client ID, subscription ID, client secret (a service principal) | Client secret |

### What a run receives

| Provider | Variables | Credential |
| --- | --- | --- |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (session token only), `AWS_REGION`, `AWS_DEFAULT_REGION` | A 12-hour session token, or the access keys themselves |
| Google Cloud | `CLOUDSDK_AUTH_ACCESS_TOKEN` (read by `gcloud`), `GOOGLE_OAUTH_ACCESS_TOKEN` (read by Terraform's Google provider), `CLOUDSDK_CORE_PROJECT`, `GOOGLE_CLOUD_PROJECT` | A 1-hour access token |
| Azure | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`, and the same four as `ARM_TENANT_ID`, `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_SUBSCRIPTION_ID` (read by Terraform's Azure provider) | The client secret |

No other variable can be added for a cloud account. Nothing is written to disk: no credentials file, no config file, no cache. The values exist only in The Terminal's memory and in the environment of the run that was given them.

- **AWS.** When the run starts, The Terminal asks AWS for a session token that lasts 12 hours (`GetSessionToken`), and the run receives that instead of your keys. Some keys may not ask for a session token: if AWS answers `AccessDenied` (or another permission refusal that is not about the keys themselves), the run receives your access keys, and the ledger records that it got the access keys rather than a session token. If AWS rejects the keys, refuses the request as invalid (`ValidationError` or `InvalidParameterValue`), is throttling requests or cannot be reached, the run does not start. Credentials and the endpoint are never read from `~/.aws` or the environment: The Terminal passes the stored keys and region itself and always calls the region's own STS address. The AWS SDK may still read other settings from there, such as its retry mode.
- **Google Cloud.** The Terminal signs a request with the service account key and asks Google for a 1-hour access token, and the run receives the token, never the key. What the token can do is what the service account's roles allow. If your Gemini connection sets no Google Cloud project, a Google Cloud grant's project is also the one Gemini CLI itself uses. Programs that need a credentials *file* (`GOOGLE_APPLICATION_CREDENTIALS`, as Google's client libraries and Application Default Credentials expect) are not served in this version, because giving them one would mean writing the key to disk.
- **Azure.** The run receives the client secret itself, with no exchange, because the Azure SDKs and Terraform's Azure provider need the secret rather than an access token. Limit what the service principal may do in Azure; the secret does not expire on The Terminal's side.

A run that lasts longer than its token loses access when the token expires: 12 hours for an AWS session token, 1 hour for Google Cloud. Start the run again to get a fresh token.

### Why AWS profiles are not offered

The Terminal does not read profiles from `~/.aws`. Using a profile would mean reading files that other tools own and may share with other accounts, and some profiles run a program or a browser sign-in to get their keys (`credential_process`, SSO). Keys from a profile would also live outside the keychain, where The Terminal cannot vouch for them. Create an access key for The Terminal and add it as a connection instead.

## Giving a run access

When you start an agent, the Agents panel lists your enabled cloud accounts and MCP servers under **Give this run access to**. Nothing is passed unless you tick it. A disabled connection is not offered, and the server refuses a connection that is disabled, unknown or of the wrong kind.

If credentials for a ticked cloud account cannot be had, the run does not start and the panel names the connection. Codex and Gemini runs cannot be given MCP servers, so their MCP boxes are greyed out with a note.

For each connection a run receives, the ledger records one line, with the connection's name and never a value:

- `Agent <id> was given a 12-hour AWS session token from "<name>"`
- `Agent <id> was given the AWS access keys (no session token available) from "<name>"`
- `Agent <id> was given a 1-hour Google Cloud token from "<name>"`
- `Agent <id> was given the Azure client secret from "<name>"`
- `Agent <id> was given the MCP server "<name>"`

The ledger entry for a cloud credential also records when it expires, if it does.

### Codex commands and cloud accounts

Codex normally hides variables whose names contain `KEY`, `SECRET` or `TOKEN` from the commands it runs, which would hide the cloud variables too. When a Codex run is given a cloud account, The Terminal sets Codex's command environment policy to an include-only list: the allowlisted variables above, the git settings and the cloud account's own variables, with every provider API key excluded. If your own Codex configuration sets `filters` in `shell_environment_policy`, Codex refuses to combine it with this policy and the run fails with a message saying so. Remove `filters` from your Codex configuration to give Codex runs cloud accounts.

## MCP servers

An MCP server gives an agent extra tools. You can have as many MCP connections as you like (**Add another** in the Connections view). There are two kinds:

| Kind | Field | Where it lives |
| --- | --- | --- |
| Local (stdio): a program started on your computer | Command | Keychain (shown in the editor, never in the ledger). Appears on Claude Code's command line: no credentials here |
| | Arguments, one per line | Keychain (shown in the editor, never in the ledger). Appears on Claude Code's command line: no credentials here |
| | Environment variables, `NAME=value` per line | Keychain only |
| Remote (http): a server reached over HTTP | URL | Ledger and API. Appears on Claude Code's command line: no credentials here |
| | Headers, `Name=value` per line | Keychain only |

A local server's command and arguments, and a remote server's URL, appear on Claude Code's command line when a run uses the server, so never put a credential in them: put it in an environment variable or a header. A remote server's URL must use https (or http to this computer only), and a URL with a user name, a password, a query string or a fragment is refused, because the URL is kept in the ledger: put credentials in a header. Environment variable and header values of 8 or more characters are also redacted from agent output.

The Terminal never starts an MCP server itself. It hands the server's description to the agent program for the run you ticked it for, and the agent program starts or contacts the server. Every tool call to an MCP server goes through the approval gate and asks you first. Agents see each server under a name made from its connection id, `tt-xxxxxxxx` (for example, a tool appears as `mcp__tt-xxxxxxxx__<tool>`), not the name you gave it.

### MCP servers with Claude

MCP servers work with Claude only in this version.

- **Environment variable and header values never go on the command line.** The values in an MCP connection's environment variables and headers reach Claude Code through its environment, and its MCP configuration refers to them by name, as `${TT_MCP_<n>_<m>}`. A program's environment is harder to read than a command line, which any local user can list. The command, arguments and URL do appear on Claude Code's command line, so credentials belong in environment variables or headers.
- **A local (stdio) MCP server sees more than its own values.** Claude Code starts it with Claude Code's own environment: the Anthropic API key in API key mode, the variables of any cloud account given to the run, and the `TT_MCP_` values of every other MCP server in the run. Prefer a remote (http) MCP server for a connection that carries a secret: it receives only its own headers.
- **No `${` in MCP fields.** Claude Code reads `${NAME}` in an MCP server's command, arguments, URL, environment variables and headers as a reference to one of its own variables, with no way to escape it. The Terminal refuses `${` in those fields.
- **One server name per run.** If two selected connections would get the same server name, the run is refused; untick one of them.

### Why Codex and Gemini cannot use them

- **Codex** gives no approval step for MCP tool calls under the strict policy The Terminal runs it with, so an MCP tool call could not be shown to you for approval first. Rather than skip the approval, The Terminal does not offer MCP servers to Codex.
- **Gemini CLI** starts MCP servers only in a trusted folder, and The Terminal never trusts an agent's worktree: trusting it would also load settings, a `.env` file and hooks that a repository could plant there. Rather than trust the worktree, The Terminal does not offer MCP servers to Gemini.

A Codex or Gemini run that is sent an MCP server is refused before it starts.

## GitHub view

The GitHub view shows one repository: its branches, open pull requests and recent CI runs. The status bar's `CI` item shows the state of the latest run. To use it, add a GitHub connection with a fine-grained personal access token that has read access to the repository, and set the repository as `owner/name`.

The view is read-only. The Terminal makes four `GET` requests to `api.github.com` for the repository, and nothing else:

- the repository itself
- its branches (up to 100)
- its open pull requests (up to 50)
- its 10 most recent GitHub Actions runs

Only the fields the view shows are kept: no logins, emails or pull request bodies. Links in the view go to `github.com` only; a response with a link anywhere else is refused.

Answers are cached for 30 seconds. After that, The Terminal asks again with the ETag of each previous answer, so an unchanged answer does not count against your GitHub rate limit. If GitHub is rate-limiting requests, The Terminal waits until the limit resets and shows the last loaded data with the note `Showing the last loaded data; GitHub is rate-limiting requests.` If GitHub cannot be reached or rejects the token, the status bar shows `CI: unknown`; the rest of The Terminal is not affected.

## Capacity

The Capacity view shows, for each AI provider, the runs, cost and tokens today and this month, the plan and monthly budget you entered in the provider's connection, and the rate limits observed in the last 24 hours. It also shows what this computer has.

### What the labels mean

- A figure marked `estimate` is not the provider's own number: it was computed by The Terminal or by the agent program.
- `not reported` means the provider did not report that figure. It is never shown as `0`.

What each provider reports:

| Provider | Cost | Tokens |
| --- | --- | --- |
| Claude | An estimate, from the Claude Agent SDK | As reported |
| Codex | Not reported | As reported |
| Gemini | Not reported | Not reported |

Token counts are as the provider reports them. They are not comparable across providers: each provider counts differently.

### Rate limits

Rate limits are inferred: The Terminal counts the runs that hit a rate-limit error (a provider's rate-limit signal, an HTTP 429, or error text that reads as a rate limit), counting each run once. The counts are what The Terminal observed, not a quota the provider published, so they are labelled `estimate`. Figures from the providers themselves, such as remaining quota, are not shown yet.

### This computer

**Detect this computer** in the Capacity side bar records the CPU model and core count, memory, the first GPU and its memory. It runs only when you press it. Only model names and amounts are recorded, never a serial number, host name or user name.

- On macOS it runs `system_profiler SPDisplaysDataType -json` (always from `/usr/sbin/system_profiler`) to find the GPU. On Apple silicon the GPU memory shown is the memory it shares with the CPU.
- On Windows and Linux it runs `nvidia-smi` if it is installed, to find an NVIDIA GPU and its memory. `nvidia-smi` is looked up through the PATH of The Terminal's server process (on Windows, the NVIDIA driver's folder under `SystemRoot` is also tried), so a copy earlier on that PATH is the one that runs.
- Each program is started directly with fixed arguments, never through a shell. A program that fails or is missing leaves its fields empty.
- Inside WSL, the GPU is the Windows machine's, and the view says so.

Detection writes a `This computer` connection with the results. You can turn it off or remove it in the Connections view; the next detection writes it again.
