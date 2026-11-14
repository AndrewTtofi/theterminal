import type { FastifyInstance } from "fastify";
import { z, ZodError, type ZodIssue } from "zod";
import { cardStatusSchema, stageSchema } from "@theterminal/shared";
import { LedgerReadOnlyError, type Ledger, type VerifyResult } from "../ledger/ledger.js";
import { BoardService, NotFoundError } from "../board/board-service.js";
import { AlreadyDecidedError } from "../agents/approvals.js";
import { AdapterUnavailableError, ShuttingDownError } from "../agents/runner.js";
import { redact } from "../agents/redact.js";
import { ConflictError, SecretInConfigError, UnknownFieldError } from "../connections/service.js";
import { SecretStoreUnavailableError } from "../secrets/store.js";

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

/**
 * A zod issue as the client sees it: path, code and message only. Nothing the request sent is echoed: no
 * `received`, record keys that are not plain field names become "*", and the default messages that quote the
 * input (an enum value, unknown keys) are replaced.
 */
function publicIssue(issue: ZodIssue): { path: (string | number)[]; code: string; message: string } {
  const path = issue.path.map((p) => (typeof p === "number" || (PLAIN_SEGMENT.test(p) && redact(p) === p) ? p : "*"));
  let message = issue.message;
  if (issue.code === "invalid_enum_value") message = `Invalid enum value. Expected ${issue.options.map((o) => `'${String(o)}'`).join(" | ")}`;
  else if (issue.code === "unrecognized_keys") message = "Unrecognized key(s) in object";
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
    if (err instanceof SecretStoreUnavailableError) return reply.code(503).send({ error: "keychain_unavailable" });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
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
