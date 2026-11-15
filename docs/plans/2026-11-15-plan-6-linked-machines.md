# Plan 6: Linked Machines Implementation Plan

**Goal:** The Owner's Mac and GPU desktop each run The Terminal, pair once over the local network with a code shown on one screen and typed on the other, and from then on work as one workspace: a run started on the Mac can execute on the desktop (on the desktop's own credentials or its local model), every action lands in the project's ledger as a signed, attributed copy of the worker's entry, the Owner decides on the Mac, the finished work comes back as the run's working copy, and the Capacity view shows both machines' hardware and local models. Open-weight models served by Ollama or llama.cpp become a capacity source through Codex. Everything in this plan works without internet.

**Architecture:**
- **A second listener, never the first.** The workspace server keeps its `127.0.0.1` bind, Host check and cookie exactly as today. Linking adds a separate Fastify instance (`LinkListener`) that binds the LAN only after the Owner records an opt-in in the ledger (`machine.linking_enabled`, with a fixed acknowledgement sentence), speaks only mutual-authentication TLS 1.3, and authenticates every connection by the raw Ed25519 public key in the peer's certificate against the pinned keys of paired machines. The `/api/*` routes never learn about it beyond `/api/link/*`, which the Owner's browser calls on loopback as usual.
- **Identity, trust and pairing.** Each machine has one Ed25519 key, generated on first start and kept in the OS keychain through the existing `SecretStore`; its public key defines the machine id and fingerprint, and a self-signed X.509 certificate is encoded from it at startup (our own ~120-line DER encoder, verified by `node:crypto`'s `X509Certificate`). Pairing: machine S shows a 20-character code that carries the first 64 bits of S's fingerprint plus a 32-bit one-time secret; machine E types it, connects to S over TLS, refuses the connection unless S's certificate matches the fingerprint in the code, and both sides prove the secret with an HMAC bound to the TLS session's exported keying material. Each side records `machine.paired` with the other's key.
- **What crosses the link, and what never does.** Three things cross: the capacity inventory (hardware, local models, which connections exist by id, kind and name), remote run requests and their project repository as a git bundle, and ledger entries mirrored as `link.mirrored` frames signed with the origin machine's key. Credentials never cross: a remote run uses only the worker's own connections, chosen by the worker's connection ids, resolved from the worker's keychain, and the worker's `buildChildEnv` is the only one that builds the agent's environment.
- **Remote runs: the requester is the project's home.** The requesting machine A records `link.run_requested`, ships the project repository as a bundle, and asks worker B to start the run under the same run id. B runs it with its own runner and gate, unchanged, and A pulls B's entries for that run as an NDJSON stream of signed frames, verifying each against B's pinned key before committing `link.mirrored`; the projection applies the inner event, so the run, its actions and its pending decisions appear on A's board and Needs-you strip as if local, labelled with the machine. A decision made on A is forwarded to B, which records it and mirrors it back; A records nothing itself, so there is one source of truth per entry. When B finishes, A fetches a snapshot of the run's working copy and imports it as the run's worktree, so Plan 4's Changes, diff and file views work unchanged. Each machine's ledger stays complete for what that machine did.
- **Local models are a connection, run through Codex.** A `local_model` connection points at an OpenAI-compatible endpoint on loopback (Ollama's `/v1`, llama.cpp server's `/v1`) and names a model. Detection (loopback probes, cached) fills the Capacity view. A run selects a local model like any other connection; only the Codex adapter accepts one, and it configures Codex's own `model_providers` table for the thread instead of an OpenAI key. Nothing is bundled: The Terminal detects and uses an engine the Owner installed.
- **Offline is the default assumption, not a mode switch.** Nothing here makes a network call outside the LAN. An inferred `network` state (from the outcome of the Owner's own cloud calls, never a probe) tells the UI what to say; it never blocks anything local.
- Test doubles stay behind `THETERMINAL_FAKE_AGENT=1`: a fake discovery registry, the fake Codex fixture's local-model mode, and a fake local-model server answered by the fake HTTP. Unit and e2e tests bind the link listener to `127.0.0.1` through a `createServer` option and run two or three servers in one process.

**Tech Stack:** existing stack, plus `bonjour-service` **1.4.4** (MIT, published 2026-07-28, the newest release at least two weeks old on 2026-11-15; TypeScript types included; ~74 KB; depends on `multicast-dns` 7.2.5 (MIT), `dns-packet` 5.6.1 (MIT), `thunky` 1.1.0 (MIT) and `fast-deep-equal` 3.1.3 (MIT); no install script). `@homebridge/ciao` 1.4.0 is rejected: published 2026-11-01, exactly fourteen days before this plan, and it pulls `debug`, `tslib` and `source-map-support`. TLS, Ed25519, HMAC, HKDF-free keying-material export and X.509 parsing come from `node:tls` and `node:crypto` (verified on Node 22+: TLS 1.3 with Ed25519 self-signed certificates on both sides, `exportKeyingMaterial`, `X509Certificate.publicKey` → 44-byte SPKI). Git bundles come from `git bundle` through `WorktreeManager.runGit`. No HTTP client library: the link client uses `node:https` with explicit `key`, `cert` and a pinning check on `secureConnect`.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §1 (hardware "used to the maximum"), §2 goal 4 (connect local hardware), goal 6 (maximum utilization), goal 9 (offline mode: workspace, board, ledger, share view and linked machines keep working; agents run on local models), anti-goals "waste" and "black box", §4.2 (local models via Ollama/llama.cpp as a capacity source), §4.3 (capacity panel), §5 (ledger complete, exportable), §6 (capacity inventory includes local hardware), §7 core items 5 and 6, §8 (credentials stay with the Owner; the ledger is complete), §9 (the first project runs models on the desktop GPU for the Mac; the capacity loop), §10.2 (every action mediated before it runs: unchanged on the worker), §10.4 ("The Terminal is installed on both machines, and the two instances are linked. A project can span linked machines. Agents run on whichever machine the work requires … and all actions land in one shared project ledger and one board. Linking is a core feature"). Builds on Plans 1, 2, 2B, 5A, 5B, 3, 4 and 9A (`docs/plans/`), whose interfaces are assumed to exist: 5B's `connectionIds`, `selectForRun`, `RunCredentials.env`, `CLOUD_ENV_ALLOWLIST`, `capacityReport`, `detectHardware`, `/api/capacity`; Plan 3's `narrate`, `commitEvents`, `HumanRequiredError`; Plan 4's `runGit`, `repoPath`, `baseChildEnv`, `StartRunForm`, `onStartRun(adapter, prompt, cardId?, connectionIds?)`, the changes routes; Plan 9A's `allowlistedEnv`, the data-folder lock and the desktop app (the listener lives in the core server process the app spawns). This branch is cut from `main` after Plans 3, 4 and 9A merge. Out of scope: roles and presence (Plan 8), the share view (Plan 7), the capacity router and scheduler (§6: this plan gives them the inventory of both machines), bundling a model engine, IPv6 discovery and binding, two-way board synchronisation (see Decisions).

## Decisions

- **Decision (controller default): mutual-authentication TLS 1.3 with Ed25519 identity keys and self-signed certificates, authenticated by pinning the raw public key, not Noise.** Why: `node:tls` and OpenSSL provide the handshake, record layer, key schedule, replay protection, and the HTTP and streaming stack on top; the only code we write is a deterministic DER encoder for one certificate shape, which `X509Certificate` parses back and `cert.verify`/`checkPrivateKey` check in a test. Noise over `node:crypto` would mean hand-writing the handshake state machine, nonce handling and AEAD framing, then a request protocol on top: that is where mistakes in crypto code hide. Certificates are details of transport: trust is the pinned SPKI (`machine.paired.publicKey`), so validity dates are irrelevant (`notAfter` is `99991231235959Z`, RFC 5280's "no well-defined expiration"), there is no CA, and `rejectUnauthorized` is `false` on both sides while our own check runs on every connection and refuses anything unpinned. `minVersion` is `TLSv1.3`.
- **Decision (controller default): the identity key lives in the OS keychain under the existing `SecretStore` (account `link/identity`, PKCS#8 PEM); the public key and machine id are recorded in the ledger (`machine.identity_created`).** Why: the keychain is the one place secrets live (5A), and the store already handles unavailability. A keychain that is unavailable means linking is unavailable (fail closed: the listener does not start, pairing refuses, `/api/link/machines` reports `identity: "unavailable"`); a key missing from the keychain while the ledger has an identity means a new key, a new machine id and re-pairing, and the UI says so. The machine id is the first 16 bytes of SHA-256 over the SPKI DER (32 hex characters); the fingerprint is the full hash (64 hex).
- **Decision (controller default): pairing is a 20-character code (Crockford base32 of 12 bytes: 8 bytes of the showing machine's fingerprint, 4 bytes of one-time secret), valid for 10 minutes, cancelled after 5 wrong proofs, one at a time, over a TLS connection whose server certificate must match the fingerprint in the code; both sides prove the secret with `HMAC-SHA256(secret, label ‖ exportKeyingMaterial(32, "theterminal-pairing") ‖ own SPKI)`.** Why: a short numeric code alone is not safe against an active attacker on the LAN who relays the handshake and brute-forces the HMAC offline; putting 64 bits of the showing machine's key into the code authenticates the server end-to-end before any secret is used, so nobody but the two machines sees the keying material, and the 32-bit secret is then only guessable online, five times. The entering machine types one code once per machine pair; no QR code (desktops have no camera to scan one, and the code is short enough to type). Typed input is normalised (upper case, `O`→`0`, `I`/`L`→`1`, separators dropped).
- **Decision (controller default): discovery through mDNS/DNS-SD with `bonjour-service` 1.4.4, service type `_theterminal._tcp`, published only while linking is enabled, browsed only while the "Link a machine" panel is open (no other view browses; the Run on list and the names in narration use `GET /api/link/machines`, which asks no machine and browses nothing; `GET /api/link`, which the Machines view and the panel call, starts browsing); manual `host:port` entry always available.** Why: the library is small, maintained in 2026, MIT, typed and dependency-light (see Tech Stack); multicast can be blocked by a firewall or a Windows network profile, so the code panel always shows the showing machine's LAN addresses and the entering side accepts a typed address. The TXT record carries `id` (machine id), `name` (the Owner's name for the machine), `v` (`1`); the instance name is `TheTerminal <first 8 of the machine id>`, never the hostname (the OS broadcasts its `.local` name anyway, but The Terminal adds nothing personal).
- **Decision (controller default): a machine's name is chosen by the Owner (1 to 40 characters, checked by `redact`), defaulting to `Mac`, `Windows PC` or `Linux PC` by platform, never the hostname.** Why: hostnames commonly contain a person's name, and the name goes into both machines' ledgers.
- **Decision (controller default): the link listener binds `0.0.0.0` on port 4418 (scanning up to 20 ports above when taken), only after `machine.linking_enabled`, and the opt-in persists across restarts until `machine.linking_disabled`.** Why: the opt-in is the network-exposure gate the spec requires (§5, §9); once given, the Owner expects the desktop to accept work without clicking again after every reboot; the OS firewall prompt (macOS "accept incoming connections", Windows Defender) belongs to the OS and is documented. IPv4 only in this plan.
- **Decision (controller default): the requesting machine is the project's home and holds the one complete ledger of the project; the worker's ledger is complete for what the worker did (the run's events, plus `link.project_received`, `link.run_accepted`, `link.decision_received`); mirroring is one way, worker to requester, pulled by the requester as a stream of signed frames.** Why: the spec asks for "one shared project ledger and one board" (§10.4); a single home per project gives that without a conflict-resolution protocol between two hash chains, and a pull with a `seq` cursor resumes exactly after any disconnection or restart. The worker shows the received project as `(from <machine>)` with only the runs it executed; two-way board synchronisation is a later plan.
- **Decision (controller default): a mirrored entry is the worker's full ledger entry (`seq`, `id`, `ts`, `projectId`, `actor`, `type`, `payload`, `prevHash`, `hash`) signed with Ed25519 over its canonical JSON, verified against the pinned key before commit, committed as `link.mirrored` by actor `{ kind: "system", id: "link" }`, and applied to the projections by re-dispatching the inner event.** Why: the ledger of the home machine must record who said what: the inner `actor` keeps the human or agent, the outer `machineId` and signature prove which machine, and anyone with the ledger export and the paired keys can re-verify later (`GET /api/link/verify`). Only `agent.*` and `connection.used` entries of the requested run are accepted; anything else closes the stream.
- **Decision (controller default): the project repository crosses as a git bundle (`git bundle create … HEAD <the checked-out branch>`, not `--all`, ≤ 256 MiB), imported into the worker's `projects/<projectId>/repo` under the same project id; the finished work returns as a bundle of a snapshot commit of the run's worktree (a temporary index, `write-tree`, `commit-tree` on the run's HEAD, `refs/theterminal/snapshot/<runId>`), imported on the home machine as branch `run/<runId>` with a worktree at the same relative path the worker recorded.** Why: the two data folders share one layout, so the mirrored `agent.started.worktree` is already the right relative path on the home machine and Plan 4's routes need no change; a snapshot commit carries uncommitted and untracked work without touching the agent's branch; a bundle is one file over one request, with `git bundle verify` before anything is imported. What the Owner committed into the repository crosses the link (including any file an agent wrote there); keychain, ledger and token never do, because they are not in the repository.
- **Decision (controller default): local models are the `local_model` connection (kind `llm`), OpenAI-compatible, loopback only (`http://127.0.0.1`, `http://localhost`, `http://[::1]`), and only the Codex adapter runs them, through Codex's `model_providers` configuration for the thread (`model_provider = "theterminal_local"`, `base_url`, `wire_api` (default `responses`: the bundled Codex 0.169.0 rejects `chat`), `requires_openai_auth = false`, and `env_key` only when the server wants a key), with `authMode: "none"` recorded.** Why: Codex 0.169.0 (the bundled version) has first-class custom providers (its binary carries `model_providers`, `base_url`, `wire_api`, `env_key`, `requires_openai_auth`, plus a built-in `--oss` path for Ollama and LM Studio); Claude Code and Gemini CLI have no official local backend, and routing them through compatibility shims would be the "getting around providers' rules" anti-goal. `--oss` is not used: it is tied to two engines and a default model, while a custom provider covers Ollama, llama.cpp server and anything OpenAI-compatible with the same code. Loopback only: using the desktop's model from the Mac means running the agent on the desktop (a remote run), not exposing an unauthenticated model server to the LAN. Ollama and llama.cpp are detected (`GET /api/version`, `/api/tags`; `GET /health`, `/v1/models`), never installed.
- **Decision (controller default): the network state is inferred from the outcome of calls the Owner caused (connection tests, cloud grants, GitHub), labelled `inferred`, and shown; it never blocks anything, and The Terminal never probes a third party to find out.** Why: a probe would be a network call the Owner did not ask for (and to someone); an inference is honest when labelled, like capacity estimates (5B).
- **Decision (controller default): what keeps working offline, exactly.** Without internet: opening the workspace (`theterminal.localhost` resolves in the browser, no DNS), the board, cards, intake and gates, the ledger and its export, every decision, the agent feed, changes, diffs and files, the Learn view, pairing and linked machines on the LAN (mDNS, mTLS, capacity exchange, remote runs, mirroring, decisions over the link), runs on local models (Codex with a `local_model` connection, on this machine or a linked one), hardware and local-model detection, the Capacity view's local figures, and the desktop app. Degraded with exact copy: cloud model runs fail at the provider with the adapter's error; cloud credential minting fails the start with 5B's `cloud_credentials_failed`; the GitHub view shows the last loaded data as `stale` or `Could not reach GitHub`; connection tests of cloud providers say `Could not reach the provider`; sign-in fails. Pinned by the offline tests in Task 9.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, hostnames, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Machine names in tests are `Mac` and `GPU box`; addresses are `127.0.0.1:<port>`; fingerprints and keys are generated in the test. The mDNS instance name and TXT record never contain the hostname or a user name.
- **The workspace server's bind, Host check and cookie do not change.** Linked-machine traffic goes through `LinkListener` only, which has its own authentication (pinned client certificates) and serves only `/link/v1/*`. No `/api/*` route is reachable on the link listener; no `/link/v1/*` route is reachable on the workspace server.
- **Nothing listens beyond loopback without the recorded opt-in.** `LinkListener.start` is called only when the `link.enabled` setting projected from `machine.linking_enabled` is `"1"`; the acknowledgement sentence is exact; `machine.linking_disabled` stops it within the same request.
- **Default-deny on both listeners.** Every `/api/link/*` route sits behind `registerAuth` (401 without the cookie or bearer token). Every `/link/v1/*` route except `/link/v1/pair` requires a client certificate whose SPKI is a paired machine's; `/link/v1/pair` requires an open pairing window. An unpinned connection outside a pairing window is destroyed at the TLS layer and, as defence in depth, answered 403 `unknown_machine` by the request hook.
- **Credentials stay on the machine that owns them.** No keychain value, `apiKey`, `cliHome`, cloud secret, MCP header, local-model key, bootstrap token or identity private key is ever serialised into a link message, a capacity response, a mirrored frame or a bundle. The capacity response carries connection ids, kinds, providers and names only. A remote run's environment is built by the worker's `buildChildEnv` from the worker's own connections; the requester sends only ids.
- **Every child environment is built by `buildChildEnv`** (or Plan 4's `baseChildEnv` for git). The local-model key enters through `extraEnv` under the fixed name `LOCAL_MODEL_API_KEY`, admitted by a new `LOCAL_MODEL_ENV_ALLOWLIST`; any other name throws before the CLI starts.
- **No `shell: true`.** Git bundles, snapshots and imports go through `WorktreeManager.runGit` with argument arrays; probes use `fetch` on loopback.
- **Redact before truncating; redaction is live.** The worker cleans everything it records as today; the requester cleans nothing in a mirrored frame (it must commit the worker's entry byte for byte, or the signature breaks) and verifies instead that the inner payload passes the worker-side schema bounds. A local-model key joins the run's secret list before the adapter starts.
- **Fail closed.** A frame with a bad signature, an unlisted type, a `runId` that is not the stream's, or an `id` already mirrored closes the stream, records `link_runs.error` and records `link.run_failed` (a key that no longer matches the pinned one ends the run the same way, with `machine_key_mismatch`; the run ends: a bad signature, `wrong_run`, `wrong_project`, `foreign_action` and `invalid_payload` mean a compromised or wrong peer); nothing of it is committed. Transient refusals (`out_of_order`, a duplicate after a reconnect) record nothing, and the next good frame is committed. A pairing code mismatch aborts before any secret is used. A bundle that fails `git bundle verify` or exceeds 256 MiB fails the start (`repo_too_large`, `bundle_invalid`), nothing recorded as running. An unreachable worker answers 502 `machine_unreachable` and the action stays pending. A keychain that is unavailable disables linking. **Returned changes:** a bundle that is unreadable, clashes with the requester's records, is not descended from the commit that was sent, or names another working copy path is refused for good: `link.changes_refused { runId, machineId, reason }` (reasons `bad_bundle`, `conflict`, `not_from_base`, `wrong_path`; the link run ends `failed`), the Changes view and narration say so in fixed words, and it is never retried; an unreachable worker is retried with a backoff. `link.run_failed` is narrated by error code with fixed phrases (could not start / stopped: signature check failed / the machine was unlinked / its entries clash with records here / the machine's key changed / the machine refused / failed), never with the worker's own text. Uploads waiting on a worker are bounded per paired machine (4 uploads, 1 GiB, 1 hour), with a sweep at startup; an owner record must exist for a bundle to be started. The link transport caps a frame at 256 KiB and a stream stays open with a blank heartbeat line every 30 s (idle for 120 s counts as lost). The prompt of a remote run is cleaned (redact, scrub, redact) before it is recorded or sent.
- **Labels are honest.** `online`/`offline` of a machine is what the last `hello` said and when; `network.state` carries `basis: "inferred"`; local-model lists carry `detectedAt`.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`:** `THETERMINAL_FAKE_DISCOVERY=1` (in-process registry) and the fake Codex fixture's local-model mode are ignored otherwise. The link bind address is a `createServer` option, not an environment variable.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-6-linked-machines`, one commit per task, pushed when it lands, and merges through a pull request once CI is green on macOS and Windows. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1/2/2B/5A/5B/3/4/9A constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, every agent action gated before it runs on the machine that runs it, allowlisted child env, keychain-only secrets, live redaction, estimates labelled `estimate`, narration pure, read-only changes routes, data-folder lock).

## Review Focus

1. **An unpaired machine on the LAN.** A client with a fresh Ed25519 certificate connects to the link listener while no pairing window is open; then while one is open, to `/link/v1/hello` and `/link/v1/capacity`; then to `/link/v1/pair` with five wrong codes, then the right one. Expected: the first connection is destroyed before any route runs (and, when a request gets through, 403 `unknown_machine`); the routes other than `pair` answer 403 during the window; the fifth wrong proof cancels the window and the right code then gets 404 `no_pairing`; nothing is recorded in either ledger; the workspace server still answers only on `127.0.0.1`. (Tests in Tasks 3 and 4.)
2. **A forged, replayed or misdirected mirrored frame.** The requester's stream receives a frame signed with another paired machine's key, a frame whose `origin.type` is `card.moved`, a frame whose `payload.runId` is another run, a frame whose `origin.id` was already mirrored, and a frame whose `payload` fails the schema. Expected: none is committed, the stream is closed, `link_runs.error` names the reason, `GET /api/link/verify` stays `ok: true`, and a later reconnect from `last_seq` resumes. (Tests in Task 8.)
3. **Credentials that must not travel.** Machine A holds an AWS connection and a Claude key; it starts a remote run on B with `connectionIds: [A's AWS id]`; B's capacity is fetched; A's repo bundle is inspected. Expected: B answers 404 `not_found` for the id (ids are B's namespace) and no `connection.used` appears on either machine; the capacity response's JSON contains no secret field name's value and no key material; the bundle contains no file from outside the repository; a run that B does accept has an environment with none of A's values (the fake CLI logs its env). (Tests in Tasks 6 and 7.)
4. **The worker disappears mid-run.** B's listener stops while a remote run has a pending action; A is asked to decide; A restarts; B comes back. Expected: the run stays `running` on A, the machine shows `offline`, the decision answers 502 `machine_unreachable` and the action stays pending, A reconnects with backoff (1, 2, 4 … 30 s), resumes from `last_seq` after its own restart, and no entry is mirrored twice. (Tests in Task 8.)
5. **A local-model server that is missing, or without the model.** The `local_model` connection points at a port where nothing listens; then at a server that lists other models; a run is started with each. Expected: `Test connection` says `Could not reach the local model server` and `Model <name> is not installed on this server`; the run fails with the adapter's error within the Codex start timeout, never hangs, and Codex's environment never holds `OPENAI_API_KEY`; the offline indicator does not block the run. (Tests in Task 5.)

---

## File Structure

```
packages/shared/src/link.ts                    # constants, pairing code codec, Machine types, link.* and machine.* schemas, wire schemas (Task 1)
packages/shared/src/capacity.ts                # (modify) LocalModel, LocalEngine, MachineCapacity, CapacityReport.localModels/machines (Task 1)
packages/shared/src/connections.ts             # (modify) local_model provider and fields; connection.used purpose local_model (Task 1)
packages/shared/src/agents.ts                  # (modify) AgentRun.machineId; agent.started authMode "none" already allowed (Task 1)
packages/shared/src/events.ts, index.ts        # (modify) EventType gains LinkEventType (Task 1)
packages/shared/src/narration.ts               # (modify, Plan 3) machine.* and link.* templates, topic "machine" (Task 1)

packages/core/src/link/base32.ts               # Crockford base32 encode/decode (Task 2)
packages/core/src/link/x509.ts                 # selfSignedCertificate: DER encoder for an Ed25519 self-signed certificate (Task 2)
packages/core/src/link/identity.ts             # LinkIdentity: key in the keychain, machine id, fingerprint, cert, sign (Task 2)
packages/core/src/link/listener.ts             # LinkListener: mTLS Fastify instance, pin check, pairing window gate (Task 3)
packages/core/src/link/client.ts               # LinkClient: pinned https requests, NDJSON stream, upload/download, pair() (Task 3)
packages/core/src/link/pairing.ts              # PairingWindow, pairingProof (Task 4)
packages/core/src/link/discovery.ts            # Discovery interface, mdnsDiscovery (bonjour-service), fakeDiscovery, selectDiscovery (Task 4)
packages/core/src/link/service.ts              # LinkService: identity, enable/disable, name, machines, pair/unpair, hello cache (Tasks 3, 4)
packages/core/src/link/protocol-routes.ts      # /link/v1/* on the link listener (Tasks 3, 4, 6, 7)
packages/core/src/link/bundles.ts              # exportRepoBundle, importRepoBundle, snapshotBundle, importSnapshot (Task 7)
packages/core/src/link/mirror.ts               # signFrame, verifyFrame, MIRRORABLE check (Task 7)
packages/core/src/link/remote-runs.ts          # RemoteRunService: start, decide, stop, resume, import (Task 8)
packages/core/src/capacity/local-models.ts     # detectLocalEngines, localModelTester, LOCAL_MODEL_ENV_ALLOWLIST (Task 5)
packages/core/src/capacity/report.ts           # (modify) localModels, machines (Tasks 5, 6)
packages/core/src/network.ts                   # NetworkObserver, observedFetch (Task 9)
packages/core/src/server/link-routes.ts        # /api/link/* on the workspace server (Tasks 4, 6, 8)
packages/core/src/server/agent-routes.ts       # (modify) machineId on POST runs; decision/stop forwarding (Task 8)
packages/core/src/server/connection-routes.ts  # (modify) /api/status machines, network (Tasks 4, 9)
packages/core/src/server/capacity-routes.ts    # (modify) detect probes local engines (Task 5)
packages/core/src/server/routes.ts             # (modify) error map (Tasks 4, 5, 7, 8)
packages/core/src/server/server.ts             # (modify) linkBind option, LinkService, listener lifecycle, discovery, network (Tasks 3, 4, 8, 9)
packages/core/src/agents/child-env.ts          # (modify) LOCAL_MODEL_ENV_ALLOWLIST in extraEnv (Task 5)
packages/core/src/agents/adapter.ts            # (modify) RunCredentials.localModel (Task 5)
packages/core/src/agents/runner.ts             # (modify) runId option, localModel, authMode none, machine routing hook (Tasks 5, 7)
packages/core/src/agents/codex/adapter.ts      # (modify) local model provider config (Task 5)
packages/core/src/connections/service.ts       # (modify) local_model rules, selectForRun.localModel, publicConnections (Tasks 5, 6)
packages/core/src/connections/testers.ts       # (modify) local_model tester (Task 5)
packages/core/src/events/projections.ts        # (modify) machines, link_runs, machine_id, applyMirrored (Tasks 2, 8)
packages/core/src/db.ts                        # (modify) the migration after Plan 3's: machines, link_runs, agent_runs.machine_id (Task 2)
packages/core/src/index.ts                     # (modify)
packages/core/test/fixtures/fake-codex.mjs     # (modify) logs thread/start config; local-model mode (Task 5)

apps/ui/src/shell/views.ts                     # (modify) VIEWS gains machines (Task 4)
apps/ui/src/shell/{SideBar,Dock,Workbench,StatusBar,model}.tsx  # (modify) Machines view, link_machine panel, status items (Tasks 4, 6, 8, 9)
apps/ui/src/views/MachinesSideBar.tsx          # this computer, linked machines, Link a machine (Task 4)
apps/ui/src/views/LinkMachinePanel.tsx         # Show a code / Enter a code (Task 4)
apps/ui/src/views/CapacitySideBar.tsx, CapacityPanel.tsx  # (modify) local models, machines (Tasks 5, 6)
apps/ui/src/views/ConnectionEditor.tsx         # (modify) local_model help, loopback note (Task 5)
apps/ui/src/components/StartRunForm.tsx        # (modify, Plan 4) Run on picker; remote connection picker (Task 8)
apps/ui/src/components/LedgerPanel.tsx         # (modify) machine label on mirrored entries (Task 8)
apps/ui/src/api.ts, App.tsx                    # (modify) link, machines, capacity, status (Tasks 4–9)
docs/linked-machines.md                        # (Task 10)
docs/connections-and-credentials.md, README.md, CHANGELOG.md  # (modify) (Task 10)
e2e/link.spec.ts, e2e/local-model.spec.ts, e2e/offline.spec.ts, e2e/global-setup.ts  # (Task 11)
```

---

### Task 1: Shared link domain: constants, pairing code, events, wire schemas, narration

**Files:** Create `packages/shared/src/link.ts`. Modify `packages/shared/src/capacity.ts`, `connections.ts`, `agents.ts`, `events.ts`, `index.ts`, `narration.ts`. Tests `packages/shared/test/link.test.ts`, `connections.test.ts`, `narration.test.ts`, `domain.test.ts`.

- [ ] **Step 0: Branch.** `git switch -c plan-6-linked-machines`. Copy this plan to `docs/plans/2026-11-15-plan-6-linked-machines.md`.

**Interfaces:**
```ts
// shared/link.ts
export const LINK_PROTOCOL_VERSION = 1;
export const LINK_DEFAULT_PORT = 4418;
export const LINKING_ACK = "I understand that enabling linking lets other computers on my local network reach this computer, that only computers I pair with a code can use it, and that agents they start run here with this computer's own connections. I choose to enable it.";
export const PAIRING_CODE_TTL_MS = 600_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_LABEL = "theterminal-pairing";                   // exportKeyingMaterial label
export const MACHINE_ID = /^[0-9a-f]{32}$/;  export const FINGERPRINT = /^[0-9a-f]{64}$/;
export const machineNameSchema = z.string().min(1).max(40);
export const machineAddressSchema = z.string().regex(/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/);   // host:port, no userinfo, no path
export type MachineRole = "showed_code" | "entered_code";
export type Machine = { id: string; name: string; publicKey: string /* base64 SPKI DER */; fingerprint: string; address: string; role: MachineRole; pairedAt: string; updatedAt: string };
export type MachinePresence = Machine & { online: boolean | null; checkedAt: string | null };        // null: never checked
export type LinkRunState = "requested" | "running" | "finished" | "imported" | "failed";
export type LinkRun = { runId: string; machineId: string; direction: "requested" | "accepted"; projectId: string; state: LinkRunState; lastSeq: number; error: string | null; updatedAt: string };
export const MIRRORABLE_TYPES = ["agent.started", "agent.message", "agent.action.requested", "agent.action.decided", "agent.action.completed", "agent.finished", "agent.rate_limited", "connection.used"] as const;
export const mirroredOriginSchema = z.object({ seq: z.number().int().positive(), id: z.string().min(1).max(200), ts: z.string().datetime(), projectId: z.string().min(1).nullable(),
  actor: actorSchema, type: z.enum(MIRRORABLE_TYPES), payload: z.unknown(), prevHash: z.string().regex(/^[0-9a-f]{64}$/), hash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict().superRefine((o, ctx) => { /* eventPayloadSchemas[o.type].safeParse(o.payload) must succeed, else issue at ["payload"] */ });
export const linkPayloadSchemas = {
  "machine.identity_created": { machineId: MACHINE_ID, publicKey: z.string().base64().length(60), fingerprint: FINGERPRINT },
  "machine.named":            { name: machineNameSchema },
  "machine.linking_enabled":  { port: z.number().int().min(1).max(65535), acknowledgement: z.literal(LINKING_ACK) },
  "machine.linking_disabled": {},
  "machine.paired":           { machineId, name: machineNameSchema, publicKey, fingerprint, address: machineAddressSchema, role: z.enum(["showed_code", "entered_code"]) },
  "machine.unpaired":         { machineId, name },
  "link.run_requested":       { runId: id, machineId, adapter: z.enum(ADAPTERS), prompt: z.string().min(1).max(20000), cardId: z.string().max(200).nullable(), connectionIds: z.array(z.string().min(1).max(200)).max(10) },
  "link.run_failed":          { runId, machineId, error: z.string().max(500) },
  "link.project_received":    { projectId: id, machineId, name: z.string().min(1).max(120) },
  "link.run_accepted":        { runId, machineId, projectId },
  "link.decision_received":   { runId, actionId: id, machineId, decision: z.enum(["allow", "deny"]) },
  "link.mirrored":            { machineId, origin: mirroredOriginSchema, signature: z.string().regex(/^[0-9a-f]{128}$/) },
  "link.changes_imported":    { runId, machineId, commit: z.string().regex(/^[0-9a-f]{40}$/) },
}; // all .strict(); export type LinkEventType = keyof typeof linkPayloadSchemas;
// wire (the link protocol; every message carries v: LINK_PROTOCOL_VERSION)
export const helloResponseSchema   = z.object({ v: z.literal(1), machineId, name: machineNameSchema, linking: z.literal(true) }).strict();
export const pairRequestSchema     = z.object({ v: z.literal(1), machineId, name: machineNameSchema, port: z.number().int().min(1).max(65535), proof: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const pairResponseSchema    = z.object({ v: z.literal(1), machineId, name: machineNameSchema, port, proof }).strict();
export const remoteStartSchema     = z.object({ v: z.literal(1), projectId: id, projectName: z.string().min(1).max(120), adapter: z.enum(ADAPTERS), prompt, cardId: z.string().max(200).nullable(), connectionIds }).strict();
export const remoteDecisionSchema  = z.object({ v: z.literal(1), decision: z.enum(["allow", "deny"]), reason: z.string().max(500) }).strict();
export const mirrorFrameSchema     = z.object({ origin: mirroredOriginSchema, signature }).strict();
export const machineCapacitySchema; // zod for MachineCapacity below, used by the requester to validate what a worker sent
// pairing code
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function encodePairingCode(fingerprintHex: string, secret: Uint8Array /* 4 bytes */): string;        // 20 chars as XXXXX-XXXXX-XXXXX-XXXXX
export function parsePairingCode(typed: string): { fingerprintPrefix: string /* 16 hex */; secret: Uint8Array } | null;  // normalises; null when not 20 symbols
// shared/capacity.ts
export type LocalModel = { id: string; sizeBytes: number | null; parameters: string | null; quantization: string | null };
export type LocalEngine = { engine: "ollama" | "llamacpp"; baseUrl: string; version: string | null; models: LocalModel[]; detectedAt: string };
export type MachineCapacity = { machineId: string; name: string; online: boolean; checkedAt: string; hardware: HardwareInfo | null; localModels: LocalEngine[];
  sources: CapacitySource[]; adapters: AdapterId[]; connections: { id: string; kind: ConnectionKind; provider: ConnectionProvider; name: string }[] };
export type CapacityReport = { sources: CapacitySource[]; hardware: HardwareInfo | null; localModels: LocalEngine[]; machines: MachineCapacity[]; generatedAt: string };
// shared/connections.ts
CONNECTION_PROVIDERS gains "local_model" (kind "llm"); connection.used purpose gains "local_model"
// shared/agents.ts
export type AgentRun = { …; machineId: string | null };   // null: ran here
```
`link.ts` imports `agentPayloadSchemas` and `connectionPayloadSchemas` directly (never `events.ts`, which imports `link.ts`) to validate a mirrored `payload` against `MIRRORABLE_TYPES`, and declares its own strict actor schema of the same shape as `actorSchema`, so there is no import cycle.
Catalog entry `local_model` (`single: false`, label `Local model (Ollama or llama.cpp)`, description `An open-weight model served on this computer through an OpenAI-compatible endpoint.`): `baseUrl` (config/url, required, label `Server URL`, help `http://127.0.0.1:11434/v1 for Ollama, http://127.0.0.1:8080/v1 for llama.cpp server. Only this computer: to use another computer's model, run the agent there.`), `model` (config/text, required, label `Model`, pattern `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$`, help `The model name the server lists, for example qwen2.5-coder:14b.`), `wireApi` (config/text, required: false, label `API style`, pattern `^(chat|responses)$`, help `chat works with Ollama and llama.cpp; responses only with servers that offer it. Default chat.`), `apiKey` (secret/password, not required, label `API key (if the server wants one)`).
Narration (Plan 3's `narrate`; `<Who>` as Plan 3; `<machine>` = `payload.name` or, for `link.*` with only an id, `ctx.machineName?.(machineId) ?? "a linked machine"`; `NarrationContext` gains `machineName?: (id: string) => string | undefined`): `machine.identity_created` → `This computer got its identity (<fingerprint first 16, grouped in fours>)` · `machine.named` → `Owner named this computer "<name>"` · `machine.linking_enabled` → `Owner allowed other computers on the local network to link with this one (port <port>)`, attention true · `machine.linking_disabled` → `Owner stopped linking` · `machine.paired` → `Owner linked "<name>" (<fingerprint first 16>)` · `machine.unpaired` → `Owner unlinked "<name>"` · `link.run_requested` → `Owner asked <machine> to run a <Adapter> agent: "<clip(prompt, 80)>"`, detail = prompt · `link.run_failed` → `<machine> could not start the run: <error>`, attention true · `link.project_received` → `Received the project "<name>" from <machine>` · `link.run_accepted` → `Accepted a run from <machine>` · `link.decision_received` → `Owner's decision arrived from <machine>: <allowed|denied>` · `link.mirrored` → `On <machine>: <narrate(origin as entry).headline>`, detail and topic from the inner narration, `attention` from the inner, `refs` = inner refs plus `machineId` (added to `NarrationRefs`) · `link.changes_imported` → `The run's changes arrived from <machine>`. `NarrationTopic` gains `"machine"` for `machine.*`, `link.run_requested`, `link.run_failed`, `link.project_received`, `link.run_accepted`, `link.decision_received`, `link.changes_imported`.

- [ ] **Step 1: Write failing tests:**
  - link: `encodePairingCode(fp, secret)` is 23 characters matching `/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/`; `parsePairingCode(code)` returns the first 16 hex of `fp` and the same 4 bytes; `parsePairingCode("xxxxx-xxxxx-xxxxx-xxxxx".replace(/x/g, "o"))` normalises `o`→`0`; 19 symbols → null; `machineAddressSchema` rejects `user@host:1`, `host:1/path`, `http://host:1`; `machine.linking_enabled` with one character changed in the acknowledgement is rejected; `mirroredOriginSchema` rejects `type: "card.moved"` and an `agent.message` whose `text` is 4001 characters, accepts a valid `agent.action.requested`; `link.mirrored` with a 127-hex signature is rejected; `pairRequestSchema` rejects `v: 2`;
  - connections: `local_model` belongs to kind `llm`; `connection.used` accepts `purpose: "local_model"`; `wireApi: "grpc"` fails the pattern (through the catalog `pattern`);
  - narration: one assertion per template above with a fixture entry, including `link.mirrored` wrapping an `agent.action.requested` (headline `On GPU box: The agent wants to run the command "npm test"`, `attention: true`, `refs.machineId` set, topic `agent`); the purity scan allows `./link.js`;
  - domain: `eventPayloadSchemas` has a schema for every `EventType` including the thirteen new ones.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): linked-machine events, pairing code, link protocol schemas and local-model connection`

---

### Task 2: Identity: Ed25519 key in the keychain, self-signed certificate, machine id; migration

**Files:** Create `packages/core/src/link/base32.ts`, `x509.ts`, `identity.ts`. Modify `packages/core/src/db.ts`, `events/projections.ts`, `index.ts`. Tests `packages/core/test/link/{base32,x509,identity}.test.ts`, `packages/core/test/events/projections.test.ts`.

**Interfaces:**
```ts
// link/base32.ts
export function base32Encode(bytes: Uint8Array): string;   // Crockford alphabet, no padding
export function base32Decode(text: string): Uint8Array;    // throws RangeError on a symbol outside the alphabet
// link/x509.ts
export const CERT_NOT_BEFORE = "20000101000000Z", CERT_NOT_AFTER = "99991231235959Z";
export function selfSignedCertificate(privateKey: KeyObject, publicKey: KeyObject, cn: string): Buffer;  // DER: v3, serial = first 16 bytes of SHA-256(SPKI) with the top bit cleared, sigAlg Ed25519 (1.3.101.112), issuer = subject = CN=<cn>, UTCTime/GeneralizedTime as above, SPKI = publicKey.export({ type: "spki", format: "der" }), extensions basicConstraints CA:false (critical), signature = crypto.sign(null, tbs, privateKey)
export function derToPem(der: Buffer, label: "CERTIFICATE"): string;
// link/identity.ts
export const IDENTITY_ACCOUNT = "link/identity";
export function machineIdOf(spkiDer: Buffer): string;      // first 16 bytes of sha256 as hex
export function fingerprintOf(spkiDer: Buffer): string;    // sha256 hex
export function verifySignature(publicKeyDer: Buffer, data: Buffer, signatureHex: string): boolean;  // crypto.verify(null, …); false on any error
export class LinkIdentity {
  readonly machineId: string; readonly fingerprint: string; readonly publicKeyDer: Buffer; readonly publicKeyBase64: string; readonly certPem: string;
  static async load(deps: { secrets: SecretStore; onCreated: (info: { machineId: string; publicKey: string; fingerprint: string }) => void }): Promise<LinkIdentity>;
  // get(IDENTITY_ACCOUNT): a PKCS#8 PEM → use it; null → generateKeyPairSync("ed25519"), set() it, then onCreated(); SecretStoreUnavailableError propagates
  tls(): { key: string; cert: string };                     // the PEM key (held in a `#key` field, so no enumeration sees it) and certificate for node:tls; never logged or serialised elsewhere
  sign(data: Buffer): string;                              // Ed25519 signature, hex
}
```
Migration (the one after Plan 3's intake tables: index 8, `user_version` 9; Plan 7's follows it at index 9, and Plan 6 renumbers at its main merge if Plan 7 lands first): `CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, paired_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE link_runs (run_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, direction TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL); CREATE INDEX link_runs_machine ON link_runs (machine_id); ALTER TABLE agent_runs ADD COLUMN machine_id TEXT;`. Reducers: `machine.identity_created` → settings `link.machineId`, `link.publicKey`, `link.fingerprint`; `machine.named` → `link.name`; `machine.linking_enabled` → `link.enabled = "1"`, `link.port`; `machine.linking_disabled` → `link.enabled = "0"`; `machine.paired` → `INSERT OR REPLACE INTO machines`; `machine.unpaired` → `DELETE`; `link.run_requested` → `link_runs (direction requested, state requested)`; `link.run_accepted` → `link_runs (direction accepted, state running)`; `link.run_failed` → `state failed, error`; `link.changes_imported` → `state imported`; `link.changes_refused` → `state failed, error <reason>`; `link.mirrored` → Task 8's `applyMirrored`. `PROJECTION_TABLES` gains `machines`, `link_runs`. `getRun`/`listRuns` map `machine_id` to `machineId`. Query helpers: `listMachines(db): Machine[]`, `getMachine(db, id)`, `getLinkRun(db, runId): LinkRun | null`, `listLinkRuns(db, state?)`.

- [ ] **Step 1: Write failing tests:**
  - base32: `base32Encode(new Uint8Array([0]))` is `"00"`, a 12-byte round trip, decoding `"U"` throws;
  - x509: for a generated Ed25519 pair, `new X509Certificate(der)` has `subject === "CN=tt-test"`, `issuer === subject`, `validTo === "Dec 31 23:59:59 9999 GMT"`, `verify(cert.publicKey)` true, `checkPrivateKey(privateKey)` true, `publicKey.export({ type: "spki", format: "der" })` equals the key's 44 bytes, `ca === false`; two in-process `tls` sockets with two such certificates (`requestCert: true`, `rejectUnauthorized: false`, `minVersion: "TLSv1.3"`) complete a handshake, `getPeerCertificate(true).raw` parses to the other's SPKI, and both `exportKeyingMaterial(32, PAIRING_LABEL)` are equal;
  - identity: `load` over an empty `MemorySecretStore` generates a key, stores one account, calls `onCreated` once with `machineId` of 32 hex and `publicKey` of 60 base64 characters; a second `load` over the same store returns the same `machineId` and does not call `onCreated`; `sign`/`verifySignature` round trip, a flipped byte → false; a store failing on `get` → `SecretStoreUnavailableError`; `JSON.stringify(identity)` and `tls()` are the only places the PEM appears (assert `JSON.stringify(identity)` does not contain `PRIVATE KEY`: make `tls` a method and the key a private field);
  - projections: every reducer above; rebuild equals live; `getRun` of a row with `machine_id` set yields `machineId`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test link projections`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): machine identity in the keychain, self-signed Ed25519 certificates, machines and link_runs projections`

---

### Task 3: The link listener and client: mTLS, pinning, hello; the opt-in

**Files:** Create `packages/core/src/link/listener.ts`, `client.ts`, `service.ts` (first half), `protocol-routes.ts` (hello). Modify `packages/core/src/server/server.ts`, `index.ts`. Tests `packages/core/test/link/{listener,client,service}.test.ts`, `packages/core/test/server/server.test.ts`.

**Interfaces:**
```ts
// link/listener.ts
export type PeerCheck = (spkiDer: Buffer) => { machineId: string } | null;          // pinned machine for this key, else null
export type ListenerDeps = { identity: LinkIdentity; peer: PeerCheck; pairingOpen: () => boolean; register: (app: FastifyInstance) => void; bind?: string /* "0.0.0.0" */ };
export class LinkListener {
  constructor(deps: ListenerDeps);
  async start(port: number): Promise<number>;      // Fastify({ https: { ...identity.tls(), requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" } }); scans port..port+20 on EADDRINUSE; returns the bound port
  async stop(): Promise<void>;                     // closes every socket
  port(): number | null;
}
// request.linkPeer: { machineId } | null is decorated by the listener's onRequest hook
// link/client.ts
export class MachineUnreachableError extends Error { constructor(public readonly machineId: string) }   // "machine unreachable"
export class MachineKeyMismatchError extends Error {}                                                   // "the machine's key does not match the one paired"
export class RemoteRefusedError extends Error { constructor(public readonly status: number, public readonly code: string, public readonly detail?: string) }
export type Peer = { machineId: string; address: string; publicKeyDer: Buffer };
export class LinkClient {
  constructor(deps: { identity: LinkIdentity; timeoutMs?: number /* 10000 */ });
  request<T>(peer: Peer, method: "GET" | "POST", path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T>;   // JSON; pin check on secureConnect; non-2xx → RemoteRefusedError(status, body.error); network error/timeout → MachineUnreachableError
  stream(peer: Peer, path: string, onFrame: (line: string) => Promise<void>, signal: AbortSignal): Promise<void>;  // NDJSON; resolves on a clean end; rejects MachineUnreachableError on a cut
  upload(peer: Peer, path: string, file: string, maxBytes: number): Promise<void>;     // application/octet-stream from a file stream
  download(peer: Peer, path: string, file: string, maxBytes: number): Promise<void>;   // to a file; aborts past maxBytes with RemoteRefusedError(413, "too_large")
  static connectUnpinned(identity: LinkIdentity, address: string, timeoutMs: number): Promise<{ socket: TLSSocket; peerSpki: Buffer }>;  // pairing only: returns the server's SPKI for the fingerprint check
}
// link/service.ts (this task's part)
export class LinkingDisabledError extends Error {}   // "linking is not enabled on this computer"
export class IdentityUnavailableError extends Error {}  // "this computer's identity is unavailable (keychain)"
export class LinkService {
  constructor(deps: { db: Db; ledger: Ledger; secrets: SecretStore; listener: (deps: ListenerDeps) => LinkListener; client: (identity: LinkIdentity) => LinkClient; registerProtocol: (app: FastifyInstance) => void; bind?: string; now?: () => Date; platform?: NodeJS.Platform });
  // registerProtocol is a closure built in server.ts: (app) => registerLinkProtocolRoutes(app, deps), evaluated when the listener starts, so it may reference the LinkService itself
  async load(): Promise<void>;                        // LinkIdentity.load (commits machine.identity_created on creation); on SecretStoreUnavailableError: identityState "unavailable"; if settings link.enabled === "1" → start the listener on link.port (a failure to bind is logged as a fixed warning, linking stays enabled)
  identityState(): "ok" | "unavailable";
  self(): { machineId: string; fingerprint: string; name: string; linking: { enabled: boolean; port: number | null } } | null;   // null when unavailable; name defaults by platform: darwin "Mac", win32 "Windows PC", else "Linux PC"
  async setName(actor: Actor, name: string): Promise<void>;                 // redact-checked; commits machine.named
  async enableLinking(actor: Actor, acknowledgement: string, port = LINK_DEFAULT_PORT): Promise<number>;  // HumanRequiredError for a non-human; the exact sentence or ZodError; starts the listener FIRST, then commits machine.linking_enabled with the bound port; a bind failure commits nothing
  async disableLinking(actor: Actor): Promise<void>;                        // commits machine.linking_disabled, then stops the listener
  machines(): Machine[];  peerFor(machineId: string): Peer;  peerCheck: PeerCheck;   // from the machines projection
  async hello(machineId: string): Promise<boolean>;                         // GET /link/v1/hello, 3 s timeout; caches { online, checkedAt } 15 s
  presence(): MachinePresence[];
  async shutdown(): Promise<void>;
}
// protocol-routes.ts
export type LinkProtocolDeps = { link: LinkService };   // grows in Tasks 4, 6 and 7 (pairing, capacity, runs)
export function registerLinkProtocolRoutes(app: FastifyInstance, deps: LinkProtocolDeps): void;
GET /link/v1/hello → helloResponse (paired peers only)
```
Listener rules: on `secureConnection`, read the client certificate; no certificate, or a key `peer()` does not know, while `pairingOpen()` is false → `socket.destroy()` before any bytes are read; while a window is open, unknown keys are kept for the pairing route only. `onRequest` hook: `request.linkPeer = peer(spki)`; a request without a peer to any path but `/link/v1/pair` → 403 `{ error: "unknown_machine" }` and the socket is destroyed after the reply. `setErrorHandler` mirrors `routes.ts`'s map (plus the link errors added by later tasks) and never echoes input. Body limit 64 KiB for JSON routes (bundle routes set their own in Task 7). The listener's Fastify has no cookie plugin, no `registerAuth`, no static UI, no websocket.
Client rules: `https.request` with `{ key, cert, rejectUnauthorized: false, servername: undefined, checkServerIdentity: () => undefined }`; on `secureConnect`, `new X509Certificate(socket.getPeerCertificate(true).raw).publicKey.export(spki der)` must equal `peer.publicKeyDer`, else the socket is destroyed and `MachineKeyMismatchError` is thrown before the request body is written. Every request carries `accept: application/json` and, for JSON, `content-type: application/json`. Responses are capped at 1 MiB for JSON. `peer.address` is parsed with `machineAddressSchema`.
`server.ts`: `createServer` gains `linkBind?: string` (tests pass `"127.0.0.1"`; the default is `"0.0.0.0"`), constructs `LinkService` after `connections.load()`, awaits `link.load()`, and calls `link.shutdown()` in `close()` before the runner's shutdown and on every start-failure path. `/api/status.connections` is unchanged; Task 4 adds the status fields.

- [ ] **Step 1: Write failing tests:**
  - listener (two identities over memory stores, `bind: "127.0.0.1"`): a client whose key `peer()` knows gets `GET /link/v1/hello` → the hello body with the server's `machineId` and `name`; **(Review Focus 1)** a client with a third, unknown identity: the socket closes without a response (`pairingOpen` false); with `pairingOpen` true the same client gets 403 `unknown_machine` on `/link/v1/hello`; a plain `fetch("http://127.0.0.1:<port>/link/v1/hello")` (no TLS) fails; a TLS client with no certificate is destroyed; the port scan: with the first port taken, `start()` binds the next and returns it;
  - client: `request` against the listener with the right pinned key succeeds; with a wrong `publicKeyDer` → `MachineKeyMismatchError` and the server logs no request (assert via a route counter); against a closed port → `MachineUnreachableError` with the `machineId`; a 404 JSON `{ error: "not_found" }` → `RemoteRefusedError` with `status 404`, `code "not_found"`; `stream` delivers three NDJSON lines in order and resolves when the server ends; a server that destroys the socket mid-stream → `MachineUnreachableError`; `download` past `maxBytes` → `RemoteRefusedError(413)` and the partial file removed;
  - service: `load()` with an empty store commits exactly one `machine.identity_created`; `self().name` is `Mac` on `platform: "darwin"`, `Windows PC` on `win32`; `enableLinking(owner, LINKING_ACK)` starts the listener (hello answers) and commits `machine.linking_enabled { port }` with the bound port; a wrong sentence → ZodError and no listener; actor `{ kind: "system", id: "x" }` → `HumanRequiredError`; `disableLinking` commits and the port stops answering; a new service over the same db and store starts the listener on `load()` (opt-in persists) **(Global Constraints)**; a store failing on `get` → `identityState() === "unavailable"`, `self()` null, `enableLinking` → `IdentityUnavailableError`, no listener;
  - server: `createServer({ …, linkBind: "127.0.0.1" })` starts and `GET /api/health` answers on loopback as before; before the opt-in a TCP connection to `127.0.0.1:LINK_DEFAULT_PORT` is refused; after `POST /api/link/enable` (Task 4) it is accepted and the workspace server's own address is still `127.0.0.1`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test link server`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(link): mutual-TLS link listener and pinned client; linking opt-in recorded in the ledger`

---

### Task 4: Pairing, discovery and the Machines view

**Files:** Create `packages/core/src/link/pairing.ts`, `discovery.ts`, `packages/core/src/server/link-routes.ts`, `apps/ui/src/views/MachinesSideBar.tsx`, `LinkMachinePanel.tsx`. Modify `packages/core/src/link/{service,protocol-routes,client}.ts`, `server/{server,routes,connection-routes}.ts`, `packages/core/package.json` (`bonjour-service` 1.4.4, exact), `apps/ui/src/shell/{views.ts,SideBar,Dock,Workbench,StatusBar,model}.tsx`, `apps/ui/src/api.ts`, `App.tsx`. Tests `packages/core/test/link/{pairing,discovery,service}.test.ts`, `packages/core/test/server/link-routes.test.ts`, `apps/ui/test/{MachinesSideBar,LinkMachinePanel,StatusBar}.test.tsx`.

**Interfaces:**
```ts
// link/pairing.ts
export function pairingProof(secret: Uint8Array, label: "theterminal-pair-v1" | "theterminal-pair-ack-v1", ekm: Buffer, spkiDer: Buffer): string;  // HMAC-SHA256 hex, key = secret, data = label ‖ ekm ‖ spki
export class PairingWindow {
  constructor(deps: { fingerprint: string; now?: () => Date; random?: (n: number) => Uint8Array });
  open(): { code: string; expiresAt: string };                 // replaces any earlier window
  isOpen(): boolean;  cancel(): void;
  verify(proof: string, ekm: Buffer, peerSpki: Buffer): "ok" | "rejected" | "none";   // "ok" consumes the window; "rejected" counts an attempt and cancels at PAIRING_MAX_ATTEMPTS; expired → "none"; constant-time compare
  secret(): Uint8Array | null;                                  // for the ack proof after "ok" (cleared after use)
}
// link/discovery.ts
export type Discovered = { machineId: string; name: string; address: string; seenAt: string };
export interface Discovery { publish(info: { machineId: string; name: string; port: number }): void; unpublish(): void; browse(onChange: (list: Discovered[]) => void): () => void; destroy(): void }
export function mdnsDiscovery(): Discovery;       // bonjour-service: type "theterminal", txt { id, name, v: "1" }, instance name `TheTerminal ${machineId.slice(0, 8)}`; browse maps service.referer.address + port; ignores records whose txt.id is not MACHINE_ID or txt.v !== "1"
export function fakeDiscovery(): Discovery;       // one in-process registry (module-level Map) so two servers in one process see each other
export function selectDiscovery(env: NodeJS.ProcessEnv, injected?: Discovery): Discovery;  // fake only under THETERMINAL_FAKE_AGENT=1 with THETERMINAL_FAKE_DISCOVERY=1
// link/service.ts (added)
export class PairingCodeMismatchError extends Error {}   // "the code does not match that machine"
export class PairingRejectedError extends Error {}       // "the other machine rejected the code"
export class NoPairingError extends Error {}             // "that machine is not showing a code"
class LinkService { …   // constructor deps gain: discovery: Discovery; interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> (default os.networkInterfaces)
  showCode(): { code: string; expiresAt: string; addresses: string[] };   // LinkingDisabledError when the listener is down; addresses = non-internal IPv4 of interfaces() as host:port
  cancelCode(): void;
  async pair(actor: Actor, address: string, code: string): Promise<Machine>;   // entering side, below
  async unpair(actor: Actor, machineId: string): Promise<void>;                // commits machine.unpaired (NotFoundError)
  discovered(): Discovered[];                                                   // starts browsing on first call, stops 60 s after the last
}
// protocol-routes.ts (added)
POST /link/v1/pair  pairRequest → 200 pairResponse | 404 no_pairing | 403 pairing_rejected
// server/link-routes.ts (behind registerAuth)
GET    /api/link              → { identity: "ok" | "unavailable", self, machines: MachinePresence[], discovered: Discovered[] }
POST   /api/link/name         { name } → self
POST   /api/link/enable       { acknowledgement } → self        | POST /api/link/disable → self
POST   /api/link/code         → { code, expiresAt, addresses }  | DELETE /api/link/code → 204
POST   /api/link/pair         { address, code } → 201 Machine
DELETE /api/link/machines/:id → 204
```
Entering side (`pair`): `parsePairingCode` (null → ZodError at `["code"]`); `LinkClient.connectUnpinned(identity, address)` → `fingerprintOf(peerSpki).startsWith(fingerprintPrefix)` else destroy and `PairingCodeMismatchError` (nothing sent); over that socket, `POST /link/v1/pair` with `{ v: 1, machineId: self, name: self.name, port: listener port or LINK_DEFAULT_PORT, proof: pairingProof(secret, "theterminal-pair-v1", socket.exportKeyingMaterial(32, PAIRING_LABEL), own SPKI) }`; 404 → `NoPairingError`; 403 → `PairingRejectedError`; 200 → check `pairingProof(secret, "theterminal-pair-ack-v1", ekm, peerSpki) === body.proof` else `PairingRejectedError`; commit `machine.paired { machineId: body.machineId (must equal machineIdOf(peerSpki)), name: body.name, publicKey, fingerprint, address: "<host of address>:<body.port>", role: "entered_code" }`. Showing side (route): no window → 404; `verify(body.proof, socket EKM, client SPKI)`: `rejected` → 403 (and the window cancels itself at five); `ok` → commit `machine.paired { …, address: "<socket.remoteAddress>:<body.port>", role: "showed_code" }`, reply with the ack proof, then the pinned-peer set includes the new key for the rest of the connection and after. Both sides refuse to pair with themselves (`machineId === self` → 400 `self_pairing`).
`discovery` lifecycle: `publish` when the listener starts (and on `setName`), `unpublish` when it stops. `/api/status` gains `machines: { linked: number; online: number }`.
Errors (`routes.ts`): `LinkingDisabledError` → 409 `linking_disabled`; `IdentityUnavailableError` → 503 `identity_unavailable`; `PairingCodeMismatchError` → 400 `pairing_code_mismatch`; `PairingRejectedError` → 403 `pairing_rejected`; `NoPairingError` → 404 `no_pairing`; `MachineUnreachableError` → 502 `machine_unreachable`; `MachineKeyMismatchError` → 409 `machine_key_mismatch`.
UI: `VIEWS` gains `machines` (label `Machines`, after `capacity`). `MachinesSideBar`: section `This computer`: `<name>` with a `Rename` button (input ≤ 40, help `Pick a short name such as "Mac" or "GPU desktop". It is recorded in the ledger of every machine you link.`), `Fingerprint <first 16 hex in groups of 4>`, a switch `role="switch"` `aria-label="Allow linking"`; turning it on opens a dialog with `LINKING_ACK` verbatim and a checkbox `I have read this` before `Allow`; when on: `Linking on · port <n>`. Section `Linked machines`: a row per machine (`name`, dot `online`/`offline`/`not checked`, `Unlink` with confirm); empty → `No machines linked yet.` Button `Link a machine` opens dock panel `link_machine` (title `Link a machine`, main). `identity: "unavailable"` → the whole side bar shows `Your keychain is unavailable, so this computer has no identity for linking.` `LinkMachinePanel`: two tabs. `Show a code`: `Linking must be on` note with a button when off; else the code in large type with `aria-label="Pairing code"`, `Expires in <m:ss>`, `If the other computer does not find this one, enter one of these addresses there:` list, `Cancel`. `Enter a code`: `Machines found on your network` (`role="listbox"`, each `name · address`, clicking fills the address), input `Address` (placeholder `192.168.1.10:4418`), input `Code` (placeholder `XXXXX-XXXXX-XXXXX-XXXXX`, upper-cases as typed), button `Link`; results `Linked "<name>"` or the mapped error: `pairing_code_mismatch` → `That code was not shown by the machine at this address`; `pairing_rejected` → `The other machine rejected the code`; `no_pairing` → `That machine is not showing a code right now`; `machine_unreachable` → `Could not reach that address`; `linking_disabled` → `Turn on linking first (Machines view)`. Status bar: `Machines: <linked> linked` with `, <online> online` when linked > 0 (clicking selects Machines).

- [ ] **Step 1: Write failing tests:**
  - pairing: `open()` returns a code whose parsed prefix is the first 16 hex of the fingerprint; `verify` with the right proof → `ok` and then `none`; **(Review Focus 1)** four wrong proofs → `rejected` with the window still open, the fifth → `rejected` and `isOpen()` false; an expired window (`now` advanced 601 s) → `none`; `pairingProof` is deterministic and differs when the EKM differs;
  - discovery: `fakeDiscovery` publish/browse across two instances; `selectDiscovery` returns the fake only under both flags; `mdnsDiscovery` is constructed with the exact `type`, `txt` and instance name (inject the Bonjour constructor; no multicast in CI);
  - service (two services in one process over memory stores, both `bind: "127.0.0.1"`, fake discovery): S `enableLinking` → `showCode()`; E `pair(owner, "127.0.0.1:<S port>", code)` → both ledgers hold one `machine.paired` with each other's `machineId`, `publicKey` and `fingerprint`, roles `entered_code`/`showed_code`, no key material beyond the public key in `JSON.stringify(ledger.list())`; afterwards E `hello(S.id)` is true; E with a code whose fingerprint prefix is wrong → `PairingCodeMismatchError` and S's window still open with zero attempts (nothing was sent); E with the right prefix and a wrong secret → `PairingRejectedError` and S's attempts 1; `pair` against E's own address → 400 `self_pairing`; S `discovered()` lists E after E enables linking; `unpair` removes the row and E's next `hello` on S is refused (403 `unknown_machine` → `RemoteRefusedError`);
  - routes: every row; each error's status and code; without the cookie → 401; `/api/status.machines` counts;
  - UI: the side bar renders the fingerprint groups and the switch; the dialog shows the exact sentence and posts `/api/link/enable` only after the checkbox; the panel's `Enter a code` posts `{ address, code }` and shows `Linked "GPU box"`; each error copy; the status bar string.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `bonjour-service` 1.4.4 exactly; if `pnpm install` reports an ignored build script for it or a dependency, add `false` with a one-line reason under `allowBuilds`. Check the lockfile with `--frozen-lockfile` on both CI runners.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(link): pair machines with a one-time code over the local network; mDNS discovery; Machines view`

---

### Task 5: Local models: detection, connection, tester, and runs through Codex

**Files:** Create `packages/core/src/capacity/local-models.ts`. Modify `packages/core/src/connections/{service,testers}.ts`, `agents/{child-env,adapter,runner}.ts`, `agents/codex/adapter.ts`, `capacity/report.ts`, `server/{capacity-routes,server,routes}.ts`, `packages/core/test/fixtures/fake-codex.mjs`, `apps/ui/src/views/{ConnectionEditor,CapacitySideBar,CapacityPanel}.tsx`, `apps/ui/src/components/{StartRunForm,LedgerPanel}.tsx`. Tests `packages/core/test/capacity/{local-models,report}.test.ts`, `packages/core/test/connections/{service,testers}.test.ts`, `packages/core/test/agents/{child-env,runner,codex-adapter}.test.ts`, `packages/core/test/server/{agent-routes,capacity-routes}.test.ts`, `apps/ui/test/{ConnectionEditor,CapacitySideBar,StartRunForm}.test.tsx`.

**Interfaces:**
```ts
// capacity/local-models.ts
export const OLLAMA_URL = "http://127.0.0.1:11434", LLAMACPP_URL = "http://127.0.0.1:8080";
export const LOCAL_MODEL_ENV_ALLOWLIST: readonly string[] = ["LOCAL_MODEL_API_KEY"];
export function isLoopbackUrl(url: string): boolean;   // http: and host 127.0.0.1 | localhost | [::1]; no userinfo
export async function detectLocalEngines(deps: { fetch: typeof fetch; now?: () => Date; timeoutMs?: number /* 2000 */ }): Promise<LocalEngine[]>;
// ollama: GET /api/version → { version }; GET /api/tags → { models: [{ name, size, details: { parameter_size, quantization_level } }] } → engine "ollama", baseUrl OLLAMA_URL + "/v1"
// llamacpp: GET /health → 200; GET /v1/models → { data: [{ id }] } → engine "llamacpp", baseUrl LLAMACPP_URL + "/v1"; a failing probe omits that engine; never throws
export const localModelTester: ConnectionTester;      // GET <baseUrl>/models (Authorization: Bearer <apiKey> when stored) → 200 and config.model ∈ data[].id → "Connected (model available)"; 200 without it → { ok: false, message: `Model ${model} is not installed on this server` }; network error → "Could not reach the local model server"; non-2xx → 5A's "Unexpected response (HTTP <status>)"
// connections/service.ts
export type LocalModelSource = { connectionId: string; name: string; baseUrl: string; model: string; wireApi: "chat" | "responses"; apiKey?: string };
export type RunSelection = { cloud: CloudSource[]; mcp: McpServerSpec[]; localModel: LocalModelSource | null };   // more than one local_model id → ZodError at ["connectionIds"]
// agents/adapter.ts
export type RunCredentials = { …; localModel?: LocalModelSource };
// agents/runner.ts
export class LocalModelUnsupportedError extends Error {}   // "Only Codex can run on a local model in The Terminal yet"
// agents/child-env.ts: extraEnv keys must be in CLOUD_ENV_ALLOWLIST ∪ LOCAL_MODEL_ENV_ALLOWLIST
```
Service rules: `baseUrl` must satisfy `isLoopbackUrl` (ZodError at `["config", "baseUrl"]`, message `Only this computer's own address is allowed`); `wireApi` defaults to `responses` when absent (the bundled Codex refuses `chat`; a `chat` connection is refused when the run starts); `credentialsFor()` ignores `local_model`; `selectForRun` accepts `local_model` ids (kind `llm` is otherwise still refused) and fills `localModel` (the `apiKey` from the cache). Runner: `localModel` with any adapter but `codex` → `LocalModelUnsupportedError` (before `mintCloud`); with Codex, `authMode` recorded as `"none"`, no `connection.used` for the Codex llm connection, one `connection.used { purpose: "local_model" }` for the local-model connection, `credentials.localModel` set, `credentials.env.LOCAL_MODEL_API_KEY` set when the connection has a key (also joins the session's secrets). Codex adapter: `authMode === "none"` is accepted only with `credentials.localModel` (else the existing unsupported-mode error); no API key is read or required; `thread/start.config` gains `model: localModel.model`, `model_provider: "theterminal_local"`, `"model_providers.theterminal_local.name": "Local model"`, `"model_providers.theterminal_local.base_url": localModel.baseUrl`, `"model_providers.theterminal_local.wire_api": localModel.wireApi`, `"model_providers.theterminal_local.requires_openai_auth": false`, and `"model_providers.theterminal_local.env_key": "LOCAL_MODEL_API_KEY"` only when a key is set; `cli_auth_credentials_store=ephemeral` is not passed (there is no login). **Verify against the bundled Codex 0.169.0 before implementing** (record the findings in the adapter comment): that `thread/start` accepts these dotted keys (its binary carries `model_provider`, `model_providers`, `base_url`, `wire_api`, `env_key`, `requires_openai_auth`), that a provider without `env_key` and with `requires_openai_auth = false` starts a thread without any login, and which keys disable its update check and telemetry (`check_for_update_on_startup`, `analytics`, `otel` appear in the binary): set the ones that exist to off for every Codex thread, so an offline run makes no call beyond the model server. The fake Codex (`fake-codex.mjs`) logs `thread/start` params to `THETERMINAL_FAKE_LOG` and, when the config names `model_provider`, answers as before.
Capacity: `GET /api/capacity` gains `localModels` from `detectLocalEngines` (cached 30 s; `POST /api/capacity/detect` refreshes it too). `createServer` gains `localEngines?: () => Promise<LocalEngine[]>`; `selectLocalEngines(env, injected)` returns the injected one, else under `THETERMINAL_FAKE_AGENT=1` with `THETERMINAL_FAKE_HTTP=1` a detector over the fake HTTP, else `() => detectLocalEngines({ fetch: globalThis.fetch })` (the plain fetch: loopback probes are never wrapped by Task 9's observer and never routed through a proxy). The fake HTTP answers `OLLAMA_URL/api/version` → `{ version: "0.0.0-fake" }`, `OLLAMA_URL/api/tags` → one model `fake-coder:7b` (size 4 GiB, `7B`, `Q4_K_M`), anything on `LLAMACPP_URL` → a rejection with `code: "ECONNREFUSED"`, and `GET <any loopback host>/v1/models` → `{ data: [{ id: "fake-coder:7b" }] }` (so the tester and the detector agree under test).
Routes: `LocalModelUnsupportedError` → 400 `local_model_unsupported`. `describeEntry`/narration for `connection.used` with `purpose: "local_model"` → `Agent <id8> was given the local model "<name>"`.
UI: the connection editor for `local_model` shows a `Detected on this computer` list (engine, version, models) from `/api/capacity`, with a `Use` button per model that fills `baseUrl` and `model`; `CapacitySideBar` section `Local models`: `<engine> <version> · <n> models` lines or `No local model server detected. Install Ollama or llama.cpp server and detect again.`; `CapacityPanel` gains a table `Local models` (`Engine`, `Model`, `Size`, `Parameters`, `Quantization`). `StartRunForm`'s picker lists enabled `local_model` connections under `Run on a local model`; choosing one with an adapter other than Codex disables the box with `Only Codex can run on a local model in The Terminal yet.`; `errorMessage(local_model_unsupported)` is that sentence.

- [ ] **Step 1: Write failing tests:**
  - local-models: a fetch answering the Ollama and llama.cpp fixtures → two engines with the exact `baseUrl`s and models; a fetch rejecting for `:8080` → only `ollama`; both rejecting → `[]` and no throw; `isLoopbackUrl` accepts the three hosts, rejects `http://192.168.1.5:11434/v1`, `http://user@127.0.0.1/`, `https://localhost/`; tester: the three messages **(Review Focus 5)**; the key goes in the header, never the URL;
  - service: `baseUrl: "http://192.168.1.5:11434/v1"` → ZodError at `["config", "baseUrl"]`; `selectForRun([localId])` → `localModel` with `wireApi: "responses"` by default (a `chat` connection is refused when the run starts); two local ids → ZodError; `[claudeId]` still `UnsupportedConnectionError`;
  - child-env: `extraEnv: { LOCAL_MODEL_API_KEY: "TESTKEY-local-000000" }` admitted; `{ LOCAL_MODEL_KEY: "x" }` → TypeError;
  - runner: `adapter: "claude"` with a local model → `LocalModelUnsupportedError` before `mintCloud`; `adapter: "codex"` → `agent.started.authMode === "none"`, `connection.used { purpose: "local_model" }`, `credentials.localModel` set, `credentials.env.LOCAL_MODEL_API_KEY` present when stored and the key redacted from a message that echoes it;
  - codex adapter (fake CLI, log file): the `thread/start` config carries the seven keys above with the fixture's values, `env_key` only with a key; `childEnv` has no `OPENAI_API_KEY`/`CODEX_API_KEY` **(Review Focus 5)**; args carry no `cli_auth_credentials_store`; `authMode: "none"` without `localModel` → the unsupported-mode error; a `baseUrl` where nothing listens with a real `codex` is not tested in CI: the fake exits 1 with `connection refused` and the run fails with that text within the adapter's start timeout;
  - report and routes: `GET /api/capacity.localModels` under the fake flags has `fake-coder:7b`; `POST /api/capacity/detect` refreshes; `POST …/runs` with a local-model id and `adapter: "gemini"` → 400 `local_model_unsupported`;
  - UI: the editor's `Use` fills the two fields; the Capacity lines; the disabled box copy; `describeEntry` string.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS. Then, by hand on a machine with Ollama (not CI): add a `local_model` connection for a pulled model, `Test connection` → `Connected (model available)`, start a Codex run with it and confirm in the ledger that `authMode` is `none` and the run completes; record the Codex findings in the adapter comment.
- [ ] **Step 5: Commit:** `feat(capacity): local models through Ollama or llama.cpp as a connection; Codex runs on them`

---

### Task 6: Capacity across machines

**Files:** Modify `packages/core/src/link/{protocol-routes,service}.ts`, `connections/service.ts`, `capacity/report.ts`, `server/{capacity-routes,link-routes}.ts`, `apps/ui/src/views/{CapacitySideBar,CapacityPanel,MachinesSideBar}.tsx`, `apps/ui/src/api.ts`. Tests `packages/core/test/link/{protocol-routes,service}.test.ts`, `packages/core/test/capacity/report.test.ts`, `packages/core/test/server/capacity-routes.test.ts`, `apps/ui/test/{CapacityPanel,MachinesSideBar}.test.tsx`.

**Interfaces:**
```ts
// connections/service.ts
publicConnections(): { id: string; kind: ConnectionKind; provider: ConnectionProvider; name: string }[];   // enabled connections of kind llm (provider local_model only), cloud and mcp: what a remote requester may name; never config, private, secret fields or status
// link/service.ts
async capacityOf(machineId: string): Promise<MachineCapacity>;   // GET /link/v1/capacity validated by machineCapacitySchema; cached 30 s; a key mismatch is never reported as offline: it answers 409 `machine_key_mismatch` and the Machines view shows a distinct warning (`This machine's key changed — unlink and pair again`); unreachable, refused or an unreadable reply → { online: false, checkedAt, hardware: null, localModels: [], sources: [], adapters: [], connections: [] } using the last good values when there are any (the fetched values are kept in memory only)
// protocol-routes.ts (LinkProtocolDeps gains capacity: () => CapacityReport, adapters: () => AdapterId[], connections: ConnectionService)
GET /link/v1/capacity → Omit<MachineCapacity, "machineId" | "name" | "online" | "checkedAt"> for this machine (paired peers only)
// capacity/report.ts
export function capacityReport(db, deps: { …; localModels: () => LocalEngine[]; machines: () => MachineCapacity[] }): CapacityReport;
// link-routes.ts
GET /api/link/machines/:id/capacity → MachineCapacity (fresh, bypassing the cache)
```
Rules: the worker's capacity body is built from `capacityReport` (its own `sources`, `hardware`, `localModels`), the registered `adapters` whose program is available, and `publicConnections()`; a test asserts that `JSON.stringify(body)` contains no secret value of any connection and none of the strings `apiKey`, `secret`, `token`, `cliHome`, `headers`, `env` as keys. The requester's `GET /api/capacity` fills `machines` by calling `capacityOf` for every paired machine in parallel with a 3 s timeout each. UI: `CapacitySideBar` gains a section per machine `<name> · online|offline` with `cpu · memory · gpu` and `<n> local models`; `CapacityPanel` gains a `Machines` table (`Machine`, `State`, `CPU`, `Memory`, `GPU`, `Local models`, `Checked`) where `offline` rows show the last known values greyed with `last seen <time>`; `MachinesSideBar` rows show the one-line hardware summary.

- [ ] **Step 1: Write failing tests:**
  - protocol route (two paired services): the body validates against `machineCapacitySchema`; **(Review Focus 3)** with an AWS, an MCP (headers `Authorization=Bearer TESTKEY-hdr-0000000000`) and a local-model connection with a key on the worker, `JSON.stringify(body)` contains `TESTKEY` nowhere, lists the three ids with kinds and names, and omits the Claude connection; an unpaired client → destroyed/403;
  - service: `capacityOf` caches for 30 s (one request for two calls); the worker's listener stopped → `online: false` with the previous `hardware` kept and `checkedAt` updated;
  - report: `machines` from the injected list; routes: `GET /api/capacity.machines[0].name === "GPU box"`; `GET /api/link/machines/:id/capacity` for an unknown id → 404; without auth → 401;
  - UI: the panel's `Machines` table rows and the greyed offline row with `last seen`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(capacity): linked machines' hardware, local models and connections in the Capacity view`

---

### Task 7: Remote runs, worker side: repo import, start, signed event stream, decisions, snapshot export

**Files:** Create `packages/core/src/link/bundles.ts`, `mirror.ts`. Modify `packages/core/src/link/{protocol-routes,service}.ts`, `agents/runner.ts`, `agents/worktrees.ts`, `server/routes.ts`. Tests `packages/core/test/link/{bundles,mirror,protocol-routes}.test.ts`, `packages/core/test/agents/runner.test.ts`.

**Interfaces:**
```ts
// link/bundles.ts
export const MAX_BUNDLE_BYTES = 268_435_456;
export class BundleInvalidError extends Error {}   // "the repository bundle is not valid"
// RunActiveError and WorktreeMissingError are Plan 4's (override/service.ts, changes/changes.ts); the worktree of a run is Plan 4's runWorktree(deps, runId).abs
export async function exportRepoBundle(wt: WorktreeManager, projectId: string, file: string): Promise<void>;       // runGit(repoPath, ["bundle", "create", file, "HEAD", "<the checked-out branch>"]) (not `--all`: only HEAD and the branch checked out cross)
export async function importRepoBundle(wt: WorktreeManager, projectId: string, file: string): Promise<void>;       // ensureProjectRepo; runGit(repo, ["bundle", "verify", file]) else BundleInvalidError; runGit(repo, ["fetch", "--update-head-ok", file, "+refs/heads/*:refs/heads/*"]) (the repo's own branch is checked out, so plain fetch would refuse); the bundle's HEAD branch (["bundle", "list-heads", file], the ref HEAD points at) becomes the checked-out branch: ["symbolic-ref", "HEAD", "refs/heads/<name>"] then ["reset", "--hard"]; the bundle file is deleted afterwards in every case
export async function snapshotBundle(wt: WorktreeManager, worktreeAbs: string, runId: string, file: string): Promise<string>;  // temp index via env GIT_INDEX_FILE=<worktree>/.git-tt-index (removed after): ["add", "-A", "--", "."], tree = ["write-tree"], commit = ["commit-tree", tree, "-p", "HEAD", "-m", "The Terminal snapshot of run <runId>"] with GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_* set to "The Terminal" / "theterminal@localhost"; ["update-ref", `refs/theterminal/snapshot/${runId}`, commit]; ["bundle", "create", file, `refs/theterminal/snapshot/${runId}`]; returns the commit id
// worktrees.ts: Plan 4's runGit(cwd, args, opts) gains opts.env?: Record<string, string>, merged over gitEnv for that one call (GIT_INDEX_FILE, GIT_AUTHOR_*, GIT_COMMITTER_* here); nothing else may set GIT_* variables
export async function importSnapshot(wt: WorktreeManager, projectId: string, runId: string, file: string): Promise<{ commit: string; absPath: string; relPath: string }>;  // verify; fetch `+refs/theterminal/snapshot/<runId>:refs/theterminal/snapshot/<runId>` into the project repo; ["branch", `run/${runId}`, commit] (NotFound/exists → reuse); ["worktree", "add", absPath, `run/${runId}`] at join(dataDir, "projects", projectId, "worktrees", runId); relPath as createRunWorktree
// link/mirror.ts
export type MirrorFrame = z.infer<typeof mirrorFrameSchema>;
export function signFrame(identity: LinkIdentity, entry: LedgerEntry): MirrorFrame;    // origin = the entry's nine fields; signature = identity.sign(Buffer.from(canonicalJson(origin)))
export function verifyFrame(publicKeyDer: Buffer, frame: MirrorFrame): boolean;        // verifySignature over the same canonical JSON
export function mirrorable(entry: LedgerEntry, runId: string): boolean;                // type ∈ MIRRORABLE_TYPES and payload.runId === runId
// agents/runner.ts
start(actor, input: { …; runId?: string })   // must match /^[A-Za-z0-9_-]{1,100}$/ and not exist in agent_runs (ConflictError); default newId()
// protocol-routes.ts (paired peers only; :runId validated as above; LinkProtocolDeps gains runner, worktrees, changes: ChangesDeps, dataDir)
POST /link/v1/runs/:runId/repo        (application/octet-stream; a content-type parser streams the body to <dataDir>/link/incoming/<runId>.bundle and counts bytes; past MAX_BUNDLE_BYTES the file is removed and the reply is 413) → 204   | 413 repo_too_large | 400 bundle_invalid
POST /link/v1/runs/:runId/start       remoteStart → 201 AgentRun   | 404 not_found (an unknown connection id) | 400 connection_disabled / connection_unsupported / mcp_unsupported / local_model_unsupported | 409 conflict (runId exists) | 502 cloud_credentials_failed | 409 no_repo (repo not uploaded first)
GET  /link/v1/runs/:runId/events?afterSeq=N   → NDJSON of MirrorFrame (ledger entries with seq > N and mirrorable(entry, runId), in order, then live; ends after agent.finished; 404 for a run this machine did not accept)
POST /link/v1/runs/:runId/actions/:actionId/decision  remoteDecision → AgentAction  | 409 already_decided | 404
POST /link/v1/runs/:runId/stop        → AgentRun
GET  /link/v1/runs/:runId/changes     → application/octet-stream (the snapshot bundle) | 409 run_active while running | 404 worktree_missing
```
Worker flow (`LinkService.acceptRun(peer, runId, body)`): the repo must have been uploaded to `<dataDir>/link/incoming/<runId>.bundle` (else 409 `no_repo`; at most 4 uploads and 1 GiB waiting per paired machine, else `upload_limit`; an upload with no owner record, or older than 1 hour, is discarded, and `link/incoming` is swept at startup); `importRepoBundle` first (a `BundleInvalidError` → 400 and nothing recorded); then one `commitEvents` holding, in order, `project.created { projectId, name: projectName, pitch: "" }` and `link.project_received { projectId, machineId: peer, name }` when no `projects` row exists for `body.projectId`, and always `link.run_accepted { runId, machineId, projectId }`; then `runner.start({ kind: "human", id: "owner" }, { projectId, adapter, prompt, cardId, connectionIds, runId })` (the actor is the Owner: the human who asked, through the requester; the preceding `link.run_accepted` names the machine). A `runner.start` that throws leaves `link.run_accepted` in place and answers the mapped error; the requester records `link.run_failed`. The runner's own errors map through the listener's error handler with the same codes as the workspace routes. Decisions: commit `link.decision_received { runId, actionId, machineId, decision }`, then `runner.decide(owner, actionId, decision, reason)`; a decision for an action whose run was not accepted from this peer → 404. The event stream subscribes to `ledger.onAppend` first and replays `ledger.list({ afterSeq })` pages (as `events-ws.ts` does), filters with `mirrorable`, writes `JSON.stringify(signFrame(identity, e)) + "\n"`, and ends the response after writing the frame of `agent.finished`. `changes`: `RunActiveError` while `status === "running"`; the snapshot bundle is written to `<dataDir>/link/outgoing/<runId>.bundle` and streamed, then deleted; a worktree that no longer exists → 404 `worktree_missing`. Every run id in a path is checked against the runner's id pattern before any file path is built.

- [ ] **Step 1: Write failing tests:**
  - bundles (temp data dirs, real git): `exportRepoBundle` of a repo with two commits → `importRepoBundle` into a second data dir reproduces `rev-parse HEAD` and the checked-out branch name; importing again over an existing repo (whose branch is checked out) succeeds; **(Review Focus 3)** `git clone` of the exported bundle into a temp dir contains neither `token` nor `ledger.db` although both exist in the source data dir; a bundle file holding `not a bundle` → `BundleInvalidError` and the project repo untouched; `snapshotBundle` of a worktree with a modified tracked file and an untracked file → `importSnapshot` elsewhere yields a worktree whose `git status --porcelain` is empty and both files present with the new content, and the worktree's branch is `run/<runId>`; the temporary index file is gone; `git log -1 --format=%an` on the snapshot is `The Terminal`;
  - mirror: `signFrame` → `verifyFrame` true with the identity's key, false with another's or after changing `origin.payload`; `mirrorable` for each listed type with the run's id, false for `card.moved` and for another `runId`;
  - runner: `start` with `runId: "run-remote-1"` records that id; the same id twice → `ConflictError`; `runId: "../x"` → ZodError;
  - protocol routes (requester identity paired with the worker; fake adapter on the worker): upload a bundle then `start` → 201 with `id === runId`, the worker's ledger holds `project.created`, `link.project_received`, `link.run_accepted` with consecutive `seq` values (one transaction), then `agent.started`; a second run for the same project records only `link.run_accepted`; `start` before `repo` → 409 `no_repo`; a body of `MAX_BUNDLE_BYTES + 1` zero bytes → 413 and no file left under `link/incoming`; **(Review Focus 3)** `connectionIds: ["<an id that exists only on the requester>"]` → 404 `not_found` and no `connection.used`; the events stream from `afterSeq=0` yields frames in `seq` order whose types are exactly the run's `agent.*` entries, every frame verifies with the worker's key, and the response ends after `agent.finished`; a stream for a run id the worker never accepted → 404; `decision` on the pending fake shell step → the worker's ledger has `link.decision_received` then `agent.action.decided { by: "human" }`, and the stream carries the latter but not the former; `changes` while running → 409 `run_active`; after completion → a bundle that `importSnapshot` accepts on the requester's data dir; an unpaired client → destroyed.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(link): accept runs from a paired machine: import the repository, run behind the gate, stream signed ledger entries, export the snapshot`

---

### Task 8: Remote runs, requester side: request, mirror, decide, stop, resume, import; Run on picker

**Files:** Create `packages/core/src/link/remote-runs.ts`. Modify `packages/core/src/events/projections.ts`, `agents/runner.ts`, `server/{agent-routes,link-routes,routes,server}.ts`, `apps/ui/src/components/{StartRunForm,LedgerPanel}.tsx`, `apps/ui/src/shell/model.ts`, `apps/ui/src/api.ts`, `App.tsx`. Tests `packages/core/test/link/remote-runs.test.ts`, `packages/core/test/events/projections.test.ts`, `packages/core/test/server/{agent-routes,link-routes}.test.ts`, `apps/ui/test/{StartRunForm,LedgerPanel}.test.tsx`.

**Interfaces:**
```ts
// events/projections.ts
export function applyMirrored(db: Db, e: LedgerEntry): void;   // inner = payload.origin as LedgerEntry (its own ts, seq and actor); applyEvent(db, inner) when inner.type ∈ MIRRORABLE_TYPES; after an inner agent.started: UPDATE agent_runs SET machine_id = payload.machineId WHERE id = runId; UPDATE link_runs SET last_seq = inner.seq, state = 'running' | 'finished' (on agent.finished), updated_at = e.ts
export function mirroredIds(db: Db, runId: string): Set<string>;   // origin ids already mirrored for a run (from the ledger: SELECT json_extract(payload, '$.origin.id') … WHERE type = 'link.mirrored' AND json_extract(payload, '$.origin.payload.runId') = ?)
// link/remote-runs.ts
export class RemoteRunService {
  constructor(deps: { db: Db; ledger: Ledger; link: LinkService; client: LinkClient; worktrees: WorktreeManager; dataDir: string; identity: () => LinkIdentity | null; backoffMs?: number[] /* [1000, 2000, 4000, 8000, 16000, 30000] */; now?: () => Date });
  async start(actor: Actor, input: { projectId: string; machineId: string; adapter: AdapterId; prompt: string; cardId?: string | null; connectionIds?: string[] }): Promise<AgentRun>;
  async decide(actor: Actor, run: AgentRun, actionId: string, decision: "allow" | "deny", reason: string): Promise<AgentAction>;
  async stop(actor: Actor, run: AgentRun): Promise<AgentRun>;
  resume(): void;            // for every link_runs row with direction requested and state running or requested: follow(runId)
  async shutdown(): Promise<void>;   // aborts every stream
  isRemote(run: AgentRun): boolean;  // run.machineId !== null
}
// agent-routes.ts: AgentRouteDeps gains remoteRuns: RemoteRunService; startBody gains machineId: z.string().regex(MACHINE_ID).optional(); with it, POST …/runs calls remoteRuns.start. POST /api/actions/:id/decision and POST /api/runs/:id/stop look the run up first (getRun; for a decision, through the action's run_id) and call remoteRuns.decide/stop when run.machineId !== null, else the runner as today. The runner gains a guard: `stop` and `decide` on a run with `machine_id` set, from the requester side, throw `RemoteRunError` and never record a local `agent.finished`; the worker's own accepted runs stay decidable. `remoteRuns.decide/stop` return the local copy of the run or action, never the worker's reply, and an unreachable worker records nothing.
// link-routes.ts
GET /api/link/verify → { ok: boolean; checked: number; badSeqs: number[] }   // re-verifies every link.mirrored against the machines table (an unpaired machine's entries count as bad: the key is gone)
```
Requester flow (`start`): the machine must be paired (NotFoundError); `prompt` is cleaned as the runner does; `runId = newId()`; commit `link.run_requested` (actor human); `exportRepoBundle` to `<dataDir>/link/outgoing/<runId>.bundle` (ensureProjectRepo first); `client.upload(peer, "/link/v1/runs/<runId>/repo", file, MAX_BUNDLE_BYTES)`; `client.request(peer, "POST", "/link/v1/runs/<runId>/start", { v: 1, projectId, projectName, adapter, prompt, cardId, connectionIds })`; any failure → commit `link.run_failed { runId, machineId, error: <mapped code or "unreachable"> }`, delete the bundle, and rethrow (`MachineUnreachableError` → 502 `machine_unreachable`; `RemoteRefusedError` → the remote's status with `{ error: "remote_refused", code: <remote code>, machine: <name> }`); on 201, `follow(runId)` and return a provisional `AgentRun` built from the response with `machineId` (the projection row appears with the first mirrored frame). `follow(runId)`: `client.stream(peer, "/link/v1/runs/<runId>/events?afterSeq=<link_runs.last_seq>", onFrame, abort.signal)`; `onFrame`: parse with `mirrorFrameSchema`; refuse (close the stream, set `link_runs.error`, stop following) when `verifyFrame(peer.publicKeyDer, frame)` is false, `frame.origin.payload.runId !== runId`, or `frame.origin.id ∈ mirroredIds(db, runId)`; else commit `link.mirrored { machineId, origin, signature }` (actor `{ kind: "system", id: "link" }`, `projectId` = origin.projectId). On a clean end after `agent.finished`: `client.download(peer, "/link/v1/runs/<runId>/changes", file, MAX_BUNDLE_BYTES)`, `importSnapshot`, commit `link.changes_imported { runId, machineId, commit }`, delete the file; a download that fails is retried with the stream's backoff. On `MachineUnreachableError`: wait the next backoff and reconnect from the current `last_seq`, forever while the run is `running` (the machine's presence shows `offline` meanwhile). `decide`/`stop` for a remote run: `client.request(peer, "POST", …)`; a `MachineUnreachableError` propagates (502) and nothing is recorded locally; the forwarded result is returned as is. `server.ts`: constructs `RemoteRunService`, passes it to `registerAgentRoutes`, calls `remote.resume()` after `runner.recoverOnStartup()`, and `remote.shutdown()` in `close()`.
Routes: `MachineUnreachableError` → 502 `{ error: "machine_unreachable" }`; `RemoteRefusedError` → its status with `{ error: "remote_refused", code, machine }`. `errorMessage`: `machine_unreachable` → `Could not reach that machine. Nothing was started.`; `remote_refused` → `"<machine>" refused: <fixed phrase>` (only codes in a fixed table are worded; any other reads `"<machine>" refused the request`; 401/403/407/423 from the worker answer 502 so they cannot read as this computer's own session).
UI: `StartRunForm` gains a select `Run on` (`aria-label="Run on"`) with `This computer` and every machine from `/api/link` (offline ones disabled with `offline` in the label); when a machine is chosen, the `Give this run access to` fieldset lists that machine's `connections` from `/api/link/machines/:id/capacity` (legend `Give this run access to (on <name>)`), and the local-model rule from Task 5 applies to them; Start sends `machineId`. `onStartRun(adapter, prompt, cardId?, connectionIds?, machineId?)`. Run lists and the feed show `on <machine name>` after the adapter for runs with `machineId`; the ledger panel and story give `link.mirrored` entries a `machine` class and the `On <machine>:` prefix (from narration); the decision card for a remote action shows `This agent runs on <machine>. Your decision is sent there.` A `changes` tab for a remote run that is still running shows `The changes arrive when the run finishes on <machine>.` (Plan 4's `worktree_missing` mapped for remote runs).

- [ ] **Step 1: Write failing tests:**
  - projections: `applyMirrored` with an inner `agent.started` creates the run row with `machine_id`; inner `agent.action.requested` → a pending action that `listAllPendingActions` returns; inner `agent.finished` → `link_runs.state === "finished"`; rebuild equals live; `mirroredIds` lists the origin ids;
  - remote-runs (two servers in one process, fake adapter on the worker, `backoffMs: [50, 100]`): `start` → requester ledger has `link.run_requested`, then mirrored `agent.started`, `agent.action.requested` within 5 s; `GET /api/pending-actions` on the requester lists the worker's pending shell step with the project name; `decide(allow)` → the worker's ledger has `link.decision_received` and the requester's mirrored `agent.action.decided`, `agent.action.completed`, `agent.finished`; then `link.changes_imported` with a 40-hex commit and `join(dataDir, run.worktree)` exists on the requester with the fake's written file (use Plan 4's `write` step); Plan 4's `GET /api/runs/:id/changes` on the requester lists it; `GET /api/link/verify` → `ok: true, checked: n`;
  - **(Review Focus 2)** a stream fixture (a listener route under test replacing the worker's) sending a frame signed by a third key, a frame of type `card.moved`, a frame with another `runId`, a duplicate `origin.id`, and a frame whose `agent.message.text` is 4001 characters → each: nothing committed, `link_runs.error` set to `bad_signature` / `not_mirrorable` / `wrong_run` / `duplicate` / `invalid_payload`, the stream closed; the next good frame after a reconnect is committed;
  - **(Review Focus 4)** stop the worker's listener while an action is pending: `decide` on the requester → `MachineUnreachableError`, the action still pending, nothing recorded; `presence()` shows `online: false`; restart the worker's listener → the stream resumes from `last_seq` and no `link.mirrored` has a duplicate `origin.id`; `close()` the requester's server with a run in flight and create a new one over the same data dir → `resume()` reconnects and the run finishes with exactly one mirrored entry per worker entry;
  - `start` against an unreachable machine → 502 `machine_unreachable`, `link.run_failed` recorded, no bundle left under `link/outgoing`, no run row; the worker refusing a disabled connection id → the requester answers 400 `{ error: "remote_refused", code: "connection_disabled", machine: "GPU box" }` and records `link.run_failed`;
  - routes: `POST …/runs` with `machineId` of an unpaired id → 404; without auth → 401; `/api/link/verify` → 401 without auth;
  - UI: `Run on` lists machines; Start sends `machineId`; the fieldset legend changes; the decision-card sentence; the ledger `machine` class.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(link): run agents on a linked machine; mirror its ledger entries signed and attributed; decide from here; import the result`

---

### Task 9: Offline: inferred network state, status, copy, and the offline behaviour tests

**Files:** Create `packages/core/src/network.ts`. Modify `packages/core/src/server/{server,connection-routes}.ts`, `apps/ui/src/shell/StatusBar.tsx`, `apps/ui/src/components/StartRunForm.tsx`, `apps/ui/src/views/GitHubSideBar.tsx`, `apps/ui/src/api.ts`. Tests `packages/core/test/network.test.ts`, `packages/core/test/server/{connection-routes,offline}.test.ts`, `apps/ui/test/StatusBar.test.tsx`.

**Interfaces:**
```ts
// network.ts
export type NetworkState = { state: "online" | "offline" | "unknown"; basis: "inferred"; since: string | null; lastError: string | null };
export const OFFLINE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH"]);
export class NetworkObserver { constructor(now?: () => Date); report(outcome: { ok: true } | { ok: false; code: string | undefined }): void; state(): NetworkState; }
export function observedFetch(f: typeof fetch, observer: NetworkObserver): typeof fetch;   // reports ok on any response; on a rejection reports { ok: false, code: (err.cause ?? err).code }; rethrows unchanged; loopback and RFC 1918 hosts are not reported (they say nothing about the internet)
```
Rules: `report({ ok: false, code })` with a code in `OFFLINE_CODES` → `offline` with `since` set once; any `ok` → `online`; a failure with another code leaves the state. `server.ts` wraps the fetch handed to `ConnectionService`, the cloud grants and the GitHub client with `observedFetch`; the local-model detection and the link client are not wrapped. `/api/status` gains `network: NetworkState`.
UI: status bar item `Offline` (class `attention`, `title` = `No internet connection was reachable the last time The Terminal tried (inferred). Local work, local models and linked machines keep working.`) when `state === "offline"`; nothing when `online` or `unknown`. `StartRunForm`: when offline and the chosen adapter is not `fake` and no local model is ticked, a note `You seem to be offline. Cloud models will not answer; a local model will.` (the Start button stays enabled). `GitHubSideBar`: when offline and the overview is `stale` or errored, the note gains ` You seem to be offline.`

- [ ] **Step 1: Write failing tests:**
  - network: state walks `unknown` → `offline` (ENOTFOUND) → `online` (a response) → `offline` again with a new `since`; `ECONNREFUSED` leaves `online`; `observedFetch` does not report for `http://127.0.0.1:1/` or `http://192.168.0.5/`;
  - offline (the whole workspace with an injected `fetch` that rejects every non-loopback URL with an error whose `code` is `ENOTFOUND`, memory store, fake agent, two servers paired on `127.0.0.1`): `POST /api/connections/:id/test` for a Claude key → `Could not reach the provider` and then `/api/status.network.state === "offline"`; creating a project, adding and moving a card, starting and allowing a fake run, exporting the ledger (Plan 3's route) all succeed; `POST /api/link/code` and `POST /api/link/pair` succeed between the two servers; a remote fake run completes and is imported; a run with a `local_model` connection against the fake Codex completes; `GET /api/capacity` answers with `hardware` and `localModels`; the GitHub overview answers 503 `github_unavailable` while `/api/status` still answers 200; `POST …/runs` with an AWS connection → 502 `cloud_credentials_failed`; every response during the test still carries the cookie-based auth (no 401 regressions);
  - UI: the status-bar item and title for `offline`; absent for `unknown`; the run-form note.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: inferred offline state in the status bar; everything local keeps working without internet`

---

### Task 10: Documentation and wording

**Files:** Create `docs/linked-machines.md`. Modify `docs/connections-and-credentials.md`, `README.md`, `CHANGELOG.md`. Tests: none beyond `pnpm test` staying green; the docs are reviewed by reading.

`docs/linked-machines.md`, in plain language:
- **What linking is**: two Terminals on one local network; what crosses (capacity, run requests with the project's repository, signed ledger entries) and what never does (keys, logins, the identity key, the token), with the exact sentence the Owner accepts.
- **Turning it on**: the second port (4418), that the workspace itself stays on this computer only, the OS firewall prompt on macOS and Windows and what to answer, that the opt-in persists until turned off, and that the desktop app's server is the one that listens.
- **Pairing**: show a code on one machine, type it on the other, what the code contains (part of the showing machine's fingerprint and a one-time secret), ten minutes, five tries, and how to check the fingerprint shown on both screens afterwards; manual addresses when the network blocks discovery (what mDNS is, in one sentence).
- **Running on another machine**: the project is copied to that machine as a git bundle, the agent runs there under its own gate with that machine's connections and models, decisions are made here and sent there, every entry comes back signed and marked `On <machine>`, and the changes arrive when the run finishes; what `GET /api/link/verify` checks; that the other machine keeps its own record of what it did; that the project appears there as received.
- **Local models**: Ollama and llama.cpp server, detection, the `local_model` connection, that only Codex runs on them for now and why, loopback only, and how to use the desktop's model from the Mac (run the agent on the desktop).
- **Offline**: the list from the Decisions, verbatim, plus how the `Offline (inferred)` indicator is inferred; the facts that remote runs are approved on the machine that runs them, changes are verified and never merged automatically, a refused import is recorded and not retried, a remote run can be stopped or decided only through the worker, a suspicious entry or a changed key ends the run, uploads are bounded (4, 1 GiB, 1 hour), discovery runs only in the Link a machine panel, and the prompt is cleaned before it is sent.
- **When things go wrong**: `offline` machines and what resumes by itself; a keychain that is unavailable; a machine whose identity changed (the Machines view and Capacity say `This machine's key has changed. Unlink it and pair again.`, and a remote run on it ends; re-pair); unlinking.
- `docs/connections-and-credentials.md`: a `Local models` section (fields, where they live, the tester, `LOCAL_MODEL_API_KEY`) and one paragraph under "What agent programs can see" about remote runs (the worker's environment only). README: a paragraph on linking two computers and local models. CHANGELOG: `- Linked machines: pair two Terminals over the local network with a one-time code, run agents on the other machine with its own models and connections, decide from either, and see both machines in Capacity. Local models through Ollama or llama.cpp. Works offline.`

- [ ] **Step 1:** Write the sections. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: linked machines, local models and offline mode`

---

### Task 11: End-to-end: pairing, a remote run decided from here, local models, offline

**Files:** Create `e2e/link.spec.ts`, `e2e/local-model.spec.ts`, `e2e/offline.spec.ts`. Modify `e2e/global-setup.ts` (a third server, the "peer", created with the same `AT_CREATE` flags plus `THETERMINAL_FAKE_DISCOVERY=1` on both agent servers, `linkBind: "127.0.0.1"` on both, exposed as `TT_E2E_PEER_URL`; the fake agent script gains Plan 4's `{ write: { path: "notes.txt", content: "from the peer" } }` step before the shell step).

- [ ] **Step 1: Write the failing e2e tests:**
  - link: on the peer, open `Machines` → `Rename` to `GPU box` → switch `Allow linking` → the dialog shows the exact sentence → tick → `Allow` → `Linking on · port` appears; `Link a machine` → `Show a code` → read the code (`aria-label="Pairing code"`); on the agent server, `Machines` → `Link a machine` → `Enter a code` → `GPU box` appears in `Machines found on your network` → click it → type the code → `Link` → `Linked "GPU box"`; both ledgers show `Owner linked "…"`; the status bar shows `Machines: 1 linked, 1 online`; **(Review Focus 1)** a wrong code typed first shows `The other machine rejected the code` and the peer's window stays open;
  - remote run: on the agent server, `Agents` → `Run on: GPU box` → start the fake agent → the decision card `Decision: Run: nvidia-smi` appears with `This agent runs on GPU box.` → Allow → the feed shows `On GPU box: …` lines and `finished` → `Changes` for the run lists `notes.txt` → the peer's ledger shows `Accepted a run from Mac` and `Owner's decision arrived from Mac: allowed`; every response and websocket frame during the spec is checked for `TESTKEY` and for `PRIVATE KEY`;
  - local model: `Connections` → `Local model (Ollama or llama.cpp)` → `Use` next to `fake-coder:7b` → Save → `Test connection` → `Connected (model available)`; `Agents` → Codex → tick the local model → start → the fake Codex's decision card → Allow → the ledger shows `authMode` `none` in the run detail and `Agent … was given the local model "…"`; with Gemini selected the box is disabled with the Codex sentence;
  - offline: the third server is created with an injected `fetch` that rejects non-loopback URLs with `ENOTFOUND` (passed through `createServer`'s `fetch` option in global-setup); `Test connection` on a Claude key → `Could not reach the provider`; the status bar shows `Offline` with the title; the board, a fake run and the Machines view work; the GitHub view shows `Could not reach GitHub` and ` You seem to be offline.`;
  - `GET /api/link`, `GET /api/link/verify` and `GET /api/capacity` without the cookie → 401; a plain `fetch` to the peer's link port without a certificate fails.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows. Open the pull request from `plan-6-linked-machines` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): pairing, a remote run decided from here, local models, offline`

---

## Done when

- The Mac and the desktop each hold an Ed25519 identity in their keychain, pair with a code typed once, and show each other as linked and online; nothing listens beyond loopback until the Owner accepts the exact sentence, and that acceptance is in the ledger.
- A run started on the Mac executes on the desktop with the desktop's own connections or local model; its every entry arrives on the Mac signed, verified and marked `On <machine>`; the Owner decides on the Mac; the changes arrive as the run's working copy and open in the Changes view; `GET /api/link/verify` is `ok`.
- No key, login, identity private key or token ever appears in a link message, a capacity response, a bundle or either ledger; the capacity exchange carries ids, kinds and names only.
- The Capacity view shows both machines' hardware and local models; a `local_model` connection against Ollama or llama.cpp tests cleanly and Codex runs on it with `authMode` `none`.
- Without internet, everything in the offline list works, the status bar says `Offline` only when inferred, and cloud-dependent features fail with the agreed copy.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI without multicast, a real keychain, a model server or a second machine; the work is merged to `main` through a pull request.
