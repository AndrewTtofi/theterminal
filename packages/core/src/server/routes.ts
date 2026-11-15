import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { cardStatusSchema, stageSchema } from "@theterminal/shared";
import { LedgerReadOnlyError, type Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService, NotFoundError } from "../board/board-service.js";
import { AlreadyDecidedError } from "../agents/approvals.js";
import { AdapterUnavailableError, DuplicateCloudProviderError, DuplicateMcpServerError, McpUnsupportedError, ShuttingDownError } from "../agents/runner.js";
import { CloudCredentialError } from "../connections/cloud/grant.js";
import { redact } from "../agents/redact.js";
import {
  ConflictError, ConnectionDisabledError, SecretInConfigError, UnknownFieldError, UnsupportedConnectionError,
} from "../connections/service.js";
import { SecretStoreUnavailableError } from "../secrets/store.js";
import {
  DecisionNotApplicableError, HumanRequiredError, IntakeCompletedError, IntakeIncompleteError, NoIntakeError,
  SecretInTextError,
} from "../intake/service.js";
import {
  GitHubNotConnectedError, GitHubRejectedError, GitHubRepoNotFoundError, GitHubUnavailableError,
} from "../github/client.js";

export type RouteDeps = {
  board: BoardService;
  ledger: Ledger;
  getIntegrity: () => VerifyResult;
};

const actor = { kind: "human", id: "owner" } as const;

const moveBody = z.object({ to: stageSchema });
const statusBody = z.object({ to: cardStatusSchema });
const ledgerQuery = z.object({
  projectId: z.string().optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
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

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { board, ledger, getIntegrity } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_input", issues: err.issues.map(publicIssue) });
    }
    if (err instanceof AdapterUnavailableError) return reply.code(400).send({ error: "invalid_input" });
    if (err instanceof ConflictError) return reply.code(409).send({ error: "conflict" });
    if (err instanceof SecretInConfigError) return reply.code(400).send({ error: "secret_in_config" });
    if (err instanceof UnknownFieldError) return reply.code(400).send({ error: "invalid_input" });
    if (err instanceof UnsupportedConnectionError) return reply.code(400).send({ error: "connection_unsupported" });
    if (err instanceof ConnectionDisabledError) return reply.code(400).send({ error: "connection_disabled" });
    if (err instanceof McpUnsupportedError) return reply.code(400).send({ error: "mcp_unsupported", adapter: err.adapter });
    if (err instanceof DuplicateMcpServerError) return reply.code(400).send({ error: "duplicate_mcp_server" });
    if (err instanceof DuplicateCloudProviderError) return reply.code(400).send({ error: "duplicate_cloud_provider" });
    // The name passed the connection name check when it was stored, so it is safe to show; the reason is not sent.
    if (err instanceof CloudCredentialError) return reply.code(502).send({ error: "cloud_credentials_failed", name: err.connectionName });
    if (err instanceof SecretStoreUnavailableError) return reply.code(503).send({ error: "keychain_unavailable" });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
    if (err instanceof NoIntakeError) return reply.code(404).send({ error: "no_intake" });
    if (err instanceof HumanRequiredError) return reply.code(403).send({ error: "human_required" });
    if (err instanceof SecretInTextError) return reply.code(400).send({ error: "secret_in_text" });
    if (err instanceof IntakeCompletedError) return reply.code(409).send({ error: "intake_completed" });
    if (err instanceof IntakeIncompleteError) return reply.code(409).send({ error: "intake_incomplete", missing: err.missing });
    if (err instanceof DecisionNotApplicableError) return reply.code(409).send({ error: "decision_not_applicable" });
    if (err instanceof GitHubNotConnectedError) return reply.code(404).send({ error: "github_not_connected" });
    if (err instanceof GitHubRepoNotFoundError) return reply.code(404).send({ error: "repo_not_found" });
    if (err instanceof GitHubRejectedError) return reply.code(502).send({ error: "github_rejected" });
    if (err instanceof GitHubUnavailableError) return reply.code(503).send({ error: "github_unavailable" });
    if (err instanceof AlreadyDecidedError) return reply.code(409).send({ error: "already_decided" });
    if (err instanceof ShuttingDownError) return reply.code(503).send({ error: "shutting_down" });
    if (err instanceof LedgerReadOnlyError) {
      return reply.code(423).send({ error: "ledger_read_only" });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "invalid_input" });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  app.get("/api/health", async () => {
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

  app.get("/api/projects", async () => board.listProjects());

  app.post("/api/projects", async (req, reply) => {
    const project = board.createProject(actor, req.body as never);
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/board", async (req) =>
    board.getBoard(req.params.id),
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/cards", async (req, reply) => {
    const card = board.addCard(actor, req.params.id, req.body as never);
    return reply.code(201).send(card);
  });

  app.post<{ Params: { id: string } }>("/api/cards/:id/move", async (req) =>
    board.moveCard(actor, req.params.id, moveBody.parse(req.body).to),
  );

  app.post<{ Params: { id: string } }>("/api/cards/:id/status", async (req) =>
    board.setCardStatus(actor, req.params.id, statusBody.parse(req.body).to),
  );

  app.get("/api/ledger", async (req) => {
    const q = ledgerQuery.parse(req.query);
    return ledger.list({
      ...(q.projectId !== undefined && { projectId: q.projectId }),
      ...(q.afterSeq !== undefined && { afterSeq: q.afterSeq }),
      ...(q.limit !== undefined && { limit: q.limit }),
    });
  });
}
