# Plan 8: Cloud and Collaboration Implementation Plan

**Goal:** Other people join the Owner's workspace with their own identity and role, see the same board and ledger, decide and sign off what their role allows, and trigger runs that use the Owner's connections without ever seeing a credential; every ledger entry names the person who caused it. The workspace stays local-first: the Owner hosts it, on their own machine over the LAN or on a Linux server they run (the same server code, packaged as a container image), behind a separate TLS listener that is off by default and whose every state change is in the ledger and in the status bar.

**Architecture:**
- **People are ledger state.** `person.*` events (invited, joined, credential added or removed, renamed, role changed, removed, signed in, locked) and `remote.*` events (enabled, disabled, certificate changed) are ordinary ledger entries with projections (`people`, `credentials`, `invites`, `remote`). The Owner is the pre-existing actor id `owner`, so every entry written since Plan 1 is already attributed to the right person. Sessions, WebAuthn signature counters, lockout counters and challenges are **not** ledger state: they are revocable auth bookkeeping in two plain tables (`sessions`, `credential_state`) and in memory.
- **One Fastify instance, two listeners.** The existing HTTP server keeps listening on `127.0.0.1`. The remote listener is a `tls.Server` that hands every secure socket to the same HTTP server (`app.server.emit("connection", socket)`), so there is one route table, one auth hook and one WebSocket server; a request knows its listener from `request.raw.socket.encrypted`. The local listener accepts the Owner's token (as today) or a session; the remote listener accepts sessions only, never the token, and its cookies are `Secure`.
- **Identity.** An invite is a one-time 128-bit code in a link; joining registers a **passkey** (WebAuthn through `@simplewebauthn/server`, discoverable, attestation `none`) or, where passkeys cannot work (the origin is an IP address, or the browser has no WebAuthn), a **non-extractable Ed25519 key** made by the browser's WebCrypto and verified by `node:crypto`. The same Ed25519 path serves non-browser clients (Plan 6's linked machines, the CLI). A session is a random 32-byte id stored hashed, bound to the listener it was created on.
- **Authorisation is a strict lattice** `viewer < reviewer < maintainer < owner`; every route declares its minimum role in one table (`ROUTE_ROLES`), and a test asserts every registered `/api/*` route is in it. Gates keep Plan 3's engine and gain a requirement (`{ role }` or `{ personId }`, default per gate) that the signer must satisfy.
- **Credentials never leave the host.** Runs started by collaborators resolve credentials from the Owner's connections exactly as today (the runner never knew who asked); non-owners see connections as summaries (name, kind, status) and, per spec §10.3, their runs use API keys, never the Owner's personal subscription.
- **Self-hosting.** `Dockerfile` builds the core and UI on `node:24.22.2-bookworm-slim`, runs as `node`, keeps `/data` as the data folder, starts with the remote listener on and prints a one-time Owner bootstrap invite when no Owner credential exists. Because a headless Linux server has no keychain, an AES-256-GCM `FileSecretStore` keyed by a key file outside the ledger is selectable **only** by an explicit CLI flag.

**Tech Stack:** existing stack, plus `@simplewebauthn/server` **14.0.3** (MIT, Node ≥ 20, published 2026-09-25; 14.1.0 of 2026-11-06 is under two weeks old on 2026-11-15) in core and `@simplewebauthn/browser` **14.0.0** (MIT, 2026-09-02) in the UI; `@peculiar/x509` **2.2.0** (MIT, 2026-10-15; the same major `@simplewebauthn/server` already depends on, so one copy) for the self-signed certificate; `acme-client` **5.4.0** (MIT, 2024-07-16; the only maintained Node ACME client; HTTP-01 only) for certificates from Let's Encrypt when the Owner sets a domain. Ed25519 signing and verification, AES-256-GCM, SHA-256 and random ids come from `node:crypto`; TLS from `node:tls`. No rate-limit dependency: the limiter is forty lines (`throttle.ts`). All new dependencies are exact versions; every newly reported build script gets `false` in `allowBuilds`.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §2 goal 8 (self-hostable) and goal 9 (offline: LAN keeps working), §4.1 "Own cloud" (collaborators can log in; credentials never touch a third party) and "Own local address", §4.5 (roles; every ledger entry names a person; gates can require a specific person or role; presence; collaborators use connections through the workspace without seeing credentials), §5 (a named human signs off), §8 (credentials stay with the Owner; the ledger is complete), §10.3 (collaborators and cloud agents use API keys), §12 calls 5 and 9. Builds on Plans 1–5B, 3, 4, 6, 7 and 9A (all assumed built): Plan 3's `commitEvents`, `HumanRequiredError`, `GateService.move`, `GateEvaluation`, `narrate`/`NarrationContext`; Plan 4's `override.*` and presets; Plan 6's paired Ed25519 machine identities (this plan's key login is what a linked machine uses); Plan 7's share view (read by viewers here); Plan 9A's `cli.ts` IPC, data-folder lock and `allowlistedEnv`. The branch is cut from `main` after Plan 7 merges.

## Decisions

- **Decision (controller default): topology stays local-first; collaboration means people get their own identity and role on a workspace the Owner hosts, on the Owner's machine over the LAN or on a self-hosted Linux server running the same server code, packaged with a `Dockerfile`; no vendor-hosted SaaS and no one-click cloud deploy in this plan.** Why: spec §2 non-goal ("making money from hosting"), §4.1 (the own-cloud home runs *the same workspace*), §8 (credentials stay with the Owner). The one-click deploy into the Owner's cloud account (§4.1) needs the infrastructure lifecycle pack; the container image is what it will deploy.
- **Decision (controller default): identity is an invite link carrying a one-time code, a passkey or an Ed25519 key per person, and a session per person per listener; the Owner keeps the local token for the local listener and must add a passkey or key before remote access can be turned on, because the token never travels.** Why: spec §4.5 ("every ledger entry names a person"); passkeys are phishing-resistant and need no password store; an Ed25519 key is the fallback for origins that are IP addresses (WebAuthn forbids an IP as RP ID) and the identity a non-browser client (Plan 6) can hold; a one-time code means a leaked link is useless after the first use.
- **Decision (controller default): four roles in a strict order, `viewer < reviewer < maintainer < owner`.** Viewer: read everything the Owner sees except connection details and people management (board, stories, ledger, feed, capacity, share view, who is present). Reviewer: viewer plus deciding agent actions, making intake decisions, moving cards and signing off or waiving gates whose requirement they satisfy. Maintainer: reviewer plus starting and stopping runs (on API keys), creating cards, starting, answering and reopening the intake, asking agents, and giving a run access to connections by name. Owner: everything, alone: connections, provider auth modes, people, remote access, gate requirements, emergency override, capacity detection. Spec §4.5's Approver and Auditor map to `reviewer` and `viewer`. Why: a strict order is explainable in one sentence and testable in one table; separation of duties comes from gate requirements, not from a second axis.
- **Decision (controller default): gates carry a requirement, `{ role }` or `{ personId }`, with defaults `reviewer` for `plan_approved` and `ready_to_ship` and `owner` for `network_exposure`, `payments`, `personal_data`, `go_live` and `over_budget`; the Owner changes a requirement per project with a recorded `gate.requirement_set`; a `{ personId }` requirement is satisfied by that person only, the Owner included, so the Owner's way past it is to change the requirement first, which the ledger shows.** Why: spec §4.5 ("gates can require a specific person or role") and §5 (a *named* human signs off); a silent Owner bypass would make the requirement decorative.
- **Decision (controller default): a run started by anyone but the Owner runs in `api_key` mode; when the provider has no API key the start is refused with `api_key_required`.** Why: spec §10.3 (consumer plans are licensed for one person; collaborators use API keys) and §2 anti-goal "getting around providers' rules".
- **Decision (controller default): the remote listener is a separate TLS port (default 4318) bound to `0.0.0.0`, off by default; turning it on or off and every certificate change are ledger entries and the status bar shows `Remote: on` in the attention colour. TLS is self-signed by default (ECDSA P-256, 10 years, SANs for the machine's addresses and `.local` name), with the certificate's SHA-256 fingerprint shown in the People view and carried in every invite link; when the Owner sets a domain the certificate comes from ACME over HTTP-01 (port 80), renewed 30 days before expiry; the Owner may instead point at their own certificate and key files.** Why: §4.1 "own local address" keeps the local workspace at `theterminal.localhost` and never exposed; a separate port makes "exposed to the network" a single switch the ledger can record; pinning is real for non-browser clients (Plan 6, the desktop app) and a visible comparison for browsers, and the UI says plainly that a domain is needed for browsers to verify the certificate.
- **Decision (controller default): auth-sensitive routes are rate-limited per source address (10 per minute, 429) and a person is locked for 15 minutes after 5 failed sign-ins (423, recorded as `person.locked`).** Why: the brief; codes and challenges are 128-bit so the limiter protects the passkey and key paths and the server's CPU, not the code space.
- **Decision (controller default): the host is the single writer; clients submit commands (HTTP) and receive the ordered ledger (WebSocket); there is no client-side ledger and no merge.** Why: the hash chain has one `prevHash` per entry, so one process must order appends; every write already goes through `commitEvent(s)` in one SQLite transaction. Plan 6's linked machines submit commands to the project's host in the same way.
- **Decision (controller default): sessions, challenges, WebAuthn counters and lockout counters are not ledger events; sign-ins, invites, joins, role changes, removals and lockouts are.** Why: the ledger records decisions and actions people are accountable for (spec §5); a session row is revocable state that must be deletable, which an append-only ledger is not; presence is live state, not history.
- **Decision (controller default): on a headless Linux server the secret store is an encrypted file (`FileSecretStore`, AES-256-GCM, one nonce per value, key from a file the CLI is pointed at), chosen only by `--secret-store file --secret-key-file <path>`; the keychain stays the default everywhere and the UI's copy changes from `your keychain` to `this server's encrypted secret store` when the status reports `secretStore: "file"`.** Why: a container has no Secret Service; the alternative, a server that cannot hold connections, cannot run agents; the key file lives outside the ledger and the database and the Owner controls where (a mounted secret). This loosens 5A's "keychain only" and is flagged for the author under Spec gaps.
- **Decision (controller default): the remote Host check accepts, when a domain is set, exactly that domain with the remote port; otherwise only hostnames that are IP literals or end in `.local`, with the remote port.** Why: DNS rebinding needs a public name, which neither form is; a `.local` name is what mDNS gives a LAN machine and what a passkey needs as RP ID.
- **Decision (controller default): the Linux image is a CI build and smoke test on `ubuntu-latest`, not a third test matrix entry.** Why: the brief asks for macOS and Windows CI plus a Linux build of the server image; the image's build stage runs `pnpm build`, and the smoke test proves the container starts, serves TLS with the fingerprint it printed and answers `/healthz`.

## Out of scope (later plans)

- One-click deploy of the image into the Owner's AWS/GCP/Azure account (§4.1): the infrastructure pack, using Plan 5B's cloud grants. Plan 8 ships the image and documents `docker run`.
- A hosted version of any kind (§2 non-goal). Email or push invitations: the Owner copies the link.
- Per-card or per-stage permissions; a second permission axis ("their area" in §4.5's Approver): gate requirements cover it.
- Signing ledger entries with the person's key (a verifiable ledger of who wrote what). The ledger names the person; the host vouches.
- Comments and discussion threads between collaborators; notifications.
- TLS-ALPN-01, DNS-01 and wildcard certificates; a reverse proxy; HTTP/2.
- Linking a second Terminal (Plan 6) and the share view's public link (Plan 7) are consumed, not changed, here.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, workflow logs or commit messages. Test people are `Reviewer One`, `Maintainer Two`; test hosts are `tt-test.local` and `127.0.0.1`; invite codes, challenges and session ids in fixtures are generated at test time, never literal.
- **Nothing personal beyond a chosen display name.** A person's display name (1–60 characters, checked with `redact`) is the only personal field anywhere; no email, no login, no IP address, no user agent is recorded in the ledger, the database or a response. The throttle keys on an address in memory only.
- **Default-deny auth, now with roles.** Every `/api/*` route except the public auth and join routes requires a principal, and every one declares a minimum role in `ROUTE_ROLES`; a route missing from the table fails the `routes-have-roles` test. Over the remote listener the token is never accepted and `/?token=` answers 401.
- **Credentials stay with the Owner.** No response to a non-owner contains a connection's `config`, `private`, `secretFields`, a credential value, a certificate private key or an ACME account key. The private TLS key and the ACME account key live in the secret store; the certificate (public) is a file. The remote listener's key material is never in the ledger or a response.
- **Keychain-only secrets, with the one explicit exception:** `FileSecretStore` is selected only by `--secret-store file`, never by environment variable or default, and `THETERMINAL_SECRET_STORE=memory` keeps requiring `THETERMINAL_FAKE_AGENT=1`.
- **Every child environment is built by `buildChildEnv`;** nothing in this plan spawns a process at all except the ACME client's HTTPS requests (in-process `fetch`-like through `axios`, no shell). No `shell: true` anywhere, including the Dockerfile's `ENTRYPOINT` (exec form).
- **Redact before truncating; fail closed.** Names, invite errors and WebAuthn errors pass through `redact()` and are then clipped; a WebAuthn or signature verification error of any kind is `401 invalid_credential` with no detail; a session whose person was removed or whose listener differs is `401`; an invite that is unknown, used, expired or revoked is `404 invite_invalid` (one code for all four); the remote listener refuses to start without a certificate rather than falling back to plain HTTP; a ledger that is read-only refuses sign-ins (they are recorded) with 423.
- **Every write names the person.** No route constant actor remains: `actor` is `{ kind: "human", id: request.principal.personId }` everywhere a human acts; `system` actors stay for the runner, policy and the CLI.
- **The ledger records the exposure.** `remote.enabled` / `remote.disabled` / `remote.certificate_changed` are committed before the listener starts or after it stops, and the status bar reflects the projection, not a flag.
- **Projections rebuild exactly** from the ledger for `people`, `credentials`, `invites`, `remote` and `gate_requirements`; `sessions` and `credential_state` are not projections and are not in `PROJECTION_TABLES`.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`:** `THETERMINAL_FAKE_ACME=1` (a fake ACME directory in-process) and `THETERMINAL_FAKE_TIME` are ignored otherwise. WebAuthn tests use a software authenticator built in the test (`test/fixtures/webauthn.ts`), never a real one.
- **Platform.** CI stays green on macOS and Windows for `pnpm test` and `pnpm e2e`; a `server-image` job on `ubuntu-latest` builds and smoke-tests the container. The CLI's new flags work on all three; paths travel through `node:path`.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-8-cloud-collaboration`, one commit per task, pushed when it lands, and merges through a pull request once CI is green. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1–7/9A constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, `127.0.0.1` for the local listener, every agent action gated before it runs, allowlisted child env, live redaction, narration pure, estimates labelled, overrides in red, data-folder lock).

## Review Focus

1. **A collaborator reaching for a credential.** A maintainer calls `GET /api/connections`, `GET /api/connections/:id`, `PATCH`, `POST …/test`, `GET /api/capacity`, then starts a run with `connectionIds: [awsId]` and the fake agent prints its environment. Expected: the list is `ConnectionSummary[]` (no `config`, `private`, `secretFields`), the item and the writes are 403 `forbidden`, the run starts and its recorded output shows `[REDACTED]`, and no response during the sequence contains the key or the minted token. (Tests in Tasks 4 and 12.)
2. **The Owner's token over the remote listener.** `Authorization: Bearer <token>` and `GET /?token=<token>` arrive over TLS; a `tt_session` cookie minted on the local listener is replayed over TLS; a remote session cookie is replayed on the local listener. Expected: 401 in every case, no redirect carrying the token, no `person.signed_in`. (Tests in Task 6.)
3. **A person removed or demoted mid-session.** A reviewer holds a session and an open `/api/events` socket; the Owner demotes them to viewer, then removes them. Expected: after the demotion the next `POST /api/actions/:id/decision` is 403 and the socket stays open; after the removal the next request is 401, the socket closes with 1008 within a second, presence no longer lists them, and `people` shows them removed. (Tests in Tasks 2, 3 and 8.)
4. **Brute force.** Eleven `GET /api/join/<random>` from one address in a minute; five wrong passkey assertions for one person, then a correct one; a wrong Ed25519 signature; a challenge reused. Expected: the eleventh is 429 `rate_limited` with `retryAfterS`; the sixth attempt is 423 `locked` although it is valid, `person.locked` is recorded once, and a correct assertion after 15 minutes signs in; the bad signature and the reused challenge are 401 `invalid_credential` with no detail. (Tests in Task 3.)
5. **A gate signed by the wrong person.** A reviewer signs off `go_live`; the Owner sets `ready_to_ship`'s requirement to `{ personId: <maintainer> }` and a different maintainer signs it; the Owner then signs it. Expected: 403 `gate_requires` naming the gate and the requirement, nothing recorded, the card unmoved, in all three cases; after `gate.requirement_set` back to `{ role: "reviewer" }` the first reviewer's sign-off is recorded with `signedBy` equal to their person id. (Tests in Task 5.)

---

## File Structure

```
packages/shared/src/people.ts                 # roles, Person/Credential/Invite/Remote types, person.* and remote.* schemas (Task 0)
packages/shared/src/gates.ts                  # (modify) GateRequirement, defaults, satisfies, gate.requirement_set (Task 0)
packages/shared/src/narration.ts              # (modify) human actor → person name from ctx (Task 0)
packages/shared/src/events.ts, index.ts       # (modify)

packages/core/src/people/service.ts           # PeopleService: invites, join, credentials, roles, removal, lockouts (Task 1)
packages/core/src/people/sessions.ts          # SessionStore (hashed ids, listener-bound, revocation) (Task 1)
packages/core/src/people/challenges.ts        # ChallengeStore (in memory, 5 min, single use) (Task 1)
packages/core/src/people/webauthn.ts          # registration/authentication options and verification (Task 3)
packages/core/src/people/ed25519.ts           # verifyKeyLogin, keyCredentialId (Task 3)
packages/core/src/server/auth.ts              # (rewrite) principal, listeners, requireRole, ROUTE_ROLES check (Task 2)
packages/core/src/server/throttle.ts          # Throttle (Task 2)
packages/core/src/server/people-routes.ts     # /api/people*, /api/me*, /api/join/*, /api/auth/* (Task 3)
packages/core/src/server/remote.ts            # RemoteListener: tls.Server → app.server, certificate sources (Task 6)
packages/core/src/server/certs.ts             # selfSignedCertificate, fingerprint, loadProvided (Task 6)
packages/core/src/server/acme.ts              # AcmeManager (HTTP-01, renewal), fakeAcme (Task 7)
packages/core/src/server/remote-routes.ts     # GET/PUT /api/remote, /healthz, /.well-known/acme-challenge (Tasks 6, 7)
packages/core/src/server/presence.ts          # PresenceRegistry (Task 8)
packages/core/src/server/events-ws.ts         # (modify) principal on connect, presence messages, close on revoke (Task 8)
packages/core/src/server/{routes,agent-routes,connection-routes,capacity-routes,intake-routes,story-routes,override-routes,github-routes}.ts  # (modify) principal actor, ROUTE_ROLES (Task 4)
packages/core/src/gates/service.ts            # (modify) requirement check, requirement_set (Task 5)
packages/core/src/secrets/file-store.ts       # FileSecretStore (Task 10)
packages/core/src/healthcheck.ts              # container HEALTHCHECK entry (Task 10)
packages/core/src/events/projections.ts       # (modify) people, credentials, invites, remote, gate_requirements reducers (Task 1)
packages/core/src/db.ts                       # (modify) migration: projections + sessions + credential_state (Task 1)
packages/core/src/server/server.ts            # (modify) wire people, sessions, remote, presence, bootstrap invite (Tasks 2, 6, 10)
packages/core/src/cli.ts                      # (modify) --remote, --remote-port, --remote-bind, --remote-domain, --secret-store, --secret-key-file (Task 10)
packages/core/test/fixtures/webauthn.ts       # software authenticator for tests (Task 3)

apps/ui/src/pages/JoinPage.tsx                # /join/<code> (Task 9)
apps/ui/src/pages/SignInPage.tsx              # /sign-in (Task 9)
apps/ui/src/identity.ts                       # WebCrypto Ed25519 key in IndexedDB; passkey calls (Task 9)
apps/ui/src/views/PeopleSideBar.tsx           # people, invites, remote access (Task 9)
apps/ui/src/views/PeoplePanel.tsx             # main tab: people table, sessions, remote access form (Task 9)
apps/ui/src/components/InviteDialog.tsx       # (Task 9)
apps/ui/src/shell/{views,model,StatusBar,ActivityBar,Workbench}.tsx  # (modify) people view, me, remote item, role gating (Task 9)
apps/ui/src/main.tsx, api.ts                  # (modify) page routing; people/auth/remote calls (Task 9)
apps/ui/src/components/{GateCard,ConnectionsSideBar,ConnectionEditor,AgentPanel}.tsx  # (modify) requirement copy, summaries, api-key note (Tasks 4, 5, 9)

Dockerfile, .dockerignore                     # (Task 10)
.github/workflows/ci.yml                      # (modify) server-image job (Task 10)
docs/collaboration.md, docs/self-hosting.md   # (Task 11)
docs/connections-and-credentials.md, CHANGELOG.md, README.md  # (modify) (Task 11)
e2e/people.spec.ts, e2e/remote.spec.ts, e2e/global-setup.ts  # (Task 12)
```

---

### Task 0: Shared people domain, gate requirements and narration of people

**Files:** Create `packages/shared/src/people.ts`. Modify `packages/shared/src/gates.ts`, `narration.ts`, `events.ts`, `index.ts`. Tests `packages/shared/test/{people,gates,narration,domain}.test.ts`.

**Interfaces:**
```ts
// shared/people.ts
export const ROLES = ["viewer", "reviewer", "maintainer", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, reviewer: 1, maintainer: 2, owner: 3 };
export function atLeast(role: Role, min: Role): boolean;
export const ROLE_LABELS: Record<Role, string> = { viewer: "Viewer", reviewer: "Reviewer", maintainer: "Maintainer", owner: "Owner" };
export const ROLE_DESCRIPTIONS: Record<Role, string>;   // exact copy below
export const OWNER_ID = "owner";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export type Listener = "local" | "remote";
export type SignInMethod = "token" | "passkey" | "key";
export type Credential =
  | { kind: "passkey"; credentialId: string; publicKey: string; transports: string[]; label: string }   // base64url; COSE key
  | { kind: "key"; credentialId: string; publicKey: string; label: string };                              // credentialId = base64url(sha256(publicKey)); publicKey = base64url SPKI DER
export type Person = { id: string; name: string; role: Role; joinedAt: string | null; lastSeenAt: string | null; removedAt: string | null; credentials: number };
export type PersonWithCredentials = Person & { credentialList: Omit<Credential, "publicKey">[] };
export type Invite = { id: string; role: Role; createdAt: string; expiresAt: string; status: "pending" | "used" | "revoked" | "expired" };   // role "owner" only for the bootstrap invite (Task 10)
export type Me = { personId: string; name: string; role: Role; listener: Listener; method: SignInMethod; credentials: Omit<Credential, "publicKey">[]; sessions: { id: string; listener: Listener; createdAt: string; lastSeenAt: string; current: boolean }[] };
export type TlsMode = "self_signed" | "acme" | "provided";
export type RemoteState = { enabled: boolean; port: number; bind: string; domain: string | null; tls: TlsMode; fingerprint: string | null; expiresAt: string | null };
export const DEFAULT_REMOTE: RemoteState = { enabled: false, port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: null, expiresAt: null };
export const personNameSchema;   // z.string().trim().min(1).max(60)
export const domainSchema;       // /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i ; never an IP literal
export const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
export const peoplePayloadSchemas = {
  "person.invited":            { inviteId, role: z.enum(ROLES), codeHash: z.string().length(64) /* sha256 hex */, expiresAt: z.string().datetime() },
  "person.invite_revoked":     { inviteId },
  "person.joined":             { personId, inviteId, name: personNameSchema, role: z.enum(ROLES), credential: credentialSchema },
  "person.credential_added":   { personId, credential: credentialSchema },
  "person.credential_removed": { personId, credentialId },
  "person.renamed":            { personId, name: personNameSchema },
  "person.role_changed":       { personId, from: z.enum(ROLES), to: z.enum(ROLES) },      // neither side "owner"
  "person.removed":            { personId },                                             // never OWNER_ID
  "person.signed_in":          { personId, listener: z.enum(["local", "remote"]), method: z.enum(["token", "passkey", "key"]) },
  "person.locked":             { personId, until: z.string().datetime(), failures: z.number().int().min(1) },
  "remote.enabled":            { port: z.number().int().min(1).max(65535), bind: z.string().max(45), domain: domainSchema.nullable(), tls: z.enum(["self_signed", "acme", "provided"]), fingerprint: z.string().regex(FINGERPRINT) },
  "remote.disabled":           {},
  "remote.certificate_changed":{ tls, fingerprint, domain: domainSchema.nullable(), expiresAt: z.string().datetime() },
}; // all .strict(); credentialSchema is a discriminated union on kind with base64url strings ≤ 2000 chars and label ≤ 60
export type PeopleEventType = keyof typeof peoplePayloadSchemas;
// shared/gates.ts additions
export type GateRequirement = { role: Role } | { personId: string };
export const DEFAULT_GATE_REQUIREMENT: Record<GateId, GateRequirement>;   // Decisions: reviewer for plan_approved, ready_to_ship; owner for the rest
export function satisfies(req: GateRequirement, signer: { personId: string; role: Role }): boolean;  // role: atLeast; personId: equality only
export function requirementLabel(req: GateRequirement, name: (personId: string) => string): string;   // "a reviewer or above" | "the Owner" | "<name> only"
export type GateEvaluation = … & { requirement: GateRequirement; signable: boolean };               // signable: satisfies(requirement, the requesting principal)
export const gatePayloadSchemas["gate.requirement_set"] = { gateId: z.enum(GATE_IDS), requirement: requirementSchema.nullable() }.strict();   // null restores the default
// gate.signed_off / gate.waived: signedBy / waivedBy stay strings and now hold the person id
// shared/narration.ts
export type NarrationContext = { …; personName?: (personId: string) => string | undefined };
// Who, for a human actor: ctx.personName?.(id) ?? (id === OWNER_ID ? "Owner" : "Someone"). Every Plan 3 template that began "Owner …" begins "<Who> …".
```
`ROLE_DESCRIPTIONS` (exact): viewer `Can see the board, every card's story, the ledger, the agent feed and who is here. Cannot change anything.` · reviewer `Everything a viewer can, plus deciding what agents may do, making plan decisions, moving cards and signing off gates that allow their role.` · maintainer `Everything a reviewer can, plus starting and stopping agents (on API keys), adding cards, running the intake and giving runs access to connections by name.` · owner `Everything. Only the Owner manages connections, people, remote access and gate requirements, and only the Owner holds credentials.`
Narration headlines for the new events (exact; `<Who>` is the acting human): `person.invited` `<Who> invited a <role label, lower-cased>` · `person.invite_revoked` `<Who> revoked an invitation` · `person.joined` `<name> joined as <role label, lower-cased>` · `person.credential_added` `<Who> added a <passkey|key> ("<label>")` · `person.credential_removed` `<Who> removed a credential` · `person.renamed` `<Who> is now called "<name>"` · `person.role_changed` `<Who> made <person name of payload.personId> a <to label, lower-cased>` · `person.removed` `<Who> removed <person name>` · `person.signed_in` `<person name> signed in <locally|remotely>` (topic `people`, `attention` false) · `person.locked` `<person name> was locked out after <failures> failed sign-ins` (attention true) · `remote.enabled` `<Who> turned remote access on (<domain ?? "this machine's addresses">, port <port>)` (attention true) · `remote.disabled` `<Who> turned remote access off` · `remote.certificate_changed` `The remote certificate changed (<tls label>, fingerprint <first 8 chars>…)` · `gate.requirement_set` `<Who> set who may sign "<gate title>": <requirementLabel>` or `… back to the default`. `NarrationTopic` gains `"people"` and `"remote"`.

- [ ] **Step 1: Write failing tests:** `atLeast("reviewer", "viewer")` true, `("viewer", "reviewer")` false, `("owner", "owner")` true; every payload schema accepts a fixture and rejects an extra key; `person.role_changed` with `to: "owner"` rejected; `person.removed` with `personId: "owner"` rejected; `domainSchema` accepts `tt-test.local` and `example.org`, rejects `192.168.1.10`, `localhost`, `a..b`; `FINGERPRINT` accepts a 32-pair string; `satisfies({ role: "reviewer" }, { personId: "x", role: "maintainer" })` true, `({ personId: "a" }, { personId: "owner", role: "owner" })` false, `({ personId: "a" }, { personId: "a", role: "viewer" })` true; `DEFAULT_GATE_REQUIREMENT.go_live` is `{ role: "owner" }`; `narrate` of a `card.moved` by actor id `p1` with `personName: () => "Reviewer One"` reads `Reviewer One moved …`, with no ctx reads `Someone moved …`, and actor `owner` still reads `Owner moved …` (Plan 3's tests pass unchanged); each new headline above; `eventPayloadSchemas` has a schema for every `EventType`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): roles, people and remote-access events, gate requirements, narration that names the person`

---

### Task 1: People projections, sessions, challenges and the PeopleService

**Files:** Create `packages/core/src/people/{service,sessions,challenges}.ts`. Modify `packages/core/src/db.ts`, `events/projections.ts`, `index.ts`. Tests `packages/core/test/people/{service,sessions,challenges}.test.ts`, `packages/core/test/events/projections.test.ts`.

**Interfaces:**
```ts
// db.ts: the migration after Plan 7's
`CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT, last_seen_at TEXT, removed_at TEXT);
 CREATE TABLE credentials (credential_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, kind TEXT NOT NULL, public_key TEXT NOT NULL, transports TEXT NOT NULL, label TEXT NOT NULL, added_at TEXT NOT NULL, removed_at TEXT);
 CREATE INDEX credentials_person ON credentials (person_id);
 CREATE TABLE invites (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, used_by TEXT);
 CREATE TABLE remote_state (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, port INTEGER NOT NULL, bind TEXT NOT NULL, domain TEXT, tls TEXT NOT NULL, fingerprint TEXT, expires_at TEXT);
 CREATE TABLE gate_requirements (project_id TEXT NOT NULL, gate_id TEXT NOT NULL, requirement TEXT NOT NULL, PRIMARY KEY (project_id, gate_id));
 CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, listener TEXT NOT NULL, method TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
 CREATE INDEX sessions_person ON sessions (person_id);
 CREATE TABLE credential_state (credential_id TEXT PRIMARY KEY, counter INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, locked_until TEXT);`
// PROJECTION_TABLES gains people, credentials, invites, remote_state, gate_requirements (not sessions, not credential_state)
// projections.ts
export function getPerson(db: Db, id: string): Person | null;        // OWNER_ID is virtual: { id: "owner", name: <person.renamed or "Owner">, role: "owner", joinedAt: null, … } even with no row
export function listPeople(db: Db, opts?: { includeRemoved?: boolean }): Person[];   // Owner first, then by joinedAt
export function listCredentials(db: Db, personId: string): Credential[];           // not removed
export function findCredential(db: Db, credentialId: string): (Credential & { personId: string }) | null;
export function getInviteByHash(db: Db, codeHash: string): Invite | null;
export function getRemoteState(db: Db): RemoteState;                                // DEFAULT_REMOTE when no row
export function getGateRequirement(db: Db, projectId: string, gateId: GateId): GateRequirement;  // row or default
// people/sessions.ts
export type Session = { id: string; personId: string; listener: Listener; method: SignInMethod; createdAt: string; lastSeenAt: string; expiresAt: string };
export class SessionStore {
  constructor(db: Db, opts?: { now?: () => Date; ttlMs?: number /* SESSION_TTL_MS */ });
  create(personId: string, listener: Listener, method: SignInMethod): { id: string /* 43-char base64url of 32 random bytes */; session: Session };
  lookup(id: string, listener: Listener): Session | null;   // sha256(id) → row; null when revoked, expired, wrong listener or unknown; touches last_seen_at at most once a minute
  revoke(id: string): void; revokeAll(personId: string): number; list(personId: string): Session[];
  onRevoke(fn: (personId: string, sessionIdHash: string | null) => void): () => void;   // null = every session of the person
}
// people/challenges.ts
export class ChallengeStore {
  constructor(opts?: { now?: () => Date; ttlMs?: number /* 300000 */; max?: number /* 1000 */ });
  issue(scope: string): string;                       // 32 random bytes base64url, remembered with its scope ("join:<inviteId>" | "login" | "me:<personId>")
  consume(challenge: string, scope: string): boolean; // true once, then gone; false when unknown, expired or scoped differently
}
// people/service.ts
export class InviteInvalidError extends Error {}          // "invite is invalid"      → 404 invite_invalid
export class OwnerCredentialRequiredError extends Error {} // → 409 owner_credential_required
export class LastCredentialError extends Error {}         // "the last credential cannot be removed" → 409 last_credential
export class SelfChangeError extends Error {}             // "a person cannot change their own role or remove themselves" → 409 self_change
export class OwnerRoleError extends Error {}              // "the owner role cannot be given or taken" → 409 owner_role
export class LockedError extends Error { constructor(public readonly retryAfterS: number) }   // → 423 locked
export class PeopleService {
  constructor(deps: { db: Db; ledger: Ledger; sessions: SessionStore; newId?: () => string; now?: () => Date });
  invite(actor: Actor, role: Role): { invite: Invite; code: string };     // role "owner" only when no owner credential exists (bootstrap); code = 16 random bytes base64url; commits person.invited with sha256 hex
  revokeInvite(actor: Actor, inviteId: string): void;
  inviteByCode(code: string): Invite;                                        // InviteInvalidError unless pending and unexpired
  join(code: string, name: string, credential: Credential): Person;         // one transaction: person.joined (actor = the new person); invite used; OWNER bootstrap → personId OWNER_ID with person.credential_added + person.renamed instead of person.joined
  addCredential(actor: Actor, personId: string, credential: Credential): void;
  removeCredential(actor: Actor, personId: string, credentialId: string): void;   // LastCredentialError when it is the person's last and personId !== OWNER_ID
  rename(actor: Actor, personId: string, name: string): void;               // redact-checked (SecretInTextError)
  changeRole(actor: Actor, personId: string, to: Role): void;               // SelfChangeError, OwnerRoleError
  remove(actor: Actor, personId: string): void;                              // SelfChangeError; OwnerRoleError for OWNER_ID; revokes every session
  recordSignIn(personId: string, listener: Listener, method: SignInMethod): void;   // person.signed_in, actor = that person
  failure(credentialId: string): void;                                      // failures+1; at LOCKOUT_FAILURES → locked_until = now + 15 min, person.locked (actor system "auth"), failures reset
  assertNotLocked(credentialId: string): void;                               // LockedError
  success(credentialId: string): void;                                       // failures = 0
  hasOwnerCredential(): boolean;
}
export const LOCKOUT_FAILURES = 5; export const LOCKOUT_MS = 15 * 60_000;
```
Reducers: `person.invited` → INSERT invites `pending`; `person.invite_revoked` → `revoked`; `person.joined` → INSERT people (joined_at = ts) + INSERT credentials + invites `used`, `used_by`; `person.credential_added` → INSERT credentials (for `owner`, INSERT OR IGNORE a people row `{ id: "owner", name: "Owner", role: "owner" }` first); `person.credential_removed` → `removed_at`; `person.renamed` → name (INSERT OR IGNORE the owner row first); `person.role_changed` → role; `person.removed` → `removed_at`; `person.signed_in` → `last_seen_at`; `remote.enabled` → UPSERT row 1 `enabled 1` with the payload; `remote.disabled` → `enabled 0`; `remote.certificate_changed` → `tls`, `fingerprint`, `domain`, `expires_at`; `gate.requirement_set` → UPSERT or DELETE when null. `listPeople` computes `status` `expired` for invites by comparing `expires_at` to now at read time (no event).

- [ ] **Step 1: Write failing tests:**
  - sessions: `create` returns a 43-character id and the table holds its sha256, never the id; `lookup(id, "local")` works and `lookup(id, "remote")` is null **(Review Focus 2)**; after `revoke` null; after `ttlMs` null; `revokeAll` returns the count and fires `onRevoke(personId, null)`;
  - challenges: `consume` true once then false; a different scope false; after `ttlMs` false; the 1001st issue evicts the oldest;
  - service: `invite(owner, "reviewer")` → one `person.invited` whose payload holds a 64-hex `codeHash` and not the code; `inviteByCode(code)` returns it; `inviteByCode("nope")`, a revoked one, and one past `expiresAt` → `InviteInvalidError`; `join(code, "Reviewer One", passkeyCred)` → `person.joined` with actor `{ kind: "human", id: <new id> }`, `listPeople()` is `[owner, Reviewer One]`, the invite is `used`, and `join` again with the same code → `InviteInvalidError`; `invite(owner, "owner")` → `OwnerRoleError` once an owner credential exists, else allowed, and `join` of it records `person.credential_added` + `person.renamed` for `owner` with no `person.joined`; `changeRole(owner, p1, "maintainer")` → `person.role_changed { from: "reviewer", to: "maintainer" }`; `changeRole(owner, "owner", …)` and `changeRole(p1 as actor, p1, …)` → errors; `remove(owner, p1)` revokes p1's two sessions and `getPerson(p1).removedAt` is set **(Review Focus 3)**; `removeCredential` of the last one → `LastCredentialError`, of the Owner's last → allowed (the token remains); five `failure(c)` → one `person.locked`, `assertNotLocked(c)` throws with `retryAfterS ≤ 900`, `success` after the lock expires clears it **(Review Focus 4)**; `rename` with `sk-ant-TESTKEY-0000000000` → `SecretInTextError`;
  - projections: rebuild after the whole sequence equals the live five tables row for row; `getPerson("owner")` without any row is the virtual Owner; `getRemoteState` is `DEFAULT_REMOTE` before any event and reflects `remote.enabled` after.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test people events`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): people, invites, credentials and remote state as ledger projections; sessions, challenges and lockouts`

---

### Task 2: Principals, listeners, role table and the throttle

**Files:** Rewrite `packages/core/src/server/auth.ts`; create `packages/core/src/server/throttle.ts`. Modify `server.ts`. Tests `packages/core/test/server/{auth,throttle}.test.ts`.

**Interfaces:**
```ts
// auth.ts
export const TOKEN_COOKIE = "tt_token"; export const SESSION_COOKIE = "tt_session"; export const APP_HOST = "theterminal.localhost";
export type Principal = { personId: string; name: string; role: Role; listener: Listener; method: SignInMethod; sessionId: string | null };
declare module "fastify" { interface FastifyRequest { principal: Principal | null; listener: Listener } }
export type AuthDeps = { token: string; port: () => number; remote: () => RemoteState; sessions: SessionStore; person: (id: string) => Person | null; now?: () => Date;
  listenerOf?: (request: FastifyRequest) => Listener };               // tests only: default is the TLS check below
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void;
export function listenerOf(request: FastifyRequest): Listener;        // (request.raw.socket as TLSSocket).encrypted === true → "remote"
export function remoteHostAllowed(host: string, remote: RemoteState): boolean;   // Decisions: domain:port exactly, else (IP literal | *.local) with remote.port
export const ROUTE_ROLES: Record<string, Role>;                         // "<METHOD> <url>" → minimum role, e.g. "POST /api/projects/:id/runs": "maintainer"
export const PUBLIC_ROUTES: ReadonlySet<string>;                        // exact route keys: "GET /", "GET /*", "GET /join/*", "GET /sign-in", "GET /healthz", "GET /api/join/:code", "POST /api/join/:code/passkey/options", "POST /api/join/:code/passkey/verify", "POST /api/join/:code/key/challenge", "POST /api/join/:code/key", "POST /api/auth/passkey/options", "POST /api/auth/passkey/verify", "POST /api/auth/key/challenge", "POST /api/auth/key/verify" (the ACME challenge is served by the plain :80 server, not Fastify)
export function requireRole(min: Role): preHandlerHookHandler;          // 403 { error: "forbidden", required: min }
export function actorOf(request: FastifyRequest): Actor;                // { kind: "human", id: request.principal!.personId }
export function assertRoutesHaveRoles(app: FastifyInstance): string[];  // every registered route is in ROUTE_ROLES or PUBLIC_ROUTES; returns the missing ones
// throttle.ts
export class Throttle {
  constructor(opts: { limit: number; windowMs: number; now?: () => Date; max?: number /* 10000 keys */ });
  hit(key: string): { allowed: true } | { allowed: false; retryAfterS: number };
}
export const AUTH_THROTTLE = { limit: 10, windowMs: 60_000 };
```
Hook order on every request: (1) `request.listener = listenerOf(request)`; (2) Host: local → the 5A rule; remote → `remoteHostAllowed`, else 403 `bad_host`; (3) on remote, `GET /?token=` and a bearer token are refused 401 before anything else (the token is never compared off the local listener) **(Review Focus 2)**; (4) public routes pass with `principal = null`; (5) Origin: local → the 5A rule; remote → `https://<host header>` only; (6) principal: a bearer or `tt_token` cookie matching the token on local → `{ personId: OWNER_ID, role: "owner", method: "token", sessionId: null }`; else `tt_session` → `sessions.lookup(id, request.listener)` → `person(session.personId)`; a removed person or no session → 401 `unauthorized`; (7) `requireRole(ROUTE_ROLES[key])` where `key = "<method> <routeOptions.url>"`; a route with no entry → 500 `internal` (fail closed; the test in Task 4 keeps the table complete). The bootstrap `/?token=` on local still sets `tt_token` as today. Session cookie attributes: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` on remote. `request.principal.name` comes from `person()`, so a rename shows on the next request.

`server.ts`: constructs `SessionStore`, `ChallengeStore`, `PeopleService` and `Throttle` and passes them on; after `app.ready()`, `assertRoutesHaveRoles(app)` must return `[]` or the server refuses to start with `Refusing to start: routes without a role: …`.

- [ ] **Step 1: Write failing tests:**
  - throttle: 10 hits allowed, the 11th `{ allowed: false, retryAfterS: 60 }`, allowed again after `windowMs`; two keys are independent; the 10001st key evicts the oldest;
  - auth (Fastify `inject`; the listener is chosen per test through `AuthDeps.listenerOf`, and Task 6 repeats the remote cases over a real `tls.Server`): local bearer → `principal.personId === "owner"`, `method: "token"`; a session created on local → principal with the person's current name and role; the same session with `listener: "remote"` → 401; on remote a bearer → 401 and `GET /?token=` → 401 with no `location` header **(Review Focus 2)**; remote Host `tt-test.local:4318` and `192.168.1.10:4318` accepted, `evil.example.org:4318` and `tt-test.local:4317` → 403; with `domain: "work.example.org"` only `work.example.org:4318` accepted; remote Origin `https://tt-test.local:4318` accepted, `http://…` → 403; `requireRole("maintainer")` → 403 `{ error: "forbidden", required: "maintainer" }` for a reviewer and pass for a maintainer; a removed person's session → 401 **(Review Focus 3)**; `assertRoutesHaveRoles` lists a test route registered without an entry; the cookie set on remote has `Secure`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/auth server/throttle`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS (existing route tests pass with the bearer as the Owner).
- [ ] **Step 5: Commit:** `feat(server): principals with roles on two listeners; sessions never cross listeners; auth throttle`

---

### Task 3: Passkeys, Ed25519 keys and the people, join and auth routes

**Files:** Create `packages/core/src/people/{webauthn,ed25519}.ts`, `packages/core/src/server/people-routes.ts`, `packages/core/test/fixtures/webauthn.ts`. Modify `server.ts`, `routes.ts` (error map), `packages/core/package.json` (`@simplewebauthn/server` 14.0.3). Tests `packages/core/test/people/{webauthn,ed25519}.test.ts`, `packages/core/test/server/people-routes.test.ts`.

**Interfaces:**
```ts
// people/webauthn.ts  (wraps @simplewebauthn/server; rpName "The Terminal")
export type Rp = { rpId: string; origin: string };                       // from the request: rpId = hostname of Host; origin = `${listener === "remote" ? "https" : "http"}://${host}`
export function rpFor(request: FastifyRequest): Rp | null;              // null when the hostname is an IP literal (passkeys unavailable)
export async function registrationOptions(rp: Rp, user: { id: string; name: string }, exclude: Credential[], challenge: string): Promise<PublicKeyCredentialCreationOptionsJSON>;
// residentKey "required", userVerification "preferred", attestationType "none", algorithms ES256 and Ed25519 (-7, -8)
export async function verifyRegistration(rp: Rp, challenge: string, response: unknown): Promise<Credential>;   // kind "passkey"; throws InvalidCredentialError on any failure
export async function authenticationOptions(rp: Rp, challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON>;  // allowCredentials empty (discoverable)
export async function verifyAuthentication(rp: Rp, challenge: string, response: unknown, cred: Credential & { counter: number }): Promise<{ newCounter: number }>;
export class InvalidCredentialError extends Error {}   // "invalid credential" → 401 invalid_credential; never wraps the library's message
// people/ed25519.ts
export function keyCredentialId(publicKeySpkiB64url: string): string;    // base64url(sha256(der))
export function verifyKeyLogin(i: { publicKey: string; challenge: string; host: string; signature: string }): boolean;
// message = utf8(`theterminal-auth\n${challenge}\n${host}`); node:crypto verify(null, message, { key: createPublicKey({ key: der, format: "der", type: "spki" }) }, sig); the key must be Ed25519 (asymmetricKeyType), else false
// test/fixtures/webauthn.ts: a software authenticator with ES256 keys from node:crypto and a 60-line CBOR encoder
export function softAuthenticator(rp: Rp): { register(optionsJSON): RegistrationResponseJSON; authenticate(optionsJSON): AuthenticationResponseJSON; counter: number };
```
Routes (`people-routes.ts`; `ROUTE_ROLES` entries in brackets; public ones throttled by `AUTH_THROTTLE` keyed on `request.ip`):

| Method & path | Role | Body → 2xx |
|---|---|---|
| `GET /api/me` | viewer | `Me` |
| `PATCH /api/me` | viewer | `{ name }` → `Me` |
| `POST /api/me/sign-out` | viewer | 204; clears the cookie; revokes the current session |
| `POST /api/me/credentials/passkey/options` | viewer | → options (challenge scope `me:<personId>`) |
| `POST /api/me/credentials/passkey/verify` | viewer | `{ label, response }` → 201 `Me`; `person.credential_added` |
| `POST /api/me/credentials/key/challenge` | viewer | → `{ challenge }` |
| `POST /api/me/credentials/key` | viewer | `{ label, publicKey, challenge, signature }` → 201 `Me` |
| `DELETE /api/me/credentials/:id` | viewer | 204 |
| `GET /api/people` | viewer | `Person[]` (not removed) |
| `GET /api/people/invites` | owner | `Invite[]` (pending) |
| `POST /api/people/invites` | owner | `{ role }` → 201 `{ invite, url, fingerprint }`; `url` = `https://<domain ?? first address>:<remotePort>/join/<code>#fp=<fingerprint>` when remote is on, else `http://theterminal.localhost:<port>/join/<code>`; shown once |
| `DELETE /api/people/invites/:id` | owner | 204 |
| `PATCH /api/people/:id` | owner | `{ role }` → `Person` |
| `DELETE /api/people/:id` | owner | 204 |
| `POST /api/people/:id/sign-out` | owner | `{ revoked: number }` |
| `GET /api/join/:code` | public | `{ role, expiresAt, passkeys: boolean, host, fingerprint: string \| null }` |
| `POST /api/join/:code/passkey/options` | public | `{ name }` → options (scope `join:<inviteId>`) |
| `POST /api/join/:code/passkey/verify` | public | `{ name, response }` → 201 `Me` + session cookie; `person.joined`, `person.signed_in` |
| `POST /api/join/:code/key/challenge` | public | → `{ challenge }` |
| `POST /api/join/:code/key` | public | `{ name, publicKey, challenge, signature }` → 201 `Me` + cookie |
| `POST /api/auth/passkey/options` | public | → options (scope `login`) |
| `POST /api/auth/passkey/verify` | public | `{ response }` → `Me` + cookie; `person.signed_in` |
| `POST /api/auth/key/challenge` | public | → `{ challenge }` |
| `POST /api/auth/key/verify` | public | `{ publicKey, challenge, signature }` → `Me` + cookie |

Rules: a join or login where `rpFor()` is null answers the passkey routes 409 `passkeys_unavailable`; every verification failure (bad challenge, bad signature, unknown credential, wrong rpId, counter not increasing when the stored counter is > 0) is 401 `invalid_credential` after `people.failure(credentialId)` where the credential is known **(Review Focus 4)**; `assertNotLocked` runs before verification; the ledger read-only → 423 `ledger_read_only` on join and sign-in; a session is created on the listener the request came in on; `Me.sessions[].id` is the sha256 prefix (8 chars), never the id. Error map: `InviteInvalidError` → 404 `invite_invalid`; `InvalidCredentialError` → 401 `invalid_credential`; `LockedError` → 423 `{ error: "locked", retryAfterS }`; `LastCredentialError` → 409 `last_credential`; `SelfChangeError` → 409 `self_change`; `OwnerRoleError` → 409 `owner_role`; `OwnerCredentialRequiredError` → 409 `owner_credential_required`; throttle → 429 `{ error: "rate_limited", retryAfterS }`.

- [ ] **Step 1: Write failing tests:**
  - webauthn: `rpFor` for Host `tt-test.local:4318` over remote → `{ rpId: "tt-test.local", origin: "https://tt-test.local:4318" }`, for `192.168.1.10:4318` → null, for local `theterminal.localhost:4317` → http origin; a soft authenticator registration verifies to a `passkey` credential; an assertion verifies and returns the next counter; the same assertion replayed (counter not increased) → `InvalidCredentialError`; a response for another rpId → `InvalidCredentialError` whose message is exactly `invalid credential`;
  - ed25519: a key pair from `generateKeyPairSync("ed25519")` signs the message and verifies; a wrong host, wrong challenge or an RSA key → false; `keyCredentialId` is 43 chars;
  - routes (memory store, fake time): the Owner invites a reviewer → 201 whose `url` contains `/join/` and whose ledger entry holds the hash only; `GET /api/join/<code>` → role and `passkeys: true`; join with the soft authenticator → 201 `Me { role: "reviewer", method: "passkey" }` and a `Set-Cookie` with `tt_session` and `HttpOnly`; a second join with the same code → 404 `invite_invalid`; `GET /api/me` with the cookie → the person; sign out → 204 and the cookie no longer works; `POST /api/auth/passkey/options` + `verify` → signed in with `person.signed_in { listener: "local", method: "passkey" }`; key join: `challenge` → sign → 201; **(Review Focus 4)** 11 `GET /api/join/x` in a minute → the 11th 429 with `retryAfterS`; five wrong assertions for one credential → 401 ×5 then a valid one → 423 `locked` and exactly one `person.locked`; a reused challenge → 401; `PATCH /api/people/:id { role: "owner" }` → 409 `owner_role`; `DELETE /api/people/<self>` → 409 `self_change`; a reviewer calling `POST /api/people/invites` → 403; `DELETE /api/me/credentials/:last` → 409 `last_credential`; no response body in the suite contains an invite code after creation or a session id.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test people server/people-routes`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the dependency exactly; `allowBuilds` gets `false` for any newly reported script.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): invites, passkeys and Ed25519 keys; people management; sign-in, lockouts and rate limits`

---

### Task 4: Every route names the person and checks the role; collaborators see summaries and run on API keys

**Files:** Modify `packages/core/src/server/{routes,agent-routes,connection-routes,capacity-routes,intake-routes,story-routes,override-routes,github-routes,events-ws}.ts`, `packages/core/src/agents/runner.ts`, `packages/shared/src/connections.ts`, `apps/ui/src/api.ts`, `apps/ui/src/views/{ConnectionsSideBar,ConnectionEditor}.tsx`, `apps/ui/src/components/AgentPanel.tsx`. Tests `packages/core/test/server/{routes,agent-routes,connection-routes,route-roles}.test.ts`, `apps/ui/test/{ConnectionsSideBar,AgentPanel}.test.tsx`.

**Interfaces:**
```ts
// shared/connections.ts
export type ConnectionSummary = Pick<Connection, "id" | "kind" | "provider" | "name" | "enabled" | "status">;
// runner.ts
start(actor, input: { …; forceApiKey?: boolean })   // when true: authMode is "api_key" regardless of settings; no key → ApiKeyRequiredError
export class ApiKeyRequiredError extends Error {}    // "collaborators run agents on API keys; no API key is configured for <provider>" → 409 api_key_required
```
`ROUTE_ROLES` (exact; `GET` routes not listed are `viewer`): `POST /api/projects` maintainer · `POST /api/projects/:id/cards` maintainer · `POST /api/cards/:id/move` reviewer · `POST /api/cards/:id/status` maintainer · `POST /api/projects/:id/runs` maintainer · `POST /api/runs/:id/stop` maintainer · `POST /api/actions/:id/decision` reviewer · `POST /api/settings/provider-auth`, `POST /api/settings/claude-auth` owner · `POST /api/projects/:id/intake`, `…/answers`, `…/reopen` maintainer · `…/decisions`, `…/complete` reviewer · every `POST`/`PATCH`/`DELETE` under `/api/connections` owner · `/api/connections/signin*` owner · `POST /api/capacity/detect` owner · `POST /api/runs/:id/override/*` owner · `GET /api/connections` viewer (summaries for non-owners) · `GET /api/connections/:id` owner · `GET /api/connections/catalog` owner · `GET /api/github/overview` viewer · `GET /api/ledger/export` reviewer · `GET /api/presence` viewer.
Rules: every handler replaces its `actor` constant with `actorOf(request)`; `GET /api/connections` returns `Connection[]` for the Owner and `ConnectionSummary[]` otherwise; `/api/status` for non-owners carries `connections: { enabled, failed }` without `keychain`; `POST /api/projects/:id/runs` passes `forceApiKey: principal.personId !== OWNER_ID`; `connectionIds` from a maintainer are honoured (names only were ever visible). `GET /api/agents` for non-owners omits `apiKey` sources and `acks`. UI: `api.listConnections()` returns `Connection[] | ConnectionSummary[]` and the Connections side bar renders summaries read-only with the line `Only the Owner can see or change connection details.`; the editor tab is never opened for a non-owner; `AgentPanel` for a non-owner shows under the adapter `Runs you start use the Owner's API key for <Provider>, never a personal subscription.` and maps `api_key_required` to `No API key is configured for <Provider>. Ask the Owner to add one in Connections.`

- [ ] **Step 1: Write failing tests:**
  - route-roles: after `createServer`, `assertRoutesHaveRoles` returns `[]`; for each `(method, url, role)` in `ROUTE_ROLES` a principal one rank below answers 403 and one at the rank does not answer 403 (a table-driven test over fake sessions for a viewer, reviewer, maintainer and the Owner);
  - **(Review Focus 1)** a maintainer's `GET /api/connections` has no `config`, `private` or `secretFields` key in any item; `GET /api/connections/:id`, `PATCH`, `POST …/test` → 403; the maintainer starts a fake run with `connectionIds: [azureId]` → 201, the recorded `agent.started` actor is the maintainer's id, the `connection.used` entries exist, the recorded shell output shows `[REDACTED]`, and `JSON.stringify` of every response in the test lacks the secret;
  - a maintainer starting a `codex` run while the provider mode is `chatgpt` and a key connection exists → the run's `authMode` is `api_key`; without a key → 409 `api_key_required`; the Owner in `chatgpt` mode is unchanged;
  - a reviewer's `POST /api/actions/:id/decision` → recorded with actor id of the reviewer and `by: "human"`; a viewer's → 403; the narration of that entry with `personName` reads `Reviewer One allowed it`;
  - UI: summaries render read-only with the Owner-only line; the maintainer note and the `api_key_required` message.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): every write names the acting person and checks their role; collaborators see connection summaries and run on API keys`

---

### Task 5: Gate requirements by role or person

**Files:** Modify `packages/core/src/gates/service.ts`, `packages/core/src/server/routes.ts` (requirement route, error map), `apps/ui/src/components/GateCard.tsx`, `apps/ui/src/api.ts`. Tests `packages/core/test/gates/service.test.ts`, `packages/core/test/server/routes.test.ts`, `apps/ui/test/GateCard.test.tsx`.

**Interfaces:**
```ts
// gates/service.ts
export class GateRequirementError extends Error { constructor(public readonly gateId: GateId, public readonly requirement: GateRequirement) }  // → 403 { error: "gate_requires", gateId, requirement }
class GateService {
  evaluate(cardId: string, to: Stage, signer: { personId: string; role: Role }): GateEvaluation[];   // fills requirement (project row or default) and signable
  move(actor: Actor, signer: { personId: string; role: Role }, cardId: string, to: Stage, decisions?: GateDecisionInput[]): Card;  // a sign_off or waive for a gate the signer does not satisfy → GateRequirementError before anything is recorded; signedBy/waivedBy = actor.id
  setRequirement(actor: Actor, projectId: string, gateId: GateId, requirement: GateRequirement | null): void;  // Owner only (route); a personId must be a current, not removed person (NotFoundError)
}
// routes: PUT /api/projects/:id/gates/:gateId/requirement { requirement: GateRequirement | null } (owner) → 200 { gateId, requirement }
//         GET /api/cards/:id/gates?to= now passes the principal as signer
```
GateCard: under the acknowledgement, `Who may sign: <requirementLabel>`; when `signable` is false the `Sign off` and `Waive` buttons are disabled with the line `You cannot sign this gate. It needs <requirementLabel>.`; the Owner sees a `Change who may sign` select (`A reviewer or above`, `A maintainer or above`, `The Owner`, then each current person by name) that calls the PUT.

- [ ] **Step 1: Write failing tests:**
  - **(Review Focus 5)** a reviewer signs `go_live` → `GateRequirementError { gateId: "go_live", requirement: { role: "owner" } }`, ledger unchanged, card unmoved; the Owner sets `ready_to_ship` to `{ personId: m1 }` → `gate.requirement_set`; maintainer `m2` signs → error; the Owner signs → error; the Owner sets `null` → `gate.requirement_set { requirement: null }` and the row is gone; the reviewer signs → `gate.signed_off { signedBy: <reviewer id> }` and `card.moved` with the reviewer as actor; `setRequirement` with a removed person → `NotFoundError`; `evaluate` for the reviewer shows `signable: false` on `go_live` and `true` on `ready_to_ship`; rebuild equals live;
  - routes: `PUT …/requirement` by a maintainer → 403 `forbidden`; by the Owner → 200; a reviewer's `POST /api/cards/:id/move` with a `go_live` sign-off → 403 `{ error: "gate_requires", gateId: "go_live", requirement: { role: "owner" } }`;
  - UI: a non-signable gate disables both buttons with the exact line; the Owner's select posts `{ requirement: { personId } }`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(gates): a gate names who may sign it, by role or by person; the Owner changes it on the record`

---

### Task 6: The remote TLS listener with a self-signed, pinned certificate

**Files:** Create `packages/core/src/server/{remote,certs,remote-routes}.ts`. Modify `server.ts`, `connection-routes.ts` (`/api/status.remote`), `packages/core/package.json` (`@peculiar/x509` 2.2.0). Tests `packages/core/test/server/{remote,certs,remote-routes}.test.ts`.

**Interfaces:**
```ts
// certs.ts
export type CertMaterial = { certPem: string; keyPem: string; fingerprint: string /* AA:BB:…, SHA-256 of the DER, upper-case */; expiresAt: string; subjectAltNames: string[] };
export async function selfSignedCertificate(i: { hostnames: string[]; addresses: string[]; now?: () => Date; days?: number /* 3650 */ }): Promise<CertMaterial>;   // ECDSA P-256 via node:crypto, X.509 via @peculiar/x509; CN "The Terminal"; SANs = hostnames + IPs; serial random
export function fingerprintOf(certPem: string): string;
export function loadProvided(certFile: string, keyFile: string): CertMaterial;   // throws CertificateError with a fixed message when unreadable, mismatched or expired
export class CertificateError extends Error {}
export function localAddresses(): { hostnames: string[]; addresses: string[] };   // os.hostname() + ".local" when it has no dot; non-internal IPv4 from os.networkInterfaces()
// remote.ts
export type RemoteDeps = { http: import("node:http").Server; db: Db; ledger: Ledger; secrets: SecretStore; people: PeopleService; dataDir: string; acme?: AcmeManager /* Task 7 */; now?: () => Date };
export class RemoteListener {
  constructor(deps: RemoteDeps);
  state(): RemoteState & { listening: boolean; addresses: string[] };
  enable(actor: Actor, i: { port?: number; bind?: string; domain?: string | null; tls?: TlsMode; certFile?: string; keyFile?: string; acmePort?: number /* 80; tests pass 0 */ }): Promise<RemoteState>;
  // order: material (self_signed: reuse <dataDir>/remote/cert.pem + secret "remote/tls/key" when present and unexpired, else make new and commit remote.certificate_changed; provided: loadProvided, with the two paths kept in the secret store under "remote/tls/files" as JSON, never in the ledger, like 5A's private fields; acme: Task 7) → commit remote.enabled → tls.createServer({ cert, key, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"] }, s => http.emit("connection", s)).listen(port, bind) → on listen error: commit remote.disabled and rethrow RemoteStartError
  disable(actor: Actor): Promise<void>;         // close the tls server (destroy its sockets), then commit remote.disabled
  startIfEnabled(): Promise<void>;              // at boot, from the projection; a failure logs a fixed line and commits remote.disabled with actor { kind: "system", id: "remote" }
  close(): Promise<void>;
}
export class RemoteStartError extends Error {}  // "the remote listener could not start" → 502 remote_start_failed
// enable() throws people/service.ts's OwnerCredentialRequiredError unless deps.people.hasOwnerCredential()
// remote-routes.ts
GET  /healthz                 public → 200 { ok: true }        (no other field; for containers and load balancers)
GET  /api/remote              viewer → RemoteListener.state() (viewers get { enabled, listening } only)
PUT  /api/remote              owner, local listener only when enabling (409 remote_only_from_local otherwise) → { enabled, port?, bind?, domain?, tls?, certFile?, keyFile? } → state
```
`/api/status` gains `remote: { enabled: boolean; listening: boolean; label: string }` where `label` is `<domain>:<port>` or `<first address>:<port>` or `off`. `createServer` gains `remote?: { enabled?: boolean; port?: number; bind?: string; domain?: string }` (the CLI's flags) and, when given with `enabled`, commits through `enable` with actor `{ kind: "system", id: "cli" }` at startup (after the lock, before listen). `RunningServer` gains `remoteUrl: string | null` and `fingerprint: string | null`. The `Secure` cookie, `rpFor` and `listenerOf` from Tasks 2–3 now see real TLS sockets.

- [ ] **Step 1: Write failing tests:**
  - certs: `selfSignedCertificate({ hostnames: ["tt-test.local"], addresses: ["192.168.1.10"] })` parses with `new X509Certificate(pem)` from `node:crypto`, has both SANs, `fingerprint` matches `FINGERPRINT` and equals `X509Certificate.fingerprint256`, `expiresAt` is 10 years out; `loadProvided` with a mismatched key → `CertificateError` whose message holds no path;
  - remote: with a real `http.Server` and Fastify app, `enable(owner, { port: 0, bind: "127.0.0.1" })` commits `remote.certificate_changed` then `remote.enabled` (consecutive seqs), the private key is in the secret store under `remote/tls/key` and nowhere in the data dir except the `.pem` cert; a `fetch` with a `tls.connect` agent pinned to `fingerprint256` reaches `GET /healthz` → `{ ok: true }` and a different fingerprint is refused by the client; the Fastify request over TLS has `listener: "remote"`; **(Review Focus 2)** the Owner's bearer over TLS → 401, `GET /?token=` over TLS → 401 without `location`; a session created over TLS works over TLS and not over the plain server; `disable` commits `remote.disabled` and the port closes; `enable` twice reuses the certificate (no second `certificate_changed`); `enable` without an Owner credential → `OwnerCredentialRequiredError`; a port already in use → `RemoteStartError` and a `remote.disabled` after the `remote.enabled`; `startIfEnabled` after a restart over the same db listens again;
  - routes: `PUT /api/remote { enabled: true }` over the remote listener → 409 `remote_only_from_local`; by a maintainer → 403; `GET /api/remote` as a viewer has only `enabled` and `listening`; `/api/status.remote.label` is `off` then `<address>:<port>`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/remote server/certs server/remote-routes`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `@peculiar/x509` exactly.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): an off-by-default TLS listener for the network, self-signed with a pinned fingerprint, every change in the ledger`

---

### Task 7: Certificates from ACME when the Owner sets a domain

**Files:** Create `packages/core/src/server/acme.ts`. Modify `remote.ts`, `remote-routes.ts`, `server.ts`, `packages/core/package.json` (`acme-client` 5.4.0). Tests `packages/core/test/server/acme.test.ts`, `remote.test.ts`.

**Interfaces:**
```ts
// acme.ts
export const ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
export type AcmeDeps = { secrets: SecretStore; dataDir: string; directoryUrl?: string; client?: AcmeClientLike /* tests */; now?: () => Date };
export class AcmeManager {
  constructor(deps: AcmeDeps);
  challengeResponse(token: string): string | null;            // served at GET /.well-known/acme-challenge/:token on the plain :80 listener while an order is open
  obtain(domain: string): Promise<CertMaterial>;              // account key from secret "remote/acme/account" (created once; never in the ledger); order, http-01, finalize; cert → <dataDir>/remote/acme-cert.pem, key → secret "remote/acme/key"
  renewIfDue(domain: string, current: CertMaterial): Promise<CertMaterial | null>;   // null when more than RENEW_BEFORE_MS remains
}
export class AcmeError extends Error {}   // fixed message "certificate could not be obtained"; the ACME error type (e.g. urn:ietf:params:acme:error:dns) is kept in `.type` for the UI, never the body
export const fakeAcme: AcmeClientLike;    // under THETERMINAL_FAKE_AGENT=1 + THETERMINAL_FAKE_ACME=1: issues a self-signed cert for the domain after "serving" the challenge through challengeResponse
```
Rules: `tls: "acme"` requires `domain`; `enable` opens a plain `http.Server` on port 80 (`bind` same) that answers only `/.well-known/acme-challenge/:token` and redirects everything else to `https://<domain>:<port>/`; the plain listener stays up for renewals. Renewal check every 12 hours (`setInterval`, `unref`); a new certificate replaces the `tls.Server`'s context via `setSecureContext` and commits `remote.certificate_changed`. `GET /api/remote` gains `acme: { lastError: string | null }` (the ACME error type only). Port 80 in use or the challenge unreachable → `AcmeError` → `PUT /api/remote` answers 502 `{ error: "acme_failed", type }` and remote stays off.

- [ ] **Step 1: Write failing tests:** with `fakeAcme`, `enable(owner, { tls: "acme", domain: "tt-test.local", port: 0, bind: "127.0.0.1", acmePort: 0 })` serves the challenge token on the plain listener during the order, commits `remote.certificate_changed { tls: "acme", domain }` then `remote.enabled`, and the cert's SAN is the domain; the account key is in the secret store and not in the ledger or any file; `renewIfDue` returns null at 60 days left and a new material at 20 days left, after which the TLS server presents the new fingerprint (`tls.connect` → `getPeerCertificate().fingerprint256`) and a `remote.certificate_changed` is committed; a client that fails the order → `AcmeError` with `.type`, 502 `acme_failed`, no `remote.enabled`; the plain listener redirects `GET /` to `https://tt-test.local:<port>/` with 301; `THETERMINAL_FAKE_ACME=1` without the fake-agent flag selects the real client (assert the selector).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/acme server/remote`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `acme-client` exactly; `allowBuilds` entries as needed.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): certificates from ACME for a domain, renewed on the record`

---

### Task 8: Presence over the ledger stream

**Files:** Create `packages/core/src/server/presence.ts`. Modify `events-ws.ts`, `people-routes.ts` (`GET /api/presence`), `apps/ui/src/api.ts` (`streamLedger` distinguishes messages). Tests `packages/core/test/server/{presence,events-ws}.test.ts`, `apps/ui/test/api.test.ts`.

**Interfaces:**
```ts
// presence.ts
export type PresenceEntry = { personId: string; name: string; role: Role; projectId: string | null; view: string | null; since: string };
export class PresenceRegistry {
  constructor(opts?: { now?: () => Date });
  join(socketId: string, principal: Principal): void;
  update(socketId: string, where: { projectId: string | null; view: string | null }): void;   // view ≤ 40 chars, /^[a-z_:-]+$/ else ignored
  leave(socketId: string): void;
  list(): PresenceEntry[];                              // one entry per person (the most recent socket wins)
  onChange(fn: (people: PresenceEntry[]) => void): () => void;
}
// WS /api/events: the principal is required at upgrade (401 → close 1008 "unauthorized"); client → server: { type: "presence", projectId, view }; server → client: LedgerEntry (has "seq") or { type: "presence", people: PresenceEntry[] } on every change and once on connect
// the socket is closed with 1008 "revoked" by SessionStore.onRevoke when its session or person is revoked (Review Focus 3)
// GET /api/presence (viewer) → PresenceEntry[]
// ui/api.ts: streamLedger(onEntry, onPresence?) routes by "seq" in message
```

- [ ] **Step 1: Write failing tests:** two sockets for two people → `list()` has two entries and both sockets receive a presence message naming both; an `update` with `view: "board"` is broadcast, with `view: "<script>"` ignored; `leave` removes; a socket whose session is revoked closes with 1008 within 500 ms and the other socket sees the person gone **(Review Focus 3)**; an upgrade without a cookie closes 1008; `GET /api/presence` lists the same; UI `streamLedger` passes entries to `onEntry` and presence to `onPresence`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/presence server/events-ws && pnpm --filter @theterminal/ui test api`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): presence (who is here and what they look at) over the ledger stream`

---

### Task 9: UI: join and sign-in pages, People view, remote access, roles in the shell

**Files:** Create `apps/ui/src/pages/{JoinPage,SignInPage}.tsx`, `apps/ui/src/identity.ts`, `apps/ui/src/views/{PeopleSideBar,PeoplePanel}.tsx`, `apps/ui/src/components/InviteDialog.tsx`. Modify `main.tsx`, `api.ts`, `shell/{views,model,StatusBar,ActivityBar,Workbench,Dock}.tsx`, `App.tsx`, `packages/core/src/server/static-ui.ts` (SPA fallback for `/join/*` and `/sign-in`), `apps/ui/package.json` (`@simplewebauthn/browser` 14.0.0). Tests `apps/ui/test/{JoinPage,SignInPage,identity,PeopleSideBar,PeoplePanel,InviteDialog,StatusBar,Workbench}.test.tsx`, `packages/core/test/server/static-ui.test.ts`.

**Interfaces and copy:**
```ts
// identity.ts
export async function passkeysAvailable(): Promise<boolean>;          // window.PublicKeyCredential exists and the hostname is not an IP literal
export async function hasBrowserKey(): Promise<boolean>;              // a key exists in IndexedDB "tt-identity"
export async function ensureBrowserKey(): Promise<{ publicKey: string /* base64url SPKI */; sign(message: Uint8Array): Promise<string> }>;  // crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]) stored in IndexedDB "tt-identity"; reused when present
export async function joinWithPasskey(code: string, name: string): Promise<Me>;   // options → startRegistration → verify
export async function joinWithKey(code: string, name: string): Promise<Me>;
export async function signInWithPasskey(): Promise<Me>; export async function signInWithKey(): Promise<Me>;
// shell/views.ts: VIEWS gains "people" (label "People") after "capacity"; model gains me: Me | null, presence: PresenceEntry[], remote: RemoteView | null, people: Person[], invites: Invite[]
// main.tsx: pathname /join/<code> → JoinPage; /sign-in → SignInPage; else App (which redirects to /sign-in on a 401 from GET /api/me)
```
- **JoinPage** (`main[aria-label="Join this workspace"]`): loads `GET /api/join/<code>`; shows `You have been invited as a <role label>.` and `ROLE_DESCRIPTIONS[role]`; when the URL has `#fp=` and the server reports a `fingerprint`: `Certificate fingerprint in your link: <fp>` / `Certificate fingerprint this server reports: <fp>` and either `They match.` or, in the attention colour, `They do not match. Do not continue: someone may be intercepting the connection.` with the form disabled; a `Your name` input (`maxLength 60`) with the note `Your name is recorded in this workspace's ledger next to everything you do.`; primary button `Create a passkey and join` when `passkeysAvailable()`, else `Create a key in this browser and join` with the note `This browser cannot use passkeys here (the address is an IP, or passkeys are unsupported). A key will be created and kept in this browser only.`; errors: `invite_invalid` → `This invitation is no longer valid. Ask the Owner for a new one.`, `rate_limited` → `Too many attempts. Try again in <n> seconds.`, `invalid_credential` → `That did not work. Try again.`; success → `location.assign("/")`.
- **SignInPage** (`main[aria-label="Sign in"]`): buttons `Sign in with a passkey` and `Sign in with this browser's key` (the latter only when a key exists in IndexedDB); `locked` → `Too many failed attempts. Try again in <n> minutes.`; a line `The Owner signs in on this computer without a password; everyone else uses the passkey or key they created when they joined.`
- **Status bar**: left-most item `You: <name> (<role label>)` (clicking selects the People view); right side gains `Remote: off` or `Remote: on · <label>` with class `attention`; `Keychain unavailable` logic unchanged; when `/api/status` says `secretStore: "file"` every `Stored in your keychain` string in the Connections editor reads `Stored in this server's encrypted secret store`.
- **Activity bar**: every view stays visible to every role (reading is allowed); write controls are disabled by role with the title `Your role (<role label>) cannot do this.` — `Start agent`, `New project name`, `Add card`, `Move to…` (reviewer+ enabled), the decision buttons (reviewer+), `Save`/`Test connection`/`Remove connection` (owner), the Needs-you strip shows cards to everyone but decision buttons follow the same rule.
- **PeopleSideBar**: `People here` (presence: `<name> · <role label> · <view label> in <project name>` or `· not in a project`), `Everyone` (name, role, online dot, `Invite someone` button for the Owner), `Remote access` summary (`Off` / `On · <label>` with `Open People` to the panel).
- **PeoplePanel** (`section[aria-label="People"]`, dock panel id `people`): table `Name · Role · Credentials · Last seen · Online`; Owner-only per row: a role select (`Viewer`, `Reviewer`, `Maintainer`), `Sign out everywhere`, `Remove` (confirm `Remove <name>`); `Invitations` (pending: role, expires, `Revoke`); `Remote access` form (Owner): switch `Allow people on the network to reach this workspace` (`role="switch"`, `aria-label="Remote access"`), port, `Domain (optional)`, TLS radios `Self-signed certificate` / `Certificate from Let's Encrypt (needs the domain and port 80)` / `My own certificate files` with two path inputs; a read-only `Certificate fingerprint` with `Copy`; the machine's addresses; the note `Browsers cannot verify a self-signed certificate: people will see a warning the first time. Set a domain to get a certificate browsers trust. Programs that connect to this workspace check the fingerprint instead.`; errors `owner_credential_required` → `Add a passkey or key for yourself first, under Your credentials. Your local sign-in never leaves this computer.`, `remote_start_failed` → `The listener could not start. Is the port free?`, `acme_failed` → `Let's Encrypt could not issue a certificate (<type>). Check that the domain points here and port 80 is reachable.`; `Your credentials` (every role): list with `Remove`, buttons `Add a passkey` and `Add a key for this browser`; `Sign out`.
- **InviteDialog** (`dialog[aria-label="Invite someone"]`): role radios with `ROLE_DESCRIPTIONS`; `Create invitation` → shows the link once in a read-only input with `Copy link`, the line `This link works once and expires in 7 days. Send it over a channel you trust.`, and, when remote is off, `Remote access is off: this link only works on this computer. Turn it on under Remote access to invite someone else.`
- `static-ui.ts`: `GET /join/*` and `GET /sign-in` serve `index.html` (public); everything else as today.

- [ ] **Step 1: Write failing tests:** JoinPage with a matching `#fp=` shows `They match.` and the passkey button; with a mismatch shows the attention line and a disabled form; with `passkeys: false` shows the key button and note; `invite_invalid` copy; SignInPage renders the key button only when `identity.hasBrowserKey()` resolves true; `identity.ensureBrowserKey` (WebCrypto stubbed) stores once and reuses; StatusBar shows `You: Reviewer One (Reviewer)` and `Remote: on · tt-test.local:4318` with the class; Workbench for a viewer disables `Start agent` with the title and keeps the decision card visible without buttons; PeoplePanel: the Owner's role select posts `{ role: "maintainer" }`, `Remove` confirms, the remote switch posts `{ enabled: true, tls: "self_signed" }`, `owner_credential_required` copy; InviteDialog shows the link once and the remote-off note; static-ui serves `index.html` for `/join/abc` and 404 for `/join/../token`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test && pnpm --filter @theterminal/core test server/static-ui`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `@simplewebauthn/browser` exactly.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): join and sign-in pages, People view with presence and remote access, roles throughout the shell`

---

### Task 10: The Linux server image, the file secret store and the CLI flags

**Files:** Create `Dockerfile`, `.dockerignore`, `packages/core/src/secrets/file-store.ts`, `packages/core/src/healthcheck.ts` (fetches `https://127.0.0.1:4318/healthz` with `rejectUnauthorized: false`, exits 0 on `{ ok: true }`, 1 otherwise; no other output). Modify `packages/core/src/cli.ts`, `server.ts`, `connection-routes.ts` (`/api/status.connections.secretStore`), `.github/workflows/ci.yml`. Tests `packages/core/test/secrets/file-store.test.ts`, `packages/core/test/cli.test.ts`, `packages/core/test/server/server.test.ts`.

**Interfaces:**
```ts
// secrets/file-store.ts
export class FileSecretStore implements SecretStore {
  constructor(opts: { file: string /* <dataDir>/secrets.enc.json */; keyFile: string; createKey?: boolean /* true: write 32 random bytes, mode 0o600, when missing */ });
  // AES-256-GCM; per value: random 12-byte nonce, tag; file = { version: 1, entries: { [account]: { n, c, t } } } written atomically (tmp + rename); a key file of the wrong size → SecretStoreUnavailableError
}
export type SecretStoreKind = "keychain" | "file" | "memory";
// server.ts
selectSecretStore(env, injected, flags?: { store?: "keychain" | "file"; keyFile?: string }): { store: SecretStore; kind: SecretStoreKind }   // "file" only from flags, never from env
createServer(opts: { …; secretStore?: "keychain" | "file"; secretKeyFile?: string; remote?: { enabled?: boolean; port?: number; bind?: string; domain?: string; tls?: TlsMode }; bootstrapInvite?: (url: string) => void })
// at startup with remote enabled and !people.hasOwnerCredential(): create an "owner" invite and call bootstrapInvite(url) once; the CLI prints `Open this link once to claim the Owner identity: <url>` to stdout (the invite link is the only secret ever printed, and only when no Owner credential exists)
// cli.ts flags: --remote, --remote-port N, --remote-bind ADDR, --remote-domain NAME, --remote-tls self_signed|acme|provided, --tls-cert FILE, --tls-key FILE, --secret-store keychain|file, --secret-key-file FILE
```
`Dockerfile` (multi-stage, exec-form entrypoint, no shell):
```dockerfile
FROM node:24.22.2-bookworm-slim AS build         # pin the digest the first `docker pull` prints: node:24.22.2-bookworm-slim@sha256:…
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm --filter @theterminal/core deploy --prod --node-linker hoisted /out/core && cp -r apps/ui/dist /out/ui
FROM node:24.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out /app
USER node
VOLUME ["/data"]
EXPOSE 4318 80
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "/app/core/dist/healthcheck.js"]   # fetches https://127.0.0.1:4318/healthz with rejectUnauthorized false; exit 0 on { ok: true }
ENTRYPOINT ["node", "/app/core/dist/cli.js", "start", "--data-dir", "/data", "--ui-dir", "/app/ui", "--secret-store", "file", "--secret-key-file", "/data/secret.key", "--remote", "--remote-bind", "0.0.0.0"]
```
`.dockerignore`: `node_modules`, `**/dist`, `.git`, `e2e`, `docs`. The image needs `git` for worktrees; `apt-get` is the one shell step and runs at build time only. CI gains job `server-image` on `ubuntu-latest`: `docker build -t theterminal-server .`; `docker run -d -p 4318:4318 -v "$RUNNER_TEMP/data:/data" theterminal-server`; wait up to 60 s for the container log line `Open this link once`; `curl -sk https://127.0.0.1:4318/healthz` equals `{"ok":true}`; `openssl s_client -connect 127.0.0.1:4318 </dev/null | openssl x509 -fingerprint -sha256 -noout` equals the fingerprint in the logged link's `#fp=`; the log must not contain `secret.key` contents (assert the key file is 32 bytes and `0600`). Actions in the new job are the already-pinned `actions/checkout`; no Docker actions.

- [ ] **Step 1: Write failing tests:** file store round trip, delete, missing → null; the file holds no plaintext of a stored `sk-ant-TESTKEY-0000000000`; a wrong key file → `SecretStoreUnavailableError` on `get`; `createKey` writes a 32-byte `0o600` file (mode check skipped on win32); `selectSecretStore(env with THETERMINAL_SECRET_STORE=file)` without flags → keychain (`kind: "keychain"`); with `flags.store === "file"` → `kind: "file"`; `/api/status.connections.secretStore` reports it; `cli.test.ts`: `--secret-store file` without `--secret-key-file` exits 1 with `--secret-store file needs --secret-key-file`; `--remote-tls acme` without `--remote-domain` exits 1; `createServer({ remote: { enabled: true, port: 0, bind: "127.0.0.1" }, bootstrapInvite })` on an empty data dir calls `bootstrapInvite` once with a URL containing `/join/` and `#fp=`, commits `remote.enabled` with actor `{ kind: "system", id: "cli" }`, and a restart does not call it again once the Owner joined.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test secrets cli server/server`. Expected: FAIL.
- [ ] **Step 3:** Implement. Build the image locally once (`docker build .`) and record the base image digest in the `Dockerfile`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS. Push; the `server-image` job must pass alongside macOS and Windows.
- [ ] **Step 5: Commit:** `feat: Linux server image with an encrypted file secret store and a one-time Owner bootstrap link`

---

### Task 11: Documentation and changelog

**Files:** Create `docs/collaboration.md`, `docs/self-hosting.md`. Modify `docs/connections-and-credentials.md` (a `## On a self-hosted server` section: the file store, where the key lives, that `Stored in your keychain` reads differently there; `## What collaborators see`), `README.md` (one paragraph: invite people, roles, self-host), `CHANGELOG.md`.

`docs/collaboration.md` covers: the four roles with `ROLE_DESCRIPTIONS` verbatim and the route table in words; inviting (one-time link, 7 days, what the fingerprint in the link is for and what to do on a mismatch); passkeys vs browser keys and when each is offered (IP addresses; adding a credential on a new device; `Add a key for this browser`); sign-in, sessions (14 days, per listener, `Sign out everywhere`), lockouts (5 failures, 15 minutes) and rate limits; what the ledger records about people (name, role changes, sign-ins, lockouts) and what it does not (sessions, addresses, user agents); gate requirements and how the Owner changes them; collaborators and connections (summaries only; runs on API keys; `api_key_required`); presence; removing a person.
`docs/self-hosting.md` covers: `docker run -d --name theterminal -p 443:4318 -p 80:80 -v theterminal-data:/data ghcr.io/<org>/theterminal` (placeholder org, no real account), the bootstrap link in the logs and that it is the only time a secret is printed; `--remote-domain` + `--remote-tls acme` for a trusted certificate (DNS A record, ports 80 and 443); self-signed mode and the fingerprint; the `/data` volume contents (ledger, `secret.key`, `remote/`), backing it up and that `secret.key` must be backed up separately from the data; running the same server on a LAN without Docker (`theterminal start --remote`); updating (pull, recreate, the data-folder lock); what the server image cannot do (no keychain, no desktop app, no personal subscriptions; collaborators and the Owner alike run agents on API keys there).

- [ ] **Step 1:** Write the pages. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: collaboration (roles, invites, passkeys, gates) and self-hosting (image, certificates, bootstrap)`

---

### Task 12: End-to-end: invite, join over TLS, roles, presence, remote on and off

**Files:** Create `e2e/people.spec.ts`, `e2e/remote.spec.ts`. Modify `e2e/global-setup.ts` (the agent server starts with `remote: { enabled: true, port: 47318, bind: "127.0.0.1", domain: null }` after registering an Owner passkey through the API with the soft authenticator; exposes `TT_E2E_REMOTE_URL` = `https://127.0.0.1:47318/` and `TT_E2E_FINGERPRINT`), `playwright.config.ts` (`ignoreHTTPSErrors: true` for the remote project only). Passkeys in the browser use Playwright's CDP virtual authenticator (`WebAuthn.enable`, `addVirtualAuthenticator { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true }`) on the **local** server (`theterminal.localhost`, where RP ID is valid); over the remote URL (an IP) the join page offers the browser key, which is the path the remote spec exercises.

- [ ] **Step 1: Write the failing e2e tests:**
  - people (local): the Owner opens People → `Invite someone` → `Reviewer` → copies the link; a second browser context opens it → `They match.` is absent (no `#fp=` on local) → types `Reviewer One` → `Create a passkey and join` → lands on the board with `You: Reviewer One (Reviewer)`; the Owner's People side bar shows `Reviewer One · Reviewer · Board in <project>` within 2 s (presence); the reviewer's `Start agent` is disabled with the title; the Owner starts the fake agent; the reviewer allows the shell step from the Needs-you strip and the ledger reads `Reviewer One allowed it`; the reviewer tries to move a card to Operate and the gate card says `You cannot sign this gate. It needs the Owner.`; the Owner changes the reviewer to Viewer → the decision buttons disappear in the reviewer's context without a reload; the Owner removes them → their next click lands on `/sign-in` **(Review Focus 3)**;
  - remote (TLS, browser key): the Owner creates a `Maintainer` invite while remote is on → the link starts with `https://127.0.0.1:47318/join/` and carries `#fp=` equal to `TT_E2E_FINGERPRINT`; a fresh context opens it → `They match.` → `Create a key in this browser and join` → `You: Maintainer Two (Maintainer)`; the maintainer opens Connections → sees `Only the Owner can see or change connection details.` and no editor; starts a fake run with `Azure (cloud account)` ticked → the ledger shows `Maintainer Two started a Fake agent…` and the shell output `env=AZURE_CLIENT_SECRET=[REDACTED]`; every response and frame in the context is checked for the secret **(Review Focus 1)**; `GET https://127.0.0.1:47318/?token=<token>` from the test → 401 **(Review Focus 2)**; a tampered link (`#fp=` with one pair changed) → the attention line and a disabled form; the status bar shows `Remote: on · 127.0.0.1:47318`; the Owner turns remote off in People → the ledger shows `Owner turned remote access off`, the status bar `Remote: off`, and the maintainer's next request fails (the listener is closed);
  - `GET /api/people` and `GET /api/presence` without a cookie → 401 on both listeners.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS, Windows and the `server-image` job. Open the pull request from `plan-8-cloud-collaboration` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): invite and join with a passkey and a browser key, roles, presence, remote access on and off`

---

## Done when

- The Owner invites people with one-time links; each joins with a passkey or a browser key, gets a role, and every ledger entry they cause names them; the narration reads `<name> allowed it`, `<name> moved …`.
- Viewers read, reviewers decide and sign what their role allows, maintainers start runs on API keys and give them access to connections by name, and only the Owner touches connections, people, remote access, gate requirements and overrides; a route without a role cannot exist.
- A collaborator never sees a credential value, a connection's configuration, the TLS private key or the Owner's token, through any response, the ledger or the stream.
- Gates name who may sign them; the Owner changes it on the record; a wrong signer is refused with nothing recorded.
- Remote access is off by default, runs on its own TLS port, and every on, off and certificate change is in the ledger and in the status bar; the token never works there; self-signed certificates are pinned by fingerprint in invite links and by non-browser clients; a domain gets a Let's Encrypt certificate that renews.
- Sign-ins are rate-limited and locked out; removing a person ends their sessions and sockets at once; presence shows who is here and what they look at.
- The same server runs on Linux as a container with an encrypted file secret store, prints a one-time Owner bootstrap link, and CI builds and smoke-tests the image while macOS and Windows stay green.
- `pnpm test` and `pnpm e2e` pass; the work is merged to `main` through a pull request.

## Spec gaps (for the author)

1. **Role names.** §4.5 names Owner · Approver · Auditor · Viewer; this plan (per the brief) ships owner · maintainer · reviewer · viewer and maps Approver → reviewer, Auditor → viewer. The spec should adopt one set; `maintainer` (starts work) has no counterpart in the spec.
2. **"Their area."** §4.5's Approver "signs off decisions/gates in their area": the spec defines no areas. This plan uses per-gate requirements (role or person) per project; a per-card or per-stage scope is not built.
3. **Owner's final say vs a named signer.** §4.5 lets gates require a specific person while the Owner has "final say". Decision here: the Owner cannot satisfy a `{ personId }` requirement without first changing it on the record. Confirm.
4. **Collaboration triggers a cloud move.** §4.5 and §12.5 say inviting prompts moving the workspace to the Owner's cloud or a temporary share link. This plan hosts on the Owner's machine or a self-hosted server and ships the container image; the one-click deploy (§4.1) and the share link (Plan 7) are elsewhere. The spec should say the LAN/self-hosted path is the default.
5. **Authentication is unspecified.** The spec never says how a collaborator proves who they are, how long they stay signed in, or what happens to a removed person's sessions. Decisions: passkeys or browser-held Ed25519 keys, 14-day listener-bound sessions, immediate revocation.
6. **IP addresses and passkeys.** WebAuthn refuses an IP as RP ID, so a LAN workspace reached by IP cannot use passkeys; the browser-key fallback and the `.local` name are this plan's answer. The spec is silent.
7. **Certificates.** The spec says nothing about TLS. Decisions: self-signed with fingerprint pinning, ACME over HTTP-01 for a domain, or the Owner's own files; browsers see a warning on self-signed certificates and the UI says so.
8. **Secrets on a headless server.** §8 says credentials stay on the Owner's machine or own cloud; 5A made that "the OS keychain". A container has none, so this plan adds an encrypted file store selected only by flag. Confirm the exception.
9. **API keys for collaborators when none exists.** §10.3 says collaborators use API keys; it does not say what happens when the Owner has only a subscription. Decision: the run is refused (`api_key_required`).
10. **What the ledger holds about people.** The spec wants every entry to name a person but says nothing about sign-ins, lockouts or sessions. Decisions: sign-ins, invites, joins, role changes, removals and lockouts are ledger events; sessions, challenges, addresses and user agents never are. A chosen display name is the only personal field and travels with ledger exports (Plan 3).
11. **Presence granularity.** "What they're looking at" is implemented as the view (Board, Ledger, …) and the project, not the card or file, to avoid turning presence into surveillance. Confirm.
12. **Invite delivery and expiry** (7 days, one use, copied by the Owner) and **session length** (14 days) are this plan's numbers; the spec has none.
