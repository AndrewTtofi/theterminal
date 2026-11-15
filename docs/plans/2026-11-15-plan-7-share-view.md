# Plan 7: Share View and Daily Digest Implementation Plan

**Goal:** The Owner can show a project to collaborators or investors without showing them the workspace: one self-contained HTML page, generated locally from the ledger, that carries the plan summary, the board's progress, every human decision with its owner and evidence reference, the tech stack with a plain-language why, the agent workforce and its cost (labelled `estimate` where it is one), what is waiting on a human, the readiness gates' status, the last days as narrated daily digests, and the ledger's audit status. Everything on it has passed redaction and path scrubbing; raw agent output, file contents, prompts and account identifiers are left out by default; the Owner previews exactly the bytes that will leave the machine, confirms, and the confirmation is in the ledger. The same page can be served read-only on the local network behind a one-time capability token that expires, can be revoked, and is recorded. Every day of a project also reads as a deterministic daily digest inside the workspace.

**Architecture:**
- **A snapshot is data, then a page.** `buildSnapshot(deps, projectId, options)` in `packages/core/src/share/snapshot.ts` reads only projections and the ledger and produces a `ShareSnapshot` (typed in `@theterminal/shared`). Every string in it then passes `shareCleaner` (redact, scrub paths and the username, redact again, scrub emails, truncate). `renderShareHtml(snapshot)` turns it into one HTML document with inline CSS, no JavaScript, no external reference and a Content Security Policy that forbids both. Before anything is returned, `assertClean(html, secrets)` re-runs the cleaner over the finished page and throws if it would change a character: a page that cannot be proven clean is not generated.
- **Preview, then confirm.** `ShareService.preview()` builds the page, keeps it in memory for ten minutes under a `previewId` with its SHA-256, and returns the bytes to the UI, which renders them in a sandboxed iframe beside the list of what is hidden. `confirm()` accepts only a `previewId` and `contentHash` that match a held preview, writes the file under the data directory, and commits `share.confirmed` with the hash, size, sections and options. What is shared is always exactly what was previewed; a change in the project after the preview does not change the page.
- **Links serve frozen snapshots.** `ShareLinkManager` starts a second, minimal Fastify listener on an address the Owner picks from this computer's interfaces (loopback, or one local-network IPv4), answering `GET /<token>` with the confirmed bytes and nothing else. The token is 32 random bytes shown once; the server keeps only its SHA-256, the ledger records that digest, the expiry and the scope. Expiry, revocation, twenty wrong tokens, shutdown and restart all stop the listener and are recorded (`share.expired`, `share.revoked`, `share.stopped`). The main server stays bound to 127.0.0.1 and untouched.
- **Digests are a pure function.** `dailyDigest(entries, ctx)` in `@theterminal/shared` groups a project's ledger entries by UTC day and narrates them with Plan 3's `narrate`, from an allowlist of event types that never carry raw output; prompts never enter a digest. The Digest panel in the workspace and the share page's "Daily digests" section render the same function's output, so the Owner reads before sharing the same text a Viewer will read.
- **UI:** a `Share` view in the activity bar (side bar: options, preview button, saved snapshots, live links), a `share` dock tab for the preview and confirmation, a `digest` dock tab, a status-bar item while a link is live, and a `Share` topic in the ledger filter.

**Tech Stack:** existing stack only (TypeScript strict ESM, zod 4, better-sqlite3, Fastify 5, React 18 + `dockview-react` 8.8.3, Vitest 4, Playwright). `node:crypto` for the token and the content hash; `node:os` `networkInterfaces()` for the addresses offered; a second `Fastify()` instance for the link server. No new dependencies: no PDF library (the page carries a print stylesheet and the browser prints it), no templating library (the renderer is string building with one `escapeHtml`), no HTTP client.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §1 (success: "can explain what was built, why, what it costs, and what risks they've accepted"), §2 goal 3 (glass box), goal 9 (offline: "the workspace, board, ledger, share view … keep working"), §4.3 (panels: daily digest; cost and usage), §4.4 (project overview / share view: link, present, PDF, and its contents), §4.5 (collaboration: "a temporary secure share link while the laptop is on"; Viewer is read-only), §5 (the ledger is "linkable from every card and share view"), §8 (credentials stay with the Owner), §10.3 (estimates labelled), §12 call 5. Builds on Plans 1, 2, 2B, 5A, 5B, 3 and 4 (`docs/plans/`): Plan 3's `narrate`, `NarrationTopic`, `NarrationContext`, `narrationContext(db)`, `commitEvents`, `HumanRequiredError`, `getIntake`, `listGateDecisions`, `GateService.evaluate`, `applicableDecisions`, `INTAKE_DECISIONS`, `INTAKE_QUESTIONS`, `GATES`; Plan 4's `ledger.list({ beforeSeq })`, `override.*` events, `VIEWS` (nine views, `learn` last), `DockPanelId`; 5B's `Figure`/`Basis`, `GitHubClient.ciStatus()`, `CiState`, `KIND_LABELS`. The mockup the spec names (`share-view-v2.html`) is the layout reference: hero, stage progress, four headline figures, what and why, tech stack table, agent workforce, decisions, waiting. This branch is cut from `main` after Plan 4 merges; Plan 6 (linked machines) is independent of it.

## Decisions

- **Decision (controller default): the share view is a static, self-contained export generated locally: one HTML file with inline data and no external requests, and an optional local read-only server mode with its own capability token that is time-limited, revocable and recorded in the ledger. No hosted service in this plan; cloud sharing is Plan 8.** Why: spec §2 goal 9 requires the share view to work offline, and a file does; a file is also what an investor can be sent and what an auditor can keep; a page with no script and a CSP of `default-src 'none'; style-src 'unsafe-inline'; img-src data:` cannot phone home, load a tracker or run anything, so sending it is as safe as sending a PDF; the local server exists for §4.5's "temporary secure share link while the laptop is on" and is bounded by a token nobody else can guess, a clock and the Owner's hand.
- **Decision (controller default): the link server serves the confirmed snapshot's bytes only, never live data, and only one link per project is live at a time.** Why: the Owner confirmed exactly those bytes; a live page would show what nobody has previewed. Refreshing is a new preview and a new confirmation.
- **Decision (controller default): content.** The page has these sections, in this order: overview (name, pitch, `Owner`, started, generated), stage progress, headline numbers, what it does and why (the approved plan summary and the idea), tech stack, agent workforce, waiting on a human, decisions made, readiness, daily digests, earlier history (one line per day), audit status. The tech stack is derived from the intake decisions, the platform answer, the enabled connections (kind and provider label only: no names, no config values such as regions, project ids or repository names) and the agent programs that ran, each row with a plain-language why, a licence or terms line, and the ledger entry that decided it. Every cost figure carries `basis` and is shown with the word `estimate` unless every contributing run reported its own number. Why: spec §4.4 lists these contents; config values of connections identify the Owner's accounts, which the page must not; a licence line answers the spec's "licence status" for the parts the workspace knows.
- **Decision (controller default): privacy filter.** Every string passes the cleaner (redact known secrets and patterns, scrub the data directory to `<data>`, the home directory to `~` and the username to `<user>`, redact again, replace email addresses with `[email]`, then truncate). Excluded by default and never present without an option: raw agent output, action inputs, agent messages, file contents and diffs, prompts (`includePrompts`), this computer's hardware (`includeHardware`), connection names and config values (always), other projects (always). The Owner sees the finished page and the hidden list, ticks `I have read this page and I am happy to share everything on it.`, and `share.confirmed` records the content hash, byte count, sections and options. After rendering, the whole page is cleaned once more and must come back unchanged, or nothing is generated. Why: redaction is pattern matching and patterns miss, so the person accountable must see what leaves; recording the hash makes "what was shared" answerable from the ledger forever; the final assertion turns a missed pattern into a refusal instead of a leak.
- **Decision (controller default): daily digest.** A digest is a deterministic function of a project's ledger entries for one UTC calendar day: a fixed-template summary sentence with counts and spend, then the narrated headlines (Plan 3's `narrate`) of an allowlist of event types, capped at 100 with `and <n> more`. No model, no clock, no network; days are UTC so the same ledger digests the same on every machine and the page says `(UTC)`. Prompts and agent messages never appear in a digest; `agent.started` is narrated as `Owner started a <Adapter> agent[ on "<card>"]` without the prompt. Why: Plan 3 decided narration is the glass box and must say exactly what the ledger says; a digest is narration grouped by day; UTC removes the generating machine's timezone from the output.
- **Decision (controller default): evidence references are ledger coordinates, not URLs.** Each decision and stack row shows `#<seq> · <first 12 hex of the hash>`; the audit section explains how to check them against the NDJSON export (Plan 3). Why: a static page has nowhere to link to; the seq and hash prefix identify an entry in any copy of the ledger.
- **Decision (controller default): present mode and PDF are CSS.** The page has a `Present` link (`href="#present"`) that, through `:target`, shows one section per screen with scroll snapping and larger type, an `Exit` link (`href="#"`), and a print stylesheet; "Save as PDF" in the workspace opens the confirmed page in a new tab and the Owner uses the browser's print. Why: no script in the page; a PDF library is a dependency for a job the browser already does.
- **Decision (controller default): the link server.** Address from `os.networkInterfaces()`: `127.0.0.1` labelled `This computer only`, and each non-internal IPv4 labelled `Local network`; never `0.0.0.0` or IPv6. Port `4400` or the next free up to 20 above. Durations 1 hour, 8 hours, 24 hours (default) or 7 days. Routes: `GET`/`HEAD /<token>` → the bytes with `Content-Type: text/html; charset=utf-8`, `Content-Security-Policy` as the page's meta, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; anything else → 404 `{}` (other methods 405); a `Host` header that is not `<address>:<port>` → 403. Twenty wrong tokens in a link's life revoke it (`share.revoked { reason: "too_many_failures" }`). The token is compared by SHA-256 with `timingSafeEqual`. On `close()` every link stops with `share.stopped { reason: "shutdown" }`; at startup every link still `active` in the projection gets `share.stopped { reason: "restart" }` and no listener is reopened. The ledger records the token's digest, the expiry, the scope and the port, never the address. Why: a capability in the path is what "a link" means; digest-only storage means a ledger or memory read cannot reproduce the link; fail-closed on guessing, on expiry and on restart keeps "while the laptop is on" literal; an IP address of the Owner's network is not the ledger's business.

## Out of scope (later plans)

- Hosted or cloud sharing, a share link that outlives the laptop, Viewer accounts and presence (§4.5): Plan 8. The page shows `Owner`, never a name.
- Importing a snapshot into another workspace; a machine-readable export (the audit NDJSON of Plan 3 already exists).
- A live demo link and health/uptime figures (§4.4): there is no deployment or monitoring record yet (operate pack). The page shows the CI state from 5B as its only health signal and omits uptime.
- Recording the model name per run (§4.4 "which model"): adapters record the agent program; the workforce table shows that.
- Hand-written or edited share pages (§4.4: "never hand-written"); per-section toggles beyond the three options.
- Translation: the page is English only.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Fixtures use `zq-TESTKEY-e2e-opaque-0000000000`, `sk-ant-TESTKEY-0000000000`, `someone@example.test` and temp dirs; snapshots in tests describe made-up projects (`Book Club`).
- **Every new route sits behind the default-deny auth** (`registerAuth`): `/api/projects/:id/share*`, `/api/projects/:id/digests`, `/api/share/*` answer 401 without the cookie or bearer token. The link server is a separate listener that knows nothing but one snapshot's bytes and one token digest; it has no cookie, no session, no API and no file access beyond that one read at start.
- **Secrets stay in the keychain.** The share module never reads a secret value, only `secretValues()` for redaction; the snapshot reads `connections` config for kinds and providers and emits no config value. The link token exists in memory (digest) and once in a `POST` response.
- **No shell.** Nothing in this plan spawns a process.
- **Redact before truncating.** `shareCleaner` is `truncate(emails(redact(scrub(redact(s)))))`; every cap (section item limits, `MAX_SHARE_BYTES`) applies after cleaning.
- **Fail closed.** `assertClean` fails the preview; a wrong, expired or mismatched preview fails the confirm; a snapshot file whose hash no longer matches the ledger is not served or downloaded (`snapshot_tampered`); an address outside `shareAddresses()` is refused; too many wrong tokens revoke; restart stops links; a read-only ledger refuses confirm and link creation (423) and still allows preview.
- **No personal data.** The page names `Owner`, scrubs the username and emails, shows no addresses, no connection names, no config values, no hardware unless asked. The ledger records no address.
- **Main server unchanged:** still 127.0.0.1 only. Only the link server may bind a local-network address, only to a confirmed snapshot, only behind a token.
- **Labels are honest.** `estimate` next to every figure The Terminal computed; `not reported` where nothing was reported; `(UTC)` next to every day.
- **Narration and digests are pure.** `digest.ts` imports only `./narration.js`, `./domain.js`, `./agents.js` and types; no `Date`, `Math.random`, `fetch`, `process`.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`** (unchanged); this plan adds no switch. The link server binds `127.0.0.1` in every test.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-7-share-view`, one commit per task, pushed when it lands, and merges through a pull request once CI is green on macOS and Windows. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1/2/2B/5A/5B/3/4 constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, every agent action gated, allowlisted child env, keychain-only secrets, live redaction, estimates labelled, narration pure, projections rebuild exactly from the ledger).

## Review Focus

1. **A secret, a path, a username or an email on the page.** A stored connection key appears in a run's shell output and in a waiver reason; the project's pitch contains the home directory, the OS username and `someone@example.test`; a card title contains `sk-ant-TESTKEY-0000000000`. Expected: the preview's HTML contains none of the key, the path, the username or the email; the reason shows `[REDACTED]`, the pitch shows `~`, `<user>` and `[email]`; the shell output is absent altogether (not included by default); `assertClean` on a page where a pattern was deliberately bypassed throws `ShareNotCleanError` and no preview is held. (Tests in Tasks 2, 3, 4 and 8.)
2. **Confirming something that was not previewed.** `confirm` with an unknown `previewId`; with the right id and a wrong hash; after eleven minutes; with a system actor. Expected: 404 `preview_not_found`, 409 `preview_stale`, 409 `preview_stale`, 403 `human_required`; `ledger.headSeq()` unchanged and no file under `share/` in every case. (Tests in Task 4.)
3. **Guessing, outliving or probing a link.** Twenty wrong tokens; a request after expiry; `POST /<token>`; `GET /api/ledger` on the link port; a wrong `Host`. Expected: 404 each time until the twentieth wrong token, after which the link is revoked, `share.revoked { reason: "too_many_failures" }` is recorded and the right token also answers 404; after expiry 404 and `share.expired`; 405; 404; 403. The right token before expiry returns bytes identical to the download. (Tests in Task 5.)
4. **A restart while a link is live.** A link is created; the server is closed and a new one opened on the same data directory. Expected: `share.stopped { reason: "shutdown" }` at close, no listener on the port afterwards, the link listed as `stopped`; on a data directory whose projection still says `active` (simulated), startup records `share.stopped { reason: "restart" }` and opens nothing. (Tests in Task 5.)
5. **Content that must stay hidden, and content from elsewhere.** A run with a prompt, a message, an allowed shell action with output and a written file; a second project with its own cards and decisions; `includePrompts` off, then on. Expected: the page holds the command phrase but not the output, not the message text, not the file contents and not the prompt; with `includePrompts: true` the prompt appears (cleaned) under the day's `Asks`; nothing from the second project appears either way; the preview's `hidden` list names each excluded class. (Tests in Tasks 2, 4 and 8.)

---

## File Structure

```
packages/shared/src/share.ts              # ShareOptions, ShareSnapshot and row types, sections, hidden copy, stack catalog, share.* schemas (Task 1)
packages/shared/src/digest.ts             # DailyDigest, dailyDigest, DIGEST_ITEM_TYPES, utcDay (Task 1)
packages/shared/src/narration.ts          # (modify) share.* templates, topic "share" (Task 1)
packages/shared/src/events.ts, index.ts   # (modify) EventType gains share.* (Task 1)

packages/core/src/db.ts                   # (modify) migration: share_snapshots, share_links (Task 2)
packages/core/src/events/projections.ts   # (modify) share reducers, queries (Task 2)
packages/core/src/share/clean.ts          # shareCleaner, cleanSnapshot, assertClean, EMAIL (Task 2)
packages/core/src/share/stack.ts          # techStack derivation (Task 2)
packages/core/src/share/snapshot.ts       # buildSnapshot (Task 2)
packages/core/src/share/render.ts         # renderShareHtml, escapeHtml, SHARE_CSP (Task 3)
packages/core/src/share/service.ts        # ShareService: preview, confirm, list, files (Task 4)
packages/core/src/share/digests.ts        # projectDigests(db, ledger, projectId, days) (Task 4)
packages/core/src/server/share-routes.ts  # /api/projects/:id/share*, /api/projects/:id/digests, /api/share/* (Tasks 4, 5)
packages/core/src/share/link-server.ts    # shareAddresses, ShareLinkManager (Task 5)
packages/core/src/server/{routes,connection-routes,server}.ts, index.ts  # (modify) error map, status, wiring (Tasks 4, 5)

apps/ui/src/api.ts                        # (modify) share, digests (Task 6)
apps/ui/src/shell/{views,Dock,dock-layout,Workbench,SideBar,StatusBar,model}.ts(x)  # (modify) share view, panels, status item (Task 6)
apps/ui/src/views/ShareSideBar.tsx        # options, preview, snapshots, links (Task 6)
apps/ui/src/views/SharePanel.tsx          # preview iframe, hidden list, confirmation (Task 6)
apps/ui/src/views/DigestPanel.tsx         # daily digests (Task 6)
apps/ui/src/components/ShareLinkForm.tsx  # address, duration, the link shown once (Task 6)
apps/ui/src/views/LedgerSideBar.tsx       # (modify) Share topic (Task 6)
apps/ui/src/App.tsx, styles.css           # (modify) (Task 6)
docs/share-view.md, CHANGELOG.md, README.md  # (Task 7)
e2e/share.spec.ts, e2e/digest.spec.ts, e2e/global-setup.ts  # (Task 8)
```

---

### Task 1: Shared share types and schemas, the daily digest, share narration

**Files:** Create `packages/shared/src/share.ts`, `packages/shared/src/digest.ts`. Modify `packages/shared/src/narration.ts`, `events.ts`, `index.ts`. Tests `packages/shared/test/{share,digest,narration,domain}.test.ts`.

**Interfaces:**
```ts
// shared/share.ts
export const SHARE_VERSION = 1;
export const DIGEST_DAYS = [7, 14, 30] as const;
export type DigestDays = (typeof DIGEST_DAYS)[number];
export type ShareOptions = { includePrompts: boolean; includeHardware: boolean; digestDays: DigestDays };
export const DEFAULT_SHARE_OPTIONS: ShareOptions = { includePrompts: false, includeHardware: false, digestDays: 7 };
export const shareOptionsSchema; // z.object({ includePrompts: z.boolean(), includeHardware: z.boolean(), digestDays: z.union([z.literal(7), z.literal(14), z.literal(30)]) }).strict()
export const SHARE_SECTIONS = ["overview", "progress", "numbers", "what_and_why", "stack", "workforce", "waiting", "decisions", "readiness", "digests", "history", "audit"] as const;
export type ShareSection = (typeof SHARE_SECTIONS)[number];
export const SHARE_SECTION_TITLES: Record<ShareSection, string> = { overview: "Overview", progress: "Progress", numbers: "Headline numbers", what_and_why: "What it does and why", stack: "Tech stack", workforce: "Agent workforce", waiting: "Waiting on a human", decisions: "Decisions made", readiness: "Readiness", digests: "Daily digests", history: "Earlier history", audit: "Audit status" };
export const HIDDEN_BY_DEFAULT: readonly string[] = [
  "Credentials, API keys and tokens (they live only in your keychain and are never in the ledger)",
  "File contents and diffs",
  "Raw agent output and the raw input of every action",
  "What agents said (their messages)",
  "Your prompts to agents (shown only when you tick Include my prompts)",
  "This computer's hardware (shown only when you tick Include this computer)",
  "Connection names and account details: regions, project ids, repository names",
  "File paths outside the project, your username and email addresses",
  "Anything from other projects",
];
export type Evidence = { seq: number; hash12: string; at: string };
export type ShareNumbers = { cardsTotal: number; cardsDone: number; runsTotal: number; runsCompleted: number; overrides: number;
  spendUsd: Figure; budgetUsd: number | null; costPerDayUsd: Figure; decisionsMade: number; decisionsWaiting: number; ci: CiState | null };
export type StackRow = { layer: string; choice: string; why: string; licence: string | null; evidence: Evidence | null };
export type WorkforceRow = { adapter: AdapterId; label: string; runs: number; completed: number; failed: number; stopped: number; costUsd: Figure; inputTokens: number | null; outputTokens: number | null };
export type WaitingItem = { kind: "action" | "intake"; headline: string; since: string | null; cardTitle: string | null; assignee: "Owner" };
export type DecisionItem = { kind: "intake" | "gate_sign_off" | "gate_waiver" | "action"; headline: string; by: "Owner"; at: string; reason: string | null; evidence: Evidence };
export type ReadinessRow = { gateId: GateId; title: string; state: "signed_off" | "waived" | "open" | "not_reached"; detail: string | null; cardTitle: string | null; at: string | null; evidence: Evidence | null };
export type HistoryDay = { day: string; entries: number; actions: number; decisions: number; cardsMoved: number };
export type Ask = { day: string; time: string; adapterLabel: string; cardTitle: string | null; prompt: string };
export type ShareSnapshot = { version: 1; generatedAt: string; options: ShareOptions; hidden: string[];
  project: { name: string; pitch: string; createdAt: string }; owner: "Owner";
  progress: Record<Stage, { total: number; done: number }>; currentStage: Stage | null;
  numbers: ShareNumbers; summary: string | null; idea: string | null; stack: StackRow[]; workforce: WorkforceRow[];
  waiting: WaitingItem[]; decisions: DecisionItem[]; decisionsOmitted: number; readiness: ReadinessRow[];
  digests: DailyDigest[]; asks: Ask[]; history: HistoryDay[]; hardware: HardwareInfo | null;
  audit: { ok: boolean; entries: number; brokenAtSeq: number | null; headSeq: number; headHash12: string | null } };
export const STACK_LICENCES: Record<string, string> = { claude: "Claude Agent SDK, under Anthropic's legal agreements", codex: "Apache-2.0 (Codex CLI)", gemini: "Apache-2.0 (Gemini CLI)", github: "GitHub terms of service", aws: "AWS customer agreement", gcp: "Google Cloud terms", azure: "Microsoft Azure terms", mcp_stdio: "Per server", mcp_http: "Per server" };
export const STACK_LAYERS = { first_version: "Scope", hosting: "Hosting", exposure_protection: "Access", payments_scope: "Payments", data_handling: "Personal data" } as const satisfies Record<DecisionId, string>;
export const STACK_KIND_LAYERS: Record<Exclude<ConnectionKind, "hardware">, string> = { llm: "AI agents", cloud: "Cloud", github: "Code hosting", mcp: "Tools (MCP)" };
export type ShareSnapshotRecord = { id: string; projectId: string; contentHash: string; bytes: number; sections: ShareSection[]; options: ShareOptions; headSeq: number; confirmedAt: string };
export type ShareLinkState = "active" | "revoked" | "expired" | "stopped";
export type ShareScope = "this_computer" | "local_network";
export type ShareLink = { id: string; shareId: string; projectId: string; scope: ShareScope; port: number; state: ShareLinkState; createdAt: string; expiresAt: string; endedAt: string | null };
export const TTL_MINUTES = [60, 480, 1440, 10080] as const;
export const sharePayloadSchemas = {
  "share.confirmed":    { shareId: id, contentHash: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative(), sections: z.array(z.enum(SHARE_SECTIONS)).min(1), options: shareOptionsSchema, headSeq: z.number().int().nonnegative() },
  "share.link_created": { linkId: id, shareId: id, tokenDigest: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.string().datetime(), port: z.number().int().min(1).max(65535), scope: z.enum(["this_computer", "local_network"]) },
  "share.revoked":      { linkId: id, reason: z.enum(["owner", "too_many_failures"]) },
  "share.expired":      { linkId: id },
  "share.stopped":      { linkId: id, reason: z.enum(["shutdown", "restart"]) },
}; // all .strict(); id = z.string().min(1).max(200)
export type ShareEventType = keyof typeof sharePayloadSchemas;
```
```ts
// shared/digest.ts
export const DIGEST_MAX_ITEMS = 100;
/** Entry types a digest narrates. Everything else counts but is not listed. */
export const DIGEST_ITEM_TYPES: readonly EventType[] = ["project.created", "card.created", "card.moved", "card.status_changed", "agent.started", "agent.finished", "agent.action.requested", "agent.action.decided", "agent.rate_limited", "intake.started", "intake.decided", "intake.completed", "intake.reopened", "gate.blocked", "gate.signed_off", "gate.waived", "connection.added", "connection.removed", "override.command", "override.discard", "override.completed", "share.confirmed", "share.link_created", "share.revoked", "share.expired", "share.stopped"];
export type DigestItem = { seq: number; time: string; headline: string; topic: NarrationTopic; attention: boolean };
export type DigestCounts = { entries: number; actions: number; allowed: number; denied: number; decisions: number; cardsMoved: number; runsStarted: number; runsFinished: number; spendUsd: number | null };
export type DailyDigest = { day: string; summary: string; counts: DigestCounts; items: DigestItem[]; more: number };
export function utcDay(ts: string): string;                                   // ts.slice(0, 10) of an ISO timestamp
export function digestDay(day: string, entries: LedgerEntry[], ctx?: NarrationContext): DailyDigest;   // entries of that day, any order; items in seq order
export function dailyDigests(entries: LedgerEntry[], ctx?: NarrationContext): DailyDigest[];           // one per day present, newest day first
```
Digest rules: `counts.actions` = `agent.action.requested`; `allowed`/`denied` = `agent.action.decided` with `by: "human"`; `decisions` = those plus `intake.decided`, `gate.signed_off`, `gate.waived`; `cardsMoved` = `card.moved`; `runsStarted`/`runsFinished` = `agent.started`/`agent.finished`; `spendUsd` = sum of `agent.finished.costUsd` that are numbers, null when none. `agent.action.decided` by `policy` is counted in `entries` only and never listed. Items: entries whose type is in `DIGEST_ITEM_TYPES` (and, for `agent.action.decided`, `by === "human"`), narrated with `narrate(e, ctx).headline`, except `agent.started` → `Owner started a <Adapter> agent on "<cardTitle>"` when the card resolves, else `Owner started a <Adapter> agent` (never the prompt); the first `DIGEST_MAX_ITEMS` in seq order, `more` = the rest. Summary (exact): `<entries> ledger entr(y|ies): <actions> agent action(s) requested, <allowed> allowed and <denied> denied by a human, <decisions> decision(s) by the Owner, <cardsMoved> card(s) moved, <runsStarted> agent run(s) started and <runsFinished> finished.` followed by ` Agent spend recorded that day: $<x.xx> (estimate).` when `spendUsd` is not null. Plurals: `1 entry`, `2 entries`, `1 action`, `2 actions`, etc.

Narration (`narrate`, exact; topic `share`): `share.confirmed` → `Owner confirmed a share page (<sections.length> sections, <bytes> bytes)`, detail = `JSON.stringify(options)` · `share.link_created` → `Owner created a share link for <"this computer only" | "the local network">, valid until <expiresAt>`, attention true · `share.revoked` → owner `Owner revoked a share link`; too_many_failures `A share link was revoked after too many wrong attempts`, attention true · `share.expired` → `A share link expired` · `share.stopped` → `A share link stopped: The Terminal <closed | restarted>`. `NarrationTopic` gains `"share"`; `NarrationRefs` gains `shareId?` and `linkId?`. `events.ts`: `EventType` gains `ShareEventType`; `eventPayloadSchemas` spreads `sharePayloadSchemas`.

- [ ] **Step 1: Write failing tests:**
  - share: `shareOptionsSchema` rejects `digestDays: 10` and an extra key, accepts `DEFAULT_SHARE_OPTIONS`; `share.confirmed` rejects a 63-character hash and `sections: []`; `share.link_created` rejects `scope: "internet"` and `port: 0`; `share.revoked` rejects `reason: "bored"`; `STACK_LAYERS` has every `DECISION_ID`; `HIDDEN_BY_DEFAULT` has nine lines;
  - digest: a fixture day with a project created, a card created, a card moved, a run started on card `Login` with prompt `secret plan`, a requested shell action, a human allow, a policy deny, an `agent.action.completed` with output `zq-TESTKEY-e2e-opaque-0000000000`, an `agent.message`, and a finish with `costUsd: 0.25` → `counts` `{ entries: 10, actions: 1, allowed: 1, denied: 0, decisions: 1, cardsMoved: 1, runsStarted: 1, runsFinished: 1, spendUsd: 0.25 }`, `summary` exactly `10 ledger entries: 1 agent action requested, 1 allowed and 0 denied by a human, 1 decision by the Owner, 1 card moved, 1 agent run started and 1 finished. Agent spend recorded that day: $0.25 (estimate).`; `items` has no entry of type `agent.message` or `agent.action.completed`, none mentions `secret plan` or the output; the `agent.started` item reads `Owner started a Fake agent on "Login"` **(Review Focus 5)**; 150 listed entries → 100 items and `more: 50`; `dailyDigests` over two days returns the newer day first; `utcDay("2026-11-15T23:59:59.000Z")` is `2026-11-15`; determinism (same input twice, cloned input); a source scan asserts `digest.ts` imports only `./narration.js`, `./domain.js`, `./agents.js`, `./events.js` and does not mention `Date`, `Math.random`, `fetch` or `process`;
  - narration: the five templates; topic `share`; `refs.linkId`; the Plan 3/4 purity scan passes with `./share.js` allowed;
  - domain: `eventPayloadSchemas` has a schema for every `EventType` including `share.*`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): share snapshot types and events, deterministic daily digests, share narration`

---

### Task 2: Migration and projections; the share cleaner; the snapshot builder and tech-stack derivation

**Files:** Create `packages/core/src/share/clean.ts`, `stack.ts`, `snapshot.ts`. Modify `packages/core/src/db.ts`, `events/projections.ts`, `index.ts`. Tests `packages/core/test/share/{clean,stack,snapshot}.test.ts`, `packages/core/test/events/projections.test.ts`.

**Interfaces:**
```ts
// db.ts: the migration after Plan 3's (intakes, intake_answers, intake_decisions, gate_decisions)
`CREATE TABLE share_snapshots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, content_hash TEXT NOT NULL, bytes INTEGER NOT NULL, sections TEXT NOT NULL, options TEXT NOT NULL, head_seq INTEGER NOT NULL, confirmed_at TEXT NOT NULL);
 CREATE INDEX share_snapshots_project ON share_snapshots (project_id);
 CREATE TABLE share_links (id TEXT PRIMARY KEY, share_id TEXT NOT NULL, project_id TEXT NOT NULL, scope TEXT NOT NULL, port INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT);
 CREATE INDEX share_links_state ON share_links (state);`
// projections.ts
export function listShareSnapshots(db: Db, projectId: string): ShareSnapshotRecord[];   // newest first
export function getShareSnapshot(db: Db, shareId: string): ShareSnapshotRecord | null;
export function listShareLinks(db: Db, q?: { state?: ShareLinkState; projectId?: string }): ShareLink[];   // newest first
export function countActiveShareLinks(db: Db): number;
// share/clean.ts
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export type ShareClean = (s: string, max: number) => string;
export type CleanerDeps = { dataDir: string; secrets: () => string[]; username?: string; home?: string };  // username default: os.userInfo().username (empty when none); home default os.homedir()
export function shareCleaner(deps: CleanerDeps): ShareClean;        // truncate(emails(redact(scrub(redact(s, secrets)), secrets)), max); scrub = usernameScrubber ∘ pathScrubber([[dataDir, "<data>"], [home, "~"]])
export const SHARE_TEXT_MAX = 4000;
export function cleanSnapshot(s: ShareSnapshot, clean: ShareClean): ShareSnapshot;   // every string field and array element, depth-first; keys untouched; `hash12`, `day`, `time`, ISO dates and ids are strings too and pass through unchanged by construction
export class ShareNotCleanError extends Error {}   // "the share page could not be proven clean"
export function assertClean(html: string, clean: ShareClean): void;   // clean(html, Infinity) !== html → ShareNotCleanError
// share/stack.ts
export type StackDeps = { intake: ReturnType<typeof getIntake>; connections: Connection[]; runs: AgentRun[]; entries: LedgerEntry[] };
export function techStack(deps: StackDeps): StackRow[];
// share/snapshot.ts
export type SnapshotDeps = { db: Db; ledger: Ledger; integrity: () => VerifyResult; gates: GateService; connections: () => Connection[];
  ci: () => Promise<CiStatus | null>; hardware: () => HardwareInfo | null; clean: ShareClean; now?: () => Date };
export const SHARE_LIMITS = { decisions: 200, waiting: 50, readinessCards: 20, historyDays: 2000, asksPerDay: 50 } as const;
export async function buildSnapshot(deps: SnapshotDeps, projectId: string, options: ShareOptions): Promise<ShareSnapshot>;   // NotFoundError; cleaned
export function evidenceOf(e: LedgerEntry): Evidence;   // { seq, hash12: hash.slice(0, 12), at: ts }
```
Reducers: `share.confirmed` → INSERT (`sections`, `options` as canonical JSON); `share.link_created` → INSERT with `project_id = e.projectId`, `state 'active'`; `share.revoked` / `share.expired` / `share.stopped` → `UPDATE share_links SET state = ?, ended_at = ? WHERE id = ?` (`revoked`/`expired`/`stopped`). `PROJECTION_TABLES` gains both tables.

Snapshot rules (every text through `clean(s, SHARE_TEXT_MAX)` once the raw snapshot is built, via `cleanSnapshot`; the project's entries are read with `ledger.list({ projectId, afterSeq, limit: 500 })` pages):
- `project` from `projects`; `progress` per stage from `cards` (`done` = status `done`); `currentStage` = the first stage in `STAGES` order with a card not `done`, else the last stage with a card, else null.
- `numbers`: `cardsDone`/`cardsTotal`; `runsCompleted`/`runsTotal` from `agent_runs`; `overrides` = `override.command` + `override.discard` entries; `spendUsd.value` = `SUM(cost_usd)` (null when every run is null), `basis` `not_reported` when null, `reported` when every run with a cost is `codex` or `gemini` and no run has a null cost, else `estimate`; `budgetUsd` = the intake's `budget_usd` answer or null; `costPerDayUsd` = spend ÷ max(1, whole days from the first run's `started_at` to `now`), `basis: "estimate"`, null when no spend; `decisionsMade` = human `agent.action.decided` + `intake.decided` + `gate.signed_off` + `gate.waived`; `decisionsWaiting` = pending actions of the project + (open intake: `applicableDecisions(answers)` minus decided); `ci` = `(await deps.ci())?.state ?? null` (the client never throws).
- `summary` = `intakes.summary` or null; `idea` = `intakes.idea` or null.
- `stack = techStack(…)`, in this order: one row per decided intake decision in `DECISION_IDS` order (`layer` from `STACK_LAYERS`, `choice` = the chosen option's label, `why` = the rationale when non-empty else the option's `tradeoffs`, `licence: null`, `evidence` = the `intake.decided` entry); `Platforms` (`choice` = `renderAnswer(platform)`, `why` = `From the plan`, evidence = the latest `intake.answered` for `platform`); one row per enabled connection of kind `llm`, `cloud`, `github`, `mcp` (`layer` from `STACK_KIND_LAYERS`, `choice` = the catalog label, `why` = `Connected by the Owner`, `licence` from `STACK_LICENCES[provider]`, evidence = its `connection.added` entry; two connections of one provider collapse to one row); one row `Agent programs` per adapter that ran (`choice` `Claude Code (Claude Agent SDK)` / `Codex CLI` / `Gemini CLI` / `Fake agent`, `why` = `<n> run(s)`, licence from `STACK_LICENCES`, evidence = the first `agent.started` of that adapter). No config value, no connection name, no `local_hardware` row.
- `workforce`: one row per adapter with runs; `costUsd.basis` per 5B's rule (`claude` → `estimate`; `codex`/`gemini` → `reported` when a cost exists, else `not_reported`; `fake` → `estimate`); tokens summed or null.
- `waiting`: pending actions (`headline` = `narrate(requestedEntry).headline`, `since` = `requestedAt`, `cardTitle` from the run's card), then one `intake` item per undecided applicable decision (`headline` = `Decide: <question>`), capped at `SHARE_LIMITS.waiting`.
- `decisions`: newest first from the entries: `intake.decided` (reason = rationale or null), `gate.signed_off` (null), `gate.waived` (reason), human `agent.action.decided` (reason or null); `headline` = `narrate(e, ctx).headline`; the first 200, `decisionsOmitted` = the rest.
- `readiness`: for every `GATE_ID` in order: the latest `gate_decisions` row for the project → `signed_off`/`waived` with `detail` = reason, `cardTitle`, `at`, `evidence`; otherwise, if `gates.evaluate(card, "ship")` for cards in `build` or `evaluate(card, "operate")` for cards in `ship` (at most `readinessCards` cards, oldest first) lists that gate → `open` with `detail` = the unmet condition labels joined `; ` (or `All conditions met; awaiting sign-off`) and the first such card's title; else `not_reached`.
- `digests` = `dailyDigests(entries within the last options.digestDays UTC days, ctx)` with `ctx = narrationContext(db)` (Plan 3); `asks` only when `includePrompts`: one per `agent.started` in those days (`prompt` cleaned), capped at `asksPerDay` per day; `history` = one `HistoryDay` per earlier day with entries, oldest first, at most `historyDays` (the oldest beyond are dropped); `hardware` = `deps.hardware()` only when `includeHardware`, else null.
- `audit` from `integrity()` and `ledger.headSeq()`; `headHash12` from the last entry.
- `hidden` = `HIDDEN_BY_DEFAULT` minus the prompts line when `includePrompts`, minus the hardware line when `includeHardware`.

- [ ] **Step 1: Write failing tests:**
  - projections: each reducer against the live table; rebuild after confirm, link, revoke equals live; `countActiveShareLinks` 1 → 0 after `share.expired`;
  - clean: `shareCleaner({ dataDir, secrets: () => ["zq-TESTKEY-e2e-opaque-0000000000"], username: "alice", home: "/Users/alice" })("key zq-TESTKEY-e2e-opaque-0000000000 in /Users/alice/x by alice, mail someone@example.test", 4000)` is `key [REDACTED] in ~/x by <user>, mail [email]` **(Review Focus 1)**; a 5,000-character string is cut at 4,000 after redaction (the secret at position 4,100 is gone, not half-present); `cleanSnapshot` cleans a nested `decisions[0].reason` and leaves `audit.headSeq` a number; `assertClean("<p>sk-ant-TESTKEY-0000000000</p>", clean)` throws `ShareNotCleanError`, a clean page passes;
  - stack: a completed intake (`hosting: own_cloud` with rationale `Cheaper to start`, `first_version: smallest` without one) plus an enabled `aws` connection named `My prod account` with region `us-east-1` and a `claude` connection, plus two claude runs → rows in order `Scope` (why = the tradeoffs text), `Hosting` (`In your own cloud account (AWS, Google Cloud or Azure)`, why `Cheaper to start`), `Platforms`, `AI agents · Claude (Anthropic)`, `Cloud · AWS` (licence `AWS customer agreement`), `Agent programs · Claude Code (Claude Agent SDK)` (`2 runs`); `JSON.stringify(rows)` contains neither `My prod account` nor `us-east-1`; every `evidence.hash12` is 12 hex characters;
  - snapshot (a project with a completed intake for a private no-payments idea with budget 25, five cards with one done, two fake runs: one completed with cost 0.1, one allowed shell action with output `zq-TESTKEY-e2e-opaque-0000000000` and a message `I am done`, a prompt `Build the login page`; card `Login` moved to Ship with a waiver of `ready_to_ship` (reason `We are only testing this`); a pending action on a second run; a second project with its own card and decision): `progress.plan.total` 1, `numbers` `{ cardsDone: 1, runsCompleted: 1, spendUsd: { value: 0.1, basis: "estimate" }, budgetUsd: 25, decisionsMade: 4, decisionsWaiting: 1, overrides: 0 }`; `waiting[0].headline` contains `wants to run the command`; `decisions` newest first with the waiver's `reason`; `readiness` has `plan_approved` `not_reached`, `ready_to_ship` `waived` with `detail` `We are only testing this` and `cardTitle` `Login`, and `go_live` `open` with `detail` containing `No agent is waiting for a decision in this project`; `digests[0].items` contain the action request and not the output or `I am done`; `JSON.stringify(snapshot)` contains none of the output, `I am done`, `Build the login page`, nor the second project's card title **(Review Focus 5)**; with `includePrompts: true` `asks[0].prompt` is `Build the login page` and `hidden` lacks the prompts line; with a pitch `by alice at /Users/alice, someone@example.test` the snapshot's pitch is `by <user> at ~, [email]` **(Review Focus 1)**; `history` is empty when every entry is within the window; unknown project → `NotFoundError`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test share events`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): share snapshot built from the ledger with a tech stack, workforce, decisions and digests, cleaned of secrets, paths and personal data`

---

### Task 3: The share page renderer: one file, no script, no external request

**Files:** Create `packages/core/src/share/render.ts`. Test `packages/core/test/share/render.test.ts`.

**Interfaces:**
```ts
export const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export function escapeHtml(s: string): string;   // & < > " ' → entities
export function renderShareHtml(s: ShareSnapshot): string;
export function contentHashOf(html: string): string;   // sha256 hex of the UTF-8 bytes
```
Page rules:
- `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" …><meta http-equiv="Content-Security-Policy" content="<SHARE_CSP>"><title><project name> · The Terminal</title><style>…</style></head>`. The output contains no `<script`, no `<link`, no `<img`, no `<iframe`, no `src=`, no `url(` and no `http://`/`https://` except inside visible text that came from the snapshot (and such text is escaped). A test asserts each absence over a snapshot whose pitch is `<script>alert(1)</script> https://example.test`: the pitch renders as `&lt;script&gt;…` and the raw substring `<script` never appears.
- Body: a `<nav class="controls">` with `Present` (`href="#present"`), `Exit` (`href="#"`) and the note `Print this page to save it as a PDF.`; an empty `<span id="present"></span>`; then one `<section id="<section id>">` per `SHARE_SECTIONS` entry, with an `<h2>` of its title, in order. Sections with nothing to show render one line: `No plan has been approved yet.` (what and why), `Nothing is waiting on a human.`, `No decisions recorded yet.`, `No agent has run yet.`, `No readiness gate has been reached yet.`, `No earlier days.`
- Overview: `<h1>` name, the pitch, `Owner · Started <createdAt date> · Generated <generatedAt> (UTC)`. Progress: five stage cells `✓ Plan` (every card done), `● Build · 70%` (the current stage, done ÷ total rounded), plain for the rest. Numbers: four figures `Work done by agents: <runsCompleted> of <runsTotal> run(s) · <overrides> by hand`; `Spend to date: $<x.xx> of $<budget> (estimate)` or `not reported`; `~$<y.yy>/day to run (estimate)`; `Human decisions: <made> made · <waiting> waiting`; `Checks: <ci state>` or `Checks: not connected`. Every figure whose `basis` is `estimate` carries `<abbr title="Not a figure from the provider. Computed by The Terminal from recorded usage.">estimate</abbr>`.
- Tech stack: a table with columns `Layer`, `Choice`, `Why (plain words)`, `Licence or terms`, `Decided` (the evidence as `#<seq> · <hash12>` or `—`). Workforce: columns `Agent`, `Runs`, `Completed`, `Failed`, `Stopped`, `Cost`, `Tokens (in / out)`. Waiting: list items `<headline> · assigned to Owner · since <date>[ · pauses "<card>"]`. Decisions: list items `<headline> · Owner · <date> · #<seq> · <hash12>` with the reason as a quoted line under it; `and <n> earlier decisions` when omitted. Readiness: one row per gate `title · state word (`Signed off`, `Waived`, `Open`, `Not reached`) · detail · card · date · evidence`. Digests: one `<article id="day-<day>">` per digest with `<h3><day> (UTC)</h3>`, the summary, the items as `<time>` + headline, `and <more> more` when cut, and when `asks` has that day's prompts a sub-list `Asks` with `<time> · <adapterLabel>[ on "<card>"]: <prompt>`. History: a table `Day (UTC)`, `Entries`, `Agent actions`, `Decisions`, `Cards moved`. Hardware (only when present): one line inside Tech stack, `This computer: <cpu> · <memoryGb> GB · <gpu>`. Audit: `Ledger intact: <entries> entries, head #<headSeq> · <headHash12>` or `Ledger chain broken at #<brokenAtSeq>: entries after it are not shown`, and the sentence `Every #<seq> · <hash> on this page names an entry of the project's append-only ledger; compare them with the audit export (theterminal-ledger-<id>.ndjson) to verify.`
- Footer: `Generated by The Terminal on <generatedAt>. Secrets, file contents, raw agent output and anything from other projects are not on this page.` The hidden list renders in the footer as `Not included:` with `hidden` as items.
- CSS (inline, a dark-neutral theme, system font stack): `#present:target ~ section { min-height: 100vh; scroll-snap-align: start; font-size: 1.2rem }`, `html:has(#present:target) { scroll-snap-type: y mandatory }`, `@media print { .controls { display: none } section { break-inside: avoid } }`.

- [ ] **Step 1: Write failing tests:** the fixture snapshot from Task 2 renders a page whose `<title>` is `Book Club · The Terminal`; the CSP meta holds `SHARE_CSP`; the twelve `<section id>`s appear in order; the absences above **(no script, link, img, iframe, src=, url()**); the escaping case; the `estimate` abbr next to `$0.10`; `#<seq> · <hash12>` of the waiver's evidence appears in Decisions and Readiness; `Not included:` lists nine items; `contentHashOf` equals `createHash("sha256")` of the bytes and changes when one character changes; the same snapshot renders identical bytes twice (no clock in the renderer: `generatedAt` comes from the snapshot).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test render`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): render the share snapshot as one self-contained page with no script and no external request`

---

### Task 4: ShareService (preview, confirm, files), digests, and the share and digest routes

**Files:** Create `packages/core/src/share/service.ts`, `share/digests.ts`, `packages/core/src/server/share-routes.ts`. Modify `packages/core/src/server/routes.ts` (error map), `server.ts`, `index.ts`. Tests `packages/core/test/share/{service,digests}.test.ts`, `packages/core/test/server/share-routes.test.ts`.

**Interfaces:**
```ts
// share/service.ts
export class PreviewNotFoundError extends Error {}    // "no such preview"
export class PreviewStaleError extends Error {}       // "the preview has changed or expired"
export class SnapshotMissingError extends Error {}    // "the snapshot file is missing"
export class SnapshotTamperedError extends Error {}   // "the snapshot file does not match the ledger"
export class ShareTooLargeError extends Error {}      // "the share page is too large"
export const PREVIEW_TTL_MS = 600_000, MAX_SHARE_BYTES = 8 * 1024 * 1024, MAX_PREVIEWS = 20;
export type Preview = { previewId: string; projectId: string; contentHash: string; bytes: number; html: string; snapshot: ShareSnapshot; expiresAt: string };
export type ShareServiceDeps = { db: Db; ledger: Ledger; dataDir: string; build: (projectId: string, options: ShareOptions) => Promise<ShareSnapshot>;
  render?: (s: ShareSnapshot) => string; clean: ShareClean; newId?: () => string; now?: () => Date };
export class ShareService {
  constructor(deps: ShareServiceDeps);
  async preview(projectId: string, options: ShareOptions): Promise<Preview>;   // build → render → assertClean → size check; held in memory, oldest evicted past MAX_PREVIEWS; expired ones dropped on every call
  confirm(actor: Actor, projectId: string, previewId: string, contentHash: string): ShareSnapshotRecord;
  list(projectId: string): ShareSnapshotRecord[];
  htmlPath(shareId: string): string;        // join(dataDir, "projects", record.projectId, "share", `${shareId}.html`); assertId on both ids
  readHtml(shareId: string): string;        // NotFoundError (no record); SnapshotMissingError; SnapshotTamperedError when sha256 ≠ record.contentHash
}
// share/digests.ts
export function projectDigests(db: Db, ledger: Ledger, projectId: string, days: DigestDays, now?: () => Date): DailyDigest[];
// pages newest-first with ledger.list({ projectId, beforeSeq, limit: 500 }) and stops at the first entry older than the window start (UTC midnight, days-1 days ago)
```
`confirm` rules, in order: `actor.kind !== "human"` → `HumanRequiredError` (Plan 3's, from `intake/service.ts`); the preview must exist for that `projectId` and be unexpired, else `PreviewNotFoundError` when the id is unknown and `PreviewStaleError` when expired; `contentHash` must equal the preview's, else `PreviewStaleError`; then `mkdirSync(dirname(path), { recursive: true })`, `writeFileSync(path, html, { mode: 0o600 })`, then `commitEvent(share.confirmed { shareId: previewId, contentHash, bytes, sections: SHARE_SECTIONS, options, headSeq: ledger.headSeq() })`; if the commit throws, `rmSync(path, { force: true })` and rethrow; the preview is dropped on success. The `shareId` is the `previewId` (one random id per generation). `preview` refuses a page over `MAX_SHARE_BYTES` with `ShareTooLargeError` and holds nothing.

Routes (all behind auth; actor `{ kind: "human", id: "owner" }`):

| Method & path | Body / query | 2xx |
|---|---|---|
| `POST /api/projects/:id/share/preview` | `shareOptionsSchema.partial()`, merged over `DEFAULT_SHARE_OPTIONS` (so `{}` is the default) | 200 `{ previewId, contentHash, bytes, expiresAt, html, snapshot }` |
| `POST /api/projects/:id/share/confirm` | `{ previewId, contentHash }` | 201 `ShareSnapshotRecord` |
| `GET /api/projects/:id/share/snapshots` | — | `ShareSnapshotRecord[]` |
| `GET /api/share/snapshots/:id` | — | 200 `text/html; charset=utf-8` inline, headers `Content-Security-Policy: <SHARE_CSP>`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` |
| `GET /api/share/snapshots/:id/download` | — | the same bytes with `Content-Disposition: attachment; filename="theterminal-share-<id first 8>.html"` |
| `GET /api/projects/:id/digests` | `?days=7\|14\|30` (default 7) | `DailyDigest[]` newest first |

Error map (`routes.ts`): `PreviewNotFoundError` → 404 `preview_not_found`; `PreviewStaleError` → 409 `preview_stale`; `SnapshotMissingError` → 404 `snapshot_missing`; `SnapshotTamperedError` → 409 `snapshot_tampered`; `ShareTooLargeError` → 409 `share_too_large`; `ShareNotCleanError` → 409 `share_not_clean` (logged without the page). A read-only ledger: `confirm` → 423 (already mapped); `preview` works.

`server.ts`: constructs `const shareClean = shareCleaner({ dataDir, secrets: () => [token, ...secretEnvValues(process.env), ...connections.secretValues()] })` and `const share = new ShareService({ db, ledger, dataDir, clean: shareClean, build: (id, o) => buildSnapshot({ db, ledger, integrity: () => integrity, gates, connections: () => connections.list(), ci: () => github.ciStatus(), hardware: () => connections.hardware(), clean: shareClean }, id, o) })`, where `gates` is Plan 3's `GateService`, `github` 5B's client (`ci` resolves `null` when no github source) and `connections.hardware()` the `local_hardware` connection's config parsed to `HardwareInfo` or null (a small new `ConnectionService` method; null when absent).

- [ ] **Step 1: Write failing tests:**
  - service (memory db, a project with one card and one finished fake run whose output holds a stored secret): `preview()` → `bytes > 0`, `contentHash` = sha256 of `html`, `html` lacks the secret **(Review Focus 1)**; a second `preview` yields a new `previewId`; `confirm` writes `projects/<pid>/share/<id>.html` with mode `0o600` (non-Windows), commits one `share.confirmed` whose `contentHash` and `bytes` match, and `list()` has one record; **(Review Focus 2)** `confirm` with `previewId: "nope"` → `PreviewNotFoundError`; with the right id and `contentHash: "0".repeat(64)` → `PreviewStaleError`; with `now` advanced 11 minutes → `PreviewStaleError`; with actor `{ kind: "system", id: "runner" }` → `HumanRequiredError`; after each, `headSeq()` unchanged and the `share/` directory absent; a `build` whose pitch slips `sk-ant-TESTKEY-0000000000` past cleaning (inject `clean: (s) => s` into `build` only) → `preview` rejects with `ShareNotCleanError` and holds no preview **(Review Focus 1)**; `readHtml` returns the bytes; after appending one byte to the file → `SnapshotTamperedError`; after deleting it → `SnapshotMissingError`; a `render` returning 9 MiB → `ShareTooLargeError`; 21 previews → the oldest is gone;
  - digests: entries over three UTC days → `projectDigests(…, 7)` returns three digests newest first; `days: 7` with an entry 8 days old excludes it; another project's entries never appear; the page loop stops (assert the injected ledger's `list` was called with `beforeSeq`);
  - routes: each row of the table with status codes; `POST …/preview` with `{ digestDays: 9 }` → 400 `invalid_input`; the inline route's headers; the download's `Content-Disposition`; `GET /api/share/snapshots/<id>` after the file is tampered → 409 `snapshot_tampered`; `confirm` with a wrong hash → 409 `preview_stale` **(Review Focus 2)**; `GET …/digests?days=14` → the digests; a read-only ledger (broken chain fixture as in Plan 1's tests) → `preview` 200, `confirm` 423; every route → 401 without the cookie.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): preview and confirm a share page, recorded with its hash; serve and download confirmed snapshots; daily digests per project`

---

### Task 5: The read-only link server with a capability token

**Files:** Create `packages/core/src/share/link-server.ts`. Modify `packages/core/src/server/share-routes.ts`, `connection-routes.ts` (`/api/status`), `routes.ts`, `server.ts`, `index.ts`. Tests `packages/core/test/share/link-server.test.ts`, `packages/core/test/server/share-routes.test.ts`, `connection-routes.test.ts`.

**Interfaces:**
```ts
export const SHARE_PORT_DEFAULT = 4400, SHARE_PORT_ATTEMPTS = 21, MAX_TOKEN_FAILURES = 20, TOKEN_BYTES = 32;
export type ShareAddress = { address: string; scope: ShareScope; label: string };
export function shareAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): ShareAddress[];
// [{ address: "127.0.0.1", scope: "this_computer", label: "This computer only" }, then one per non-internal IPv4 { scope: "local_network", label: "Local network (<address>)" }]; IPv6 and internal interfaces skipped; deterministic order (interface name, then address)
export class ShareLinkActiveError extends Error {}     // "a share link is already live for this project"
export class AddressNotAllowedError extends Error {}   // "that address cannot be used"
export class LinkNotActiveError extends Error {}       // "the link is not live"
export type LinkManagerDeps = { db: Db; ledger: Ledger; service: ShareService; port?: number; addresses?: () => ShareAddress[];
  now?: () => Date; newId?: () => string; randomToken?: () => string /* 32 bytes base64url */ };
export class ShareLinkManager {
  constructor(deps: LinkManagerDeps);
  async create(actor: Actor, shareId: string, address: string, ttlMinutes: number): Promise<{ link: ShareLink; url: string }>;
  async revoke(actor: Actor, linkId: string): Promise<void>;     // reason "owner"
  list(projectId?: string): ShareLink[];
  activeCount(): number;
  recoverOnStartup(): void;                                      // every projection row with state 'active' → share.stopped { reason: "restart" }
  async shutdown(): Promise<void>;                               // close every listener, then share.stopped { reason: "shutdown" } each
}
```
`create`, in order: `actor.kind !== "human"` → `HumanRequiredError`; `ttlMinutes` must be one of `TTL_MINUTES` (ZodError otherwise); the snapshot record must exist (`NotFoundError`) and its bytes must read clean (`service.readHtml(shareId)`: tampered or missing fails here, before any listener); an active link for the same `projectId` → `ShareLinkActiveError`; `address` must equal an entry of `addresses()` → `AddressNotAllowedError`; token = `randomToken()` (`randomBytes(32).toString("base64url")`), digest = sha256 hex; a `Fastify()` instance with: an `onRequest` hook rejecting `request.headers.host !== `${address}:${port}`` with 403 `{}`; `GET`/`HEAD /:token` → `timingSafeEqual(digest(token), expectedDigest)` → the bytes with the headers of the Decisions section; a mismatch → `failures++`, 404 `{}`, and at `MAX_TOKEN_FAILURES` → `end("revoked", "too_many_failures")`; every other route → 404 `{}`; `setNotFoundHandler` the same; methods other than GET/HEAD → 405 `{}`. Listen on `address` at `port ?? SHARE_PORT_DEFAULT`, trying up to `SHARE_PORT_ATTEMPTS` ports on `EADDRINUSE` (port `0` in tests binds any). Then `commitEvent(share.link_created { linkId, shareId, tokenDigest, expiresAt, port, scope })` with `projectId` = the snapshot record's project (every `share.*` entry carries the project, so the projection and the digests scope them); a commit failure closes the listener and rethrows. A timer (`unref`) fires at `expiresAt` → `end("expired")`. `end(kind, reason?)` closes the listener (idempotent), then commits `share.expired { linkId }` / `share.revoked { linkId, reason }` / `share.stopped { linkId, reason }`. The returned `url` is `http://<address>:<port>/<token>`; it is never stored and never returned again. `revoke` of a link that is not `active` → `LinkNotActiveError`.

Routes:

| Method & path | Body | 2xx |
|---|---|---|
| `GET /api/share/addresses` | — | `ShareAddress[]` |
| `POST /api/share/snapshots/:id/links` | `{ address, ttlMinutes }` | 201 `{ link: ShareLink, url: string }` |
| `GET /api/share/links` | `?projectId=` optional | `ShareLink[]` |
| `DELETE /api/share/links/:id` | — | 204 |

Error map: `ShareLinkActiveError` → 409 `share_link_active`; `AddressNotAllowedError` → 400 `invalid_input`; `LinkNotActiveError` → 409 `link_not_active`. `/api/status` gains `shareLinks: number` (`countActiveShareLinks`). `server.ts`: `createServer` gains `sharePort?: number` (tests pass `0`); constructs the manager with `addresses: () => shareAddresses()`; calls `links.recoverOnStartup()` beside `runner.recoverOnStartup()` (skipped when the ledger is read-only); `close()` awaits `links.shutdown()` before `app.close()`.

- [ ] **Step 1: Write failing tests:**
  - `shareAddresses` over a fixture `{ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }, { address: "::1", family: "IPv6", internal: true }], en0: [{ address: "192.0.2.10", family: "IPv4", internal: false }, { address: "2001:db8::1", family: "IPv6", internal: false }] }` → exactly two entries with the labels above and `127.0.0.1` first;
  - manager (memory db, a confirmed snapshot from Task 4's service, `port: 0`, `addresses` fixed to loopback): `create` → `share.link_created` with a 64-hex `tokenDigest`, `scope: "this_computer"`, `expiresAt` = now + 24 h; `fetch(url)` → 200, body identical to `readHtml`, headers `content-security-policy`, `x-content-type-options: nosniff`, `cache-control: no-store`; **(Review Focus 3)** `fetch(url + "x")` → 404; 20 wrong tokens → `share.revoked { reason: "too_many_failures" }`, `list()[0].state` `revoked`, the right token → connection refused or 404; a fresh link: `POST` → 405; `GET http://127.0.0.1:<port>/api/ledger` → 404; `Host: evil.test` → 403; `now` advanced past `expiresAt` and the timer fired (inject `now` and use `vi.useFakeTimers`) → `share.expired`, 404; a second `create` for the same project while one is live → `ShareLinkActiveError`; `address: "0.0.0.0"` and `"192.0.2.1"` (not offered) → `AddressNotAllowedError` with nothing listening and nothing recorded; `ttlMinutes: 5` → ZodError; a tampered snapshot file → `SnapshotTamperedError` before listening; actor system → `HumanRequiredError`; the response for a wrong token and for an unknown path are byte-identical (`{}`); the `url` string contains the token and no API response afterwards does (`list()` serialised lacks it);
  - **(Review Focus 4)** `shutdown()` with a live link → `share.stopped { reason: "shutdown" }` and the port refuses connections; a projection row inserted as `active` (through a ledger `share.link_created` entry with no listener) → `recoverOnStartup()` commits `share.stopped { reason: "restart" }` and opens nothing; `activeCount()` 1 → 0;
  - routes: each row with status codes; `/api/status.shareLinks` 0 → 1 → 0 after `DELETE`; `DELETE` of a revoked link → 409 `link_not_active`; every route → 401 without the cookie; `createServer({ sharePort: 0 })` closes cleanly with a live link (the e2e teardown relies on it).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): read-only share links on this computer or the local network, behind a one-time token that expires, can be revoked and is recorded`

---

### Task 6: The Share view, the share preview tab, links, the Digest panel

**Files:** Create `apps/ui/src/views/ShareSideBar.tsx`, `SharePanel.tsx`, `DigestPanel.tsx`, `apps/ui/src/components/ShareLinkForm.tsx`. Modify `apps/ui/src/api.ts`, `shell/{views,Dock,dock-layout,Workbench,SideBar,StatusBar,model}.ts(x)`, `views/LedgerSideBar.tsx`, `App.tsx`, `styles.css`, `test/test-dock.tsx`. Tests `apps/ui/test/{ShareSideBar,SharePanel,ShareLinkForm,DigestPanel,StatusBar,ActivityBar,Workbench,LedgerSideBar}.test.tsx`.

**Interfaces and copy:**
```ts
// views.ts
export const VIEWS = ["board", "agents", "changes", "needs_you", "ledger", "connections", "github", "capacity", "share", "learn"] as const;   // VIEW_LABELS gains share: "Share"
// Dock.tsx
export type DockPanelId = … | "share" | "digest";   // DEFAULTS gains share { title: "Share", where: "main" }, digest { title: "Daily digest", where: "main" }; PANELS gains share: SharePanel, digest: DigestPanel
// api.ts
Status gains shareLinks: number;
previewShare(projectId, options: ShareOptions): Promise<SharePreview>;   // { previewId, contentHash, bytes, expiresAt, html, snapshot }
confirmShare(projectId, previewId, contentHash): Promise<ShareSnapshotRecord>;
listShareSnapshots(projectId): Promise<ShareSnapshotRecord[]>;
shareSnapshotUrl(id): string;            // "/api/share/snapshots/<id>" (open in a new tab: view, present, print)
shareDownloadUrl(id): string;            // "/api/share/snapshots/<id>/download"
listShareAddresses(): Promise<ShareAddress[]>;
createShareLink(shareId, address, ttlMinutes): Promise<{ link: ShareLink; url: string }>;
listShareLinks(projectId?): Promise<ShareLink[]>;
revokeShareLink(id): Promise<void>;
getDigests(projectId, days: DigestDays): Promise<DailyDigest[]>;
// errorMessage: preview_stale → "The preview has changed or expired. Preview again before confirming."; share_not_clean → "The page could not be cleaned of sensitive text and was not generated."; share_too_large → "The page is too large to share. Choose fewer digest days."; share_link_active → "A link is already live for this project. Revoke it first."; snapshot_tampered → "This snapshot's file no longer matches the ledger. It will not be shared."; snapshot_missing → "This snapshot's file is missing."; link_not_active → "That link is no longer live."
// model.ts
share: { options: ShareOptions; onOptionsChange(o: ShareOptions): void; preview: SharePreview | null; previewing: boolean; onPreview(): Promise<boolean>; onConfirm(): Promise<boolean>;
  snapshots: ShareSnapshotRecord[]; links: ShareLink[]; addresses: ShareAddress[]; onCreateLink(shareId, address, ttlMinutes): Promise<{ url: string } | null>; onRevokeLink(id): Promise<boolean> };
  // snapshots and links reload on any share.* entry of the project; addresses load when the Share view opens
digests: { days: DigestDays; onDaysChange(d: DigestDays): void; list: DailyDigest[] | null };   // reloaded on any entry of the selected project, coalesced
```
- `ShareSideBar` (`Share`): without a project `Select or create a project.`; otherwise section `Share this project`: `fieldset` legend `Include`, checkboxes `Include my prompts to agents` and `Include this computer's hardware`, a `select` `aria-label="Digest days"` with `7`, `14`, `30` labelled `Last 7 days` …; the sentence `Everything else that is private stays out: secrets, file contents, raw agent output, account details.`; button `Preview share page` (calls `onPreview`, then `dock.focus("share")`). Section `Saved snapshots`: `ul[aria-label="Saved snapshots"]` rows `<confirmedAt date> · <bytes in KB> KB · #<id first 8>` with buttons `Open` (`window.open(shareSnapshotUrl(id))`), `Download` (`<a download href={shareDownloadUrl(id)}>`), `Share on your network…` (reveals `ShareLinkForm`); `No snapshots yet. Preview and confirm one.` when empty. Section `Live links`: `ul[aria-label="Live links"]` rows `<scope label> · until <expiresAt> · port <port>` with `Revoke`; the note `Links work only while The Terminal is running on this computer.`; `No live links.` when none. Section `Daily digest`: button `Open daily digest` (`dock.focus("digest")`).
- `SharePanel` (`section[aria-label="Share preview"]`): without a preview `Choose what to include in the Share view and press Preview share page.`; with one: heading `This is exactly what will be shared`, `<bytes> bytes · hash <contentHash first 12> · preview expires <expiresAt>`, a two-column body: `<iframe title="Share page preview" sandbox="" srcDoc={html}>` and an aside `Not included` listing `snapshot.hidden`; below, a checkbox labelled exactly `I have read this page and I am happy to share everything on it.` and a button `Confirm and save snapshot` enabled only when ticked (calls `onConfirm`); on success the panel shows `Saved. Open, download or share it from the Share view.` and the checkbox resets; on `preview_stale` the error copy above and the preview is cleared.
- `ShareLinkForm` (`form[aria-label="Share on your network"]`): `select` `aria-label="Address"` of `addresses` by label; `select` `aria-label="Valid for"` with `1 hour`, `8 hours`, `24 hours` (default), `7 days`; the sentence `Anyone with the link can read this snapshot, and nothing else, until it expires or you revoke it. It works only while The Terminal is running.`; button `Create link` → on success shows `<input readOnly aria-label="Share link" value={url}>` and a `Copy` button (`navigator.clipboard.writeText`, guarded) and the note `This link is shown once. Copy it now.`; errors by `errorMessage`.
- `DigestPanel` (`section[aria-label="Daily digest"]`): a `select` `aria-label="Days"` (7/14/30); one `<article>` per digest with `<h3><day> (UTC)</h3>`, the summary, the items (time, headline, `attention`/`override` classes as the ledger panel), `and <more> more` when cut; `No entries in this window.` when the list is empty; `Loading…` while null.
- Status bar: when `status.shareLinks > 0`, an item `Sharing: <n> link(s) live` with class `attention` (clicking selects `share`); absent at 0. Ledger side bar: the topic checkbox `Share` (topic `share`) after `Override`. `LedgerPanel` already paints `attention`.
- `TestDock` registers `share` and `digest`.

- [ ] **Step 1: Write failing tests:**
  - ActivityBar renders ten labels with `Share` ninth and `Learn` last (update Plan 4's "nine" assertions);
  - ShareSideBar: `Preview share page` calls `onPreview` then focuses `share` (TestDock); the checkbox calls `onOptionsChange({ …, includePrompts: true })`; a saved snapshot row shows `Download` with the `download` attribute and `href` `/api/share/snapshots/<id>/download`; `Revoke` calls `onRevokeLink(id)`; empty states;
  - SharePanel: with a preview the iframe has `sandbox=""` and `srcdoc` containing the project name; `Confirm and save snapshot` is disabled until the checkbox is ticked, then calls `onConfirm`; the `Not included` aside lists nine items; a rejected `onConfirm` with `preview_stale` shows the copy and clears the preview;
  - ShareLinkForm: `Create link` calls `onCreateLink(shareId, "127.0.0.1", 1440)`; the url renders once in the `Share link` input with `This link is shown once. Copy it now.`;
  - DigestPanel: renders `2026-11-15 (UTC)`, the summary, an item headline, and `and 3 more`; changing days calls `onDaysChange(30)`;
  - StatusBar: `shareLinks: 2` → `Sharing: 2 links live` with class `attention`; `shareLinks: 0` → absent;
  - LedgerSideBar: ten topic checkboxes including `Share`;
  - Workbench: a pending action's decision card still renders in the strip with the `share` view active and the bottom panel closed (Review Focus 5 of 5A, extended).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): Share view with a previewed and confirmed share page, downloads, network links and a daily digest panel`

---

### Task 7: Documentation and changelog

**Files:** Create `docs/share-view.md`. Modify `CHANGELOG.md` (an `Added` block for this plan under Unreleased), `README.md` (one paragraph in "What it does today": the share page and the daily digest). Tests: none beyond `pnpm test` staying green; the doc is reviewed by reading.

`docs/share-view.md` covers: what the share page is (one file, no script, no external request, the CSP) and why; the sections and where each comes from in the ledger; what is included and the exact hidden list, with the two opt-ins; the cleaning steps in order and the final check that refuses an unclean page; preview and confirm (ten-minute previews, the hash, what `share.confirmed` records, where the file lives and that it is verified against the ledger before being served again); evidence references and how to verify them against the audit export; present mode and printing to PDF; links (addresses offered and why never `0.0.0.0`, durations, the one-time token and its digest, what the link server answers and refuses, twenty wrong tokens, expiry, revocation, shutdown and restart, that the ledger records no address); daily digests (UTC days, the allowlist, prompts never, the summary template); what later plans add (Plan 8: cloud sharing, Viewer accounts, named owners; the operate pack: live demo link, uptime; model names per run).

- [ ] **Step 1:** Write the sections. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: the share view: what is shared, how it is cleaned and confirmed, links and daily digests`

---

### Task 8: End-to-end: preview to confirmed page, download, a link on this computer, the digest

**Files:** Create `e2e/share.spec.ts`, `e2e/digest.spec.ts`. Modify `e2e/global-setup.ts` (the agent server passes `sharePort: 0`, exposes nothing new; the existing fake script already outputs the opaque test key from its shell step and Plan 4's `write` step writes `notes.txt`), `e2e/shell.spec.ts` (ten views).

- [ ] **Step 1: Write the failing e2e tests:**
  - share: store the Claude test key as in `connections.spec.ts`; create project `Book Club` with pitch `Reading lists for a club, someone@example.test`; add a card `Login` in Build; Agents → start the fake agent on `Login` with prompt `Build the login page` → allow the shell step → wait for `completed`; `Share` → `Preview share page` → the `Share preview` tab shows an iframe whose document contains `Book Club`, `Reading lists for a club, [email]`, `Login`, `wants to run the command "nvidia-smi"` and `estimate`, and does not contain `zq-TESTKEY` (the shell output and the written file's contents), `Build the login page` or `sk-ant-TESTKEY` **(Review Focus 1, 5)**; tick `Include my prompts to agents` → preview again → the iframe contains `Build the login page`; tick the acknowledgement → `Confirm and save snapshot` → `Saved.`; the ledger shows `Owner confirmed a share page (12 sections,`; the side bar lists one snapshot; `Download` saves `theterminal-share-<8>.html` whose bytes contain no `<script` and whose sha256 equals the `contentHash` from `GET /api/projects/<id>/share/snapshots`; every response body during the spec is checked for the two keys;
  - link: `Share on your network…` → address `This computer only`, `24 hours` → `Create link` → the `Share link` input shows `http://127.0.0.1:<port>/<token>`; from the test (a plain `fetch`, no cookie) → 200 and bytes identical to the download; `<url>x` → 404; `POST <url>` → 405; the status bar shows `Sharing: 1 link live`; `Revoke` → the status item disappears and `fetch(url)` fails or answers 404 **(Review Focus 3)**; `GET /api/share/links` without the cookie → 401;
  - digest: `Open daily digest` → the `Daily digest` tab shows today's day with `(UTC)`, a summary containing `1 agent action requested, 1 allowed and 0 denied by a human` and the item `Owner started a Fake agent on "Login"`, and no item containing `Build the login page` or `zq-TESTKEY`;
  - shell: the activity bar shows ten views with `Share` before `Learn`.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows. Open the pull request from `plan-7-share-view` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): share page preview, confirmation, download, a local link and the daily digest`

---

## Done when

- The Owner previews a share page built from the project's ledger: plan summary, progress, headline numbers with `estimate` where computed, what it does and why, a tech stack with plain-language whys and ledger evidence, the agent workforce and its cost, what is waiting on a human, decisions with their owner and evidence, readiness gates, daily digests and the audit status; sees the list of what is not included; confirms; and the confirmation is in the ledger with the page's hash.
- The page is one HTML file with no script, no external request and a CSP that forbids both; secrets, paths, the username, emails, raw agent output, file contents, prompts (unless asked), connection details and other projects are absent; a page that cannot be proven clean is not generated.
- A confirmed snapshot can be opened, presented, printed to PDF and downloaded, and served read-only on this computer or the local network behind a one-time token that expires, can be revoked, is revoked after twenty wrong guesses, stops when The Terminal closes or restarts, and is recorded in the ledger without the address.
- Every day of a project reads as a deterministic digest in the workspace and on the page, in UTC, with prompts and raw output never included.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI; the work is merged to `main` through a pull request.
