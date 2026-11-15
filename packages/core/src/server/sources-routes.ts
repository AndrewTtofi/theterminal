import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { OWNER_ID, type GitHubRepoChoice } from "@theterminal/shared";
import type { Db } from "../db.js";
import { NotFoundError } from "../board/board-service.js";
import { getProjectSource } from "../events/projections.js";
import type { SourceService } from "../sources/service.js";
import type { WritebackService } from "../sources/writeback.js";
import { actorOf, needs, requireRole } from "./auth.js";

export type SourcesRouteDeps = {
  db: Db;
  sources: Pick<SourceService, "createFromGitHub" | "createFromFolder" | "openUpload" | "putUploadFile" | "commitUpload" | "cancelUpload" | "projectFiles">;
  writeback: Pick<WritebackService, "accept" | "preview" | "apply" | "publish">;
  github: { listRepos(): Promise<GitHubRepoChoice[]> };
  /** The host's folder picker (the desktop app); absent on a headless server, which answers folder_picker_unavailable. */
  pickFolder?: () => Promise<string | null>;
};

/** 403 `local_only` unless the request came in on the local listener (this computer). */
export const localOnly: preHandlerAsyncHookHandler = async (request, reply) => {
  if (request.listener !== "local") return reply.code(403).send({ error: "local_only" });
};

const REPO = z.string().min(3).max(200);
const NAME = z.string().min(1).max(120);
const githubBody = z.object({ repo: REPO, name: NAME.optional(), includeSecrets: z.boolean().optional() }).strict();
const folderBody = z.object({ path: z.string().min(1).max(4096), name: NAME.optional(), includeSecrets: z.boolean().optional() }).strict();
const uploadBody = z.object({
  files: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  includeSecrets: z.boolean(),
}).strict();
const fileQuery = z.object({ path: z.string().min(1).max(1024) });
const headBody = z.object({ head: z.string().min(1).max(64) }).strict();
const emptyBody = z.object({}).strict().optional();

/** The owner-only routes that also refuse the remote listener: the role check first, then the listener. */
const ownerLocal = { preHandler: [requireRole("owner"), localOnly] };

/**
 * Home's project files, projects from GitHub or a folder, uploads, accepting a run, and writing accepted work back
 * to the source. The folder path of a folder source is sent to the Owner alone. Errors are mapped by the handler in
 * routes.ts: fixed codes, nothing from the request echoed.
 */
export function registerSourcesRoutes(app: FastifyInstance, deps: SourcesRouteDeps): void {
  const { db, sources, writeback, github } = deps;
  const requireProject = (id: string) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new NotFoundError("project", "(given)");
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/files", needs("reviewer"), async (req) =>
    sources.projectFiles(req.params.id, req.principal),
  );

  // Where the project's files came from; the folder's path for the Owner alone.
  app.get<{ Params: { id: string } }>("/api/projects/:id/source", needs("reviewer"), async (req) => {
    requireProject(req.params.id);
    const s = getProjectSource(db, req.params.id);
    if (s === null) return { source: null };
    if (s.kind === "github") return { source: { kind: "github", repo: s.repo ?? "", branch: s.branch ?? "" } };
    const owner = req.principal?.personId === OWNER_ID;
    return { source: owner && s.path !== null ? { kind: "folder", path: s.path } : { kind: "folder" } };
  });

  app.get("/api/github/repos", needs("maintainer"), async () => ({ repos: await github.listRepos() }));

  app.post("/api/projects/from-github", needs("maintainer"), async (req, reply) => {
    const body = githubBody.parse(req.body);
    const imported = await sources.createFromGitHub(actorOf(req), {
      repo: body.repo, ...(body.name !== undefined && { name: body.name }), ...(body.includeSecrets !== undefined && { includeSecrets: body.includeSecrets }),
    });
    return reply.code(201).send(imported);
  });

  app.post("/api/projects/from-folder", ownerLocal, async (req, reply) => {
    const body = folderBody.parse(req.body);
    const imported = await sources.createFromFolder(actorOf(req), {
      path: body.path, ...(body.name !== undefined && { name: body.name }), ...(body.includeSecrets !== undefined && { includeSecrets: body.includeSecrets }),
    });
    return reply.code(201).send(imported);
  });

  app.post("/api/host/pick-folder", ownerLocal, async (req, reply) => {
    emptyBody.parse(req.body ?? undefined);
    if (!deps.pickFolder) return reply.code(404).send({ error: "folder_picker_unavailable" });
    return { path: await deps.pickFolder() };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/uploads", needs("maintainer"), async (req, reply) => {
    const body = uploadBody.parse(req.body);
    return reply.code(201).send(sources.openUpload(actorOf(req), req.params.id, body));
  });

  app.register(async (scope) => {
    // The file arrives as a raw body: the service streams it into staging itself, counting bytes, so nothing holds a
    // whole upload in memory (no body limit applies to a body the parser leaves unread).
    scope.addContentTypeParser("application/octet-stream", (_request, _payload, done) => done(null, undefined));

    scope.put<{ Params: { id: string } }>("/api/uploads/:id/file", needs("maintainer"), async (req, reply) => {
      try {
        const { path } = fileQuery.parse(req.query);
        // Answered 415 `invalid_input` by the error handler: a body some other parser already read is not a file.
        if (!isOctetStream(req)) throw Object.assign(new Error("the body must be application/octet-stream"), { statusCode: 415 });
        await sources.putUploadFile(actorOf(req), req.params.id, path, req.raw);
      } catch (err) {
        closeAfterReply(req, reply);
        throw err;
      }
      return reply.code(204).send();
    });
  });

  app.post<{ Params: { id: string } }>("/api/uploads/:id/commit", needs("maintainer"), async (req) => {
    emptyBody.parse(req.body ?? undefined);
    return sources.commitUpload(actorOf(req), req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/uploads/:id", needs("maintainer"), async (req, reply) => {
    sources.cancelUpload(actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/accept", needs("maintainer"), async (req) => {
    emptyBody.parse(req.body ?? undefined);
    return writeback.accept(actorOf(req), req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/writeback", needs("owner"), async (req) => {
    requireProject(req.params.id);
    return writeback.preview(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/apply", ownerLocal, async (req) => {
    const { head } = headBody.parse(req.body);
    requireProject(req.params.id);
    return writeback.apply(actorOf(req), req.params.id, head);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/publish", needs("owner"), async (req) => {
    const { head } = headBody.parse(req.body);
    requireProject(req.params.id);
    return writeback.publish(actorOf(req), req.params.id, head);
  });
}

function isOctetStream(req: FastifyRequest): boolean {
  const type = req.headers["content-type"];
  return typeof type === "string" && type.split(";")[0]!.trim().toLowerCase() === "application/octet-stream";
}

/** The rest of a refused body is never read: the connection closes once the refusal is sent. */
function closeAfterReply(req: FastifyRequest, reply: FastifyReply): void {
  reply.header("connection", "close");
  reply.raw.once("finish", () => req.raw.socket?.destroy());
}
