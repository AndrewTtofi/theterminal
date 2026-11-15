export { openDatabase } from "./db.js";
export type { Db } from "./db.js";
export { canonicalJson } from "./ledger/canonical.js";
export { Ledger, LedgerReadOnlyError, MAX_RUN_IDS } from "./ledger/ledger.js";
export type { LedgerRow, VerifyResult } from "./ledger/ledger.js";
export { BoardService, NotFoundError } from "./board/board-service.js";
export { applyEvent, rebuildAllProjections, getSetting } from "./events/projections.js";
export { commitEvent, commitEvents } from "./events/commit.js";
export {
  getIntake, listOpenIntakes, listGateDecisions, projectSpendUsd, countPendingActions, countRunningRuns,
} from "./events/projections.js";
export type { GateDecision, IntakeRow, IntakeState } from "./events/projections.js";
export type { CardStory } from "@theterminal/shared";
export { registerRoutes } from "./server/routes.js";
export type { RouteDeps } from "./server/routes.js";
export {
  registerAuth, TOKEN_COOKIE, SESSION_COOKIE, PUBLIC_ROUTE, PUBLIC_ROUTES, ROUTE_ROLES, APP_HOST, routeKey, requireRole, needs, actorOf,
  assertRoutesHaveRoles, sessionCookieOptions, clientKey, listenerOf, remoteHostAllowed,
} from "./server/auth.js";
export type { AuthDeps, HostRule, Principal, RoleGuard } from "./server/auth.js";
export { registerGateRoutes, sendGateError } from "./server/gates-routes.js";
export type { GateRouteDeps } from "./server/gates-routes.js";
export { registerLedgerStream } from "./server/events-ws.js";
export { createServer } from "./server/server.js";
export { DataDirInUseError } from "./server/data-dir-lock.js";
export type { RunningServer, RemoteOptions } from "./server/server.js";
export {
  RemoteListener, RemoteStartError, RemoteInputError, REMOTE_KEY_SECRET, REMOTE_FILES_SECRET, HEALTHZ_PATH, REMOTE_IDLE_TIMEOUT_MS,
  ADDRESS_CACHE_MS, readRemoteState, checkRemoteHost,
} from "./server/remote.js";
export type { RemoteDeps, EnableInput, RemoteView, RemoteInputCode } from "./server/remote.js";
export { registerRemoteRoutes, remoteStatus, remoteLabel } from "./server/remote-routes.js";
export type { RemoteRoutesDeps, RemoteStatus } from "./server/remote-routes.js";
export { AcmeManager, AcmeError, selectAcmeClient, fakeAcme, ACME_DIRECTORY, ACME_STAGING } from "./server/acme.js";
export type { AcmeClientLike, AcmeDeps } from "./server/acme.js";
export { CertificateError, selfSignedTlsCertificate, certFingerprint, loadProvided, localAddresses } from "./server/certs.js";
export type { CertMaterial } from "./server/certs.js";
export { defaultDataDir } from "./paths.js";
export { redact, truncate, REDACTED } from "./agents/redact.js";
export {
  SharedGitconfigModifiedError, WorktreeManager, GitOutputTooLargeError, GitTimeoutError, GIT_COMMON_ARGS,
} from "./agents/worktrees.js";
export type { GitRunner } from "./agents/worktrees.js";
export {
  runWorktree, listChanges, fileDiff, listDir, readFile, WorktreeMissingError, NoBaseError, RunActiveError, RUN_ACTIVE_MESSAGE,
} from "./changes/changes.js";
export type { ChangesDeps } from "./changes/changes.js";
export { registerChangesRoutes } from "./server/changes-routes.js";
export {
  OverrideService, OverrideBusyError, ProgramNotFoundError, ProgramNotAllowedError, OverridesShuttingDownError, OVERRIDE_RUN_ACTIVE,
  OVERRIDE_TIMEOUT_MS, OVERRIDE_OUTPUT_CHARS, OVERRIDE_BUFFER,
} from "./override/service.js";
export type { OverrideDeps } from "./override/service.js";
export { registerOverrideRoutes } from "./server/override-routes.js";
export type { OverrideRouteDeps } from "./server/override-routes.js";
export type { ChangesRouteDeps } from "./server/changes-routes.js";
export type { AdapterEvent, AdapterStartOptions, AgentAdapter, GateResult, ProposedAction, RunCredentials } from "./agents/adapter.js";
export {
  IntakeService, RecordedText, HumanRequiredError, SecretInTextError, IntakeCompletedError, IntakeIncompleteError,
  DecisionNotApplicableError, NoIntakeError,
} from "./intake/service.js";
export type { IntakeServiceDeps, IntakeProjectDecisions, RecordedTextDeps } from "./intake/service.js";
export { GateService, GateBlockedError, GateNotMetError, GateRequirementError } from "./gates/service.js";
export type { GateServiceDeps, Signer } from "./gates/service.js";
export { gateFacts, evaluateConditions } from "./gates/conditions.js";
export { registerIntakeRoutes } from "./server/intake-routes.js";
export type { IntakeRouteDeps } from "./server/intake-routes.js";
export { cardStory, narrationContext, ledgerExportLines } from "./story/story.js";
export { registerStoryRoutes } from "./server/story-routes.js";
export type { StoryRouteDeps } from "./server/story-routes.js";
export { registerConnectionRoutes } from "./server/connection-routes.js";
export type { ConnectionRouteDeps } from "./server/connection-routes.js";
export { workspaceCounts, listMachines, getMachine, getLinkRun, listLinkRuns, applyMirrored, mirroredIds } from "./events/projections.js";
export type { WorkspaceCounts } from "./events/projections.js";
export {
  getPerson, listPeople, listCredentials, findCredential, getInvite, getInviteByHash, listInvites, getRemoteState, getGateRequirement,
} from "./events/projections.js";
export { SessionStore } from "./people/sessions.js";
export type { Session } from "./people/sessions.js";
export { ChallengeStore, CHALLENGE_TTL_MS, CHALLENGE_MAX, CHALLENGE_PER_CLIENT } from "./people/challenges.js";
export { LockoutStore, LOCKOUT_MAX_KEYS } from "./people/lockouts.js";
export {
  PeopleService, InviteInvalidError, OwnerCredentialRequiredError, LastCredentialError, SelfChangeError, OwnerRoleError,
  CredentialExistsError, LockedError, LOCKOUT_FAILURES, LOCKOUT_MS, OWNER_INVITE_TTL_MS,
} from "./people/service.js";
export type { PeopleServiceDeps } from "./people/service.js";
export { classify } from "./agents/policy.js";
export { ApprovalBroker, AlreadyDecidedError } from "./agents/approvals.js";
export { FakeAdapter } from "./agents/fake-adapter.js";
export type { FakeStep } from "./agents/fake-adapter.js";
export { AgentRunner, AdapterUnavailableError, RemoteRunError, ShuttingDownError } from "./agents/runner.js";
export type { AgentRunnerDeps } from "./agents/runner.js";
export { ClaudeAdapter, toolToAction } from "./agents/claude-adapter.js";
export { GeminiAdapter } from "./agents/gemini/adapter.js";
export { ProviderSettings } from "./agents/settings.js";
export { which } from "./agents/which.js";
export type { WhichOptions } from "./agents/which.js";
export { baseChildEnv, buildChildEnv } from "./agents/child-env.js";
export { JsonRpcPeer } from "./agents/jsonrpc.js";
export type { RpcHandler } from "./agents/jsonrpc.js";
export { CodexAdapter, codexApprovalToAction } from "./agents/codex/adapter.js";
export { SecretStoreUnavailableError, SECRET_SERVICE, MAX_SECRET_BYTES, ChunkedSecretStore } from "./secrets/store.js";
export type { SecretStore } from "./secrets/store.js";
export { MemorySecretStore } from "./secrets/memory-store.js";
export { FileSecretStore, KeyInsideDataDirError, assertKeyOutsideDataDir } from "./secrets/file-store.js";
export type { SecretStoreKind } from "./secrets/file-store.js";
export { KeychainSecretStore } from "./secrets/keychain-store.js";
export type { KeyringEntryLike, KeyringEntryFactory } from "./secrets/keychain-store.js";
export { ConnectionService, ConflictError, SecretInConfigError, UnknownFieldError } from "./connections/service.js";
export type {
  AddConnectionInput, ConnectionServiceDeps, ConnectionTester, Credentials, UpdateConnectionPatch,
} from "./connections/service.js";
export { CONNECTION_TESTERS } from "./connections/testers.js";
export { base32Encode, base32Decode } from "./link/base32.js";
export { selfSignedCertificate, derToPem, CERT_NOT_BEFORE, CERT_NOT_AFTER } from "./link/x509.js";
export { LinkIdentity, IDENTITY_ACCOUNT, machineIdOf, fingerprintOf, verifySignature } from "./link/identity.js";
export type { IdentityCreated } from "./link/identity.js";
export { LinkListener, PAIR_PATH, LINK_BODY_LIMIT } from "./link/listener.js";
export type { ListenerDeps, PeerCheck } from "./link/listener.js";
export {
  LinkClient, MachineUnreachableError, MachineKeyMismatchError, RemoteRefusedError, LinkProtocolError, ClosedBeforeReplyError, MAX_JSON_BYTES,
  MAX_FRAME_BYTES, parseAddress,
} from "./link/client.js";
export type { Peer } from "./link/client.js";
export {
  LinkService, LinkingDisabledError, IdentityUnavailableError, PairingCodeMismatchError, PairingRejectedError, NoPairingError,
  SelfPairingError,
} from "./link/service.js";
export type { LinkServiceDeps, PairReply } from "./link/service.js";
export { PairingWindow, pairingProof } from "./link/pairing.js";
export type { PairingProofLabel } from "./link/pairing.js";
export { mdnsDiscovery, fakeDiscovery, selectDiscovery, adaptBonjour } from "./link/discovery.js";
export type { Discovered, Discovery, PublishInfo } from "./link/discovery.js";
export { registerLinkRoutes } from "./server/link-routes.js";
export type { LinkRouteDeps } from "./server/link-routes.js";
export { registerLinkProtocolRoutes } from "./link/protocol-routes.js";
export type { LinkProtocolDeps } from "./link/protocol-routes.js";
export { acceptMirroredLine, displayEntry, remoteDisplay, builtInClean, FATAL_REFUSALS } from "./link/mirrored.js";
export { LinkCapacity } from "./link/capacity.js";
export type { LinkCapacityDeps } from "./link/capacity.js";
export { capacityBody } from "./link/protocol/capacity.js";
export type { CapacityProtocolDeps } from "./link/protocol/capacity.js";
export * from "./share/index.js";
