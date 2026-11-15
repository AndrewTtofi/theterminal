import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { cardInputSchema, cardStatusSchema, gateDecisionInputSchema, stageSchema } from "@theterminal/shared";
import { LedgerReadOnlyError, type Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService, NotFoundError } from "../board/board-service.js";
import { AlreadyDecidedError } from "../agents/approvals.js";
import {
  AdapterUnavailableError, ApiKeyRequiredError, DuplicateCloudProviderError, DuplicateMcpServerError, LocalModelUnsupportedError, McpUnsupportedError,
  RemoteRunError, ShuttingDownError,
} from "../agents/runner.js";
import { CloudCredentialError } from "../connections/cloud/grant.js";
import { NoBaseError, RunActiveError, WorktreeMissingError } from "../changes/changes.js";
import { HooksDirModifiedError, SharedGitconfigModifiedError, UnsafeGitConfigError } from "../agents/worktrees.js";
import { OverrideBusyError, OverridesShuttingDownError, ProgramNotAllowedError, ProgramNotFoundError } from "../override/service.js";
import { redact } from "../agents/redact.js";
import { LinkProtocolError, MachineKeyMismatchError, MachineUnreachableError, RemoteRefusedError } from "../link/client.js";
import { BundleGitLimitError, BundleInvalidError, NoRepoError, RepoTooLargeError, UploadLimitError } from "../link/bundles.js";
import {
  IdentityUnavailableError, LinkingDisabledError, NoPairingError, PairingCodeMismatchError, PairingRejectedError, SelfPairingError,
} from "../link/service.js";
import { displayEntry } from "../link/mirrored.js";
import { RemoteRunRefusedError } from "../link/remote-runs.js";
import {
  ConflictError, ConnectionDisabledError, SecretInConfigError, UnknownFieldError, UnsupportedConnectionError,
} from "../connections/service.js";
import { SecretStoreUnavailableError } from "../secrets/store.js";
import {
  DecisionNotApplicableError, HumanRequiredError, IntakeCompletedError, IntakeIncompleteError, NoIntakeError,
  SecretInTextError,
} from "../intake/service.js";
import { GateBlockedError, GateNotMetError, GateRequirementError, stageHasEntryGates, type GateService, type Signer } from "../gates/service.js";
import {
  GitHubNotConnectedError, GitHubRejectedError, GitHubRepoNotFoundError, GitHubUnavailableError,
} from "../github/client.js";
import { ShareNotCleanError } from "../share/clean.js";
import {
  AddressNotAllowedError, LinkNotActiveError, PreviewNotFoundError, PreviewStaleError, ShareLinkActiveError, ShareTooLargeError,
  SnapshotMissingError, SnapshotTamperedError,
} from "../share/errors.js";
import { actorOf, needs } from "./auth.js";
import { trimmerFor } from "../ledger/trim.js";

export type RouteDeps = {
  board: BoardService;
  gates: GateService;
  ledger: Ledger;
  getIntegrity: () => VerifyResult;
  /** This machine's redaction, for a linked machine's mirrored entries. Default: the built-in patterns. */
  clean?: (s: string) => string;
};

/** The person asking, as a gate's signer: the gates judge who may sign by their recorded role or by name. */
const signerOf = (req: FastifyRequest): Signer => {
  const p = req.principal;
  if (!p) throw new Error("signerOf: the request has no principal");
  return { personId: p.personId, role: p.role };
};

const moveBody = z.object({ to: stageSchema, gates: z.array(gateDecisionInputSchema).max(10).optional() }).strict();
const STAGE_GATED = "Add the card to an earlier stage, then move it, so its readiness checks run.";
const gatesQuery = z.object({ to: stageSchema });
const statusBody = z.object({ to: cardStatusSchema });
const ledgerQuery = z.object({
  projectId: z.string().optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** A path segment shown as given only when it has the shape of one of our own field names. */
const PLAIN_SEGMENT = /^[a-z][A-Za-z0-9]{0,40}$/;

/** Codes whose zod default message names only the schema's own limits, types or patterns, never the input. */
const SCHEMA_ONLY_MESSAGE = new Set(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of"]);

/**
 * A zod issue as the client sees it: path, code and message only. Nothing the request sent is echoed: no
 * `input` and no nested issues, and record keys that are not plain field names (and symbols) become "*".
 * Messages are an allowlist by code: our own refinement messages, defaults that hold only schema values,
 * and messages rebuilt from the schema (enum options) or fixed (unknown keys). Any other code, such as
 * `invalid_union`, gets "Invalid input".
 */
function publicIssue(issue: z.core.$ZodIssue): { path: (string | number)[]; code: string; message: string } {
  const path = issue.path.map((p) =>
    typeof p === "number" || (typeof p === "string" && PLAIN_SEGMENT.test(p) && redact(p) === p) ? p : "*",
  );
  let message = "Invalid input";
  if (issue.code === "custom" || SCHEMA_ONLY_MESSAGE.has(issue.code)) message = issue.message;
  else if (issue.code === "invalid_value") message = `Invalid option: expected one of ${issue.values.map((o) => `'${String(o)}'`).join(" | ")}`;
  else if (issue.code === "unrecognized_keys") message = "Unrecognized key(s) in object";
  // A record key that fails our own refinement: show that refinement's fixed message, as zod 3 did.
  else if (issue.code === "invalid_key") message = issue.issues.find((i) => i.code === "custom")?.message ?? message;
  return { path, code: issue.code, message };
}

/**
 * The errors the gate routes and the move route raise over who may sign: fixed codes, the gate and its requirement
 * only (a person id at most, never a name). Null for any other error.
 */
export function sendGateError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (err instanceof GateRequirementError) {
    return reply.code(403).send({ error: "gate_requires", gateId: err.gateId, requirement: err.requirement });
  }
  if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
  return null;
}

/**
 * The error reply for every route: a fixed code per known error, and nothing the request sent. Shared by the
 * workspace server and the link listener, so both answer the same way.
 */
export function sendError(err: unknown, reply: FastifyReply, log: FastifyBaseLogger): FastifyReply {
  const gate = sendGateError(err, reply);
  if (gate !== null) return gate;
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "invalid_input", issues: err.issues.map(publicIssue) });
  }
  if (err instanceof AdapterUnavailableError) return reply.code(400).send({ error: "invalid_input" });
  // A collaborator's run with no API key for the provider: the provider's fixed name, nothing else.
  if (err instanceof ApiKeyRequiredError) return reply.code(409).send({ error: "api_key_required", provider: err.provider });
  if (err instanceof ConflictError) return reply.code(409).send({ error: "conflict" });
  if (err instanceof SecretInConfigError) return reply.code(400).send({ error: "secret_in_config" });
  if (err instanceof UnknownFieldError) return reply.code(400).send({ error: "invalid_input" });
  if (err instanceof UnsupportedConnectionError) return reply.code(400).send({ error: "connection_unsupported" });
  if (err instanceof ConnectionDisabledError) return reply.code(400).send({ error: "connection_disabled" });
  if (err instanceof McpUnsupportedError) return reply.code(400).send({ error: "mcp_unsupported", adapter: err.adapter });
  if (err instanceof LocalModelUnsupportedError) return reply.code(400).send({ error: "local_model_unsupported" });
  if (err instanceof DuplicateMcpServerError) return reply.code(400).send({ error: "duplicate_mcp_server" });
  if (err instanceof DuplicateCloudProviderError) return reply.code(400).send({ error: "duplicate_cloud_provider" });
  // The name passed the connection name check when it was stored, so it is safe to show; the reason is not sent.
  if (err instanceof CloudCredentialError) return reply.code(502).send({ error: "cloud_credentials_failed", name: err.connectionName });
  if (err instanceof SecretStoreUnavailableError) return reply.code(503).send({ error: "keychain_unavailable" });
  if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
  if (err instanceof WorktreeMissingError) return reply.code(404).send({ error: "worktree_missing" });
  if (err instanceof NoBaseError) return reply.code(409).send({ error: "no_base" });
  // A fixed sentence chosen by the code that threw, never request text.
  if (err instanceof RunActiveError) return reply.code(409).send({ error: "run_active", message: err.message });
  if (err instanceof RemoteRunError) return reply.code(409).send({ error: "remote_run", message: err.message });
  // A fixed sentence: the repository's configuration includes other files, or the like. Never a path.
  if (err instanceof OverrideBusyError) return reply.code(409).send({ error: "override_busy" });
  if (err instanceof ProgramNotFoundError) return reply.code(400).send({ error: "program_not_found" });
  if (err instanceof ProgramNotAllowedError) return reply.code(400).send({ error: "program_not_allowed" });
  if (err instanceof OverridesShuttingDownError) return reply.code(503).send({ error: "shutting_down" });
  if (err instanceof UnsafeGitConfigError) return reply.code(409).send({ error: "unsafe_repository", message: err.message });
  // The workspace's own git pins were tampered with, so git was not run: fixed text, never a path or fs error.
  if (err instanceof SharedGitconfigModifiedError) {
    return reply.code(409).send({ error: "gitconfig_modified", message: "The Terminal's shared git configuration was modified, so git was not run. Restart The Terminal to repair it." });
  }
  if (err instanceof HooksDirModifiedError) {
    return reply.code(409).send({ error: "hooks_modified", message: "The Terminal's empty hooks folder was modified, so git was not run. Empty it and try again." });
  }
  if (err instanceof NoIntakeError) return reply.code(404).send({ error: "no_intake" });
  if (err instanceof HumanRequiredError) return reply.code(403).send({ error: "human_required" });
  // The explanation is a fixed sentence naming a field, never the text.
  if (err instanceof SecretInTextError) {
    return reply.code(400).send({ error: "secret_in_text", ...(err.explanation !== undefined && { message: err.explanation }) });
  }
  if (err instanceof IntakeCompletedError) return reply.code(409).send({ error: "intake_completed" });
  if (err instanceof IntakeIncompleteError) return reply.code(409).send({ error: "intake_incomplete", missing: err.missing });
  // Every string in an evaluation comes from the gate catalog, a count or an amount, never from what was typed.
  if (err instanceof GateBlockedError) return reply.code(409).send({ error: "gate_blocked", gates: err.gates });
  if (err instanceof GateNotMetError) return reply.code(409).send({ error: "gate_not_met", gateId: err.gateId, unmet: err.unmet });
  if (err instanceof DecisionNotApplicableError) return reply.code(409).send({ error: "decision_not_applicable" });
  if (err instanceof GitHubNotConnectedError) return reply.code(404).send({ error: "github_not_connected" });
  if (err instanceof GitHubRepoNotFoundError) return reply.code(404).send({ error: "repo_not_found" });
  if (err instanceof GitHubRejectedError) return reply.code(502).send({ error: "github_rejected" });
  if (err instanceof GitHubUnavailableError) return reply.code(503).send({ error: "github_unavailable" });
  if (err instanceof AlreadyDecidedError) return reply.code(409).send({ error: "already_decided" });
  if (err instanceof ShuttingDownError) return reply.code(503).send({ error: "shutting_down" });
  // A linked machine's reply could not be read: fixed code, never the reply.
  if (err instanceof LinkProtocolError) return reply.code(502).send({ error: "machine_bad_reply" });
  // Linked machines: fixed codes. An address or a machine's reply is never echoed.
  if (err instanceof LinkingDisabledError) return reply.code(409).send({ error: "linking_disabled" });
  if (err instanceof IdentityUnavailableError) return reply.code(503).send({ error: "identity_unavailable" });
  if (err instanceof PairingCodeMismatchError) return reply.code(400).send({ error: "pairing_code_mismatch" });
  if (err instanceof PairingRejectedError) return reply.code(403).send({ error: "pairing_rejected" });
  if (err instanceof NoPairingError) return reply.code(404).send({ error: "no_pairing" });
  if (err instanceof SelfPairingError) return reply.code(400).send({ error: "self_pairing" });
  if (err instanceof MachineUnreachableError) return reply.code(502).send({ error: "machine_unreachable" });
  if (err instanceof MachineKeyMismatchError) return reply.code(409).send({ error: "machine_key_mismatch" });
  // Remote runs, requester side: the worker's code and this computer's name for it, never the worker's message.
  if (err instanceof RemoteRunRefusedError) return reply.code(err.status).send({ error: "remote_refused", code: err.code, machine: err.machine });
  if (err instanceof RemoteRefusedError) return reply.code(502).send({ error: "machine_refused" });
  // Remote runs, worker side: a repository sent by a paired machine.
  if (err instanceof RepoTooLargeError) return reply.code(413).send({ error: "repo_too_large" });
  if (err instanceof BundleInvalidError) return reply.code(400).send({ error: "bundle_invalid" });
  if (err instanceof BundleGitLimitError) return reply.code(503).send({ error: "bundle_git_limit" });
  if (err instanceof NoRepoError) return reply.code(409).send({ error: "no_repo" });
  if (err instanceof UploadLimitError) return reply.code(409).send({ error: "upload_limit" });
  // The share view. Fixed codes only: never a path, an id, or the page.
  if (err instanceof PreviewNotFoundError) return reply.code(404).send({ error: "preview_not_found" });
  if (err instanceof PreviewStaleError) return reply.code(409).send({ error: "preview_stale" });
  if (err instanceof SnapshotMissingError) return reply.code(404).send({ error: "snapshot_missing" });
  if (err instanceof SnapshotTamperedError) return reply.code(409).send({ error: "snapshot_tampered" });
  if (err instanceof ShareTooLargeError) return reply.code(409).send({ error: "share_too_large" });
  if (err instanceof ShareNotCleanError) {
    log.warn("a share page was refused: it could not be proven clean"); // the page itself is never logged
    return reply.code(409).send({ error: "share_not_clean" });
  }
  if (err instanceof ShareLinkActiveError) return reply.code(409).send({ error: "share_link_active" });
  if (err instanceof AddressNotAllowedError) return reply.code(400).send({ error: "invalid_input" });
  if (err instanceof LinkNotActiveError) return reply.code(409).send({ error: "link_not_active" });
  if (err instanceof LedgerReadOnlyError) {
    return reply.code(423).send({ error: "ledger_read_only" });
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return reply.code(status).send({ error: "invalid_input" });
  }
  log.error(err);
  return reply.code(500).send({ error: "internal" });
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { board, gates, ledger, getIntegrity } = deps;

  app.setErrorHandler((err, _req, reply) => sendError(err, reply, app.log));

  app.get("/api/health", needs("viewer"), async () => {
    const integrity = getIntegrity();
    const headSeq = ledger.headSeq();
    return integrity.ok
      ? { ok: true, integrity: "ok", readOnly: ledger.readOnly, headSeq }
      : {
          ok: true,
          integrity: "broken",
          brokenAtSeq: integrity.brokenAtSeq,
          readOnly: ledger.readOnly,
          headSeq,
        };
  });

  app.get("/api/projects", needs("viewer"), async () => board.listProjects());

  app.post("/api/projects", needs("maintainer"), async (req, reply) => {
    const project = board.createProject(actorOf(req), req.body as never);
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/board", needs("viewer"), async (req) => board.getBoard(req.params.id));

  app.post<{ Params: { id: string } }>("/api/projects/:id/cards", needs("maintainer"), async (req, reply) => {
    const { stage } = cardInputSchema.parse(req.body);
    // A card created in Ship or Operate would skip the gates a move there runs. The intake's approved plan still
    // creates cards in those stages (IntakeService.complete), because approving the plan is itself a recorded
    // human decision; only this direct path is refused.
    if (stageHasEntryGates(stage)) {
      return reply.code(409).send({ error: "stage_gated", message: STAGE_GATED });
    }
    const card = board.addCard(actorOf(req), req.params.id, req.body as never);
    return reply.code(201).send(card);
  });

  // Through the gates only: BoardService.moveCard is for tests and internal use. The person asking is the signer.
  app.post<{ Params: { id: string } }>("/api/cards/:id/move", needs("reviewer"), async (req) => {
    const body = moveBody.parse(req.body);
    return gates.move(actorOf(req), req.params.id, body.to, body.gates, signerOf(req));
  });

  app.get<{ Params: { id: string } }>("/api/cards/:id/gates", needs("viewer"), async (req) =>
    gates.evaluate(req.params.id, gatesQuery.parse(req.query).to, signerOf(req)),
  );

  app.post<{ Params: { id: string } }>("/api/cards/:id/status", needs("maintainer"), async (req) =>
    board.setCardStatus(actorOf(req), req.params.id, statusBody.parse(req.body).to),
  );

  // A collaborator's copy of a connection entry has no config or field names (trimForRole); the Owner's is whole.
  app.get("/api/ledger", needs("viewer"), async (req) => {
    const q = ledgerQuery.parse(req.query);
    const trim = trimmerFor(req.principal);
    return ledger
      .list({
        ...(q.projectId !== undefined && { projectId: q.projectId }),
        ...(q.afterSeq !== undefined && { afterSeq: q.afterSeq }),
        ...(q.beforeSeq !== undefined && { beforeSeq: q.beforeSeq }),
        ...(q.limit !== undefined && { limit: q.limit }),
      })
      .map((e) => trim(displayEntry(e, deps.clean)));
  });
}
