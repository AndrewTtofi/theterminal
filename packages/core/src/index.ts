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
export { registerAuth, TOKEN_COOKIE, PUBLIC_ROUTE, APP_HOST } from "./server/auth.js";
export { registerLedgerStream } from "./server/events-ws.js";
export { createServer } from "./server/server.js";
export { DataDirInUseError } from "./server/data-dir-lock.js";
export type { RunningServer } from "./server/server.js";
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
export { GateService, GateBlockedError, GateNotMetError } from "./gates/service.js";
export type { GateServiceDeps } from "./gates/service.js";
export { gateFacts, evaluateConditions } from "./gates/conditions.js";
export { registerIntakeRoutes } from "./server/intake-routes.js";
export type { IntakeRouteDeps } from "./server/intake-routes.js";
export { cardStory, narrationContext, ledgerExportLines } from "./story/story.js";
export { registerStoryRoutes } from "./server/story-routes.js";
export type { StoryRouteDeps } from "./server/story-routes.js";
export { registerConnectionRoutes } from "./server/connection-routes.js";
export type { ConnectionRouteDeps } from "./server/connection-routes.js";
export { workspaceCounts } from "./events/projections.js";
export type { WorkspaceCounts } from "./events/projections.js";
export { classify } from "./agents/policy.js";
export { ApprovalBroker, AlreadyDecidedError } from "./agents/approvals.js";
export { FakeAdapter } from "./agents/fake-adapter.js";
export type { FakeStep } from "./agents/fake-adapter.js";
export { AgentRunner, AdapterUnavailableError, ShuttingDownError } from "./agents/runner.js";
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
export { KeychainSecretStore } from "./secrets/keychain-store.js";
export type { KeyringEntryLike, KeyringEntryFactory } from "./secrets/keychain-store.js";
export { ConnectionService, ConflictError, SecretInConfigError, UnknownFieldError } from "./connections/service.js";
export type {
  AddConnectionInput, ConnectionServiceDeps, ConnectionTester, Credentials, UpdateConnectionPatch,
} from "./connections/service.js";
export { CONNECTION_TESTERS } from "./connections/testers.js";
export * from "./share/index.js";
