# Plan 5B: Cloud Accounts, Scoped Credentials, GitHub View, MCP Through the Gate, Capacity Implementation Plan

**Goal:** The Owner connects their AWS, Google Cloud and Azure accounts, their GitHub repository and their MCP servers in the Connections view, and gives a run exactly the connections it needs: cloud credentials arrive as short-lived tokens through the allowlisted environment, MCP servers arrive through the agent CLI's own configuration with every tool call stopped at the existing gate, and every grant is recorded. The GitHub view shows branches, pull requests and CI runs read-only, with a live `CI` item in the status bar. The Capacity view shows what each provider and this computer can do, with every estimated number labelled `estimate`.

**Architecture:**
- The connection catalog gains fields for `aws`, `gcp`, `azure`, `mcp_stdio`, `mcp_http` and `local_hardware`, and `plan` / `monthlyBudgetUsd` fields for the three model providers. Nothing changes in how fields are stored: secrets and private values in the keychain, config in the ledger. Two new field shapes: `input: "number"` (validated as a non-negative decimal) and `format: "pairs"` (a multiline secret of `NAME=value` lines whose individual values join the redaction set).
- `POST /api/projects/:id/runs` gains `connectionIds`. `ConnectionService.selectForRun(ids)` checks each id (exists, enabled, kind `cloud` or `mcp`) and returns the sources. Before the worktree exists, the runner mints a `CloudGrant` per cloud connection (`packages/core/src/connections/cloud/`): AWS `GetSessionToken` (12 h) through `@aws-sdk/client-sts` with the static keys as the recorded fallback, a GCP access token (1 h) from an RS256 JWT signed with `node:crypto`, and the Azure client secret itself. Grants become `RunCredentials.env`, which `buildChildEnv` admits through a fixed `CLOUD_ENV_ALLOWLIST`. Minted values join the run's redaction set. No credentials file is written in this plan.
- MCP connections become `McpServerSpec`s named `tt-<8 chars of the connection id>`. Claude gets them as `Options.mcpServers` under the existing `strictMcpConfig: true`; its `mcp__*` tools already reach the PreToolUse gate and ask. Gemini gets them in `session/new`'s `mcpServers`, `--allowed-mcp-server-names` lists exactly those names, and the per-run policy adds an `ask_user` rule per server (verified against gemini-cli 0.68.0: MCP tools are named `mcp_<server>_<tool>`, and a rule's `mcpName` matches the server). Codex runs refuse MCP connections.
- GitHub: a `GitHubClient` over plain `fetch` with an in-memory ETag cache serves `GET /api/github/overview` and the `ci` field of `/api/status`. Read-only; no octokit.
- Capacity: `GET /api/capacity` aggregates `agent_runs` cost and token columns per provider for today and this month, joins the Owner's plan and budget from the llm connections, counts rate-limit events the adapters observed (`agent.rate_limited`, a new ledger event with a projection table), and reports the `local_hardware` connection that `POST /api/capacity/detect` writes from `os` plus `execFile` probes (`system_profiler` on Apple Silicon, `nvidia-smi` elsewhere). Every number that is not a provider's own figure carries `basis: "estimate"`.
- Test doubles stay behind `THETERMINAL_FAKE_AGENT=1`: `THETERMINAL_FAKE_HTTP=1` now also selects a fake STS caller and answers the GCP, Azure and GitHub endpoints.

**Tech Stack:** existing stack, plus `@aws-sdk/client-sts` **3.1161.0** (Apache-2.0, Node ≥ 20, published 2026-10-30, the newest release at least two weeks old on 2026-11-15; `npm view @aws-sdk/client-sts time` has 3.1162.0 on 2026-11-04 and daily releases after). The client is always constructed with explicit `credentials` and `region`, so its default provider chain never reads the Owner's `~/.aws` or environment. GCP and Azure use the global `fetch`; the GCP JWT is signed with `node:crypto`'s `createSign("RSA-SHA256")`. No cloud CLIs, no `@azure/*`, no `google-auth-library`, no octokit.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §2 goal 4 (connect anything) and goal 7 (plug-and-play), §4.3 (panels: connections, capacity), §4.5 (collaborators use connections through the workspace), §5 (ledger completeness), §6 (capacity, router and scheduler groundwork), §7 core item 5 (connections) and 6 (capacity), §8 (credentials stay with the Owner, official APIs), §10.2 (mediate every action: MCP tool calls included), §10.3 (estimates labelled), §10.4 (Windows/WSL note for detection). Builds on Plan 5A (`docs/plans/2026-11-14-plan-5a-connections-shell.md`), whose final section is this plan's outline. The router and scheduler of §6 stay out of scope: this plan builds the inventory and the panel they will read.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Fakes contain `TESTKEY` (`AKIATESTKEY000000000`, `TESTKEY-azure-secret-0000000000`); GCP fixtures sign with a key pair generated in the test. No account ids, subscription ids, project ids or repository names of real accounts anywhere.
- **Every new route sits behind the default-deny auth** (`registerAuth`): `/api/github/*`, `/api/capacity*` and the extended run route answer 401 without the cookie or bearer token.
- **Secrets live only in the keychain and in the process that needs them.** Minted tokens (AWS session token, GCP access token) exist in the server's memory and the run's environment only; they are never written to a file, the ledger, the database or an API response. The ledger records that a run was given credentials, which kind, and when they expire, never the values.
- **Every child env is built by `buildChildEnv`.** Cloud variables enter only through `extraEnv`, only when named in `CLOUD_ENV_ALLOWLIST`; a name outside it is a programming error that throws before the CLI starts.
- **No `shell: true`.** Hardware detection and every probe use `execFile` with argument arrays. The Terminal never spawns an MCP server itself: the agent CLI does, from the spec we hand it.
- **Redact before truncating; redaction is live.** Minted values are added to the run's secret list before the adapter starts; `clean()` sees them on every call.
- **Fail closed.** A cloud provider that cannot be reached at run start fails the start (nothing recorded as running); a disabled, unknown or wrong-kind connection id is refused before anything is minted; a Codex run with an MCP connection is refused; a GitHub failure never breaks `/api/status` (`ci.state: "unknown"`); a probe that fails leaves that hardware field null and never throws.
- **Labels are honest.** A figure that is not the provider's own carries `basis: "estimate"` and the UI shows the word `estimate` next to it; a provider that reports nothing shows `not reported`, never `0`.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`:** the fake STS caller, the extended fake HTTP and the fake hardware detector are ignored otherwise.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-5b-cloud-github-mcp-capacity`, one commit per task, pushed when it lands, and merges through a pull request once CI is green on macOS and Windows. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1/2/2B/5A constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, 127.0.0.1 bind, every action gated before it runs, allowlisted child env, keychain-only secrets, live redaction).

## Review Focus

1. **A minted token leaving through the run record.** A run is given AWS, GCP and Azure credentials and its shell step prints its whole environment. Expected: the completed-action output and every ledger payload show `[REDACTED]` for the session token, the GCP access token, the static keys and the client secret, although the minted values were never stored in a connection. (Tests in Task 3.)
2. **Credentials a run was not given.** AWS and Azure connections exist and are enabled; a run starts with `connectionIds: []` or without the field. Expected: its environment holds no `AWS_*`, `AZURE_*`, `ARM_*`, `CLOUDSDK_*` or `GOOGLE_*` variable; a run naming a disabled connection is refused with 400 `connection_disabled` and no `connection.used` is recorded; a removed id → 404. (Tests in Task 3.)
3. **A cloud provider down at run start.** STS times out or the GCP token endpoint answers 500. Expected: `POST /api/projects/:id/runs` answers 502 `cloud_credentials_failed` within the 10 s timeout, no `agent.started` and no `connection.used` are recorded, no worktree is created, and the UI shows `Could not get credentials from "<name>". The run did not start.` (Tests in Task 3.)
4. **A GitHub token without access, or rate-limited.** The overview is requested for a repository the token cannot see (404), then under a 403 with `x-ratelimit-remaining: 0`. Expected: `{ error: "repo_not_found" }` 404 and the side bar copy `Repository not found, or the token has no access to it`; on the rate limit the last good overview is served with `stale: true`, `/api/status` keeps answering with `ci.state: "unknown"`, and no second request goes out before the cache window ends. (Tests in Task 4.)
5. **An MCP tool call that bypasses the gate.** Gemini reports a tool call named `mcp_tt-abc12345_list` as in progress without a `session/request_permission`; Claude calls `mcp__tt-abc12345__list`. Expected: Gemini's run fails with the existing ungated-tool detector and the call is recorded as denied; Claude's call is recorded as kind `mcp` with summary `MCP tool list on tt-abc12345` and asks a human; an MCP connection whose derived server name is not `tt-` plus eight `[a-z0-9]` characters is never handed to a CLI. (Tests in Task 5.)

---

## File Structure

```
packages/shared/src/connections.ts            # (modify) cloud/mcp/hardware fields, number + pairs inputs, connection.used purpose/credential (Task 1)
packages/shared/src/agents.ts                 # (modify) agent.rate_limited payload (Task 1)
packages/shared/src/events.ts                 # (modify) EventType gains agent.rate_limited (Task 1)
packages/shared/src/github.ts                 # GitHubOverview, CiStatus types (Task 1)
packages/shared/src/capacity.ts               # CapacityReport, HardwareInfo types (Task 1)
packages/shared/src/index.ts                  # (modify)

packages/core/src/connections/service.ts      # (modify) number/pairs validation, pair values in seen, selectForRun, githubSource, budgets (Task 1)
packages/core/src/connections/mcp.ts          # mcpServerName, parsePairs, McpServerSpec, toMcpSpec (Task 1)
packages/core/src/connections/cloud/aws.ts    # StsCaller, realSts (client-sts), fakeSts (Task 2)
packages/core/src/connections/cloud/gcp.ts    # service-account schema, signJwt, fetchGcpToken (Task 2)
packages/core/src/connections/cloud/azure.ts  # fetchAzureToken (Task 2)
packages/core/src/connections/cloud/grant.ts  # CloudGrant, mintCloudGrant, CloudCredentialError, CLOUD_ENV_ALLOWLIST (Task 2)
packages/core/src/connections/testers.ts      # (modify) cloudTesters(sts) for aws/gcp/azure (Task 2)
packages/core/src/agents/child-env.ts         # (modify) extraEnv through CLOUD_ENV_ALLOWLIST (Task 3)
packages/core/src/agents/adapter.ts           # (modify) RunCredentials.env/mcpServers, rate_limited event (Tasks 3, 5, 6)
packages/core/src/agents/runner.ts            # (modify) connectionIds, grants, per-run secrets, connection.used, rate_limited (Tasks 3, 5, 6)
packages/core/src/agents/claude-adapter.ts    # (modify) extraEnv, mcpServers, mcp summaries, rate limit (Tasks 3, 5, 6)
packages/core/src/agents/codex/adapter.ts     # (modify) extraEnv, rate limit (Tasks 3, 6)
packages/core/src/agents/gemini/adapter.ts    # (modify) extraEnv, mcpServers in session/new, args, policy rules, rate limit (Tasks 3, 5, 6)
packages/core/src/github/client.ts            # GitHubClient with ETag cache, overview, ciStatus (Task 4)
packages/core/src/server/github-routes.ts     # GET /api/github/overview (Task 4)
packages/core/src/capacity/hardware.ts        # detectHardware via execFile, fakeHardware (Task 6)
packages/core/src/capacity/report.ts          # capacityReport(db, service, now) (Task 6)
packages/core/src/server/capacity-routes.ts   # GET /api/capacity, POST /api/capacity/detect (Task 6)
packages/core/src/server/agent-routes.ts      # (modify) connectionIds in the run body (Task 3)
packages/core/src/server/connection-routes.ts # (modify) /api/status ci, monthCostUsd, monthlyBudgetUsd (Tasks 4, 6)
packages/core/src/server/routes.ts            # (modify) error map (Tasks 3, 4)
packages/core/src/server/server.ts            # (modify) selectSts, fake http endpoints, github client, capacity deps (Tasks 2, 4, 6)
packages/core/src/events/projections.ts       # (modify) rate_limits reducer, month cost (Task 6)
packages/core/src/db.ts                       # (modify) migration 6: rate_limits (Task 6)
packages/core/src/index.ts                    # (modify)

apps/ui/src/api.ts                            # (modify) startRun connectionIds, github, capacity (Tasks 3, 4, 6)
apps/ui/src/components/AgentPanel.tsx         # (modify) "Give this run access to" picker (Task 3)
apps/ui/src/views/ConnectionEditor.tsx        # (modify) number and multiline inputs, Codex MCP note (Tasks 1, 5)
apps/ui/src/views/GitHubSideBar.tsx           # repo, branches, PRs, CI runs (Task 4)
apps/ui/src/views/CapacitySideBar.tsx         # per-source bars, Detect button (Task 6)
apps/ui/src/views/CapacityPanel.tsx           # main tab "Capacity" (Task 6)
apps/ui/src/shell/{SideBar,Dock,Workbench,StatusBar}.tsx, shell/model.ts  # (modify) new views, panel id, CI and budget items (Tasks 4, 6)
apps/ui/src/components/LedgerPanel.tsx        # (modify) describeEntry for new purposes and agent.rate_limited (Tasks 3, 5, 6)
docs/connections-and-credentials.md           # (modify) cloud, MCP, GitHub, capacity sections (Task 7)
e2e/cloud.spec.ts, e2e/github.spec.ts, e2e/mcp.spec.ts, e2e/capacity.spec.ts, e2e/global-setup.ts  # (Task 8)
```

---

### Task 1: Catalog, schemas and service rules for cloud, MCP and hardware connections

**Files:** Modify `packages/shared/src/connections.ts`, `agents.ts`, `events.ts`, `index.ts`; create `packages/shared/src/github.ts`, `capacity.ts`, `packages/core/src/connections/mcp.ts`; modify `packages/core/src/connections/service.ts`, `apps/ui/src/views/ConnectionEditor.tsx`. Tests `packages/shared/test/connections.test.ts`, `packages/core/test/connections/{service,mcp}.test.ts`, `apps/ui/test/ConnectionEditor.test.tsx`.

**Interfaces:**
```ts
// shared/connections.ts
export type ConnectionField = { …; input: "text" | "password" | "path" | "url" | "multiline" | "number"; format?: "pairs"; pattern?: string; help?: string };
// format "pairs": only with storage "secret" and input "multiline"; NAME=value lines. pattern: a RegExp source the whole value must match
export const connectionPayloadSchemas["connection.used"] = z.object({ connectionId, name, runId,
  purpose: z.enum(["api_key", "cli_home", "cloud_credentials", "mcp_server"]),
  credential: z.enum(["aws_session_token", "aws_static_keys", "gcp_access_token", "azure_client_secret"]).optional(),
  expiresAt: z.string().datetime().nullable().optional() }).strict();
// shared/agents.ts
"agent.rate_limited": z.object({ runId: id, retryAfterS: z.number().int().nonnegative().nullable() }).strict()
// shared/github.ts
export type CiState = "passing" | "failing" | "running" | "unknown";
export type CiStatus = { state: CiState; url: string | null; branch: string | null; updatedAt: string | null };
export type GitHubOverview = { repo: { fullName: string; defaultBranch: string; htmlUrl: string; private: boolean };
  branches: { name: string; isDefault: boolean }[];
  pulls: { number: number; title: string; headRef: string; baseRef: string; draft: boolean; htmlUrl: string; updatedAt: string }[];
  ciRuns: { id: number; name: string; status: string; conclusion: string | null; headBranch: string; htmlUrl: string; updatedAt: string }[];
  ci: CiStatus; fetchedAt: string; stale: boolean };
// shared/capacity.ts
export type Basis = "reported" | "estimate" | "not_reported";
export type Figure = { value: number | null; basis: Basis };
export type UsageWindow = { runs: number; costUsd: Figure; inputTokens: Figure; outputTokens: Figure };
export type CapacitySource = { provider: Provider; connectionId: string | null; name: string; mode: AuthMode;
  plan: string | null; monthlyBudgetUsd: number | null; today: UsageWindow; month: UsageWindow;
  rateLimits: { last24h: number; lastAt: string | null; basis: "estimate" } };
export type HardwareInfo = { cpu: string | null; cores: number | null; memoryGb: number | null; gpu: string | null; gpuMemoryGb: number | null;
  platform: "darwin" | "win32" | "linux"; wsl: boolean; detectedAt: string };
export type CapacityReport = { sources: CapacitySource[]; hardware: HardwareInfo | null; generatedAt: string };
```
Catalog (all `available: true`; `single` as noted; new fields in this order):
- `claude`, `codex`, `gemini` gain `plan` (config/text, label `Plan`, help `What you pay for, in your words: "Max 5x", "Plus", "pay per use". Shown in Capacity.`) and `monthlyBudgetUsd` (config/number, label `Monthly budget (USD)`, help `Capacity shows this month's spend against it.`).
- `github` gains `repo` (config/text, label `Repository`, help `owner/name of the repository the GitHub view shows.`). Validation: `/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/`.
- `aws` (cloud, `single: false`, description `Amazon Web Services account, through an IAM access key.`): `accessKeyId` (secret/password, required, label `Access key ID`), `secretAccessKey` (secret/password, required, label `Secret access key`), `region` (config/text, required, label `Region`, help `For example us-east-1.`; validation `/^[a-z]{2}(-[a-z]+)+-\d$/`). The outline's `profile` field is **not** added (see the header: it would let a run read every profile in the Owner's `~/.aws`, and testing it needs a second AWS package).
- `gcp` (cloud, `single: false`, `Google Cloud`, `Google Cloud project, through a service account key.`): `serviceAccountJson` (secret/multiline, required, label `Service account key (JSON)`, help `The JSON key file's contents. Stored in your keychain in pieces.`), `project` (config/text, required, label `Project ID`; `/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/`).
- `azure` (cloud, `single: false`, `Azure`, `Microsoft Azure subscription, through a service principal.`): `tenantId`, `clientId`, `subscriptionId` (config/text, required; each a UUID `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`), `clientSecret` (secret/password, required).
- `mcp_stdio` (mcp, `single: false`, `MCP server (local)`, `A local MCP server the agent's program starts for the run.`): `command` (private/text, required, label `Command`, help `The program to start, for example npx or an absolute path. Never run through a shell.`), `args` (private/multiline, label `Arguments`, help `One argument per line.`), `env` (secret/multiline, `format: "pairs"`, label `Environment variables`, help `NAME=value, one per line. Stored in your keychain.`).
- `mcp_http` (mcp, `single: false`, `MCP server (remote)`, `A remote MCP server over HTTP.`): `url` (config/url, required, label `URL`; must parse as `https:` URL, or `http:` only for `localhost` / `127.0.0.1`), `headers` (secret/multiline, `format: "pairs"`, label `Headers`, help `Name=value, one per line, for example Authorization=Bearer …`).
- `local_hardware` (hardware, `single: true`, `This computer`, `What this computer can run. Filled in by detection.`): config fields `cpu`, `cores`, `memoryGb`, `gpu`, `gpuMemoryGb`, `platform`, `wsl`, `detectedAt`, none required, all `input: "text"`; the editor renders them read-only with the note `Filled in by detection. Use Detect this computer in the Capacity view.`

```ts
// core/connections/mcp.ts
export const MCP_SERVER_NAME = /^tt-[a-z0-9]{8}$/;
export function mcpServerName(connectionId: string): string;    // "tt-" + first 8 of connectionId.toLowerCase().replace(/[^a-z0-9]/g, ""); throws RangeError if fewer than 8 remain
export function parsePairs(text: string, kind: "env" | "headers"): Record<string, string>; // blank lines skipped; env names /^[A-Za-z_][A-Za-z0-9_]*$/, header names /^[A-Za-z0-9-]+$/; value = everything after the first "="; a bad line → ZodError at path [kind, lineNumber]
export type McpServerSpec = { serverName: string; connectionId: string; name: string } &
  ({ transport: "stdio"; command: string; args: string[]; env: Record<string, string> } | { transport: "http"; url: string; headers: Record<string, string> });
export function toMcpSpec(conn: Connection, values: Record<string, string>): McpServerSpec; // args split on \n, blank lines dropped
// core/connections/service.ts
export class ConnectionDisabledError extends Error {}      // "connection is disabled"
export class UnsupportedConnectionError extends Error {}   // "this connection cannot be given to a run" (kind llm/github/hardware)
export type CloudSource = { connectionId: string; name: string; provider: "aws" | "gcp" | "azure"; config: Record<string, string>; secrets: Record<string, string> };
export type RunSelection = { cloud: CloudSource[]; mcp: McpServerSpec[] };
export type GitHubSource = { connectionId: string; token: string; repo: string } | null;
export type Budget = { connectionId: string; provider: Provider; name: string; plan: string | null; monthlyBudgetUsd: number | null };
class ConnectionService { …
  selectForRun(ids: string[]): RunSelection;   // sync, from the cache; NotFoundError / ConnectionDisabledError / UnsupportedConnectionError; duplicates collapsed; order preserved
  githubSource(): GitHubSource;                // the enabled github connection with a token and a repo, else null
  budgets(): Budget[];                         // one per enabled llm connection
}
```
Service rules:
- `input: "number"` values must match `/^\d{1,9}(\.\d{1,2})?$/`; `input: "url"` must parse; the catalog patterns above are checked in `checkValues`/`checkConfig` through a new optional `ConnectionField.pattern?: string` (a RegExp source) so the catalog, not the service, owns them. A failure is a `ZodError` at the field's path (400 `invalid_input`, no value echoed).
- `format: "pairs"`: `parsePairs` runs on add/update (a bad line is refused before any keychain write) and on `load()`; every value of ≥ 8 characters is added to `seen`, so `secretValues()` redacts each header or variable value on its own, not only the whole blob.
- `selectForRun`: an id of kind `llm`, `github` or `hardware` → `UnsupportedConnectionError`; `enabled = 0` → `ConnectionDisabledError`; `keychainState() !== "ok"` → `SecretStoreUnavailableError` (a run must not start with half its secrets).
- The `local_hardware` entry is written only by the detector (Task 6): `add`/`update` from the API for provider `local_hardware` → `UnsupportedConnectionError` (`"this connection is managed by detection"`); `remove` is allowed.
- Editor: `input: "number"` → `<input type="number" min="0" step="0.01">`; `input: "multiline"` → `<textarea rows={4}>` (secrets too: a stored multiline secret shows the placeholder `Stored in your keychain` and the `Replace` button like a password field); `private` multiline likewise a textarea.

- [ ] **Step 1: Write failing tests:**
  - shared: every new provider's fields belong to its kind; `connection.used` accepts `purpose: "mcp_server"` and `credential: "aws_session_token"`, rejects `credential: "password"`; `agent.rate_limited` accepts `retryAfterS: null`; config keys `tenantId`, `clientId`, `subscriptionId`, `region`, `project`, `repo`, `plan`, `monthlyBudgetUsd` pass `connectionConfigSchema`;
  - mcp: `mcpServerName("3f9a2c1e-…")` is `tt-3f9a2c1e` and matches `MCP_SERVER_NAME`; `parsePairs("A=1\n\nB=x=y", "env")` is `{ A: "1", B: "x=y" }`; `parsePairs("bad line", "env")` throws at path `["env", 1]`; `parsePairs("X-Token=abc", "headers")` works and `parsePairs("Bad Name=1", "headers")` throws;
  - service: adding `aws` with `region: "us-east-1"` and both keys stores two keychain entries and `list()` shows `secretFields: ["accessKeyId", "secretAccessKey"]`; `region: "nowhere"` → ZodError at `["config", "region"]`; `monthlyBudgetUsd: "12.345"` → ZodError; `"50"` accepted; a second `aws` connection is allowed (`single: false`); `mcp_http` with `headers: "Authorization=Bearer TESTKEY-hdr-0000000000"` → `secretValues()` contains `Bearer TESTKEY-hdr-0000000000`; after `load()` on a fresh service it still does;
  - `selectForRun([awsId, mcpId])` returns one `CloudSource` (with the secrets) and one `McpServerSpec` (`serverName` `tt-…`, `transport: "http"`, headers parsed); `[claudeId]` → `UnsupportedConnectionError`; a disabled id → `ConnectionDisabledError`; an unknown id → `NotFoundError`; a failing store → `SecretStoreUnavailableError`;
  - `githubSource()` is null without a `repo`, then `{ token, repo }` after `config: { repo: "octo/example" }`; `budgets()` returns `monthlyBudgetUsd: 50` as a number and `plan` as given;
  - `add` for `local_hardware` through the service → `UnsupportedConnectionError`;
  - editor: a `number` field renders `type="number"`; `serviceAccountJson` renders a textarea that is empty with placeholder `Stored in your keychain` when stored.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(connections): catalog fields for cloud accounts, MCP servers and hardware; run selection rules`

---

### Task 2: Cloud testers and short-lived credential grants

**Files:** Create `packages/core/src/connections/cloud/{aws,gcp,azure,grant}.ts`. Modify `packages/core/src/connections/testers.ts`, `packages/core/src/server/server.ts` (`selectSts`, fake HTTP endpoints), `packages/core/package.json` (`@aws-sdk/client-sts` 3.1161.0, exact). Tests `packages/core/test/connections/cloud/{aws,gcp,azure,grant}.test.ts`, `testers.test.ts`, `server.test.ts`.

**Interfaces:**
```ts
// cloud/aws.ts
export type StaticKeys = { accessKeyId: string; secretAccessKey: string; region: string };
export type StsCaller = {
  callerIdentity(keys: StaticKeys, signal: AbortSignal): Promise<{ arn: string }>;
  sessionToken(keys: StaticKeys, durationS: number, signal: AbortSignal): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string }>;
};
export const realSts: StsCaller;   // new STSClient({ region, credentials: { accessKeyId, secretAccessKey } }); GetCallerIdentityCommand / GetSessionTokenCommand with { abortSignal: signal }
export const fakeSts: StsCaller;   // accepts keys whose accessKeyId contains "TESTKEY"; otherwise throws an error with name "InvalidClientTokenId"; sessionToken returns "FQoGZXIvYXdzTESTKEY-session-0000000000" expiring in durationS
export class AwsRejectedError extends Error {}  // the SDK error named InvalidClientTokenId, SignatureDoesNotMatch, AccessDenied, ExpiredToken, UnrecognizedClientException
// cloud/gcp.ts
export const serviceAccountSchema; // z.object({ type: z.literal("service_account"), project_id, client_email: z.string().email().endsWith(".iam.gserviceaccount.com"), private_key: PEM beginning "-----BEGIN PRIVATE KEY-----", token_uri: z.literal("https://oauth2.googleapis.com/token") }).passthrough()
export const GCP_SCOPE_READ = "https://www.googleapis.com/auth/cloud-platform.read-only";
export const GCP_SCOPE_FULL = "https://www.googleapis.com/auth/cloud-platform";
export function signJwt(sa: ServiceAccount, scope: string, now: Date): string; // header {alg:"RS256",typ:"JWT"}, claims { iss: client_email, scope, aud: token_uri, iat, exp: iat+3600 }, base64url, createSign("RSA-SHA256")
export function fetchGcpToken(sa: ServiceAccount, scope: string, deps: { fetch: typeof fetch; signal: AbortSignal; now?: () => Date }): Promise<{ accessToken: string; expiresAt: string }>;
// POST token_uri, content-type application/x-www-form-urlencoded, grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>; expiresAt = now + expires_in s
// cloud/azure.ts
export const AZURE_SCOPE = "https://management.azure.com/.default";
export function fetchAzureToken(i: { tenantId: string; clientId: string; clientSecret: string }, deps): Promise<{ accessToken: string; expiresAt: string }>;
// POST https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token, form grant_type=client_credentials&client_id&client_secret&scope
// cloud/grant.ts
export type CredentialKind = "aws_session_token" | "aws_static_keys" | "gcp_access_token" | "azure_client_secret";
export type CloudGrant = { env: Record<string, string>; credential: CredentialKind; expiresAt: string | null; secrets: string[] };
export class CloudCredentialError extends Error { constructor(public readonly connectionName: string, message: string) }
export const CLOUD_ENV_ALLOWLIST: readonly string[] = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION",
  "CLOUDSDK_AUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_CORE_PROJECT", "GOOGLE_CLOUD_PROJECT",
  "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID", "ARM_TENANT_ID", "ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_SUBSCRIPTION_ID"];
export const AWS_SESSION_SECONDS = 43200;
export function mintCloudGrant(source: CloudSource, deps: { sts: StsCaller; fetch: typeof fetch; signal: AbortSignal; now?: () => Date }): Promise<CloudGrant>;
```
Grant rules:
- AWS: `sessionToken(keys, 43200)` → env `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION`; `credential: "aws_session_token"`, `expiresAt` from STS, `secrets` = the three temporary values **and** the two static keys. If STS answers `AccessDenied` or a 4xx that is not a rejection of the keys themselves (`GetSessionToken` is refused for some principals), fall back to the static keys: env without `AWS_SESSION_TOKEN`, `credential: "aws_static_keys"`, `expiresAt: null`. An `AwsRejectedError` (bad keys) or a network error / timeout → `CloudCredentialError`.
- GCP: `fetchGcpToken(sa, GCP_SCOPE_FULL)` → env `CLOUDSDK_AUTH_ACCESS_TOKEN`, `GOOGLE_OAUTH_ACCESS_TOKEN` (Terraform's Google provider reads it), `CLOUDSDK_CORE_PROJECT`, `GOOGLE_CLOUD_PROJECT` (both = `config.project`); `credential: "gcp_access_token"`; `secrets` = the token and the service account's `private_key`. No `GOOGLE_APPLICATION_CREDENTIALS`: no file is written in this plan.
- Azure: no exchange at run time. Env `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID` and the `ARM_*` copies (Terraform's azurerm provider); `credential: "azure_client_secret"`, `expiresAt: null`, `secrets: [clientSecret]`.
- Every grant's `env` keys are a subset of `CLOUD_ENV_ALLOWLIST` (asserted by a test over all three providers).

Testers (`cloudTesters(sts: StsCaller): Partial<Record<ConnectionProvider, ConnectionTester>>`, merged into the testers map in `server.ts`); messages reuse 5A's exact strings where they fit:
- aws: `callerIdentity` → `Connected (identity verified)`; `AwsRejectedError` → `Rejected by the provider (<error name>)`; else `Could not reach the provider`. No ARN or account id is recorded.
- gcp: JSON that fails `serviceAccountSchema` → `The key is not a service account JSON`; `fetchGcpToken(sa, GCP_SCOPE_READ)` then `GET https://cloudresourcemanager.googleapis.com/v1/projects/<project>` with `Authorization: Bearer`; 200 → `Connected`; token endpoint 400/401 → `Rejected by the provider (HTTP <status>)`; project GET 403/404 → `The service account cannot see project <project> (HTTP <status>)`; else as 5A.
- azure: `fetchAzureToken` then `GET https://management.azure.com/subscriptions/<subscriptionId>?api-version=2022-12-01`; the same message shapes with `subscription <id>`.
- Missing secret → `No credentials stored`.

`server.ts`: `createServer` gains `sts?: StsCaller`; `selectSts(env, injected)` returns `fakeSts` only under `THETERMINAL_FAKE_AGENT=1` with `THETERMINAL_FAKE_HTTP=1`. The fake `fetch` gains, in this order: POST to `https://oauth2.googleapis.com/token` or `https://login.microsoftonline.com/<any>/oauth2/v2.0/token` → 200 `{ "access_token": "TESTKEY-access-token-0000000000", "expires_in": 3600, "token_type": "Bearer" }` when the body contains `grant_type=` and (for Azure) `client_secret=` whose value contains `TESTKEY`, else 401; everything else keeps the 5A rule (a header value containing `TESTKEY` → 200 `{}`), extended in Task 4 for GitHub.

- [ ] **Step 1: Write failing tests:**
  - aws: `realSts` builds the client with the given region and explicit credentials (inject the client constructor; assert no `AWS_PROFILE`/env read by passing `credentials` as an object); `fakeSts` rejects a non-TESTKEY key with `InvalidClientTokenId`; the tester maps that to `Rejected by the provider (InvalidClientTokenId)`;
  - gcp: a key pair from `generateKeyPairSync("rsa", { modulusLength: 2048 })` → `signJwt` output verifies with `createVerify("RSA-SHA256")` and its claims are `{ iss, scope, aud, iat, exp: iat + 3600 }`; a JSON missing `private_key` → the exact message, no fetch; the token request body is form-encoded with the assertion; a 500 from the project GET → `Unexpected response (HTTP 500)`;
  - azure: the token POST goes to the tenant URL with `client_credentials` and the subscription GET carries the Bearer; 401 at the token step → `Rejected by the provider (HTTP 401)`;
  - grant: AWS happy path → `credential: "aws_session_token"`, env has the five names, `secrets` has five values; STS `AccessDenied` on GetSessionToken → `aws_static_keys`, env has no `AWS_SESSION_TOKEN`; bad keys → `CloudCredentialError` naming the connection; GCP → four env names and `secrets` includes the private key; Azure → eight names; for every grant `Object.keys(env)` ⊆ `CLOUD_ENV_ALLOWLIST`; `signal` already aborted → `CloudCredentialError` without a request **(Review Focus 3)**;
  - server: `selectSts` ignores the fake outside `THETERMINAL_FAKE_AGENT=1`; the fake fetch answers the two token endpoints as specified; `POST /api/connections/:id/test` for an `azure` connection with `TESTKEY-azure-secret-0000000000` → `Connected`, and the recorded `connection.tested` message holds no secret.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the dependency with an exact version; check `pnpm-lock.yaml` resolves on both CI runners with `--frozen-lockfile`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(connections): test AWS, Google Cloud and Azure accounts; mint short-lived credentials for runs`

---

### Task 3: Scoped credential passing to runs

**Files:** Modify `packages/core/src/agents/child-env.ts`, `adapter.ts`, `runner.ts`, `claude-adapter.ts`, `codex/adapter.ts`, `gemini/adapter.ts`, `packages/core/src/server/agent-routes.ts`, `routes.ts`, `server.ts`, `apps/ui/src/api.ts`, `apps/ui/src/App.tsx`, `apps/ui/src/shell/model.ts`, `apps/ui/src/components/AgentPanel.tsx`, `apps/ui/src/views/AgentsSideBar.tsx`, `apps/ui/src/components/LedgerPanel.tsx`. Tests `packages/core/test/agents/{child-env,runner,claude-adapter,codex-adapter,gemini-adapter}.test.ts`, `packages/core/test/server/agent-routes.test.ts`, `apps/ui/test/{AgentPanel,LedgerPanel}.test.tsx`.

**Interfaces:**
```ts
// child-env.ts
export type ChildEnvOptions = { …; extraEnv?: Record<string, string> };  // every key must be in CLOUD_ENV_ALLOWLIST, else TypeError("variable not allowed for a child: <name>"); applied after the provider key, before the gitconfig check
// adapter.ts
export type RunCredentials = { apiKey?: string; cliHome?: string; googleCloudProject?: string; env: Record<string, string>; mcpServers: McpServerSpec[] };
// runner.ts
export type AgentRunnerDeps = { …; selectConnections?: (ids: string[]) => RunSelection;   // default: ids.length ? throw UnsupportedConnectionError : { cloud: [], mcp: [] }
  mintCloud?: (source: CloudSource, signal: AbortSignal) => Promise<CloudGrant>; grantTimeoutMs?: number /* 10000 */ };
export class McpUnsupportedError extends Error {}  // "Codex cannot use MCP servers in The Terminal yet"
start(actor, input: { projectId; adapter; prompt; cardId?; connectionIds?: string[] })
// agent-routes.ts: startBody gains connectionIds: z.array(z.string().min(1).max(200)).max(10).optional()
```
Runner flow in `start()`, in this order: project, read-only, closing, adapter, prompt and card checks as today → `selection = deps.selectConnections(ids)` (sync; errors propagate before anything is created) → `if (adapter === "codex" && selection.mcp.length) throw new McpUnsupportedError()` → for each `selection.cloud` in order, `grant = await deps.mintCloud(source, AbortSignal.timeout(grantTimeoutMs))`; the first `CloudCredentialError` aborts the start (nothing recorded) → then the worktree, `agent.started`, the 5A `connection.used` for the llm connection, one `connection.used { purpose: "cloud_credentials", credential, expiresAt }` per grant and one `{ purpose: "mcp_server" }` per MCP spec (actor `RUNNER`), then `launch` with `credentials.env = Object.assign({}, ...grants.map(g => g.env))` and `credentials.mcpServers = selection.mcp`. `Session` gains `secrets: string[]` = every grant's `secrets` plus every MCP `env`/`headers` value of ≥ 8 characters; `clean()` and `cleanInput()` use `[...this.secrets(), ...s.secrets]` for that session (and `close()` for its error text) **(Review Focus 1)**.

Adapters pass `extraEnv: o.credentials.env` to every `buildChildEnv` call (both auth modes, all three adapters). Gemini's `PROVIDER_ENV` filter for `terminal/create` commands drops every `GOOGLE_*` name, which would also drop `GOOGLE_CLOUD_PROJECT` and `GOOGLE_OAUTH_ACCESS_TOKEN` from a cloud grant: exempt exactly the names in `CLOUD_ENV_ALLOWLIST` from that filter (`GEMINI_API_KEY` and the rest stay dropped), so a `gcloud` or `terraform` command the Owner approved can authenticate.

Routes: `UnsupportedConnectionError` → 400 `{ error: "connection_unsupported" }`; `ConnectionDisabledError` → 400 `{ error: "connection_disabled" }`; `McpUnsupportedError` → 400 `{ error: "mcp_unsupported" }`; `CloudCredentialError` → 502 `{ error: "cloud_credentials_failed", name: <connection name> }` (the name is ledger-safe: it passed `checkName`). `server.ts` wires `selectConnections: (ids) => connections.selectForRun(ids)` and `mintCloud: (s, signal) => mintCloudGrant(s, { sts, fetch, signal })`.

UI: `api.startRun(projectId, { adapter, prompt, cardId?, connectionIds? })`; `WorkbenchModel.onStartRun(adapter, prompt, connectionIds)`; `AgentPanel` gains, under the prompt, a `fieldset` with legend `Give this run access to` listing every enabled `cloud` and `mcp` connection as a checkbox labelled `<name> (<KIND_LABELS[kind]>)`; when the chosen adapter is `codex`, MCP checkboxes are disabled with the note `Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.`; the fieldset is absent when there is nothing to offer. `errorMessage`: `connection_unsupported` → `That connection cannot be given to a run`; `connection_disabled` → `That connection is disabled`; `mcp_unsupported` → the Codex sentence above; `cloud_credentials_failed` → `Could not get credentials from "<name>". The run did not start.` (the name from the error body; `ApiError` gains an optional `detail` for it).
`describeEntry` for `connection.used`: `cloud_credentials` → `Agent <id8> was given <label> from "<name>"` with label `a 12-hour AWS session token` / `the AWS access keys (no session token available)` / `a 1-hour Google Cloud token` / `the Azure client secret`; `mcp_server` → `Agent <id8> was given the MCP server "<name>"`.

- [ ] **Step 1: Write failing tests:**
  - child-env: `extraEnv: { AWS_ACCESS_KEY_ID: "AKIATESTKEY000000000", AWS_SESSION_TOKEN: "t" }` appears in the result for every provider and mode; `extraEnv: { NPM_TOKEN: "x" }` → `TypeError`; a base holding `AWS_SECRET_ACCESS_KEY` without `extraEnv` → absent **(Review Focus 2)**;
  - runner (fake adapter asserting `o.credentials`): two cloud sources and one MCP spec → `connection.used` ×3 in selection order with the right `purpose`/`credential`/`expiresAt`, `credentials.env` is the merged env, `credentials.mcpServers` has one spec; a message echoing the session token, the static key and an MCP header value is recorded `[REDACTED]` **(Review Focus 1)**; `mintCloud` rejecting with `CloudCredentialError` → `start` rejects, `agent_runs` is empty, no worktree directory exists, no `connection.used` **(Review Focus 3)**; `mintCloud` that never settles → rejects after `grantTimeoutMs: 50`; `connectionIds: []` → no `connection.used` beyond 5A's and `credentials.env` is `{}`; `adapter: "codex"` with an MCP spec → `McpUnsupportedError` before `mintCloud` is called;
  - adapters: each adapter's spawn/query env contains `AZURE_CLIENT_SECRET` from `credentials.env` in both auth modes; Gemini's terminal env for a `gcloud` command keeps `CLOUDSDK_AUTH_ACCESS_TOKEN` and still drops `GEMINI_API_KEY`;
  - routes: `POST …/runs` with a disabled id → 400 `connection_disabled` and no `connection.used`; an llm id → 400 `connection_unsupported`; an unknown id → 404; a `fakeSts` that rejects (inject `sts`) → 502 `cloud_credentials_failed` with `name`, and `GET …/runs` lists nothing **(Review Focus 2, 3)**; 11 ids → 400 `invalid_input`; without a cookie → 401;
  - UI: the picker lists only enabled cloud/mcp connections; with adapter `codex` the MCP box is disabled and the note shows; Start sends `connectionIds: [awsId]`; `describeEntry` strings above.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(agents): runs receive the cloud credentials and MCP servers the Owner selects, through the allowlisted environment`

---

### Task 4: GitHub view and the CI status item

**Files:** Create `packages/core/src/github/client.ts`, `packages/core/src/server/github-routes.ts`, `apps/ui/src/views/GitHubSideBar.tsx`. Modify `packages/core/src/server/{server,connection-routes,routes}.ts`, `apps/ui/src/api.ts`, `App.tsx`, `shell/{model,SideBar,StatusBar}.tsx`. Tests `packages/core/test/github/client.test.ts`, `packages/core/test/server/github-routes.test.ts`, `apps/ui/test/{GitHubSideBar,StatusBar}.test.tsx`.

**Interfaces:**
```ts
// github/client.ts
export class GitHubUnavailableError extends Error {}   // network error, 5xx, or rate limit with no cache
export class GitHubRepoNotFoundError extends Error {}  // 404 on the repository
export class GitHubRejectedError extends Error {}      // 401, or 403 without a rate-limit header
export class GitHubClient {
  constructor(deps: { fetch: typeof fetch; source: () => GitHubSource; now?: () => Date; cacheMs?: number /* 30000 */; timeoutMs?: number /* 10000 */ });
  overview(): Promise<GitHubOverview>;  // the four GETs below, in parallel, with If-None-Match; the result cached per URL with its ETag and body
  ciStatus(): Promise<CiStatus>;        // from the cached or fresh overview; never throws: { state: "unknown", url: null, branch: null, updatedAt: null } on any failure
}
export function ciStatusOf(repo: { defaultBranch }, runs: GitHubOverview["ciRuns"]): CiStatus;
```
Requests (headers as 5A's github tester: `Authorization: Bearer`, `X-GitHub-Api-Version: 2022-11-28`, `Accept: application/vnd.github+json`): `GET /repos/<repo>`, `GET /repos/<repo>/branches?per_page=100`, `GET /repos/<repo>/pulls?state=open&per_page=50`, `GET /repos/<repo>/actions/runs?per_page=10`. Within `cacheMs` of the last good fetch the cached overview is returned without a request; after it, each URL is re-fetched with `If-None-Match` and a 304 keeps the cached body. `ciStatusOf`: the newest run whose `head_branch` is the default branch; `status` `queued`/`in_progress`/`waiting`/`pending` → `running`; `conclusion` `success` → `passing`; `failure`/`timed_out`/`startup_failure`/`action_required` → `failing`; anything else or no run → `unknown`; `url` = that run's `html_url`. On 403 with `x-ratelimit-remaining: 0` (or 429): return the cached overview with `stale: true` if there is one, else throw `GitHubUnavailableError`; do not retry before `x-ratelimit-reset` (or `cacheMs`). Response fields other than the ones in `GitHubOverview` are dropped before caching: no author logins, no emails.

Routes: `GET /api/github/overview` → 200 `GitHubOverview`; no github source → 404 `{ error: "github_not_connected" }`; `GitHubRepoNotFoundError` → 404 `{ error: "repo_not_found" }`; `GitHubRejectedError` → 502 `{ error: "github_rejected" }`; `GitHubUnavailableError` → 503 `{ error: "github_unavailable" }`. `/api/status.ci` becomes `CiStatus | null` (null when not connected) and is computed from the client without awaiting a network round trip when a cache entry exists (`ciStatus()` with a fresh cache answers synchronously; a cold cache answers `unknown` and starts the fetch).

Fake HTTP (`server.ts`): under `THETERMINAL_FAKE_HTTP=1`, GETs to `https://api.github.com/repos/<owner>/<name>…` answer canned bodies for `fullName` `<owner>/<name>` (default branch `main`, branches `main` and `feature/e2e`, one open PR `#7 "Add the thing"`, two runs: `main` `completed`/`success`, `feature/e2e` `in_progress`) when the Bearer contains `TESTKEY`, 401 otherwise, and 404 when `<name>` is `missing`.

UI: `api.getGitHubOverview()`; `WorkbenchModel.github: { overview: GitHubOverview | null; error: string | null; refresh(): void }` refreshed on view select and every 60 s while the GitHub view is open. `GitHubSideBar` (replaces the placeholder): header `<fullName>` as a link, `Default branch: <name>`; sections `Branches` (`<ul>`), `Pull requests` (`#<n> <title>` links, `draft` badge), `CI runs` (name, branch, `passing`/`failing`/`running` word, link); `stale` → the note `Showing the last loaded data; GitHub is rate-limiting requests.`; errors: `github_not_connected` → `Connect GitHub and set a repository in Connections.` with a button `Open Connections`; `repo_not_found` → `Repository not found, or the token has no access to it`; `github_rejected` → `GitHub rejected the token`; `github_unavailable` → `Could not reach GitHub`. Status bar: `CI: not connected` when `ci` is null; otherwise `CI: <state>` as a link to `ci.url` when present (`attention` class on `failing`).

- [ ] **Step 1: Write failing tests:**
  - client: four requests with the exact headers and no token in any URL; a second `overview()` within 30 s makes no request; after 30 s each URL is re-fetched with `If-None-Match: <etag>` and 304s keep the body; `ciStatusOf` for each status/conclusion row above; **(Review Focus 4)** a 404 on the repo → `GitHubRepoNotFoundError`; a 403 with `x-ratelimit-remaining: 0` after a good fetch → the cached overview with `stale: true` and no further request before `x-ratelimit-reset`; the same 403 on a cold cache → `GitHubUnavailableError` and `ciStatus()` resolves `unknown`; the cached body holds no `login` field;
  - routes: 404 `github_not_connected` before a connection; after `POST /api/connections` with a TESTKEY token and `config.repo` → the canned overview with `ci.state: "passing"`; `/api/status.ci` is `{ state: "passing", … }`; repo `octo/missing` → 404 `repo_not_found` while `/api/status` still answers 200 with `ci.state: "unknown"` **(Review Focus 4)**; without auth → 401;
  - UI: the side bar renders the three sections and the stale note; each error copy; the status bar shows `CI: failing` with the link and `CI: not connected` for null.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(github): read-only GitHub view with branches, pull requests and CI runs; live CI status`

---

### Task 5: MCP servers through the gate (Claude and Gemini; Codex refuses)

**Files:** Modify `packages/core/src/agents/claude-adapter.ts`, `gemini/adapter.ts`, `apps/ui/src/views/ConnectionEditor.tsx`, `packages/core/test/fixtures/fake-gemini.mjs` (log `session/new` params; a `type: "mcpTool"` step). Tests `packages/core/test/agents/{claude-adapter,gemini-adapter,codex-adapter}.test.ts`, `apps/ui/test/ConnectionEditor.test.tsx`.

**Verified against the installed CLIs (record the versions in the adapter comments):**
- Claude Agent SDK 0.3.323 `sdk.d.ts`: `Options.mcpServers?: Record<string, McpServerConfig>` with `McpStdioServerConfig = { type?: "stdio"; command; args?; env? }` and `McpHttpServerConfig = { type: "http"; url; headers? }`; `strictMcpConfig: true` (already set) ignores every other MCP configuration. Tools are named `mcp__<server>__<tool>` and reach the PreToolUse hook like any tool.
- gemini-cli 0.68.0 bundle: the ACP `session/new` handler maps `mcpServers` entries of shape `{ name, command, args, env: [{ name, value }] }` (stdio, cwd = the session cwd) and `{ type: "http", name, url, headers: [{ name, value }] }` into its config, then `loadCliConfig` applies `--allowed-mcp-server-names` as the allowlist. MCP tools are named `mcp_<server>_<tool>` (`MCP_TOOL_PREFIX = "mcp_"`, separator `_`, parsed with `/^([^_]+)_(.+)$/`, which is why server names must contain no underscore). The policy engine matches a rule's `mcpName` against the call's server name, and `toolName = "*"` with `mcpName` set covers every tool of that server. Confirm at implementation time that `tools.core` (the api_key-mode `HOME_SETTINGS`) does not exclude MCP tools; if it does, add `"mcp_*"`-style allowance through the policy rather than by widening `tools.core`.

Rules:
- Claude: `options.mcpServers = Object.fromEntries(specs.map(s => [s.serverName, s.transport === "stdio" ? { type: "stdio", command, args, env } : { type: "http", url, headers }]))`; omitted when there are no specs. `toolToAction`: a tool matching `/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/` → kind `mcp`, summary `MCP tool <tool> on <server>`; other `mcp__` names keep `MCP tool <tool>`. Policy already asks for kind `mcp` (no paths).
- Gemini: `session/new` params `{ cwd, mcpServers: specs.map(toAcpServer) }` where `toAcpServer` produces the two shapes above (env/headers as `{ name, value }` arrays). `ACP_ARGS` becomes `acpArgs(names: string[])` with `--allowed-mcp-server-names` = `names.join(",")` or `theterminal-none` when empty (names are checked against `MCP_SERVER_NAME`, so no comma can appear). `POLICY_TOML` becomes `policyToml(names)` = the 5A text plus, per name, `[[rule]]\nmcpName = "<name>"\ntoolName = "*"\ndecision = "ask_user"\npriority = 999\nargsPattern = ".*"\n` placed before the wildcard deny. The ACP tool-call kind for MCP calls is whatever Gemini reports (usually `other`), so policy asks; the ungated-tool tracker stays the backstop **(Review Focus 5)**.
- Codex: nothing changes in the adapter; the runner refuses (Task 3). The connection editor for `mcp_stdio`/`mcp_http` shows the note `Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.`
- Every spec handed to a CLI has a `serverName` matching `MCP_SERVER_NAME`; an adapter that receives one that does not fails the run with `invalid MCP server name` before starting the CLI (defence in depth: the service already derives it).
- The fake Gemini logs the `session/new` params to `THETERMINAL_FAKE_LOG` and gains the step `{ type: "mcpTool", server, tool, permission?: boolean }`: a `tool_call` named `mcp_<server>_<tool>` of kind `other` that asks through `session/request_permission` when `permission` is true and runs ungated otherwise.

- [ ] **Step 1: Write failing tests:**
  - Claude: a run with one stdio and one http spec passes `mcpServers` with exactly those two entries in the SDK shapes and keeps `strictMcpConfig: true`; without specs the option is absent; `toolToAction("mcp__tt-abc12345__list", {})` → `{ kind: "mcp", summary: "MCP tool list on tt-abc12345", paths: [] }`; the gate asks (`classify` → `ask`) **(Review Focus 5)**;
  - Gemini: with two specs the fake's log shows `session/new` params with `mcpServers` in the ACP shapes (env as `[{ name, value }]`), `argv` containing `--allowed-mcp-server-names tt-abc12345,tt-9f8e7d6c`, and the policy file holding the two `mcpName` rules before the wildcard deny; without specs the arguments and policy equal 5A's; an `mcpTool` step with `permission: true` is gated as kind `other` and completes after Allow; the same step ungated → the run fails and the call is recorded denied with reason `ran without approval` **(Review Focus 5)**; a spec with `serverName: "tt_bad"` → the run fails before spawn;
  - Codex: `start()` with `credentials.mcpServers` non-empty is never reached by the runner (covered in Task 3); the adapter test asserts the thread still disables every MCP server Codex knows of (5A behaviour unchanged);
  - editor: the MCP entries show the Codex note.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test` and `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(agents): MCP servers reach Claude and Gemini through the gate; Codex refuses them`

---

### Task 6: Capacity: inventory, usage, rate limits, hardware detection

**Files:** Create `packages/core/src/capacity/{hardware,report}.ts`, `packages/core/src/server/capacity-routes.ts`, `apps/ui/src/views/{CapacitySideBar,CapacityPanel}.tsx`. Modify `packages/core/src/db.ts` (migration 6), `events/projections.ts`, `agents/adapter.ts`, `runner.ts`, the three adapters, `server/{server,connection-routes}.ts`, `apps/ui/src/api.ts`, `App.tsx`, `shell/{model,Dock,Workbench,SideBar,StatusBar}.tsx`, `components/LedgerPanel.tsx`. Tests `packages/core/test/capacity/{hardware,report}.test.ts`, `packages/core/test/server/capacity-routes.test.ts`, `packages/core/test/events/projections.test.ts`, `packages/core/test/agents/{runner,claude-adapter,codex-adapter,gemini-adapter}.test.ts`, `apps/ui/test/{CapacitySideBar,CapacityPanel,StatusBar,LedgerPanel}.test.tsx`.

**Interfaces:**
```ts
// adapter.ts
export type AdapterEvent = | … | { type: "rate_limited"; retryAfterS?: number };
// runner: on rate_limited commit agent.rate_limited { runId, retryAfterS: integer ≥ 0 or null } with actor { kind: "agent", id: runId }
// db.ts migration 6
`CREATE TABLE rate_limits (run_id TEXT NOT NULL, adapter TEXT NOT NULL, at TEXT NOT NULL, retry_after_s INTEGER); CREATE INDEX rate_limits_at ON rate_limits (at);`
// projections: agent.rate_limited → INSERT (adapter from agent_runs); PROJECTION_TABLES gains "rate_limits"; workspaceCounts gains monthCostUsd (runs started this calendar month)
// capacity/hardware.ts
export type ExecFile = (file: string, args: string[], opts: { timeout: number; windowsHide: true }) => Promise<{ stdout: string }>;
export type HardwareDeps = { execFile: ExecFile; platform: NodeJS.Platform; arch: string; totalmem: () => number; cpus: () => { model: string }[]; release: () => string; now?: () => Date };
export function detectHardware(deps: HardwareDeps): Promise<HardwareInfo>;   // never throws
export const fakeHardware: HardwareInfo;  // { cpu: "Fake CPU", cores: 8, memoryGb: 32, gpu: "Fake GPU", gpuMemoryGb: 24, platform: process.platform, wsl: false, detectedAt }
// capacity/report.ts
export function capacityReport(db: Db, deps: { budgets: () => Budget[]; modes: (p: Provider) => AuthMode; hardware: () => HardwareInfo | null; now?: () => Date }): CapacityReport;
// capacity-routes.ts
GET  /api/capacity          → CapacityReport
POST /api/capacity/detect   → 200 HardwareInfo (writes/updates the local_hardware connection as actor owner)
```
Detection rules (`execFile` with `timeout: 10000`, never a shell; a failing or missing program → that field `null`):
- `cpu` = `cpus()[0].model` (on Apple Silicon this is the chip name, e.g. `Apple M2 Max`), `cores` = `cpus().length`, `memoryGb` = `totalmem() / 2**30` rounded to one decimal.
- `darwin`/`arm64`: `system_profiler SPDisplaysDataType -json` → `gpu` = `SPDisplaysDataType[0].sppci_model`, `gpuMemoryGb` = `memoryGb` (unified memory; the UI says `shared with the CPU`). Other darwin: `gpu` from the same key, `gpuMemoryGb` null.
- `win32`/`linux`: `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` (the program on PATH, located with the existing `which`; on win32 also tried at `<SystemRoot>\System32\nvidia-smi.exe`) → first line `name, <n> MiB` → `gpu`, `gpuMemoryGb` = n/1024 rounded to one decimal. `wsl` = linux and `release()` contains `microsoft` (case-insensitive); the UI then notes `Running inside WSL: the GPU is the Windows machine's.`
- The result is written through `ConnectionService.writeHardware(actor, info)` (a new method that bypasses the API-only `UnsupportedConnectionError` for `local_hardware`): `add` when absent, else `update` with the changed config. Values are strings (`"32"`, `"true"`).
- `server.ts`: `createServer` gains `hardware?: () => Promise<HardwareInfo>` (default: `detectHardware` over `node:child_process` `execFile` promisified and `node:os`); `selectHardware(env, injected)` returns `() => fakeHardware` only under `THETERMINAL_FAKE_AGENT=1` with `THETERMINAL_FAKE_HARDWARE=1`, so CI never depends on a runner's GPU.

Report rules: one `CapacitySource` per provider (`claude`, `codex`, `gemini`), `connectionId`/`name`/`plan`/`monthlyBudgetUsd` from `budgets()` or null, `mode` from `modes(p)`. Windows: `today` = runs with `started_at` on the server's local calendar day, `month` = this calendar month. `costUsd.value` = `SUM(cost_usd)` (null when every run is null), `basis`: claude → `"estimate"` (the SDK's cost is documented as an estimate), codex and gemini → `"not_reported"` when the value is null, else `"reported"`; tokens: `"reported"` when any run has them, else `"not_reported"`. `rateLimits.last24h` = `COUNT(*)` from `rate_limits` for that adapter within 24 h, `lastAt` the newest `at`, `basis: "estimate"` (what the adapter inferred from an error, not a provider quota).
Adapters emit `rate_limited`: Claude when the result message is an error whose text matches `/\b429\b|rate[ _-]?limit/i` (also `m.subtype === "error_max_turns"` is **not** a rate limit); Codex on a `turn/completed` or error notification whose message matches the same pattern (parse `retry after (\d+)` seconds when present); Gemini on a `session/prompt` error or `session/update` text matching it. The pattern is a heuristic and the report says so (`basis: "estimate"`).

`/api/status` gains `monthCostUsd: number` and `monthlyBudgetUsd: number | null` (sum over `budgets()`, null when none). Status bar: `Today: $<x.xx>`, then ` · Month: $<m.mm> of $<b.mm>` when a budget exists (class `attention` when `m ≥ b`).

UI: `DockPanelId` gains `"capacity"` (title `Capacity`, main group; the registry gains `capacity: CapacityPanel`). `CapacitySideBar` (replaces the placeholder): per source a row `<Provider> · <plan or "no plan set">` with a bar `month cost / budget` when both exist (`aria-valuenow`), the text `$<m> of $<b> this month` or `$<m> this month` or `not reported`, and the word `estimate` in `<abbr title="Not a figure from the provider. Computed by The Terminal from observed usage.">estimate</abbr>` wherever `basis === "estimate"`; a button `Open capacity` focuses the tab; a section `This computer` with cpu/memory/gpu lines or `Not detected yet` and a button `Detect this computer` (`POST /api/capacity/detect`, then refresh). `CapacityPanel`: a table with columns `Source`, `Mode`, `Plan`, `Today`, `This month`, `Budget`, `Tokens (in / out)`, `Rate limits (24 h)`; every estimated cell carries the same `<abbr>`; the footer `Figures marked estimate are computed by The Terminal, not published by the provider. Providers that publish no quota have none shown.`
`describeEntry("agent.rate_limited")` → `Agent <id8> was rate-limited by the provider` (+ `; retry after <n> s` when present).

- [ ] **Step 1: Write failing tests:**
  - hardware: darwin/arm64 deps with a canned `system_profiler` JSON → `gpu: "Apple M2 Max"`, `gpuMemoryGb === memoryGb`; linux with a canned `nvidia-smi` line `NVIDIA GeForce RTX 4090, 24564 MiB` → `gpuMemoryGb: 24`; `execFile` rejecting → `gpu: null` and no throw; `release()` `5.15.0-microsoft-standard` → `wsl: true`; every `execFile` call has `windowsHide: true` and an argument array (assert no string contains a space-joined command);
  - projections: `agent.rate_limited` inserts a row with the run's adapter; rebuild equals live; `workspaceCounts().monthCostUsd` sums this month only;
  - runner + fake adapter step `{ rateLimited: { retryAfterS: 30 } }` → one `agent.rate_limited` with `retryAfterS: 30`; a non-integer → `null`;
  - adapters: Claude result `is_error` with `"429 rate limit"` → `rate_limited`; Codex error `"Rate limit reached, retry after 12 seconds"` → `{ retryAfterS: 12 }`; Gemini prompt error `"RESOURCE_EXHAUSTED"` (Gemini's 429 text, verify against the CLI's error mapping) → `rate_limited`;
  - report: two claude runs today ($0.1, $0.2) and one last month → `today.costUsd` `{ value: 0.3, basis: "estimate" }`, `month` excludes last month's; codex with tokens but null cost → `costUsd { value: null, basis: "not_reported" }`, tokens `reported`; a rate limit 2 h ago → `last24h: 1`; no budget → `monthlyBudgetUsd: null`;
  - routes: `GET /api/capacity` without auth → 401; `selectHardware` ignores `THETERMINAL_FAKE_HARDWARE` outside `THETERMINAL_FAKE_AGENT=1`; with the fake selected, `POST /api/capacity/detect` → the info, a `connection.added` for `local_hardware` with config strings, a second POST → `connection.updated` or no event when unchanged; `GET /api/capacity` then has `hardware`; `/api/status` carries `monthCostUsd` and `monthlyBudgetUsd: 50` after a claude connection with that budget;
  - UI: the side bar shows `estimate` for a claude source and `not reported` for codex, the bar's `aria-valuenow`, `Detect this computer` calls the API; the panel renders the eight columns and the footer; the status bar shows `Today: $0.40 · Month: $12.00 of $50.00`; `describeEntry` string.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(capacity): usage per provider, budgets, observed rate limits and hardware detection, with estimates labelled`

---

### Task 7: Documentation and wording

**Files:** Modify `docs/connections-and-credentials.md`, `README.md` (the connections paragraph, if one names what is connectable), `CHANGELOG.md` (an entry for this plan, if the file exists). Tests: none beyond `pnpm test` staying green; the doc is reviewed by reading.

The doc gains, after "Codex and MCP servers" (which is kept and shortened to the first sentence plus a link to the new section) and replacing "What comes next":
- **Cloud accounts**: what each provider needs (AWS access key and region; GCP service account JSON and project; Azure tenant, client, subscription and client secret); what a run receives, with the exact variable names; that AWS gets a 12-hour session token when the keys allow it and the static keys otherwise, recorded as such in the ledger; that Google Cloud gets a 1-hour access token and that programs needing a credentials *file* (`GOOGLE_APPLICATION_CREDENTIALS`) are not served in this version; that Azure receives the client secret itself; that nothing is written to disk; that a run longer than the token's life loses access and should be started again; that AWS profiles from `~/.aws` are not offered, and why.
- **Giving a run access**: the picker, that nothing is passed unless selected, and the ledger lines to expect.
- **MCP servers**: local vs remote, where each field lives, that the agent program starts the server (not The Terminal), that every tool call asks, the `tt-xxxxxxxx` server name agents see, and that Codex cannot use them yet.
- **GitHub view**: read-only, which four requests are made, the 30-second cache and ETags, rate limits and the stale note.
- **Capacity**: what is counted, what `estimate` means, which providers report what (Claude: cost and tokens as estimates; Codex: tokens; Gemini: nothing), how rate limits are inferred, what detection runs (`system_profiler`, `nvidia-smi`, never a shell) and the WSL note, and that detection writes a `This computer` connection you can remove.

- [ ] **Step 1:** Write the sections. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: cloud accounts, MCP servers, the GitHub view and capacity`

---

### Task 8: End-to-end: scoped cloud env, GitHub view, Gemini MCP rule, capacity

**Files:** Create `e2e/cloud.spec.ts`, `e2e/github.spec.ts`, `e2e/mcp.spec.ts`, `e2e/capacity.spec.ts`. Modify `e2e/global-setup.ts` (the agent server's `AT_CREATE` gains `THETERMINAL_FAKE_HARDWARE=1`; `DURING_RUNS` gains `THETERMINAL_FAKE_LOG` pointing at a file in the agent data dir, exposed as `TT_E2E_FAKE_LOG`; the fake agent script gains a shell step whose output is `env=AZURE_CLIENT_SECRET=TESTKEY-azure-secret-0000000000`; the Gemini script gains `{ type: "mcpTool", server: "<name>", tool: "list", permission: true }` where the name is resolved by the spec from the connection id). `server.ts`: `THETERMINAL_FAKE_HARDWARE=1` (under the fake flag) makes `detect` return `fakeHardware`.

- [ ] **Step 1: Write the failing e2e tests:**
  - cloud: open Connections → `Azure` → fill the three ids (`00000000-0000-4000-8000-000000000001` …) and the secret → Save → `Test connection` → `Connected`; Agents → tick `Azure (cloud account)` → start the fake agent → allow the shell step → the ledger shows `Agent … was given the Azure client secret from "Azure"` and the completed-action output shows `env=AZURE_CLIENT_SECRET=[REDACTED]` **(Review Focus 1)**; a second run without the box ticked shows no `was given` line **(Review Focus 2)**; every response and frame during the spec is checked for the secret as `connections.spec.ts` does;
  - cloud env proof: start a **Gemini** run (api_key mode, fake CLI) with Azure ticked; read `TT_E2E_FAKE_LOG` from the test and assert the fake's recorded env contains `AZURE_CLIENT_SECRET` and not `OPENAI_API_KEY`;
  - github: connect GitHub with `ghp_TESTKEY0000000000000000000000000000` and repo `octo/example` → the GitHub view lists `main`, `feature/e2e`, `#7 Add the thing`, two CI runs, and the status bar shows `CI: passing`; set the repo to `octo/missing` → the view shows `Repository not found, or the token has no access to it` and the status bar `CI: unknown` **(Review Focus 4)**;
  - mcp: add `MCP server (remote)` with url `https://mcp.example.test/` and headers `Authorization=Bearer TESTKEY-mcp-0000000000`; start a Gemini run with it ticked → the decision card `Decision: mcp_tt-…_list` (the fake's title) appears → Allow → run completes; the log shows `--allowed-mcp-server-names tt-…` and `session/new` with one http server whose header value is present (the log is the fake's own file, not the ledger); the ledger's recorded action input shows the header `[REDACTED]`; selecting Codex disables the MCP box with the note **(Review Focus 5)**;
  - capacity: Capacity view → `Detect this computer` → `Fake CPU`, `32 GB`, `Fake GPU`; after the earlier fake runs the Claude row shows `estimate` and the Codex row `not reported`; set a budget of `50` on the Claude connection → the status bar shows `Month: $… of $50.00`;
  - `GET /api/github/overview` and `GET /api/capacity` without the cookie → 401.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows. Open the pull request from `plan-5b-cloud-github-mcp-capacity` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): scoped cloud credentials, GitHub view, MCP through the gate, capacity`

---

## Done when

- The Owner adds AWS, Google Cloud and Azure accounts, MCP servers and a GitHub repository in the Connections view; every secret lives in the keychain, every connection test is a read-only identity call, and no response, file or ledger entry carries a value.
- A run receives exactly the connections the Owner ticked: cloud credentials as short-lived tokens where the provider allows it (recorded as such), through the allowlisted environment; MCP servers through the agent CLI's own configuration, with every tool call stopped at the gate; a run with nothing ticked receives nothing. Each grant is a `connection.used` entry.
- Minted tokens and MCP header values are redacted from agent traffic although they were never stored as connections.
- The GitHub view shows branches, pull requests and CI runs read-only, with ETag caching and a stale notice under rate limits; the status bar's `CI` item is live and never breaks `/api/status`.
- The Capacity view shows per-provider usage for today and this month against the Owner's plan and budget, observed rate limits, and this computer's hardware; every computed figure is labelled `estimate` and unreported ones say `not reported`.
- Codex runs refuse MCP connections with the agreed sentence; Claude and Gemini accept them.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI without a real keychain, real cloud, real GitHub or a GPU; the work is merged to `main` through a pull request.
