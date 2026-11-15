# Plan 8: Cloud and Collaboration Implementation Plan

**Goal:** Other people join the Owner's workspace with their own identity and role, see the same board and ledger, decide and sign off what their role allows, and trigger runs that use the Owner's connections without ever seeing a credential; every ledger entry names the person who caused it. The workspace stays local-first: the Owner hosts it, on their own machine over the LAN or on a Linux server they run (the same server code, packaged as a container image), behind a separate TLS listener that is off by default and whose every state change is in the ledger and in the status bar.

**Architecture:**
- **People are ledger state.** `person.*` events (invited, joined, credential added or removed, renamed, role changed, removed, signed in, locked) and `remote.*` events (enabled, disabled, certificate changed) are ordinary ledger entries with projections (`people`, `credentials`, `invites`, `remote`). The Owner is the pre-existing actor id `owner`, so every entry written since Plan 1 is already attributed to the right person. Sessions, WebAuthn signature counters, lockout counters and challenges are **not** ledger state: they are revocable auth bookkeeping in two plain tables (`sessions`, `credential_state`) and in memory.
- **One Fastify instance, two listeners.** The existing HTTP server keeps listening on `127.0.0.1`. The remote listener is a `tls.Server` that hands every secure socket to the same HTTP server (`app.server.emit("connection", socket)`), so there is one route table, one auth hook and one WebSocket server; a request knows its listener from `request.raw.socket.encrypted`. The local listener accepts the Owner's token (as today) or a session; the remote listener accepts sessions only, never the token, and its cookies are `Secure`.
- **Identity.** An invite is a one-time 128-bit code in a link; joining registers a **passkey** (WebAuthn through `@simplewebauthn/server`, discoverable, attestation `none`) or, where passkeys cannot work (the origin is an IP address, or the browser has no WebAuthn), a **non-extractable Ed25519 key** made by the browser's WebCrypto and verified by `node:crypto`. The same Ed25519 path serves non-browser clients such as the CLI (Plan 6's linked machines are *not* such a client: they authenticate each other by mutual TLS on their own listener and never hold a session here). A session is a random 32-byte id stored hashed, bound to the listener it was created on.
- **Authorisation is a strict lattice** `viewer < reviewer < maintainer < owner`; every route declares its minimum role in one table (`ROUTE_ROLES`), there is no default for an unlisted route (not even for a `GET`: it fails closed), and a test asserts every registered route, including Plan 6's `/api/link/*` and Plan 7's share and digest routes, is in the table or in the public set. Gates keep Plan 3's engine and gain a requirement (`{ role }` or `{ personId }`, default per gate) that the signer must satisfy.
- **Credentials never leave the host.** Runs started by collaborators resolve credentials from the Owner's connections exactly as today (the runner never knew who asked); non-owners see connections as summaries (name, kind, status) and, per spec §10.3, their runs use API keys, never the Owner's personal subscription.
- **Self-hosting.** `Dockerfile` builds the core and UI on `node:24.22.2-bookworm-slim`, runs as `node`, keeps `/data` as the data folder and `/key` as a separate mount for the secret key, starts with the remote listener on and prints a one-time, one-hour Owner bootstrap invite when no Owner credential exists. Because a headless Linux server has no keychain, an AES-256-GCM `FileSecretStore` keyed by a key file outside the data folder is selectable **only** by an explicit CLI flag.

**Tech Stack:** existing stack, plus `@simplewebauthn/server` **14.0.3** (MIT, Node ≥ 20, published 2026-09-25; 14.1.0 of 2026-11-06 is under two weeks old on 2026-11-15) in core and `@simplewebauthn/browser` **14.0.0** (MIT, 2026-09-02) in the UI; `@peculiar/x509` **2.2.0** (MIT, 2026-10-15; the version `@simplewebauthn/server`'s `^2.1.0` resolves to, so one copy *of the 2.x line*; `acme-client` depends on `^1.11.0`, so the lockfile holds a second copy, 1.14.3, plus `tslib` 1.x and 2.x; all MIT/0BSD) for the self-signed certificate; `acme-client` **5.4.0** (MIT, 2024-07-16; HTTP-01 only; its last release predates this plan by sixteen months and it still targets the x509 1.x line) for certificates from Let's Encrypt when the Owner sets a domain. `acme-client`'s transitive ranges float, and on 2026-11-15 three of them resolve to versions under fourteen days old, so `pnpm-workspace.yaml` `overrides` pin **`axios` 1.21.0** (MIT, 2026-10-27), **`follow-redirects` 1.16.2** (MIT, 2026-10-25) and **`node-forge` 1.4.2** (`(BSD-3-Clause OR GPL-2.0)`, BSD applies, 2026-10-27), each with a one-line reason like the `dockview` pins (re-check the dates when the branch is cut; the newer versions may be old enough by then). The transitive closure (62 packages) has no `preinstall`/`install`/`postinstall` script, so `allowBuilds` needs no new entry; `axios` honours `HTTPS_PROXY`/`NO_PROXY` from the server's environment, which `docs/self-hosting.md` says. Ed25519 signing and verification, AES-256-GCM, SHA-256 and random ids come from `node:crypto`; TLS from `node:tls`. No rate-limit dependency: the limiter is forty lines (`throttle.ts`). All new dependencies are exact versions (the four direct pins plus the three overrides) and land in one `chore(deps)` commit before any task, so every worktree starts from one lockfile.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §2 goal 8 (self-hostable) and goal 9 (offline: LAN keeps working), §4.1 "Own cloud" (collaborators can log in; credentials never touch a third party) and "Own local address", §4.5 (roles; every ledger entry names a person; gates can require a specific person or role; presence; collaborators use connections through the workspace without seeing credentials), §5 (a named human signs off), §8 (credentials stay with the Owner; the ledger is complete), §10.3 (collaborators and cloud agents use API keys), §12 calls 5 and 9. Builds on Plans 1–5B, 3, 4, 6, 7 and 9A (all assumed built): Plan 3's `commitEvents`, `HumanRequiredError`, `GateService.move`, `GateEvaluation`, `narrate`/`NarrationContext`; Plan 4's `override.*` and presets; Plan 6's `/api/link/*` routes (given roles here) and its `machine` narration (its linked machines authenticate by mutual TLS and never use this plan's key login; the one thing shared is `node:crypto` Ed25519 and SPKI DER); Plan 7's share view and digests (read by viewers here, and their literal `Owner` labels corrected here); Plan 9A's `cli.ts` IPC, data-folder lock and `allowlistedEnv`. The branch is cut from `main` after Plans 6 **and** 7 merge.

## Decisions

- **Decision (controller default): topology stays local-first; collaboration means people get their own identity and role on a workspace the Owner hosts, on the Owner's machine over the LAN or on a self-hosted Linux server running the same server code, packaged with a `Dockerfile`; no vendor-hosted SaaS and no one-click cloud deploy in this plan.** Why: spec §2 non-goal ("making money from hosting"), §4.1 (the own-cloud home runs *the same workspace*), §8 (credentials stay with the Owner). The one-click deploy into the Owner's cloud account (§4.1) needs the infrastructure lifecycle pack; the container image is what it will deploy.
- **Decision (controller default): identity is an invite link carrying a one-time code, a passkey or an Ed25519 key per person, and a session per person per listener; the Owner keeps the local token for the local listener and must add a passkey or key before remote access can be turned on, because the token never travels.** Why: spec §4.5 ("every ledger entry names a person"); passkeys are phishing-resistant and need no password store; an Ed25519 key is the fallback for origins that are IP addresses (WebAuthn forbids an IP as RP ID) and the identity a non-browser client (Plan 6) can hold; a one-time code means a leaked link is useless after the first use.
- **Decision (controller default): four roles in a strict order, `viewer < reviewer < maintainer < owner`.** Viewer: read everything the Owner sees except connection details and people management (board, stories, ledger, feed, capacity, share view, who is present). Reviewer: viewer plus deciding agent actions, making intake decisions, moving cards and signing off or waiving gates whose requirement they satisfy. Maintainer: reviewer plus starting and stopping runs (on API keys), creating cards, starting, answering and reopening the intake, asking agents, and giving a run access to connections by name. Owner: everything, alone: connections, provider auth modes, people, remote access, gate requirements, emergency override, capacity detection. Spec §4.5's Approver and Auditor map to `reviewer` and `viewer`. Why: a strict order is explainable in one sentence and testable in one table; separation of duties comes from gate requirements, not from a second axis.
- **Decision (controller default): gates carry a requirement, `{ role }` or `{ personId }`, with defaults `reviewer` for `plan_approved` and `ready_to_ship` and `owner` for `network_exposure`, `payments`, `personal_data`, `go_live` and `over_budget`; the Owner changes a requirement per project with a recorded `gate.requirement_set`; a `{ personId }` requirement is satisfied by that person only, the Owner included, so the Owner's way past it is to change the requirement first, which the ledger shows.** Why: spec §4.5 ("gates can require a specific person or role") and §5 (a *named* human signs off); a silent Owner bypass would make the requirement decorative.
- **Decision (controller default): a run started by anyone but the Owner runs in `api_key` mode; when the provider has no API key the start is refused with `api_key_required`.** Why: spec §10.3 (consumer plans are licensed for one person; collaborators use API keys) and §2 anti-goal "getting around providers' rules".
- **Decision (controller default): the remote listener is a separate TLS port (default 4318) bound to `0.0.0.0`, off by default; turning it on or off and every certificate change are ledger entries and the status bar shows `Remote: on` in the attention colour. TLS is self-signed by default (ECDSA P-256, 10 years, SANs for the machine's addresses and `.local` name), with the certificate's SHA-256 fingerprint shown in the People view and carried in every invite link; when the Owner sets a domain the certificate comes from ACME over HTTP-01 (port 80), renewed 30 days before expiry; the Owner may instead point at their own certificate and key files.** Why: §4.1 "own local address" keeps the local workspace at `theterminal.localhost` and never exposed; a separate port makes "exposed to the network" a single switch the ledger can record; pinning is real only for non-browser clients (the desktop app, the CLI, the Dockerfile smoke test), because a browser gives a page no access to the certificate it saw, so the join page shows the fingerprint for the person to compare out of band (the browser's lock icon) and never claims a match on its own; the UI says plainly that a domain is needed for browsers to verify the certificate.
- **Decision (controller default): auth-sensitive routes are rate-limited per source address (10 per minute, 429) and a credential is locked for 15 minutes after 5 failed sign-ins *from one source address* (423, recorded as `person.locked` without the address); the lockout counters live in memory, keyed by `sha256(credentialId + "\n" + address)`, never in a table.** Why: the brief; codes and challenges are 128-bit so the limiter protects the passkey and key paths and the server's CPU, not the code space. Keying the lockout on the credential alone would let anyone who has seen a public key or credential id (both are in the ledger, which reviewers can export) lock a person out for ever from behind the throttle; keying on the pair, in memory, keeps the address out of the database (Global Constraint "nothing personal").
- **Decision (controller default): passkeys require user verification (`userVerification: "required"`, and `verifyAuthentication` requires the `uv` flag).** Why: a workspace that starts agents with the Owner's cloud credentials should not accept a security key that was merely touched; `preferred` would let an unlocked key sign in.
- **Decision (controller default): the host is the single writer; clients submit commands (HTTP) and receive the ordered ledger (WebSocket); there is no client-side ledger and no merge.** Why: the hash chain has one `prevHash` per entry, so one process must order appends; every write already goes through `commitEvent(s)` in one SQLite transaction. Plan 6 keeps this true across machines in its own way: a linked worker records its own ledger and the requester commits signed copies as `link.mirrored`, so each machine stays the single writer of its own chain; nothing in Plan 6 submits `/api/*` commands or holds a session.
- **Decision (controller default): sessions, challenges, WebAuthn counters and lockout counters are not ledger events; sign-ins, invites, joins, role changes, removals and lockouts are.** Why: the ledger records decisions and actions people are accountable for (spec §5); a session row is revocable state that must be deletable, which an append-only ledger is not; presence is live state, not history.
- **Decision (controller default): on a headless Linux server the secret store is an encrypted file (`FileSecretStore`, AES-256-GCM, one nonce per value, key from a file the CLI is pointed at), chosen only by `--secret-store file --secret-key-file <path>`; the server refuses to start when the key file resolves inside the data directory unless `--allow-key-in-data-dir` is given, and the image mounts the key at `/key/secret.key`, a separate volume from `/data`; the keychain stays the default everywhere and the UI's copy changes from `your keychain` to `this server's encrypted secret store` when the status reports `secretStore: "file"`.** Why: a container has no Secret Service; the alternative, a server that cannot hold connections, cannot run agents; the key file must live outside the volume that holds the ciphertext (`secrets.enc.json`) and the ledger, or a backup of `/data` holds key and ciphertext together and "back up the key separately" cannot be followed. This loosens 5A's "keychain only" and is flagged for the author under Spec gaps.
- **Decision (controller default): the remote Host check accepts, when a domain is set, exactly that domain with the remote port; otherwise only hostnames that are IP literals (IPv4, or IPv6 in brackets) or end in `.local`, with the remote port. `GET /healthz` alone is exempt from the check.** Why: DNS rebinding needs a public name, which neither form is; a `.local` name is what mDNS gives a LAN machine and what a passkey needs as RP ID. The container's `HEALTHCHECK` fetches `https://127.0.0.1:4318/healthz`, which a domain-only Host rule would answer 403 and Docker would mark unhealthy; `/healthz` returns `{ ok: true }` and nothing else, so a rebinding attacker gains nothing from it.
- **Decision (controller default): `trustProxy` stays off; `request.ip` is the socket's peer address.** Why: a reverse proxy is out of scope, and honouring `X-Forwarded-For` would let any client choose its throttle bucket. (Behind Docker's userland proxy, traffic from the host itself may share one bucket; `docs/self-hosting.md` says so.)
- **Decision (controller default): the Linux image is a CI build and smoke test on `ubuntu-latest`, not a third test matrix entry.** Why: the brief asks for macOS and Windows CI plus a Linux build of the server image; the image's build stage runs `pnpm build`, and the smoke test proves the container starts, serves TLS with the fingerprint it printed, answers `/healthz`, and starts again after `docker kill` (the data-folder lock from Plan 9A names PID 1 in a container, and a lock naming our own pid must count as stale, or the container never recovers from an unclean stop) without printing a second bootstrap link.

## Out of scope (later plans)

- One-click deploy of the image into the Owner's AWS/GCP/Azure account (§4.1): the infrastructure pack, using Plan 5B's cloud grants. Plan 8 ships the image and documents `docker run`.
- A hosted version of any kind (§2 non-goal). Email or push invitations: the Owner copies the link.
- Per-card or per-stage permissions; a second permission axis ("their area" in §4.5's Approver): gate requirements cover it.
- Signing ledger entries with the person's key (a verifiable ledger of who wrote what). The ledger names the person; the host vouches.
- Comments and discussion threads between collaborators; notifications.
- TLS-ALPN-01, DNS-01 and wildcard certificates; a reverse proxy; HTTP/2.
- Linking a second Terminal (Plan 6) and the share view's link server (Plan 7) keep their protocols. What this plan does touch: every Plan 6 and Plan 7 route gets a role; the literal `Owner` in their narration templates, in the share page's `owner`, `by` and `assignee` and in the digest's `started a … agent` line becomes the acting person (Task 0, Task 5), or a reviewer's sign-off would be shown to investors as the Owner's.
- Naming the person on a run that executes on a linked machine (Plan 6): the worker records `agent.started` with actor `owner` and `remoteStartSchema` carries no person. Plan 8 passes the principal to `remoteRuns.start/decide/stop` and checks their role, but the wire schema is Plan 6's; adding `personId`/`personName` to it is a later change, and `docs/collaboration.md` says that until then a remote run's own ledger names the Owner (the requester's `link.run_requested` names the person).

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, workflow logs or commit messages. Test people are `Reviewer One`, `Maintainer Two`; test hosts are `tt-test.local` and `127.0.0.1`; invite codes, challenges and session ids in fixtures are generated at test time, never literal.
- **Nothing personal beyond a chosen display name.** A person's display name (1–60 characters, checked with `redact`) is the only personal field anywhere; no email, no login, no IP address, no user agent is recorded in the ledger, the database or a response. The throttle keys on an address in memory only.
- **Default-deny auth, now with roles.** Every `/api/*` route except the public auth and join routes requires a principal, and every one declares a minimum role in `ROUTE_ROLES`, Plan 6's and Plan 7's included; there is no "unlisted `GET` is a viewer" default: a route missing from the table answers 500 at request time, fails the `routes-have-roles` test and stops the server at startup. Fastify's auto-registered `HEAD` twins of `GET` routes take the `GET` entry. `trustProxy` is never enabled. Over the remote listener the token is never accepted and `/?token=` answers 401.
- **Credentials stay with the Owner.** No response to a non-owner contains a connection's `config`, `private`, `secretFields`, a credential value, a certificate private key or an ACME account key. The private TLS key and the ACME account key live in the secret store; the certificate (public) is a file. The remote listener's key material is never in the ledger or a response.
- **Keychain-only secrets, with the one explicit exception:** `FileSecretStore` is selected only by `--secret-store file`, never by environment variable or default, and `THETERMINAL_SECRET_STORE=memory` keeps requiring `THETERMINAL_FAKE_AGENT=1`.
- **Every child environment is built by `buildChildEnv`;** nothing in this plan spawns a process at all except the ACME client's HTTPS requests (in-process `fetch`-like through `axios`, no shell). No `shell: true` anywhere, including the Dockerfile's `ENTRYPOINT` (exec form).
- **Redact before truncating; fail closed.** Names, invite errors and WebAuthn errors pass through `redact()` and are then clipped; a WebAuthn or signature verification error of any kind is `401 invalid_credential` with no detail; a session whose person was removed or whose listener differs is `401`; an invite that is unknown, used, expired or revoked is `404 invite_invalid` (one code for all four); the remote listener refuses to start without a certificate rather than falling back to plain HTTP; a ledger that is read-only refuses sign-ins (they are recorded) with 423.
- **Every write names the person.** No route constant actor remains, in `routes.ts`, `agent-routes.ts`, `server.ts` (`connection.signin`), Plan 7's `share-routes.ts` or Plan 6's `link-routes.ts`: `actor` is `{ kind: "human", id: request.principal.personId }` everywhere a human acts; `system` actors stay for the runner, policy and the CLI. The one exception this plan cannot close is the worker side of a Plan 6 remote run (see Out of scope).
- **The ledger records the exposure.** `remote.enabled` / `remote.disabled` / `remote.certificate_changed` are committed before the listener starts or after it stops, and the status bar reflects the projection, not a flag.
- **Projections rebuild exactly** from the ledger for `people`, `credentials`, `invites`, `remote` and `gate_requirements`; `sessions` and `credential_state` are not projections and are not in `PROJECTION_TABLES`; lockout counters and challenges are in memory only.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`:** `THETERMINAL_FAKE_ACME=1` (a fake ACME directory in-process) and `THETERMINAL_FAKE_TIME` are ignored otherwise. WebAuthn tests use a software authenticator built in the test (`test/fixtures/webauthn.ts`), never a real one.
- **Platform.** CI stays green on macOS and Windows for `pnpm test` and `pnpm e2e`; a `server-image` job on `ubuntu-latest` builds and smoke-tests the container. The CLI's new flags work on all three; paths travel through `node:path`.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-8-cloud-collaboration` (cut from `main` after Plans 6 and 7 merge), one commit per task, pushed when it lands, and merges through a pull request once CI is green. Tasks run in the waves below, in worktrees off that branch, with one owner per shared file per wave. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1–7/9A constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, `127.0.0.1` for the local listener, every agent action gated before it runs, allowlisted child env, live redaction, narration pure, estimates labelled, overrides in red, data-folder lock).

## Review Focus

1. **A collaborator reaching for a credential.** A maintainer calls `GET /api/connections`, `GET /api/connections/:id`, `PATCH`, `POST …/test`, `GET /api/capacity`, then starts a run with `connectionIds: [awsId]` and the fake agent prints its environment. Expected: the list is `ConnectionSummary[]` (no `config`, `private`, `secretFields`), the item and the writes are 403 `forbidden`, the capacity report carries no key-source detail, the run starts and its recorded output shows `[REDACTED]`, and no response during the sequence contains the key or the minted token. A viewer then calls `GET /api/runs/:id/file`, `…/diff`, `…/changes`, `…/files` and `GET /api/ledger/export`: 403 on all five (file contents from an agent worktree are what Plan 7 keeps off the share page for the same reason). A table-driven test seeds a secret into a connection, a worktree file and an action output and asserts no secret-shaped string in the response to **every** `GET` route for a viewer, a reviewer and a maintainer. (Tests in Tasks 4 and 12.)
2. **The Owner's token over the remote listener.** `Authorization: Bearer <token>` and `GET /?token=<token>` arrive over TLS; a `tt_session` cookie minted on the local listener is replayed over TLS; a remote session cookie is replayed on the local listener. Expected: 401 in every case, no redirect carrying the token, no `person.signed_in`. (Tests in Task 6.)
3. **A person removed or demoted mid-session.** A reviewer holds a session and an open `/api/events` socket; the Owner demotes them to viewer, then removes them. Expected: after the demotion the next `POST /api/actions/:id/decision` is 403 and the socket stays open; after the removal the next request is 401, the socket closes with 1008 within a second, presence no longer lists them, and `people` shows them removed. (Tests in Tasks 2, 3 and 8.)
4. **Brute force.** Eleven `GET /api/join/<random>` from one address in a minute; five wrong passkey assertions for one credential from address A, then a correct one from A and a correct one from address B; five wrong Ed25519 signatures for a public key copied from the ledger export, from A; a challenge reused; 1001 challenges issued from A while B holds one; an assertion with `uv = false`; an assertion for a removed person's credential. Expected: the eleventh is 429 `rate_limited` with `retryAfterS`; the sixth attempt from A is 423 `locked` although it is valid, `person.locked` is recorded once and carries no address, the correct one from B signs in, and a correct assertion from A after 15 minutes signs in; the bad signatures lock only the pair (key, A); the reused challenge, the `uv = false` assertion and the removed person's assertion are 401 `invalid_credential` with no detail and no `person.signed_in`; B's challenge still consumes. (Tests in Tasks 1 and 3.)
5. **A gate signed by the wrong person.** A reviewer signs off `go_live`; the Owner sets `ready_to_ship`'s requirement to `{ personId: <maintainer> }` and a different maintainer signs it; the Owner then signs it. Expected: 403 `gate_requires` naming the gate and the requirement, nothing recorded, the card unmoved, in all three cases; after `gate.requirement_set` back to `{ role: "reviewer" }` the first reviewer's sign-off is recorded with `signedBy` equal to their person id. (Tests in Task 5.)

---

## Waves and serialisation order

The branch `plan-8-cloud-collaboration` is cut from `main` after Plans 6 **and** 7 merge. Each task runs in its own worktree off that branch; within a wave the worktrees run in parallel and no two edit the same file; across waves a task rebases onto what landed. Task numbers below are the tasks of this plan; a letter splits a task into the part that can run earlier.

**Before Wave 1, one commit: `chore(deps): webauthn, x509 and acme clients, pinned, with overrides for their floating transitive ranges`.** It adds `@simplewebauthn/server` 14.0.3 and `@peculiar/x509` 2.2.0 and `acme-client` 5.4.0 to `packages/core/package.json`, `@simplewebauthn/browser` 14.0.0 to `apps/ui/package.json`, and `overrides` for `axios` 1.21.0, `follow-redirects` 1.16.2 and `node-forge` 1.4.2 to `pnpm-workspace.yaml` (one-line reason each), re-verifying every pin with `npm view` (published at least fourteen days before the cut, licence, no install scripts; `allowBuilds` gets `false` for any newly reported script). `pnpm install --frozen-lockfile` must pass on macOS and Windows before any worktree is cut, so nobody hand-merges `pnpm-lock.yaml`.

| Wave | Worktrees (in parallel) | Depends on | Shared-file rule |
|---|---|---|---|
| **1** | **T0** shared people, gates, narration (incl. `Principal`, `CERT_FINGERPRINT`, the Plan 6/7 `Owner` literals, `share.ts`/`digest.ts` types) · **T2a** `server/throttle.ts` + tests · **T6a** `server/certs.ts` + tests · **T10a** `secrets/file-store.ts` + tests | `chore(deps)` | Disjoint files. T2a, T6a and T10a are leaf modules with no import from T0. |
| **2** | **T1** people core (projections, `db.ts`, sessions, challenges, lockouts, service; `story/story.ts` `narrationContext` gains `personName`) · **T3a** `people/{webauthn,ed25519}.ts` + `test/fixtures/webauthn.ts` · **T6b** `server/remote.ts` + `remote-routes.ts` against a stub `{ hasOwnerCredential }` (no `server.ts` wiring; the `/healthz` Host exemption) · **T8a** `server/presence.ts` + tests | T0 | T1 owns `db.ts`, `projections.ts`, `story/story.ts`; T3a, T6b and T8a touch no existing file. |
| **3** | **T2b** `auth.ts` rewrite (the full `ROUTE_ROLES` incl. Plan 6/7 routes; `HEAD`; `PUBLIC_ROUTE` kept) + `server.ts` wiring of `SessionStore`/`ChallengeStore`/`PeopleService`/`Throttle` + `assertRoutesHaveRoles` · **T5** gates service + `GateCard.tsx` + its own `gates-routes.ts` + `share/snapshot.ts` attributions (the one `move` handler line in `routes.ts` is applied in Wave 4) · **T7** `server/acme.ts` + `remote.ts` ACME path (on T6b) | T1, T3a, T6b | `server.ts`: T2b only. `routes.ts`: nobody (T5's handler line waits for Wave 4). |
| **4** | **T3b** `people-routes.ts` (an encapsulated plugin with its own error handler) + its `server.ts` registration · **T4** every route file's `actorOf`/`requireRole`, runner `forceApiKey`, `ConnectionSummary`, `connection-routes` `/api/status` trim, `api.ts` + Connections/AgentPanel UI; applies T5's `move` line · **T8b** `events-ws.ts` (principal, presence frames, revoke close, `GET /api/presence`) + `api.ts` `subscribeLedger` routing | T2b, T5, T8a | Serialise `server.ts`: T3b lands first, T4 and T8b rebase (each adds one `register…` line). `api.ts`: T4 lands first, T8b rebases. `routes.ts`: T4 only. `connection-routes.ts`: T4 only this wave. |
| **5** | **T6c** `server.ts` wiring of `RemoteListener`/`AcmeManager`, `createServer({ remote })`, `RunningServer.remoteUrl/fingerprint`, `/api/status.remote` · **T9** UI (join and sign-in pages, People view, shell roles, the final `views.ts` order, `static-ui.ts` SPA routes) · **T10b** `cli.ts` flags + `USAGE`, `selectSecretStore` flags, bootstrap invite, `healthcheck.ts`, the lock's own-pid case, `Dockerfile` with `--filter`, `.dockerignore`, `ci.yml` `server-image` job | T3b, T4, T7, T8b, T10a | `server.ts` and `connection-routes.ts`: T6c lands first, T10b rebases. T9 touches no core file but `static-ui.ts` (its own). T10b owns `cli.ts`, `cli-support.ts`, `data-dir-lock.ts`, `Dockerfile`, `ci.yml`. |
| **6** | **T11** docs · **T12** e2e (`global-setup.ts`, `playwright.config.ts`, two specs) | T9, T10b | Disjoint. T12 rebases `e2e/global-setup.ts` on Plan 6's and Plan 7's versions already on `main`. |

Critical path: T0 → T1 → T2b → T4 → T6c/T9/T10b → T12 (six waves). T5 may start in Wave 2 if it stubs the requirement lookups (it needs only T0 and `gates/service.ts`); T7 is off the critical path and may slip to Wave 4.

Serialisation order for every file more than one task edits: `server.ts` 2b → 3b → 4 → 8b → 6c → 10b (one `register…` or constructor line each, rebased in order) · `routes.ts` 4 only (5's `move` line folded in) · `connection-routes.ts` 4 → 6c → 10b · `api.ts` 4 → 8b → 9 · `events-ws.ts` 8b only · `people-routes.ts` 3b only · `GateCard.tsx` 5 only · `shared/gates.ts` 0 only · `packages/core/package.json`, `apps/ui/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` once, before Wave 1 · `e2e/global-setup.ts` 12 only · `docs/connections-and-credentials.md` 11 only.

Decoupling moves that make the waves possible (each is written into its task): `Principal` lives in `shared/people.ts` (Task 0) and `auth.ts` re-exports it; `RemoteDeps.people` is `{ hasOwnerCredential(): boolean }`, not the whole `PeopleService`; `people-routes.ts` is an encapsulated Fastify plugin with its own `setErrorHandler`, so `routes.ts`'s error map is Task 4's alone; `GET /api/presence` is registered by `events-ws.ts`'s plugin, not `people-routes.ts`; `GateService.evaluate` and `move` take `signer` as an optional trailing argument, so Plan 7's `buildSnapshot` and every existing caller compile unchanged; Task 2 keeps `PUBLIC_ROUTE` so `static-ui.ts` compiles until Task 9 touches it.

---

## File Structure

```
packages/core/package.json, apps/ui/package.json, pnpm-workspace.yaml, pnpm-lock.yaml  # (modify) the four pins and three overrides (chore(deps), before Wave 1)

packages/shared/src/people.ts                 # roles, Person/Credential/Invite/Remote/Principal types, CERT_FINGERPRINT, person.* and remote.* schemas (Task 0)
packages/shared/src/gates.ts                  # (modify) GateRequirement, defaults, satisfies, gate.requirement_set (Task 0)
packages/shared/src/narration.ts              # (modify) actorName → person name from ctx; Plan 6/7 "Owner" literals → <Who> (Task 0)
packages/shared/src/share.ts, digest.ts       # (modify) owner/by/assignee become strings; digest "started" line names the person (Task 0)
packages/shared/src/events.ts, index.ts       # (modify)

packages/core/src/people/service.ts           # PeopleService: invites, join, credentials, roles, removal (Task 1)
packages/core/src/people/sessions.ts          # SessionStore (hashed ids, listener-bound, revocation) (Task 1)
packages/core/src/people/challenges.ts        # ChallengeStore (in memory, 5 min, single use, bounded per client) (Task 1)
packages/core/src/people/lockouts.ts          # LockoutStore (in memory, keyed by credential + source address) (Task 1)
packages/core/src/people/webauthn.ts          # registration/authentication options and verification (Task 3)
packages/core/src/people/ed25519.ts           # verifyKeyLogin, keyCredentialId (Task 3)
packages/core/src/server/auth.ts              # (rewrite) principal, listeners, requireRole, the full ROUTE_ROLES incl. Plan 6/7 routes, PUBLIC_ROUTE kept (Task 2)
packages/core/src/server/throttle.ts          # Throttle (Task 2)
packages/core/src/server/people-routes.ts     # /api/people*, /api/me*, /api/join/*, /api/auth/*; encapsulated plugin with its own error handler (Task 3)
packages/core/src/server/remote.ts            # RemoteListener: tls.Server → app.server, certificate sources (Task 6)
packages/core/src/server/certs.ts             # selfSignedTlsCertificate, certFingerprint, loadProvided (Task 6)
packages/core/src/server/acme.ts              # AcmeManager (HTTP-01, renewal), fakeAcme (Task 7)
packages/core/src/server/remote-routes.ts     # GET/PUT /api/remote, /healthz (Host-exempt) (Tasks 6, 7)
packages/core/src/server/presence.ts          # PresenceRegistry (Task 8)
packages/core/src/server/events-ws.ts         # (modify) principal on connect, presence messages, close on revoke, GET /api/presence (Task 8)
packages/core/src/server/gates-routes.ts      # PUT /api/projects/:id/gates/:gateId/requirement (Task 5)
packages/core/src/server/{routes,agent-routes,connection-routes,capacity-routes,intake-routes,story-routes,override-routes,github-routes,share-routes,link-routes}.ts  # (modify) actorOf, requireRole; share-routes and link-routes are Plan 7's and Plan 6's (Task 4)
packages/core/src/gates/service.ts            # (modify) requirement check, requirement_set; signer as an optional trailing argument (Task 5)
packages/core/src/share/snapshot.ts           # (modify, Plan 7's) owner, by and assignee from people (Task 5)
packages/core/src/story/story.ts              # (modify) narrationContext(db) gains personName (Task 1)
packages/core/src/secrets/file-store.ts       # FileSecretStore (Task 10)
packages/core/src/healthcheck.ts              # container HEALTHCHECK entry (Task 10)
packages/core/src/server/data-dir-lock.ts     # (modify, Plan 9A's) a lock naming our own pid is stale (Task 10)
packages/core/src/events/projections.ts       # (modify) people, credentials, invites, remote, gate_requirements reducers (Task 1)
packages/core/src/db.ts                       # (modify) migration: projections + sessions + credential_state (Task 1)
packages/core/src/server/server.ts            # (modify) wire people, sessions, remote, presence, bootstrap invite (Tasks 2, 3, 4, 6, 8, 10; see the serialisation order)
packages/core/src/cli.ts, cli-support.ts      # (modify) --remote, --remote-port, --remote-bind, --remote-domain, --remote-tls, --tls-cert, --tls-key, --secret-store, --secret-key-file, --allow-key-in-data-dir; USAGE (Task 10)
packages/core/test/fixtures/webauthn.ts       # software authenticator for tests (Task 3)

apps/ui/src/pages/JoinPage.tsx                # /join/<code> (Task 9)
apps/ui/src/pages/SignInPage.tsx              # /sign-in (Task 9)
apps/ui/src/identity.ts                       # WebCrypto Ed25519 key in IndexedDB; passkey calls (Task 9)
apps/ui/src/views/PeopleSideBar.tsx           # people, invites, remote access (Task 9)
apps/ui/src/views/PeoplePanel.tsx             # main tab: people table, sessions, remote access form (Task 9)
apps/ui/src/components/InviteDialog.tsx       # (Task 9)
apps/ui/src/shell/{views,model}.ts, shell/{StatusBar,ActivityBar,Workbench,Dock}.tsx  # (modify) people view and the final VIEWS order, me, remote item, role gating (Task 9)
apps/ui/src/main.tsx, App.tsx, api.ts         # (modify) page routing; people/auth/remote calls; subscribeLedger presence frames (Tasks 4, 8, 9)
apps/ui/src/components/GateCard.tsx           # (modify) requirement copy, role-gated buttons (Task 5 only)
apps/ui/src/views/{ConnectionsSideBar,ConnectionEditor}.tsx, components/AgentPanel.tsx  # (modify) summaries, api-key note, secret-store wording (Tasks 4, 9)

Dockerfile, .dockerignore                     # (Task 10)
.github/workflows/ci.yml                      # (modify) server-image job (Task 10)
docs/collaboration.md, docs/self-hosting.md   # (Task 11)
docs/connections-and-credentials.md, CHANGELOG.md, README.md  # (modify) (Task 11)
e2e/people.spec.ts, e2e/remote.spec.ts, e2e/global-setup.ts  # (Task 12)
```

---

### Task 0: Shared people domain, gate requirements and narration of people

**Files:** Create `packages/shared/src/people.ts`. Modify `packages/shared/src/gates.ts`, `narration.ts`, `share.ts` and `digest.ts` (Plan 7's), `events.ts`, `index.ts`. Tests `packages/shared/test/{people,gates,narration,share,digest,domain}.test.ts`.

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
  | { kind: "passkey"; credentialId: string; publicKey: string; transports: string[]; label: string }   // credentialId base64url; publicKey = base64url(COSE key bytes, as @simplewebauthn/server returns credentialPublicKey)
  | { kind: "key"; credentialId: string; publicKey: string; label: string };                              // credentialId = base64url(sha256(publicKey)); publicKey = base64url SPKI DER
export type Principal = { personId: string; name: string; role: Role; listener: Listener; method: SignInMethod; sessionId: string | null };   // lives here, not in auth.ts, so presence.ts (Task 8) needs no core import; auth.ts re-exports it
export type Person = { id: string; name: string; role: Role; joinedAt: string | null; lastSeenAt: string | null; removedAt: string | null; credentials: number };
export type PersonWithCredentials = Person & { credentialList: Omit<Credential, "publicKey">[] };
export type Invite = { id: string; role: Role; createdAt: string; expiresAt: string; status: "pending" | "used" | "revoked" | "expired" };   // role "owner" only for the bootstrap invite (Task 10)
export type Me = { personId: string; name: string; role: Role; listener: Listener; method: SignInMethod; credentials: Omit<Credential, "publicKey">[]; sessions: { id: string; listener: Listener; createdAt: string; lastSeenAt: string; current: boolean }[] };
export type TlsMode = "self_signed" | "acme" | "provided";
export type RemoteState = { enabled: boolean; port: number; bind: string; domain: string | null; tls: TlsMode; fingerprint: string | null; expiresAt: string | null };
export const DEFAULT_REMOTE: RemoteState = { enabled: false, port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: null, expiresAt: null };
export const personNameSchema;   // z.string().trim().min(1).max(60)
export const domainSchema;       // /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i ; never an IP literal (the final label is letters only)
export const CERT_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;   // not FINGERPRINT: Plan 6's shared/link.ts exports FINGERPRINT (/^[0-9a-f]{64}$/, a SPKI hash) and shared/index.ts is `export *` for both, so a second FINGERPRINT is TS2308
export const peoplePayloadSchemas = {
  "person.invited":            { inviteId, role: z.enum(ROLES), codeHash: z.string().length(64) /* sha256 hex */, expiresAt: z.string().datetime() },
  "person.invite_revoked":     { inviteId },
  "person.joined":             { personId, inviteId, name: personNameSchema, role: z.enum(ROLES), credential: credentialSchema },
  "person.credential_added":   { personId, credential: credentialSchema },
  "person.credential_removed": { personId, credentialId },
  "person.renamed":            { personId, name: personNameSchema },
  "person.role_changed":       { personId, from: z.enum(ROLES), to: z.enum(ROLES) },      // .superRefine: neither side "owner", from !== to
  "person.removed":            { personId },                                             // .superRefine: personId !== OWNER_ID
  "person.signed_in":          { personId, listener: z.enum(["local", "remote"]), method: z.enum(["token", "passkey", "key"]) },
  "person.locked":             { personId, until: z.string().datetime(), failures: z.number().int().min(1) },
  "remote.enabled":            { port: z.number().int().min(1).max(65535), bind: z.string().max(45), domain: domainSchema.nullable(), tls: z.enum(["self_signed", "acme", "provided"]), fingerprint: z.string().regex(CERT_FINGERPRINT) },
  "remote.disabled":           {},
  "remote.certificate_changed":{ tls, fingerprint, domain: domainSchema.nullable(), expiresAt: z.string().datetime() },
}; // all .strict(); credentialSchema is a discriminated union on kind with base64url strings ≤ 2000 chars and label ≤ 60
export type PeopleEventType = keyof typeof peoplePayloadSchemas;
// shared/gates.ts additions
export type GateRequirement = { role: Role } | { personId: string };
export const DEFAULT_GATE_REQUIREMENT: Record<GateId, GateRequirement>;   // Decisions: reviewer for plan_approved, ready_to_ship; owner for the rest
export function satisfies(req: GateRequirement, signer: { personId: string; role: Role }): boolean;  // role: atLeast; personId: equality only
export function requirementLabel(req: GateRequirement, name: (personId: string) => string): string;   // "a reviewer or above" | "the Owner" | "<name> only"
export type GateEvaluation = … & { requirement: GateRequirement; signable: boolean };               // both required: GateService.evaluate (Task 5) is the one builder; signable = satisfies(requirement, signer ?? the Owner)
export const gatePayloadSchemas["gate.requirement_set"] = { gateId: z.enum(GATE_IDS), requirement: requirementSchema.nullable() }.strict();   // null restores the default
// gate.signed_off / gate.waived: signedBy / waivedBy stay strings and now hold the person id
// shared/narration.ts
export type NarrationContext = { cardTitle?; adapterName?; machineName? /* Plan 6 */; personName?: (personId: string) => string | undefined };
// The one change to Plan 3's templates is actorName(a): for a human actor, ctx.personName?.(a.id) ?? (a.id === OWNER_ID ? "Owner" : "Someone"). Plan 3's templates already use `${who}`.
// Plan 6 and Plan 7 added templates with a *literal* "Owner"; each becomes `${who}`: machine.named `<Who> named this computer "<name>"` · machine.linking_enabled `<Who> allowed other computers …` · machine.linking_disabled `<Who> stopped linking` · machine.paired `<Who> linked "<name>" …` · machine.unpaired `<Who> unlinked "<name>"` · link.run_requested `<Who> asked <machine> to run …` · link.decision_received `<Who>'s decision arrived from <machine>: …` · share.confirmed `<Who> confirmed a share page …` · share.link_created `<Who> created a share link …` · share.revoked (reason owner) `<Who> revoked a share link`.
// shared/digest.ts (Plan 7): the agent.started item reads `<Who> started a <Adapter> agent[ on "<card>"]`; the summary's `decision(s) by the Owner` reads `decision(s) by a human`.
// shared/share.ts (Plan 7): ShareSnapshot.owner: string (the Owner's display name), DecisionItem.by: string (the signer's display name), WaitingItem.assignee: string (a requirementLabel, e.g. "a reviewer or above"); the literal "Owner" types go. The snapshot builder fills them in Task 5.
```
`ROLE_DESCRIPTIONS` (exact): viewer `Can see the board, every card's story, the ledger, the agent feed and who is here. Cannot change anything.` · reviewer `Everything a viewer can, plus deciding what agents may do, making plan decisions, moving cards and signing off gates that allow their role.` · maintainer `Everything a reviewer can, plus starting and stopping agents (on API keys), adding cards, running the intake and giving runs access to connections by name.` · owner `Everything. Only the Owner manages connections, people, remote access and gate requirements, and only the Owner holds credentials.`
Narration headlines for the new events (exact; `<Who>` is the acting human): `person.invited` `<Who> invited a <role label, lower-cased>` · `person.invite_revoked` `<Who> revoked an invitation` · `person.joined` `<name> joined as <role label, lower-cased>` · `person.credential_added` `<Who> added a <passkey|key> ("<label>")` · `person.credential_removed` `<Who> removed a credential` · `person.renamed` `<Who> is now called "<name>"` · `person.role_changed` `<Who> made <person name of payload.personId> a <to label, lower-cased>` · `person.removed` `<Who> removed <person name>` · `person.signed_in` `<person name> signed in <locally|remotely>` (topic `people`, `attention` false) · `person.locked` `<person name> was locked out after <failures> failed sign-ins` (attention true) · `remote.enabled` `<Who> turned remote access on (<domain ?? "this machine's addresses">, port <port>)` (attention true) · `remote.disabled` `<Who> turned remote access off` · `remote.certificate_changed` `The remote certificate changed (<tls label>, fingerprint <first 8 chars>…)` · `gate.requirement_set` `<Who> set who may sign "<gate title>": <requirementLabel>` or `… back to the default`. `NarrationTopic` gains `"people"` and `"remote"`.

- [ ] **Step 1: Write failing tests:** `atLeast("reviewer", "viewer")` true, `("viewer", "reviewer")` false, `("owner", "owner")` true; every payload schema accepts a fixture and rejects an extra key; `person.role_changed` with `to: "owner"` rejected; `person.removed` with `personId: "owner"` rejected; `domainSchema` accepts `tt-test.local` and `example.org`, rejects `192.168.1.10`, `localhost`, `a..b`; `CERT_FINGERPRINT` accepts a 32-pair string and rejects Plan 6's 64-hex form; `import * as shared from "@theterminal/shared"` compiles (no duplicate export with `link.ts`); `satisfies({ role: "reviewer" }, { personId: "x", role: "maintainer" })` true, `({ personId: "a" }, { personId: "owner", role: "owner" })` false, `({ personId: "a" }, { personId: "a", role: "viewer" })` true; `DEFAULT_GATE_REQUIREMENT.go_live` is `{ role: "owner" }`; `narrate` of a `card.moved` by actor id `p1` with `personName: () => "Reviewer One"` reads `Reviewer One moved …`, with no ctx reads `Someone moved …`, and actor `owner` still reads `Owner moved …` (Plan 3's tests pass unchanged); each of the ten Plan 6/7 templates above by actor `p1` with `personName` reads `Reviewer One …` and by actor `owner` reads exactly as Plan 6/7's tests expect (those tests pass unchanged); a source scan asserts the string `"Owner` appears in `narration.ts` and `digest.ts` only inside `actorName`; `digestDay` of a fixture with `agent.started` by `p1` lists `Reviewer One started a Fake agent on "Login"`; each new headline above; `eventPayloadSchemas` has a schema for every `EventType`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): roles, people and remote-access events, gate requirements, narration and share types that name the person`

---

### Task 1: People projections, sessions, challenges and the PeopleService

**Files:** Create `packages/core/src/people/{service,sessions,challenges,lockouts}.ts`. Modify `packages/core/src/db.ts`, `events/projections.ts`, `story/story.ts` (`narrationContext`), `index.ts`. Tests `packages/core/test/people/{service,sessions,challenges,lockouts}.test.ts`, `packages/core/test/events/projections.test.ts`, `packages/core/test/story/story.test.ts`.

**Interfaces:**
```ts
// db.ts: appended to MIGRATIONS after whichever of Plan 6's and Plan 7's entries is last on main (user_version is the array index; the order is fixed by merge order)
`CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT, last_seen_at TEXT, removed_at TEXT);
 CREATE TABLE credentials (credential_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, kind TEXT NOT NULL, public_key TEXT NOT NULL, transports TEXT NOT NULL, label TEXT NOT NULL, added_at TEXT NOT NULL, removed_at TEXT);
 CREATE INDEX credentials_person ON credentials (person_id);
 CREATE TABLE invites (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, used_by TEXT);
 CREATE TABLE remote_state (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, port INTEGER NOT NULL, bind TEXT NOT NULL, domain TEXT, tls TEXT NOT NULL, fingerprint TEXT, expires_at TEXT);
 CREATE TABLE gate_requirements (project_id TEXT NOT NULL, gate_id TEXT NOT NULL, requirement TEXT NOT NULL, PRIMARY KEY (project_id, gate_id));
 CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, listener TEXT NOT NULL, method TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
 CREATE INDEX sessions_person ON sessions (person_id);
 CREATE TABLE credential_state (credential_id TEXT PRIMARY KEY, counter INTEGER NOT NULL);`   // the WebAuthn signature counter only; lockout counters are in memory (below), so no address ever reaches the database
// credentials.transports holds "[]" for a key credential
// PROJECTION_TABLES gains people, credentials, invites, remote_state, gate_requirements (not sessions, not credential_state)
// projections.ts
export function getPerson(db: Db, id: string): Person | null;        // OWNER_ID is virtual: { id: "owner", name: <person.renamed or "Owner">, role: "owner", joinedAt: null, … } even with no row; when an owner row exists (after credential_added or renamed) it is read, not duplicated
export function listPeople(db: Db, opts?: { includeRemoved?: boolean }): Person[];   // Owner first (virtual or row, once), then by joinedAt
export function listCredentials(db: Db, personId: string): Credential[];           // not removed
export function findCredential(db: Db, credentialId: string): (Credential & { personId: string }) | null;   // null when the credential or its person is removed
// story/story.ts: narrationContext(db) gains personName: (id) => getPerson(db, id)?.name, so GET /api/cards/:id/story, the ledger export, Plan 7's digests and the share page all name people
export function getInviteByHash(db: Db, codeHash: string): Invite | null;
export function getRemoteState(db: Db): RemoteState;                                // DEFAULT_REMOTE when no row
export function getGateRequirement(db: Db, projectId: string, gateId: GateId): GateRequirement;  // row or default
// people/sessions.ts
export type Session = { id: string; personId: string; listener: Listener; method: SignInMethod; createdAt: string; lastSeenAt: string; expiresAt: string };
export class SessionStore {
  constructor(db: Db, opts?: { now?: () => Date; ttlMs?: number /* SESSION_TTL_MS */ });
  create(personId: string, listener: Listener, method: SignInMethod): { id: string /* 43-char base64url of 32 random bytes */; session: Session };
  lookup(id: string, listener: Listener): Session | null;   // sha256(id) → row; null when revoked, expired, wrong listener or unknown; touches last_seen_at at most once a minute through one prepared statement (it runs on every request)
  revoke(id: string): void; revokeByHashPrefix(personId: string, prefix: string): boolean; revokeAll(personId: string): number; list(personId: string): (Session & { idHashPrefix: string /* 8 chars */ })[];
  onRevoke(fn: (personId: string, sessionIdHash: string | null) => void): () => void;   // null = every session of the person
}
// people/challenges.ts
export class ChallengeStore {
  constructor(opts?: { now?: () => Date; ttlMs?: number /* 300000 */; max?: number /* 10000 */; perClient?: number /* 20 */ });
  issue(scope: string, client: string): string;       // 32 random bytes base64url, remembered with its scope ("join:<inviteId>" | "login" | "me:<personId>") and client (request.ip, in memory only); the 21st open challenge of one client evicts that client's oldest, never another client's; the global max evicts the oldest overall
  consume(challenge: string, scope: string): boolean; // true once, then gone; false when unknown, expired or scoped differently
}
// people/lockouts.ts
export class LockoutStore {
  constructor(opts?: { now?: () => Date; failures?: number /* LOCKOUT_FAILURES */; lockMs?: number /* LOCKOUT_MS */; max?: number /* 10000 keys */ });
  failure(credentialId: string, source: string): { locked: boolean; until: string | null; failures: number };   // key = sha256(`${credentialId}\n${source}`); at `failures` → locked for lockMs, counter reset; the caller commits person.locked
  assertNotLocked(credentialId: string, source: string): void;   // LockedError(retryAfterS)
  success(credentialId: string, source: string): void;           // clears the pair
  clear(credentialId: string): void;                             // every pair of that credential (on credential removal)
}
// people/service.ts
export class InviteInvalidError extends Error {}          // "invite is invalid"      → 404 invite_invalid
export class OwnerCredentialRequiredError extends Error {} // → 409 owner_credential_required
export class LastCredentialError extends Error {}         // "the last credential cannot be removed" → 409 last_credential
export class SelfChangeError extends Error {}             // "a person cannot change their own role or remove themselves" → 409 self_change
export class OwnerRoleError extends Error {}              // "the owner role cannot be given or taken" → 409 owner_role
export class LockedError extends Error { constructor(public readonly retryAfterS: number) }   // → 423 locked
export class PeopleService {
  constructor(deps: { db: Db; ledger: Ledger; sessions: SessionStore; lockouts: LockoutStore; newId?: () => string; now?: () => Date });
  invite(actor: Actor, role: Role, opts?: { ttlMs?: number }): { invite: Invite; code: string };     // role "owner" only when no owner credential exists (bootstrap, ttl 1 hour); code = 16 random bytes base64url; commits person.invited with sha256 hex
  revokeInvite(actor: Actor, inviteId: string): void;
  inviteByCode(code: string): Invite;                                        // InviteInvalidError unless pending and unexpired
  join(code: string, name: string, credential: Credential): Person;         // one transaction: person.joined (actor = the new person); invite used; OWNER bootstrap → personId OWNER_ID with person.credential_added + person.renamed instead of person.joined, and every other pending "owner" invite revoked in the same transaction. Returns the Person; the route then mints the session and calls recordSignIn in the same request (a read-only ledger fails at join, before anything is minted)
  addCredential(actor: Actor, personId: string, credential: Credential): void;
  removeCredential(actor: Actor, personId: string, credentialId: string): void;   // LastCredentialError when it is the person's last and personId !== OWNER_ID
  rename(actor: Actor, personId: string, name: string): void;               // redact-checked (SecretInTextError)
  changeRole(actor: Actor, personId: string, to: Role): void;               // SelfChangeError, OwnerRoleError
  remove(actor: Actor, personId: string): void;                              // SelfChangeError; OwnerRoleError for OWNER_ID; revokes every session
  recordSignIn(personId: string, listener: Listener, method: SignInMethod): void;   // person.signed_in, actor = that person
  failure(credentialId: string, source: string): void;                      // lockouts.failure; when it locks → person.locked { personId, until, failures } (actor system "auth"; no address)
  assertNotLocked(credentialId: string, source: string): void;               // LockedError
  success(credentialId: string, source: string): void;
  hasOwnerCredential(): boolean;
}
export const LOCKOUT_FAILURES = 5; export const LOCKOUT_MS = 15 * 60_000;
```
Reducers: `person.invited` → INSERT invites `pending`; `person.invite_revoked` → `revoked`; `person.joined` → INSERT people (joined_at = ts) + INSERT credentials + invites `used`, `used_by`; `person.credential_added` → INSERT credentials (for `owner`, INSERT OR IGNORE a people row `{ id: "owner", name: "Owner", role: "owner" }` first); `person.credential_removed` → `removed_at`; `person.renamed` → name (INSERT OR IGNORE the owner row first); `person.role_changed` → role; `person.removed` → `removed_at`; `person.signed_in` → `last_seen_at`; `remote.enabled` → UPSERT row 1 `enabled 1` with the payload; `remote.disabled` → `enabled 0`; `remote.certificate_changed` → `tls`, `fingerprint`, `domain`, `expires_at`; `gate.requirement_set` → UPSERT or DELETE when null. `listPeople` computes `status` `expired` for invites by comparing `expires_at` to now at read time (no event).

- [ ] **Step 1: Write failing tests:**
  - sessions: `create` returns a 43-character id and the table holds its sha256, never the id; `lookup(id, "local")` works and `lookup(id, "remote")` is null **(Review Focus 2)**; after `revoke` null; after `ttlMs` null; `revokeAll` returns the count and fires `onRevoke(personId, null)`;
  - challenges: `consume` true once then false; a different scope false; after `ttlMs` false; 1001 issues from client `198.51.100.7` do not evict a challenge client `198.51.100.8` holds **(Review Focus 4)**; the 21st open challenge of one client evicts that client's oldest; the 10001st overall evicts the oldest overall;
  - lockouts: five `failure(c, "198.51.100.7")` → `{ locked: true }` once; `assertNotLocked(c, "198.51.100.7")` throws with `retryAfterS ≤ 900` and `assertNotLocked(c, "198.51.100.8")` does not **(Review Focus 4)**; `success` after the lock expires clears it; `clear(c)` clears both pairs; the 10001st key evicts the oldest;
  - story: `narrationContext(db)` after a `person.joined` for `p1` named `Reviewer One` → `personName("p1") === "Reviewer One"`, `personName("owner") === "Owner"`, `personName("nobody")` undefined;
  - service: `invite(owner, "reviewer")` → one `person.invited` whose payload holds a 64-hex `codeHash` and not the code; `inviteByCode(code)` returns it; `inviteByCode("nope")`, a revoked one, and one past `expiresAt` → `InviteInvalidError`; `join(code, "Reviewer One", passkeyCred)` → `person.joined` with actor `{ kind: "human", id: <new id> }`, `listPeople()` is `[owner, Reviewer One]`, the invite is `used`, and `join` again with the same code → `InviteInvalidError`; `invite(owner, "owner")` → `OwnerRoleError` once an owner credential exists, else allowed with `expiresAt` one hour out, and `join` of it records `person.credential_added` + `person.renamed` for `owner` with no `person.joined` and revokes a second pending owner invite in the same transaction; `listPeople()` after the Owner's `credential_added` lists the Owner once; `changeRole(owner, p1, "maintainer")` → `person.role_changed { from: "reviewer", to: "maintainer" }`; `changeRole(owner, "owner", …)` and `changeRole(p1 as actor, p1, …)` → errors; `remove(owner, p1)` revokes p1's two sessions and `getPerson(p1).removedAt` is set **(Review Focus 3)**; `removeCredential` of the last one → `LastCredentialError`, of the Owner's last → allowed (the token remains); five `failure(c, "198.51.100.7")` → exactly one `person.locked` whose payload has no address key **(Review Focus 4)**; `findCredential` of a removed person's credential → null; `rename` with `sk-ant-TESTKEY-0000000000` → `SecretInTextError`;
  - projections: rebuild after the whole sequence equals the live five tables row for row; `getPerson("owner")` without any row is the virtual Owner; `getRemoteState` is `DEFAULT_REMOTE` before any event and reflects `remote.enabled` after.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test people events story`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): people, invites, credentials and remote state as ledger projections; sessions, challenges and lockouts; narration context names people`

---

### Task 2: Principals, listeners, role table and the throttle

**Files:** Rewrite `packages/core/src/server/auth.ts`; create `packages/core/src/server/throttle.ts`. Modify `server.ts`. Tests `packages/core/test/server/{auth,throttle}.test.ts`. (`throttle.ts` is a leaf module and lands first, in Wave 1; the rest is Wave 3.)

**Interfaces:**
```ts
// auth.ts
export const TOKEN_COOKIE = "tt_token"; export const SESSION_COOKIE = "tt_session"; export const APP_HOST = "theterminal.localhost";
export const PUBLIC_ROUTE = { public: true };                           // kept: static-ui.ts and core index.ts import it today; the hook treats a route with config.public exactly like one in PUBLIC_ROUTES, so the core build never breaks between this task and Task 9
export type { Principal } from "@theterminal/shared";                   // defined in shared/people.ts (Task 0)
declare module "fastify" { interface FastifyRequest { principal: Principal | null; listener: Listener } }
export type AuthDeps = { token: string; port: () => number; remote: () => RemoteState; sessions: SessionStore; person: (id: string) => Person | null; now?: () => Date;
  listenerOf?: (request: FastifyRequest) => Listener };               // tests only: default is the TLS check below
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void;
export function listenerOf(request: FastifyRequest): Listener;        // (request.raw.socket as TLSSocket).encrypted === true → "remote"
export function remoteHostAllowed(host: string, remote: RemoteState): boolean;   // Decisions: domain:port exactly, else (IPv4 literal | bracketed IPv6 literal | *.local) with remote.port; "GET /healthz" is checked before this and exempt
export const ROUTE_ROLES: Record<string, Role>;                         // "<METHOD> <url>" → minimum role; the whole table is below and lands in this task, so every existing route test passes with the bearer as the Owner; there is no default for an unlisted route
export const PUBLIC_ROUTES: ReadonlySet<string>;                        // exact route keys: "GET /", "GET /*", "GET /join/*", "GET /sign-in", "GET /healthz", "GET /api/join/:code", "POST /api/join/:code/passkey/options", "POST /api/join/:code/passkey/verify", "POST /api/join/:code/key/challenge", "POST /api/join/:code/key", "POST /api/auth/passkey/options", "POST /api/auth/passkey/verify", "POST /api/auth/key/challenge", "POST /api/auth/key/verify" (the ACME challenge is served by the plain :80 server, not Fastify)
export function routeKey(method: string, url: string): string;         // `${method.toUpperCase()} ${url}`; HEAD → the GET key (Fastify adds a HEAD twin to every GET, exposeHeadRoutes default)
export function requireRole(min: Role): preHandlerHookHandler;          // 403 { error: "forbidden", required: min }
export function actorOf(request: FastifyRequest): Actor;                // { kind: "human", id: request.principal!.personId }
export function assertRoutesHaveRoles(app: FastifyInstance): string[];  // every registered route (routeOptions.method may be an array: one key per method; HEAD skipped) is in ROUTE_ROLES, in PUBLIC_ROUTES or has config.public; returns the missing ones
// throttle.ts
export class Throttle {
  constructor(opts: { limit: number; windowMs: number; now?: () => Date; max?: number /* 10000 keys */ });
  hit(key: string): { allowed: true } | { allowed: false; retryAfterS: number };
}
export const AUTH_THROTTLE = { limit: 10, windowMs: 60_000 };
```
`ROUTE_ROLES` (exact; every route on `main` after Plans 6 and 7, plus this plan's; `HEAD` twins take the `GET` entry; a `GET` that is not here is **not** a viewer route, it is a missing route):

| Role | Routes |
|---|---|
| viewer | `GET /api/health` (stays behind auth; `/healthz` is the only unauthenticated probe) · `GET /api/projects` · `GET /api/projects/:id/board` · `GET /api/cards/:id/gates` · `GET /api/ledger` · `GET /api/agents` (non-owners: no `apiKey` sources, no `acks`) · `GET /api/projects/:id/runs` · `GET /api/projects/:id/pending-actions` · `GET /api/pending-actions` · `GET /api/runs/:id` · `GET /api/connections` (non-owners: `ConnectionSummary[]`) · `GET /api/status` (non-owners: `connections: { enabled, failed }` without `keychain`, `remote: { enabled, listening }` without `label`) · `GET /api/capacity` (non-owners: `connections` reduced to `{ id, kind, provider, name }`, no key-source detail, on the report and on every `machines[]` entry) · `GET /api/projects/:id/intake` · `GET /api/cards/:id/story` · `GET /api/github/overview` · `GET /api/events` (WebSocket) · `GET /api/me` · `PATCH /api/me` · `POST /api/me/sign-out` · `POST /api/me/credentials/*` · `DELETE /api/me/credentials/:id` · `DELETE /api/me/sessions/:prefix` · `GET /api/people` · `GET /api/presence` · `GET /api/remote` (non-owners: `{ enabled, listening }`) · Plan 7: `GET /api/projects/:id/share/snapshots` · `GET /api/share/snapshots/:id` · `GET /api/share/snapshots/:id/download` · `GET /api/projects/:id/digests` · `GET /api/share/links` |
| reviewer | `POST /api/cards/:id/move` · `POST /api/actions/:id/decision` · `POST /api/projects/:id/intake/decisions` · `POST /api/projects/:id/intake/complete` · `GET /api/ledger/export` (carries display names) · `GET /api/runs/:id/changes` · `GET /api/runs/:id/diff` · `GET /api/runs/:id/files` · `GET /api/runs/:id/file` (worktree contents: what Plan 7 keeps off the share page, so not for investors) · Plan 6: `GET /api/link/verify` (audit) |
| maintainer | `POST /api/projects` · `POST /api/projects/:id/cards` · `POST /api/cards/:id/status` · `POST /api/projects/:id/runs` (incl. Plan 6's `machineId`) · `POST /api/runs/:id/stop` · `POST /api/projects/:id/intake` · `POST /api/projects/:id/intake/answers` · `POST /api/projects/:id/intake/reopen` |
| owner | `POST /api/settings/provider-auth` · `POST /api/settings/claude-auth` · `GET /api/connections/catalog` · `POST /api/connections` · `GET /api/connections/:id` · `PATCH /api/connections/:id` · `DELETE /api/connections/:id` · `POST /api/connections/:id/test` · `GET /api/connections/signin-status` · `POST /api/connections/signin/:provider` · `GET /api/connections/signin/:id` · `DELETE /api/connections/signin/:id` · `POST /api/capacity/detect` · `POST /api/runs/:id/override/command` · `POST /api/runs/:id/override/discard` · `GET /api/people/invites` · `POST /api/people/invites` · `DELETE /api/people/invites/:id` · `PATCH /api/people/:id` · `DELETE /api/people/:id` · `POST /api/people/:id/sign-out` · `PUT /api/remote` · `PUT /api/projects/:id/gates/:gateId/requirement` · Plan 6: `GET /api/link` (lists LAN addresses and discovered machines) · `POST /api/link/name` · `POST /api/link/enable` · `POST /api/link/disable` · `POST /api/link/code` · `DELETE /api/link/code` · `POST /api/link/pair` · `DELETE /api/link/machines/:id` · `GET /api/link/machines/:id/capacity` (the other machine's connections) · Plan 7: `POST /api/projects/:id/share/preview` · `POST /api/projects/:id/share/confirm` · `GET /api/share/addresses` (LAN addresses) · `POST /api/share/snapshots/:id/links` · `DELETE /api/share/links/:id` |
| public | the `PUBLIC_ROUTES` set above |

Why these (spec §4.4, §4.5, §8): only the Owner decides what leaves the machine (share preview, confirm, links) and holds credentials (connections, link pairing, the other machine's connections); LAN addresses are the Owner's business (`GET /api/link`, `GET /api/share/addresses`, `status.remote.label`); a Viewer is "read-only; investors, advisors, clients", so file contents from agent worktrees and the ledger export with names need a reviewer.

Hook order on every request: (1) `request.listener = listenerOf(request)`; (2) Host: `GET /healthz` is exempt; local → the 5A rule; remote → `remoteHostAllowed`, else 403 `bad_host`; (3) on remote, `GET /?token=` and a bearer token are refused 401 before anything else, including before the `/?token=` redirect code (the token is never compared off the local listener) **(Review Focus 2)**; (4) public routes (in `PUBLIC_ROUTES` or `config.public`) pass with `principal = null`; (5) Origin, for every non-public request including the `/api/events` upgrade: local → the 5A rule; remote → `https://<host header>` only (a `wss://` upgrade with an `http://` Origin is 403 and the socket is destroyed); (6) principal: a bearer or `tt_token` cookie matching the token on local → `{ personId: OWNER_ID, role: "owner", method: "token", sessionId: null }`; else `tt_session` → `sessions.lookup(id, request.listener)` → `person(session.personId)`; a removed person or no session → 401 `unauthorized`; (7) `requireRole(ROUTE_ROLES[routeKey(method, routeOptions.url)])`; a route with no entry → 500 `internal` (fail closed; `assertRoutesHaveRoles` at startup and the test in Task 4 keep the table complete). `trustProxy` is never set, so `request.ip` is the socket's peer. The bootstrap `/?token=` on local still sets `tt_token` as today. Session cookie attributes: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` on remote. `request.principal.name` comes from `person()`, so a rename shows on the next request.

`server.ts`: constructs `SessionStore`, `ChallengeStore`, `LockoutStore`, `PeopleService` and `Throttle` and passes them on; after `app.ready()`, `assertRoutesHaveRoles(app)` must return `[]` or the server refuses to start with `Refusing to start: routes without a role: …`.

- [ ] **Step 1: Write failing tests:**
  - throttle: 10 hits allowed, the 11th `{ allowed: false, retryAfterS: 60 }`, allowed again after `windowMs`; two keys are independent; the 10001st key evicts the oldest;
  - auth (Fastify `inject`; the listener is chosen per test through `AuthDeps.listenerOf`, and Task 6 repeats the remote cases over a real `tls.Server`): local bearer → `principal.personId === "owner"`, `method: "token"`; a session created on local → principal with the person's current name and role; the same session with `listener: "remote"` → 401; on remote a bearer → 401 and `GET /?token=` → 401 with no `location` header **(Review Focus 2)**; remote Host `tt-test.local:4318`, `192.168.1.10:4318` and `[::1]:4318` accepted, `evil.example.org:4318`, `tt-test.local:4317` and `[::1]:4317` → 403; with `domain: "work.example.org"` only `work.example.org:4318` accepted, and `GET /healthz` with Host `127.0.0.1:4318` still 200; remote Origin `https://tt-test.local:4318` accepted, `http://…` → 403; `requireRole("maintainer")` → 403 `{ error: "forbidden", required: "maintainer" }` for a reviewer and pass for a maintainer; a removed person's session → 401 **(Review Focus 3)**; `assertRoutesHaveRoles` lists a test route registered without an entry, does not list the `HEAD` twin of a listed `GET`, lists each method of a multi-method route separately, and accepts a route with `config: PUBLIC_ROUTE`; `HEAD` of a listed `GET` answers with the `GET`'s role (403 for a rank below); a request with `X-Forwarded-For: 203.0.113.9` keeps `request.ip` equal to the socket peer (no `trustProxy`); the cookie set on remote has `Secure`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/auth server/throttle`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS (existing route tests, Plan 6's and Plan 7's included, pass with the bearer as the Owner; the full table is what makes the startup check pass before Task 4).
- [ ] **Step 5: Commit:** `feat(server): principals with roles on two listeners; every route in one role table; sessions never cross listeners; auth throttle`

---

### Task 3: Passkeys, Ed25519 keys and the people, join and auth routes

**Files:** Create `packages/core/src/people/{webauthn,ed25519}.ts`, `packages/core/src/server/people-routes.ts`, `packages/core/test/fixtures/webauthn.ts`. Modify `server.ts` (one `register` line). `routes.ts` is **not** touched: `people-routes.ts` is an encapsulated Fastify plugin with its own `setErrorHandler` for the seven errors below (Fastify scopes error handlers), so `routes.ts`'s error map stays Task 4's. `@simplewebauthn/server` 14.0.3 is already in `package.json` from the `chore(deps)` commit. Tests `packages/core/test/people/{webauthn,ed25519}.test.ts`, `packages/core/test/server/people-routes.test.ts`. (The two `people/*` modules and the fixture are Wave 2; the routes are Wave 4.)

**Interfaces:**
```ts
// people/webauthn.ts  (wraps @simplewebauthn/server; rpName "The Terminal")
export type Rp = { rpId: string; origin: string };                       // from the request: rpId = hostname of Host; origin = `${listener === "remote" ? "https" : "http"}://${host}`
export function rpFor(request: FastifyRequest): Rp | null;              // null when the hostname is an IP literal (passkeys unavailable)
export async function registrationOptions(rp: Rp, user: { id: string; name: string }, exclude: Credential[], challenge: string): Promise<PublicKeyCredentialCreationOptionsJSON>;
// residentKey "required", userVerification "required" (Decisions), attestationType "none", algorithms ES256 and Ed25519 (-7, -8)
export async function verifyRegistration(rp: Rp, challenge: string, response: unknown): Promise<Credential>;   // kind "passkey"; requireUserVerification true; publicKey = base64url(credentialPublicKey bytes); throws InvalidCredentialError on any failure
export async function authenticationOptions(rp: Rp, challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON>;  // allowCredentials empty (discoverable); userVerification "required"
export async function verifyAuthentication(rp: Rp, challenge: string, response: unknown, cred: Credential & { counter: number }): Promise<{ newCounter: number }>;   // requireUserVerification true: an assertion without the uv flag is InvalidCredentialError
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
| `DELETE /api/me/sessions/:prefix` | viewer | 204; revokes one of the caller's own sessions by its 8-character hash prefix (`sessions.revokeByHashPrefix`); 404 when none matches |
| `GET /api/people` | viewer | `Person[]` (not removed) |
| `GET /api/people/invites` | owner | `Invite[]` (pending) |
| `POST /api/people/invites` | owner | `{ role }` → 201 `{ invite, url, fingerprint }`; `url` = `https://<domain ?? first address>:<remotePort>/join/<code>#fp=<fingerprint>` when remote is on, else `http://theterminal.localhost:<port>/join/<code>`; `fingerprint` and the `#fp=` value are the same `RemoteListener.state().fingerprint` (one source); shown once |
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

Rules: a join or login where `rpFor()` is null answers the passkey routes 409 `passkeys_unavailable`; the order on every verify route is `assertNotLocked(credentialId, request.ip)` → `challenges.consume(challenge, scope)` (the challenge is burned **before** verification, so a failed verification cannot retry it; `@simplewebauthn/server` checks the same challenge again inside `verifyRegistrationResponse`/`verifyAuthenticationResponse`, which is fine) → verify → `success` or `failure`; every verification failure (bad or missing challenge, bad signature, unknown or removed credential, removed person, wrong rpId, missing `uv`, counter not increasing when the stored counter is > 0) is 401 `invalid_credential` after `people.failure(credentialId, request.ip)` where the credential is known **(Review Focus 4)**; the ledger read-only → 423 `ledger_read_only` on join and sign-in; a session is created on the listener the request came in on; `Me.sessions[].id` is the sha256 prefix (8 chars), never the id. Error map (this plugin's own `setErrorHandler`): `InviteInvalidError` → 404 `invite_invalid`; `InvalidCredentialError` → 401 `invalid_credential`; `LockedError` → 423 `{ error: "locked", retryAfterS }`; `LastCredentialError` → 409 `last_credential`; `SelfChangeError` → 409 `self_change`; `OwnerRoleError` → 409 `owner_role`; `OwnerCredentialRequiredError` → 409 `owner_credential_required`; throttle → 429 `{ error: "rate_limited", retryAfterS }`.

- [ ] **Step 1: Write failing tests:**
  - webauthn: `rpFor` for Host `tt-test.local:4318` over remote → `{ rpId: "tt-test.local", origin: "https://tt-test.local:4318" }`, for `192.168.1.10:4318` → null, for local `theterminal.localhost:4317` → http origin; a soft authenticator registration verifies to a `passkey` credential whose `publicKey` is the base64url of the COSE bytes; `registrationOptions` and `authenticationOptions` carry `userVerification: "required"`; an assertion verifies and returns the next counter; the same assertion replayed (counter not increased) → `InvalidCredentialError`; an assertion with the `uv` flag clear (the soft authenticator takes `{ uv: false }`) → `InvalidCredentialError` **(Review Focus 4)**; a response for another rpId → `InvalidCredentialError` whose message is exactly `invalid credential`;
  - ed25519: a key pair from `generateKeyPairSync("ed25519")` signs the message and verifies; a wrong host, wrong challenge or an RSA key → false; `keyCredentialId` is 43 chars;
  - routes (memory store, fake time): the Owner invites a reviewer → 201 whose `url` contains `/join/` and whose ledger entry holds the hash only; `GET /api/join/<code>` → role and `passkeys: true`; join with the soft authenticator → 201 `Me { role: "reviewer", method: "passkey" }` and a `Set-Cookie` with `tt_session` and `HttpOnly`; a second join with the same code → 404 `invite_invalid`; `GET /api/me` with the cookie → the person; sign out → 204 and the cookie no longer works; `POST /api/auth/passkey/options` + `verify` → signed in with `person.signed_in { listener: "local", method: "passkey" }`; key join: `challenge` → sign → 201; **(Review Focus 4)** 11 `GET /api/join/x` in a minute → the 11th 429 with `retryAfterS`; five wrong assertions for one credential from `remoteAddress` `198.51.100.7` → 401 ×5 then a valid one from the same address → 423 `locked` and exactly one `person.locked`, while a valid one from `198.51.100.8` signs in; five wrong key signatures for a public key read out of the ledger export, from one address, lock only that pair; a reused challenge → 401, and a challenge whose verification failed cannot be presented again (401 twice); a passkey assertion for a removed person's credential → 401 and no `person.signed_in`; `PATCH /api/people/:id { role: "owner" }` → 409 `owner_role`; `DELETE /api/people/<self>` → 409 `self_change`; a reviewer calling `POST /api/people/invites` → 403; `DELETE /api/me/credentials/:last` → 409 `last_credential`; `DELETE /api/me/sessions/<prefix of the other session>` → 204 and that session no longer works, an unknown prefix → 404; the invite's `fingerprint` equals its `#fp=` and `GET /api/remote` `fingerprint`; a `GateRequirementError` thrown by a test route outside the plugin is not mapped by the plugin's handler (encapsulation); no response body in the suite contains an invite code after creation, a session id or an address.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test people server/people-routes`. Expected: FAIL.
- [ ] **Step 3:** Implement (the dependency is already pinned by the `chore(deps)` commit).
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): invites, passkeys and Ed25519 keys; people management; sign-in, lockouts and rate limits`

---

### Task 4: Every route names the person and checks the role; collaborators see summaries and run on API keys

**Files:** Modify `packages/core/src/server/{routes,agent-routes,connection-routes,capacity-routes,intake-routes,story-routes,override-routes,github-routes}.ts`, Plan 7's `share-routes.ts` and Plan 6's `link-routes.ts` (both hold the `owner` actor constant), `server.ts` (the `connection.signin` actor), `packages/core/src/agents/runner.ts`, `packages/shared/src/connections.ts`, `apps/ui/src/api.ts`, `apps/ui/src/views/{ConnectionsSideBar,ConnectionEditor}.tsx`, `apps/ui/src/components/AgentPanel.tsx`. Not `events-ws.ts` (Task 8 owns it; its `ROUTE_ROLES` entry is already in Task 2's table). Tests `packages/core/test/server/{routes,agent-routes,connection-routes,share-routes,link-routes,route-roles,no-secrets}.test.ts`, `apps/ui/test/{ConnectionsSideBar,AgentPanel}.test.tsx`.

**Interfaces:**
```ts
// shared/connections.ts
export type ConnectionSummary = Pick<Connection, "id" | "kind" | "provider" | "name" | "enabled" | "status">;
// runner.ts
start(actor, input: { …; forceApiKey?: boolean })   // when true: authMode is "api_key" regardless of settings; "no key" means agent-routes' apiKey(p) === "none" (neither a key connection nor the server's OPENAI_API_KEY/GEMINI_API_KEY/ANTHROPIC_API_KEY) → ApiKeyRequiredError
export class ApiKeyRequiredError extends Error {}    // "collaborators run agents on API keys; no API key is configured for <provider>" → 409 api_key_required
```
The role table is `ROUTE_ROLES` from Task 2 (it already covers every route here, Plan 6's and Plan 7's); this task wires `requireRole` and `actorOf` into every handler and trims what non-owners see.
Rules: every handler replaces its `actor` constant with `actorOf(request)`, in `share-routes.ts` and `link-routes.ts` too; `GET /api/connections` returns `Connection[]` for the Owner and `ConnectionSummary[]` otherwise; `/api/status` for non-owners carries `connections: { enabled, failed }` without `keychain`; `GET /api/capacity` for non-owners reduces `connections` (on the report and on each Plan 6 `machines[]` entry) to `{ id, kind, provider, name }`; `POST /api/projects/:id/runs` passes `forceApiKey: principal.personId !== OWNER_ID`, also when Plan 6's `machineId` routes it to `remoteRuns.start` (the worker side runs on its own credentials; see Out of scope); Plan 6's `remoteRuns.decide`/`stop` branches sit behind the same `reviewer`/`maintainer` checks as the local ones; `connectionIds` from a maintainer are honoured (names only were ever visible). `GET /api/agents` for non-owners omits `apiKey` sources and `acks`. UI: `api.listConnections()` returns `Connection[] | ConnectionSummary[]` and the Connections side bar renders summaries read-only with the line `Only the Owner can see or change connection details.`; the editor tab is never opened for a non-owner; `AgentPanel` for a non-owner shows under the adapter `Runs you start use the Owner's API key for <Provider>, never a personal subscription.` and maps `api_key_required` to `No API key is configured for <Provider>. Ask the Owner to add one in Connections.`

- [ ] **Step 1: Write failing tests:**
  - route-roles: after `createServer`, `assertRoutesHaveRoles` returns `[]` and the set of registered non-public routes equals the keys of `ROUTE_ROLES` (no stale entry either); for each `(method, url, role)` in `ROUTE_ROLES` a principal one rank below answers 403 and one at the rank does not answer 403 (a table-driven test over fake sessions for a viewer, reviewer, maintainer and the Owner, covering Plan 6's and Plan 7's routes); a viewer's `GET /api/runs/:id/file`, `…/diff`, `…/changes`, `…/files` and `GET /api/ledger/export` → 403 and a reviewer's → 200;
  - **(Review Focus 1)** a maintainer's `GET /api/connections` has no `config`, `private` or `secretFields` key in any item; `GET /api/connections/:id`, `PATCH`, `POST …/test` → 403; a maintainer's `GET /api/capacity` has no `apiKey` key anywhere in the body; the maintainer starts a fake run with `connectionIds: [azureId]` → 201, the recorded `agent.started` actor is the maintainer's id, the `connection.used` entries exist, the recorded shell output shows `[REDACTED]`, and `JSON.stringify` of every response in the test lacks the secret;
  - no-secrets (table-driven): seed `zq-TESTKEY-e2e-opaque-0000000000` into a connection secret, a file in a fake run's worktree and an action output; for a viewer, a reviewer and a maintainer, call every `GET` route in `ROUTE_ROLES` with real ids substituted and assert no 200 body contains the string, `private`, `secretFields` or `config` (the Owner's `GET /api/connections` is the one route allowed to);
  - share-routes and link-routes: a reviewer's `POST /api/projects/:id/share/preview` → 403; the Owner's `confirm` records `share.confirmed` with actor `owner` through `actorOf` (no constant remains: a source scan over `server/*.ts` finds no `id: "owner"` literal outside `auth.ts`); a viewer's `GET /api/share/addresses` and `GET /api/link` → 403, `GET /api/share/links` → 200; a reviewer's `GET /api/link/verify` → 200; a maintainer's `POST /api/projects/:id/runs { machineId }` reaches `remoteRuns.start` with `forceApiKey: true` and a reviewer's decision on a remote run reaches `remoteRuns.decide` with the reviewer's actor;
  - a maintainer starting a `codex` run while the provider mode is `chatgpt` and a key connection exists → the run's `authMode` is `api_key`; without a key → 409 `api_key_required`; the Owner in `chatgpt` mode is unchanged;
  - a reviewer's `POST /api/actions/:id/decision` → recorded with actor id of the reviewer and `by: "human"`; a viewer's → 403; the narration of that entry with `personName` reads `Reviewer One allowed it`;
  - UI: summaries render read-only with the Owner-only line; the maintainer note and the `api_key_required` message.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): every write names the acting person and checks their role; collaborators see connection summaries and run on API keys`

---

### Task 5: Gate requirements by role or person

**Files:** Modify `packages/core/src/gates/service.ts`, Plan 7's `packages/core/src/share/snapshot.ts` (attributions), `apps/ui/src/components/GateCard.tsx` (this task owns the whole file, including the role-gated buttons Task 9 would otherwise touch), `apps/ui/src/api.ts`. Create `packages/core/src/server/gates-routes.ts` (the requirement route and the `GateRequirementError` mapping, as its own plugin). The only change to `routes.ts` is the one line that passes `signer` in the `POST /api/cards/:id/move` and `GET /api/cards/:id/gates` handlers, and Task 4 applies it (Wave 4). Tests `packages/core/test/gates/service.test.ts`, `packages/core/test/server/gates-routes.test.ts`, `packages/core/test/share/snapshot.test.ts`, `apps/ui/test/GateCard.test.tsx`.

**Interfaces:**
```ts
// gates/service.ts
export type Signer = { personId: string; role: Role };
export class GateRequirementError extends Error { constructor(public readonly gateId: GateId, public readonly requirement: GateRequirement) }  // → 403 { error: "gate_requires", gateId, requirement }
class GateService {
  evaluate(cardId: string, to: Stage, signer?: Signer): GateEvaluation[];   // fills requirement (project row or default) and signable; signer omitted → signable for the Owner (Plan 7's buildSnapshot and the existing GET /api/cards/:id/gates caller compile unchanged)
  move(actor: Actor, cardId: string, to: Stage, decisions: GateDecisionInput[] = [], signer?: Signer): Card;  // signer is a trailing optional (every existing caller and Plan 3's tests compile unchanged); default { personId: actor.id, role: actor.id === OWNER_ID ? "owner" : <lookup via deps.person(id)> }; a sign_off or waive for a gate the signer does not satisfy → GateRequirementError before anything is recorded; signedBy/waivedBy = actor.id
  setRequirement(actor: Actor, projectId: string, gateId: GateId, requirement: GateRequirement | null): void;  // Owner only (route); a personId must be a current, not removed person (NotFoundError)
}
// GateService's deps gain person?: (id: string) => Person | null (Task 1's getPerson), used for the default signer
// gates-routes.ts: PUT /api/projects/:id/gates/:gateId/requirement { requirement: GateRequirement | null } (owner) → 200 { gateId, requirement }; its own setErrorHandler maps GateRequirementError and NotFoundError
// routes.ts (Task 4 applies): POST /api/cards/:id/move and GET /api/cards/:id/gates?to= pass { personId: principal.personId, role: principal.role } as signer
// share/snapshot.ts (Plan 7's): owner = getPerson(db, OWNER_ID).name; DecisionItem.by = getPerson(db, <decided_by | actor id>)?.name ?? "a former collaborator"; WaitingItem.assignee = requirementLabel({ role: "reviewer" }, name) for actions and intake decisions ("a reviewer or above"); ReadinessRow is unchanged (it derives from evaluate without a signer)
```
GateCard: under the acknowledgement, `Who may sign: <requirementLabel>`; when `signable` is false the `Sign off` and `Waive` buttons are disabled with the line `You cannot sign this gate. It needs <requirementLabel>.`; for a role below reviewer the same two buttons are disabled with the title `Your role (<role label>) cannot do this.` (Task 9's rule, applied here so the file has one owner); the Owner sees a `Change who may sign` select (`A reviewer or above`, `A maintainer or above`, `The Owner`, then each current person by name) that calls the PUT.

- [ ] **Step 1: Write failing tests:**
  - **(Review Focus 5)** a reviewer signs `go_live` → `GateRequirementError { gateId: "go_live", requirement: { role: "owner" } }`, ledger unchanged, card unmoved; the Owner sets `ready_to_ship` to `{ personId: m1 }` → `gate.requirement_set`; maintainer `m2` signs → error; the Owner signs → error; the Owner sets `null` → `gate.requirement_set { requirement: null }` and the row is gone; the reviewer signs → `gate.signed_off { signedBy: <reviewer id> }` and `card.moved` with the reviewer as actor; `setRequirement` with a removed person → `NotFoundError`; `evaluate` for the reviewer shows `signable: false` on `go_live` and `true` on `ready_to_ship`; `evaluate(card, "ship")` with two arguments still returns every evaluation with `requirement` and `signable` filled for the Owner, and `move(owner, card, "ship", [signOff])` with four arguments still works (Plan 3's and Plan 7's tests pass unchanged); rebuild equals live;
  - snapshot: after a reviewer `p1` named `Reviewer One` waives `ready_to_ship`, `buildSnapshot` has `decisions[0].by === "Reviewer One"`, `owner === "Owner"` (or the Owner's chosen name after `person.renamed`), `waiting[0].assignee === "a reviewer or above"`, and the digests' `agent.started` item for a run `p1` started reads `Reviewer One started a Fake agent…`; `JSON.stringify(snapshot)` has no `"by":"Owner"` for that decision; Plan 7's snapshot tests otherwise pass unchanged;
  - routes: `PUT …/requirement` by a maintainer → 403 `forbidden`; by the Owner → 200; a reviewer's `POST /api/cards/:id/move` with a `go_live` sign-off → 403 `{ error: "gate_requires", gateId: "go_live", requirement: { role: "owner" } }` (this one runs in Task 4, once the `move` line is applied);
  - UI: a non-signable gate disables both buttons with the exact line; a viewer sees both disabled with the role title; the Owner's select posts `{ requirement: { personId } }`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(gates): a gate names who may sign it, by role or by person; the Owner changes it on the record; the share page names the signer`

---

### Task 6: The remote TLS listener with a self-signed, pinned certificate

**Files:** Create `packages/core/src/server/{remote,certs,remote-routes}.ts`. Modify `server.ts`, `connection-routes.ts` (`/api/status.remote`). `@peculiar/x509` 2.2.0 is already pinned by the `chore(deps)` commit. Tests `packages/core/test/server/{remote,certs,remote-routes}.test.ts`. (Waves: `certs.ts` is a leaf in Wave 1; `remote.ts` and `remote-routes.ts` against a stub `people` in Wave 2; the `server.ts`/`connection-routes.ts` wiring in Wave 5.)

**Interfaces:**
```ts
// certs.ts  (names chosen not to collide with Plan 6's link/x509.ts selfSignedCertificate(privateKey, publicKey, cn): Buffer and link/identity.ts fingerprintOf(spkiDer): string, which core index.ts re-exports)
export type CertMaterial = { certPem: string; keyPem: string; fingerprint: string /* AA:BB:…, SHA-256 of the certificate DER, upper-case: CERT_FINGERPRINT */; expiresAt: string; subjectAltNames: string[] };
export async function selfSignedTlsCertificate(i: { hostnames: string[]; addresses: string[]; now?: () => Date; days?: number /* 3650 */ }): Promise<CertMaterial>;   // ECDSA P-256 via node:crypto, X.509 via @peculiar/x509; CN "The Terminal"; SANs = hostnames + IPs; serial random
export function certFingerprint(certPem: string): string;                    // = new X509Certificate(pem).fingerprint256
export function loadProvided(certFile: string, keyFile: string, deny: { uiDir: string; dataDir: string }): CertMaterial;   // throws CertificateError with a fixed message when unreadable, mismatched or expired, and when either path resolves inside uiDir or to the data dir's ledger.db or token (defence in depth, like static-ui.ts's deny list); the message never holds a path
export class CertificateError extends Error {}
export function localAddresses(): { hostnames: string[]; addresses: string[] };   // os.hostname() + ".local" when it has no dot; non-internal IPv4 from os.networkInterfaces()
// remote.ts
export type RemoteDeps = { http: import("node:http").Server; db: Db; ledger: Ledger; secrets: SecretStore; people: { hasOwnerCredential(): boolean } /* not the whole PeopleService: a stub in tests, so this module builds in parallel with Task 1 */; dataDir: string; uiDir: string; acme?: AcmeManager /* Task 7 */; now?: () => Date };
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
GET  /healthz                 public, exempt from the Host check → 200 { ok: true }        (no other field; for the container HEALTHCHECK and load balancers; the exemption is what lets the HEALTHCHECK pass when --remote-domain is set)
GET  /api/remote              viewer → RemoteListener.state() for the Owner; non-owners get { enabled, listening } only (no port, bind, domain, addresses or fingerprint: the address is the Owner's)
PUT  /api/remote              owner, local listener only when enabling (409 remote_only_from_local otherwise) → { enabled, port?, bind?, domain?, tls?, certFile?, keyFile? } → state
```
`/api/status` gains `remote: { enabled: boolean; listening: boolean; label?: string }` where `label` is present for the Owner only and is `<domain>:<port>` or `<first address>:<port>` or `off`; non-owners' status bars read `Remote: on`/`Remote: off` without an address. `createServer` gains `remote?: { enabled?: boolean; port?: number; bind?: string; domain?: string }` (the CLI's flags) and, when given with `enabled`, commits through `enable` with actor `{ kind: "system", id: "cli" }` at startup (after the lock, before listen). On a headless server there is no local listener, so once the Owner disables remote from the UI it can be re-enabled only by restarting with `--remote` (the flag is the switch there; `docs/self-hosting.md` says so). `RunningServer` gains `remoteUrl: string | null` and `fingerprint: string | null`. The `Secure` cookie, `rpFor` and `listenerOf` from Tasks 2–3 now see real TLS sockets.

- [ ] **Step 1: Write failing tests:**
  - certs: `selfSignedTlsCertificate({ hostnames: ["tt-test.local"], addresses: ["192.168.1.10"] })` parses with `new X509Certificate(pem)` from `node:crypto`, has both SANs, `fingerprint` matches `CERT_FINGERPRINT` and equals `X509Certificate.fingerprint256` and `certFingerprint(pem)`, `expiresAt` is 10 years out; `loadProvided` with a mismatched key → `CertificateError` whose message holds no path; `loadProvided` with a cert path inside `uiDir` or a key path equal to `<dataDir>/ledger.db` → `CertificateError` without reading the file;
  - remote: with a real `http.Server` and Fastify app, `enable(owner, { port: 0, bind: "127.0.0.1" })` commits `remote.certificate_changed` then `remote.enabled` (consecutive seqs), the private key is in the secret store under `remote/tls/key` and nowhere in the data dir except the `.pem` cert; a `fetch` with a `tls.connect` agent pinned to `fingerprint256` reaches `GET /healthz` → `{ ok: true }` and a different fingerprint is refused by the client; `state().fingerprint` equals the served certificate's `fingerprint256` (one source for the invite's `#fp=`); the Fastify request over TLS has `listener: "remote"`; **(Review Focus 2)** the Owner's bearer over TLS → 401, `GET /?token=` over TLS → 401 without `location`; a session created over TLS works over TLS and not over the plain server; a plain-HTTP `GET` written to the TLS port gets no HTTP response (the socket closes at the TLS layer: no downgrade, no plain fallback); a WebSocket upgrade to `/api/events` over TLS with `Origin: http://tt-test.local:4318` → 403 and with `https://tt-test.local:4318` → 101; `Host: [::1]:4318` over TLS → not 403 `bad_host`; `GET /healthz` over TLS with `Host: 127.0.0.1:4318` while `domain` is set → 200; `disable` commits `remote.disabled` and the port closes; `enable` twice reuses the certificate (no second `certificate_changed`); `enable` with `people.hasOwnerCredential()` false (stub) → `OwnerCredentialRequiredError`; a port already in use → `RemoteStartError` and a `remote.disabled` after the `remote.enabled`; `startIfEnabled` after a restart over the same db listens again;
  - routes: `PUT /api/remote { enabled: true }` over the remote listener → 409 `remote_only_from_local`; by a maintainer → 403; `GET /api/remote` as a viewer has only `enabled` and `listening`; `/api/status.remote` for the Owner has `label` `off` then `<address>:<port>`, for a viewer has no `label` key.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/remote server/certs server/remote-routes`. Expected: FAIL.
- [ ] **Step 3:** Implement (`@peculiar/x509` is already pinned).
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): an off-by-default TLS listener for the network, self-signed with a pinned fingerprint, every change in the ledger`

---

### Task 7: Certificates from ACME when the Owner sets a domain

**Files:** Create `packages/core/src/server/acme.ts`. Modify `remote.ts`, `remote-routes.ts` (both Task 6's, in Wave 3 after Task 6's Wave 2 part lands; the `server.ts` wiring is Task 6's Wave 5 part). `acme-client` 5.4.0 and its three `overrides` are already pinned by the `chore(deps)` commit. Tests `packages/core/test/server/acme.test.ts`, `remote.test.ts`.

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
export class AcmeError extends Error { constructor(public readonly type: string) }   // fixed message "certificate could not be obtained"; `.type` is the ACME error type when it matches /^urn:ietf:params:acme:error:[a-zA-Z]+$/ and is ≤ 200 characters, else "unknown"; it reaches the UI in the 502 body (it is a URN from the ACME server, never user input), never the ACME server's detail text
export const fakeAcme: AcmeClientLike;    // under THETERMINAL_FAKE_AGENT=1 + THETERMINAL_FAKE_ACME=1: issues a self-signed cert for the domain after "serving" the challenge through challengeResponse
```
Rules: `tls: "acme"` requires `domain`; `enable` obtains the certificate **before** committing `remote.enabled` (the Task 6 order: material first), and opens a plain `http.Server` on port 80 (`bind` same) that answers only `/.well-known/acme-challenge/:token` and redirects everything else to `https://<domain>:<port>/`; the plain listener stays up for renewals. Port 80 is a privileged port: it binds without privilege in Docker (unprivileged ports start at 0 since Docker 20.10) and fails for `theterminal start --remote --remote-tls acme` as a normal user on Linux, which `docs/self-hosting.md` says (`acmePort` is a test knob only, not a workaround). Renewal check every 12 hours (`setInterval`, `unref`); a new certificate replaces the `tls.Server`'s context via `setSecureContext` and commits `remote.certificate_changed`. `GET /api/remote` gains `acme: { lastError: string | null }` (the ACME error type only, Owner only). Port 80 in use or the challenge unreachable → `AcmeError` → `PUT /api/remote` answers 502 `{ error: "acme_failed", type }` and remote stays off (no `remote.enabled`). ACME traffic goes through `axios`, which honours `HTTPS_PROXY`/`NO_PROXY` from the server's environment.

- [ ] **Step 1: Write failing tests:** with `fakeAcme`, `enable(owner, { tls: "acme", domain: "tt-test.local", port: 0, bind: "127.0.0.1", acmePort: 0 })` serves the challenge token on the plain listener during the order, commits `remote.certificate_changed { tls: "acme", domain }` then `remote.enabled`, and the cert's SAN is the domain; the account key is in the secret store and not in the ledger or any file; `renewIfDue` returns null at 60 days left and a new material at 20 days left, after which the TLS server presents the new fingerprint (`tls.connect` → `getPeerCertificate().fingerprint256`) and a `remote.certificate_changed` is committed; a client that fails the order with type `urn:ietf:params:acme:error:dns` → `AcmeError` with that `.type`, 502 `{ error: "acme_failed", type: "urn:ietf:params:acme:error:dns" }`, no `remote.enabled`; a failure whose type is 300 characters or `<script>` → `.type === "unknown"`; the plain listener redirects `GET /` to `https://tt-test.local:<port>/` with 301; `THETERMINAL_FAKE_ACME=1` without the fake-agent flag selects the real client (assert the selector).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/acme server/remote`. Expected: FAIL.
- [ ] **Step 3:** Implement (`acme-client` and its overrides are already pinned).
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): certificates from ACME for a domain, renewed on the record`

---

### Task 8: Presence over the ledger stream

**Files:** Create `packages/core/src/server/presence.ts` (Wave 2; it imports `Principal` from `@theterminal/shared`, nothing from core). Modify `events-ws.ts` (this task owns it: principal at upgrade, presence frames, close on revoke, and `GET /api/presence` registered in this plugin, not in `people-routes.ts`, so that file keeps one owner), `server.ts` (one line), `apps/ui/src/api.ts` (`subscribeLedger` distinguishes messages; after Task 4's `api.ts` change lands). Tests `packages/core/test/server/{presence,events-ws}.test.ts`, `apps/ui/test/api.test.ts`.

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
// WS /api/events: the principal is required at upgrade (401 → close 1008 "unauthorized"); the remote Origin rule of Task 2 applies to the upgrade (http:// Origin → 403); client → server: { type: "presence", projectId, view }; server → client: LedgerEntry (has "seq") or { type: "presence", people: PresenceEntry[] } on every change and once on connect
// each socket remembers sha256(principal.sessionId) (never the id) so SessionStore.onRevoke(personId, sessionIdHash | null) can match a single-session revoke; the socket is closed with 1008 "revoked" when its session or person is revoked (Review Focus 3)
// GET /api/presence (viewer) → PresenceEntry[]   (registered here, in events-ws.ts's plugin)
// ui/api.ts: the real function today is subscribeLedger(afterSeq: number, onEntry: (e: LedgerEntry) => void, WS = WebSocket): () => void, which parses every message as a LedgerEntry and drops seq <= last. It becomes
//   subscribeLedger(afterSeq: number, onEntry: (e: LedgerEntry) => void, opts?: { onPresence?: (people: PresenceEntry[]) => void; WS?: typeof WebSocket; presence?: () => { projectId: string | null; view: string | null } }): () => void
//   and routes by `"seq" in message` FIRST: a presence frame (no seq) goes to onPresence and never touches `last`; only entries pass through the seq <= last check. (Without the ordering, `undefined <= last` is false, the frame reaches onEntry and `last` becomes undefined.) The client sends { type: "presence", … } on connect and whenever presence() changes.
```

- [ ] **Step 1: Write failing tests:** two sockets for two people → `list()` has two entries and both sockets receive a presence message naming both; an `update` with `view: "board"` is broadcast, with `view: "<script>"` ignored; `leave` removes; a socket whose session is revoked closes with 1008 within 500 ms and the other socket sees the person gone, while a second session of the same person stays connected (single-session revoke matches by hash) **(Review Focus 3)**; an upgrade without a cookie closes 1008; `GET /api/presence` lists the same and lives in the `events-ws` plugin (a server with `people-routes` unregistered still answers it); UI `subscribeLedger` passes entries to `onEntry`, presence frames to `onPresence`, a presence frame followed by an entry with `seq: 1` still delivers the entry (`last` untouched), and an entry with `seq <= last` is still dropped.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test server/presence server/events-ws && pnpm --filter @theterminal/ui test api`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(server): presence (who is here and what they look at) over the ledger stream`

---

### Task 9: UI: join and sign-in pages, People view, remote access, roles in the shell

**Files:** Create `apps/ui/src/pages/{JoinPage,SignInPage}.tsx`, `apps/ui/src/identity.ts`, `apps/ui/src/views/{PeopleSideBar,PeoplePanel}.tsx`, `apps/ui/src/components/InviteDialog.tsx`. Modify `main.tsx`, `api.ts` (after Tasks 4 and 8), `shell/{views,model}.ts`, `shell/{StatusBar,ActivityBar,Workbench,Dock}.tsx`, `App.tsx`, `views/ConnectionEditor.tsx` (the secret-store wording), `packages/core/src/server/static-ui.ts` (SPA fallback for `/join/*` and `/sign-in`; it may now import `PUBLIC_ROUTES` or keep `PUBLIC_ROUTE`, both work). Not `GateCard.tsx` (Task 5 owns it). `@simplewebauthn/browser` 14.0.0 is already pinned by the `chore(deps)` commit. Tests `apps/ui/test/{JoinPage,SignInPage,identity,PeopleSideBar,PeoplePanel,InviteDialog,StatusBar,Workbench,ActivityBar}.test.tsx`, `packages/core/test/server/static-ui.test.ts`, `e2e/shell.spec.ts` (the view count).

**Interfaces and copy:**
```ts
// identity.ts
export async function passkeysAvailable(): Promise<boolean>;          // window.PublicKeyCredential exists and the hostname is not an IP literal
export async function hasBrowserKey(): Promise<boolean>;              // a key exists in IndexedDB "tt-identity"
export async function ensureBrowserKey(): Promise<{ publicKey: string /* base64url SPKI */; sign(message: Uint8Array): Promise<string> }>;  // crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]) stored in IndexedDB "tt-identity"; reused when present
export async function joinWithPasskey(code: string, name: string): Promise<Me>;   // options → startRegistration → verify
export async function joinWithKey(code: string, name: string): Promise<Me>;
export async function signInWithPasskey(): Promise<Me>; export async function signInWithKey(): Promise<Me>;
// shell/views.ts: the final order after Plans 6, 7 and 8 is fixed here: VIEWS = ["board", "agents", "changes", "needs_you", "ledger", "connections", "github", "capacity", "machines", "people", "share", "learn"] (twelve; Plan 6's "machines" and Plan 7's "share" each said only "after capacity" / "before learn"); VIEW_LABELS gains people: "People"; ActivityBar.test.tsx and e2e/shell.spec.ts assert twelve views, not ten; LEDGER_TOPICS in model.ts gains "people" and "remote" beside Plan 6's "machine" and Plan 7's "share"; model gains me: Me | null, presence: PresenceEntry[], remote: RemoteView | null, people: Person[], invites: Invite[]; Dock.tsx DEFAULTS/PANELS gain people { title: "People", where: "main" }
// main.tsx: pathname /join/<code> → JoinPage; /sign-in → SignInPage; else App (which redirects to /sign-in on a 401 from GET /api/me)
```
- **JoinPage** (`main[aria-label="Join this workspace"]`): loads `GET /api/join/<code>`; shows `You have been invited as a <role label>.` and `ROLE_DESCRIPTIONS[role]`; when the URL has `#fp=`: `Certificate fingerprint in your link: <fp>` and the line `Compare it with the fingerprint your browser shows for this site's certificate (click the lock icon). Continue only if they are the same.` The page **never** renders `They match.` or any other claim of a match: a page cannot see the certificate its browser accepted, and a server-reported fingerprint arrives over the very connection an interceptor would control, so comparing the two proves nothing. The mismatch branch stays, because it catches a wrong link: when the server-reported `fingerprint` differs from `#fp=`, in the attention colour, `They do not match. Do not continue: someone may be intercepting the connection.` with the form disabled; a `Your name` input (`maxLength 60`) with the note `Your name is recorded in this workspace's ledger next to everything you do.`; primary button `Create a passkey and join` when `passkeysAvailable()`, else `Create a key in this browser and join` with the note `This browser cannot use passkeys here (the address is an IP, or passkeys are unsupported). A key will be created and kept in this browser only.`; errors: `invite_invalid` → `This invitation is no longer valid. Ask the Owner for a new one.`, `rate_limited` → `Too many attempts. Try again in <n> seconds.`, `invalid_credential` → `That did not work. Try again.`; success → `location.assign("/")`.
- **SignInPage** (`main[aria-label="Sign in"]`): buttons `Sign in with a passkey` and `Sign in with this browser's key` (the latter only when a key exists in IndexedDB); `locked` → `Too many failed attempts. Try again in <n> minutes.`; a line `The Owner signs in on this computer without a password; everyone else uses the passkey or key they created when they joined.`
- **Status bar**: left-most item `You: <name> (<role label>)` (clicking selects the People view); right side gains `Remote: off` or `Remote: on · <label>` with class `attention` for the Owner and `Remote: on` without an address for everyone else (`status.remote.label` is Owner-only); `Keychain unavailable` logic unchanged; when `/api/status` says `secretStore: "file"` every `Stored in your keychain` string in the Connections editor reads `Stored in this server's encrypted secret store`.
- **Activity bar**: every view stays visible to every role (reading is allowed; a viewer's Changes view shows the list of changed files and `Only reviewers and above can open file contents.` in place of the diff and file panes, since those routes are `reviewer`); write controls are disabled by role with the title `Your role (<role label>) cannot do this.` — `Start agent`, `New project name`, `Add card`, `Move to…` (reviewer+ enabled), the decision buttons (reviewer+), `Save`/`Test connection`/`Remove connection` (owner), Plan 6's Machines and Plan 7's Share write controls (owner), the Needs-you strip shows cards to everyone but decision buttons follow the same rule; the gate card's buttons are Task 5's.
- **PeopleSideBar**: `People here` (presence: `<name> · <role label> · <view label> in <project name>` or `· not in a project`), `Everyone` (name, role, online dot, `Invite someone` button for the Owner), `Remote access` summary (`Off` / `On · <label>` with `Open People` to the panel).
- **PeoplePanel** (`section[aria-label="People"]`, dock panel id `people`): table `Name · Role · Credentials · Last seen · Online`; Owner-only per row: a role select (`Viewer`, `Reviewer`, `Maintainer`), `Sign out everywhere`, `Remove` (confirm `Remove <name>`); `Invitations` (pending: role, expires, `Revoke`); `Remote access` form (Owner): switch `Allow people on the network to reach this workspace` (`role="switch"`, `aria-label="Remote access"`), port, `Domain (optional)`, TLS radios `Self-signed certificate` / `Certificate from Let's Encrypt (needs the domain and port 80)` / `My own certificate files` with two path inputs; a read-only `Certificate fingerprint` with `Copy`; the machine's addresses; the note `Browsers cannot verify a self-signed certificate: people will see a warning the first time, and the join page asks them to compare this fingerprint with the one their browser shows. Set a domain to get a certificate browsers trust. Programs that connect to this workspace check the fingerprint instead.`; errors `owner_credential_required` → `Add a passkey or key for yourself first, under Your credentials. Your local sign-in never leaves this computer.`, `remote_start_failed` → `The listener could not start. Is the port free?`, `acme_failed` → `Let's Encrypt could not issue a certificate (<type>). Check that the domain points here and port 80 is reachable.`; `Your credentials` (every role): list with `Remove`, buttons `Add a passkey` and `Add a key for this browser`; `Your sessions` (every role): one row per `Me.sessions[]` entry (`<listener label> · since <createdAt> · last seen <lastSeenAt>`, `this one` on the current) with a `Sign out` button per row that calls `DELETE /api/me/sessions/<id>`; `Sign out` (this session).
- **InviteDialog** (`dialog[aria-label="Invite someone"]`): role radios with `ROLE_DESCRIPTIONS`; `Create invitation` → shows the link once in a read-only input with `Copy link`, the line `This link works once and expires in 7 days. Send it over a channel you trust, and tell the person the certificate fingerprint some other way too.`, and, when remote is off, `Remote access is off: this link only works on this computer. Turn it on under Remote access to invite someone else.`
- `static-ui.ts`: `GET /join/*` and `GET /sign-in` serve `index.html` (public); everything else as today.

- [ ] **Step 1: Write failing tests:** JoinPage with `#fp=` equal to the server's fingerprint shows the link's fingerprint, the exact `Compare it with the fingerprint your browser shows…` line and the passkey button, and the rendered text contains neither `They match` nor `match` in any affirmative sentence (assert `queryByText(/they match/i)` is null); with a mismatch shows the attention line and a disabled form; with `passkeys: false` shows the key button and note; `invite_invalid` copy; SignInPage renders the key button only when `identity.hasBrowserKey()` resolves true; `identity.ensureBrowserKey` (WebCrypto stubbed) stores once and reuses; StatusBar shows `You: Reviewer One (Reviewer)`, `Remote: on · tt-test.local:4318` with the class when `label` is present and `Remote: on` when it is absent; ActivityBar renders twelve views in the fixed order; Workbench for a viewer disables `Start agent` with the title and keeps the decision card visible without buttons, and shows the Changes placeholder line; PeoplePanel: the Owner's role select posts `{ role: "maintainer" }`, `Remove` confirms, the remote switch posts `{ enabled: true, tls: "self_signed" }`, `owner_credential_required` copy, a session row's `Sign out` calls `DELETE /api/me/sessions/<id>`; InviteDialog shows the link once and the remote-off note; static-ui serves `index.html` for `/join/abc` and 404 for `/join/../token`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test && pnpm --filter @theterminal/core test server/static-ui`. Expected: FAIL.
- [ ] **Step 3:** Implement (`@simplewebauthn/browser` is already pinned).
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): join and sign-in pages, People view with presence and remote access, roles throughout the shell`

---

### Task 10: The Linux server image, the file secret store and the CLI flags

**Files:** Create `Dockerfile`, `.dockerignore`, `packages/core/src/secrets/file-store.ts` (Wave 1, a leaf), `packages/core/src/healthcheck.ts` (fetches `https://127.0.0.1:4318/healthz` with `rejectUnauthorized: false`, exits 0 on `{ ok: true }`, 1 otherwise; no other output). Modify `packages/core/src/cli.ts`, `cli-support.ts` (`USAGE`, the `failAndExit` paths), Plan 9A's `server/data-dir-lock.ts`, `server.ts`, `connection-routes.ts` (`/api/status.connections.secretStore`), `.github/workflows/ci.yml`. Tests `packages/core/test/secrets/file-store.test.ts`, `packages/core/test/cli.test.ts`, `packages/core/test/server/{server,data-dir-lock}.test.ts`.

**Interfaces:**
```ts
// secrets/file-store.ts
export class FileSecretStore implements SecretStore {
  constructor(opts: { file: string /* <dataDir>/secrets.enc.json */; keyFile: string; createKey?: boolean /* true: write 32 random bytes, mode 0o600, when missing */ });
  // AES-256-GCM; per value: random 12-byte nonce, tag; file = { version: 1, entries: { [account]: { n, c, t } } } written atomically (tmp + rename); a key file of the wrong size → SecretStoreUnavailableError
}
export type SecretStoreKind = "keychain" | "file" | "memory";
export class KeyInsideDataDirError extends Error {}   // "Refusing to start: the secret key file is inside the data directory"
// server.ts
selectSecretStore(env, injected, flags?: { store?: "keychain" | "file"; keyFile?: string; dataDir?: string; allowKeyInDataDir?: boolean }): { store: SecretStore; kind: SecretStoreKind }   // "file" only from flags, never from env; path.resolve(keyFile) under path.resolve(dataDir) → KeyInsideDataDirError unless allowKeyInDataDir (a backup of the data dir must not hold key and ciphertext together)
createServer(opts: { …; secretStore?: "keychain" | "file"; secretKeyFile?: string; allowKeyInDataDir?: boolean; remote?: { enabled?: boolean; port?: number; bind?: string; domain?: string; tls?: TlsMode }; bootstrapInvite?: (url: string) => void })
// at startup with remote enabled and !people.hasOwnerCredential(): create an "owner" invite with a one-hour ttl (not seven days: the link sits in the container log) and call bootstrapInvite(url) once; the CLI prints `Open this link once to claim the Owner identity: <url>` to stdout once and also writes the url to <dataDir>/bootstrap-invite with mode 0o600 (removed when the Owner joins), so an operator who shuns logs can read it there; a later start with no Owner credential revokes the previous owner invite and issues a new one (so a stale link in an old log is dead); once the Owner has a credential nothing is printed, ever (the invite link is the only secret ever printed)
// server/data-dir-lock.ts (Plan 9A's): acquireDataDirLock treats a lock whose pid === process.pid as stale, like a dead pid. In a container the server is PID 1 on every start, so after docker kill or OOM the old lock names 1, process.kill(1, 0) succeeds, and without this the container never starts again. A lock cannot be held by the process that is only now starting.
// cli.ts flags: --remote, --remote-port N, --remote-bind ADDR, --remote-domain NAME, --remote-tls self_signed|acme|provided, --tls-cert FILE, --tls-key FILE, --secret-store keychain|file, --secret-key-file FILE, --allow-key-in-data-dir; each listed in USAGE
```
`Dockerfile` (multi-stage, exec-form entrypoint, no shell):
```dockerfile
FROM node:24.22.2-bookworm-slim AS build         # pin the digest the first `docker pull` prints: node:24.22.2-bookworm-slim@sha256:…
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter @theterminal/core... --filter @theterminal/ui... && pnpm --filter @theterminal/shared --filter @theterminal/core --filter @theterminal/ui build && pnpm --filter @theterminal/core deploy --prod --node-linker hoisted /out/core && cp -r apps/ui/dist /out/ui
#   --filter keeps apps/desktop (electron, electron-builder, Plan 9A) out of the install; apps/desktop stays in the build context because a frozen lockfile needs every workspace package.json present
FROM node:24.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out /app
USER node
VOLUME ["/data", "/key"]
EXPOSE 4318 80
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "/app/core/dist/healthcheck.js"]   # fetches https://127.0.0.1:4318/healthz with rejectUnauthorized false; exit 0 on { ok: true }; works with --remote-domain because /healthz is exempt from the Host check
ENTRYPOINT ["node", "/app/core/dist/cli.js", "start", "--data-dir", "/data", "--ui-dir", "/app/ui", "--secret-store", "file", "--secret-key-file", "/key/secret.key", "--remote", "--remote-bind", "0.0.0.0"]
```
`.dockerignore`: `node_modules`, `**/dist`, `.git`, `e2e`, `docs` (not `apps/desktop`: see the comment above). The image needs `git` for worktrees; `apt-get` is the one shell step and runs at build time only. CI gains job `server-image` on `ubuntu-latest`: `docker build -t theterminal-server .`; `docker run -d --name tt -p 4318:4318 -v "$RUNNER_TEMP/data:/data" -v "$RUNNER_TEMP/key:/key" theterminal-server`; wait up to 60 s for the container log line `Open this link once`; `curl -sk https://127.0.0.1:4318/healthz` equals `{"ok":true}`; `openssl s_client -connect 127.0.0.1:4318 </dev/null | openssl x509 -fingerprint -sha256 -noout` equals the fingerprint in the logged link's `#fp=`; the key file under `$RUNNER_TEMP/key` is 32 bytes and `0600` and nothing is written under `$RUNNER_TEMP/data` named `secret.key`; the log's only line containing `/join/` is the bootstrap line and no log line matches `/^[A-Za-z0-9+/=_-]{43,44}$/` (a 32-byte base64 value on its own line); then `docker kill tt && docker start tt`, wait for `/healthz` again (the stale PID-1 lock did not stop it), and assert the log holds exactly one `Open this link once` line more (a new one-hour invite, the old one revoked), and that `curl -sk -H "Host: evil.example.org:4318" https://127.0.0.1:4318/api/status` is 403 while `/healthz` with the same Host is 200. Actions in the new job are the already-pinned `actions/checkout`; no Docker actions.

- [ ] **Step 1: Write failing tests:** file store round trip, delete, missing → null; the file holds no plaintext of a stored `sk-ant-TESTKEY-0000000000`; a wrong key file → `SecretStoreUnavailableError` on `get`; `createKey` writes a 32-byte `0o600` file (mode check skipped on win32); `selectSecretStore(env with THETERMINAL_SECRET_STORE=file)` without flags → keychain (`kind: "keychain"`); with `flags.store === "file"` → `kind: "file"`; with `keyFile` under `dataDir` → `KeyInsideDataDirError`, and with `allowKeyInDataDir` → `kind: "file"`; `/api/status.connections.secretStore` reports it; `cli.test.ts`: `--secret-store file` without `--secret-key-file` exits 1 with `--secret-store file needs --secret-key-file`; `--remote-tls acme` without `--remote-domain` exits 1; `--secret-key-file` inside `--data-dir` exits 1 with `Refusing to start: the secret key file is inside the data directory`; `USAGE` names every new flag; `data-dir-lock`: a lock file holding `process.pid` is acquired (treated as stale) while one holding another live pid still throws `DataDirInUseError`; `createServer({ remote: { enabled: true, port: 0, bind: "127.0.0.1" }, bootstrapInvite })` on an empty data dir calls `bootstrapInvite` once with a URL containing `/join/` and `#fp=`, the invite's `expiresAt` is one hour out, `<dataDir>/bootstrap-invite` holds the url with mode `0o600` (win32: exists), commits `remote.enabled` with actor `{ kind: "system", id: "cli" }`; a second `createServer` before anyone joined revokes the first invite (`person.invite_revoked`) and prints a new one; a restart after the Owner joined does not call `bootstrapInvite` and the file is gone.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test secrets cli server/server server/data-dir-lock`. Expected: FAIL.
- [ ] **Step 3:** Implement. Build the image locally once (`docker build .`) and record the base image digest in the `Dockerfile`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS. Push; the `server-image` job must pass alongside macOS and Windows.
- [ ] **Step 5: Commit:** `feat: Linux server image with an encrypted file secret store and a one-time Owner bootstrap link`

---

### Task 11: Documentation and changelog

**Files:** Create `docs/collaboration.md`, `docs/self-hosting.md`. Modify `docs/connections-and-credentials.md` (a `## On a self-hosted server` section: the file store, where the key lives, that `Stored in your keychain` reads differently there; `## What collaborators see`), `README.md` (one paragraph: invite people, roles, self-host), `CHANGELOG.md`.

`docs/collaboration.md` covers: the four roles with `ROLE_DESCRIPTIONS` verbatim and the route table in words (including that viewers see the list of changed files but not file contents or diffs, and that the ledger export, which carries names, needs a reviewer); inviting (one-time link, 7 days, what the fingerprint in the link is for, that the join page cannot check it for you and how to compare it with the browser's lock icon, and what to do on a mismatch); passkeys vs browser keys and when each is offered (IP addresses; adding a credential on a new device; `Add a key for this browser`; passkeys always ask for your PIN or biometric); sign-in, sessions (14 days, per listener, `Sign out everywhere`, signing out one session), lockouts (5 failures from one address, 15 minutes) and rate limits; what the ledger records about people (name, role changes, sign-ins, lockouts) and what it does not (sessions, addresses, user agents); gate requirements and how the Owner changes them; collaborators and connections (summaries only; runs on API keys; `api_key_required`); presence; removing a person; what the share page (Plan 7) now shows about people (the signer's name on decisions, `a reviewer or above` on waiting items, the Owner's chosen name) and that pages confirmed before this release still say `Owner`; runs on a linked machine (Plan 6): the requester's ledger names the person who asked, the worker's own ledger records the Owner until Plan 6's wire schema carries the person.
`docs/self-hosting.md` covers: `docker run -d --name theterminal -p 443:4318 -p 80:80 -v theterminal-data:/data -v theterminal-key:/key ghcr.io/<org>/theterminal` (placeholder org, no real account), the bootstrap link in the logs and in `/data/bootstrap-invite`, that it lives one hour, that a restart before the Owner joins replaces it, and that it is the only time a secret is printed; `--remote-domain` + `--remote-tls acme` for a trusted certificate (DNS A record, ports 80 and 443; port 80 needs no privilege in Docker but does for `theterminal start --remote-tls acme` as a normal user on Linux); `HTTPS_PROXY`/`NO_PROXY` are honoured for ACME traffic; self-signed mode and the fingerprint; the `/data` volume contents (ledger, `secrets.enc.json`, `remote/`) and the `/key` volume (`secret.key`), why they are two volumes, backing up `/data` and keeping the key backup somewhere else, and that `--allow-key-in-data-dir` exists but defeats that; on a headless server remote access is switched by the `--remote` flag (turning it off in the UI leaves no way back in until a restart with the flag); the throttle counts per address and traffic from the Docker host itself may share one bucket (no reverse proxy, no `trustProxy`); running the same server on a LAN without Docker (`theterminal start --remote`); updating (pull, recreate, the data-folder lock and why a killed container restarts cleanly); what the server image cannot do (no keychain, no desktop app, no personal subscriptions; collaborators and the Owner alike run agents on API keys there).

- [ ] **Step 1:** Write the pages. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: collaboration (roles, invites, passkeys, gates) and self-hosting (image, certificates, bootstrap)`

**Departures the docs follow (code over plan):**
- A viewer does not see the list of changed files: `GET /api/runs/:id/changes` is `reviewer`, so the Changes view shows a viewer only the run picker and a note (Task 9).
- With `--remote-domain` in Docker the example publishes `-p 443:443 -p 80:80` and passes `--remote-port 443` with a matching `--health-cmd`. With `-p 443:4318` the join link and the port-80 redirect would name `:4318`, because both are built from the listener's own port.
- `--remote` fails the start on any failure to bring remote up (Task 6c fix), not only on a bad flag.
- The Owner is shown a bootstrap link only in the log and `/data/bootstrap-invite`; there is no `?token=` anywhere in container logs.

---

### Task 12: End-to-end: invite, join over TLS, roles, presence, remote on and off

**Files:** Create `e2e/people.spec.ts`, `e2e/remote.spec.ts`. Modify `e2e/global-setup.ts` (rebased on the version on `main`, which by then has Plan 6's third "peer" server and `linkBind` and Plan 7's `sharePort: 0`: the agent server registers an Owner passkey through the API with the soft authenticator **before** `createServer` is asked for `remote: { enabled: true, port: 47318, bind: "127.0.0.1", domain: null }`, since `enable` refuses without an Owner credential; exposes `TT_E2E_REMOTE_URL` = `https://127.0.0.1:47318/` and `TT_E2E_FINGERPRINT`), `playwright.config.ts` (`ignoreHTTPSErrors: true` for the remote project only). Passkeys in the browser use Playwright's CDP virtual authenticator (`WebAuthn.enable`, `addVirtualAuthenticator { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true }`) on the **local** server (`theterminal.localhost`, where RP ID is valid); over the remote URL (an IP) the join page offers the browser key, which is the path the remote spec exercises.

- [ ] **Step 1: Write the failing e2e tests:**
  - people (local): the Owner opens People → `Invite someone` → `Reviewer` → copies the link; a second browser context opens it → no fingerprint lines (no `#fp=` on local) → types `Reviewer One` → `Create a passkey and join` → lands on the board with `You: Reviewer One (Reviewer)`; the Owner's People side bar shows `Reviewer One · Reviewer · Board in <project>` within 2 s (presence); the reviewer's `Start agent` is disabled with the title; the Owner starts the fake agent; the reviewer allows the shell step from the Needs-you strip and the ledger reads `Reviewer One allowed it`; the reviewer tries to move a card to Operate and the gate card says `You cannot sign this gate. It needs the Owner.`; the Owner changes the reviewer to Viewer → the decision buttons disappear in the reviewer's context without a reload; the Owner removes them → their next click lands on `/sign-in` **(Review Focus 3)**;
  - remote (TLS, browser key): the Owner creates a `Maintainer` invite while remote is on → the link starts with `https://127.0.0.1:47318/join/` and carries `#fp=` equal to `TT_E2E_FINGERPRINT`; a fresh context opens it → the page shows the link's fingerprint and the `Compare it with the fingerprint your browser shows…` line and nowhere the text `They match` → `Create a key in this browser and join` → `You: Maintainer Two (Maintainer)`; the maintainer opens Connections → sees `Only the Owner can see or change connection details.` and no editor; opens Changes on a finished run → the file list and `Only reviewers and above can open file contents.`; starts a fake run with `Azure (cloud account)` ticked → the ledger shows `Maintainer Two started a Fake agent…` and the shell output `env=AZURE_CLIENT_SECRET=[REDACTED]`; every response (`page.on("response")`) and every WebSocket frame (`page.on("websocket")` → `framereceived`) in the context is checked for the secret **(Review Focus 1)**; `GET https://127.0.0.1:47318/?token=<token>` from the test → 401 **(Review Focus 2)**; a tampered link (`#fp=` with one pair changed) → the attention line and a disabled form; the maintainer's status bar shows `Remote: on` without an address and the Owner's `Remote: on · 127.0.0.1:47318`; the Owner turns remote off in People → the ledger shows `Owner turned remote access off`, the status bar `Remote: off`, and the maintainer's next request fails (the listener is closed);
  - `GET /api/people` and `GET /api/presence` without a cookie → 401 on both listeners.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS, Windows and the `server-image` job. Open the pull request from `plan-8-cloud-collaboration` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): invite and join with a passkey and a browser key, roles, presence, remote access on and off`

---

## Done when

- The Owner invites people with one-time links; each joins with a passkey or a browser key, gets a role, and every ledger entry they cause on this workspace names them (the one exception, a run executing on a linked machine, names the person on the requester's ledger and the Owner on the worker's until Plan 6's wire schema carries the person); the narration reads `<name> allowed it`, `<name> moved …`, and Plan 6's and Plan 7's templates, the share page and the digests name the person too.
- Viewers read (but not file contents from agent worktrees, the ledger export, LAN addresses or the other machine's connections), reviewers decide and sign what their role allows, maintainers start runs on API keys and give them access to connections by name, and only the Owner touches connections, people, remote access, gate requirements, overrides, share pages and links, and machine linking; a route without a role cannot exist, Plan 6's and Plan 7's included.
- A collaborator never sees a credential value, a connection's configuration, the TLS private key or the Owner's token, through any response, the ledger or the stream.
- Gates name who may sign them; the Owner changes it on the record; a wrong signer is refused with nothing recorded.
- Remote access is off by default, runs on its own TLS port, and every on, off and certificate change is in the ledger and in the status bar; the token never works there and plain HTTP gets no answer; self-signed certificates are pinned by fingerprint by non-browser clients and shown, for an out-of-band comparison the page never claims to have done, in invite links; a domain gets a Let's Encrypt certificate that renews.
- Sign-ins are rate-limited and locked out per credential and address without recording the address; passkeys require user verification; removing a person ends their sessions and sockets at once; presence shows who is here and what they look at.
- The same server runs on Linux as a container with an encrypted file secret store whose key sits on its own volume, prints a one-hour Owner bootstrap link once, restarts cleanly after `docker kill`, and CI builds and smoke-tests the image (including that restart) while macOS and Windows stay green.
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
12. **Invite delivery and expiry** (7 days, one use, copied by the Owner; 1 hour for the container's bootstrap link) and **session length** (14 days) are this plan's numbers; the spec has none.
13. **Who a remote run names.** §4.5 wants every ledger entry to name a person, and Plan 6's worker records a run it accepted as the Owner's because its wire schema (`remoteStartSchema`) carries no person. This plan names the person on the requesting machine only; carrying `personId`/`personName` across the link is a Plan 6 change. Confirm that the requester's attribution is enough until then.
14. **What investors see about who decided.** §4.4 lists "decisions made (with approver …)"; Plan 7 shipped `Owner` literals. This plan shows the signer's chosen display name on the share page, which the Owner previews before confirming. Confirm that a collaborator's display name may leave the machine on a share page the Owner confirms.
