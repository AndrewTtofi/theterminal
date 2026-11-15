import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fileDiff, listChanges, listDir, readFile, type ChangesDeps } from "../changes/changes.js";
import { needs } from "./auth.js";

export type ChangesRouteDeps = ChangesDeps;

const pathQuery = z.object({ path: z.string().max(4096) });
const dirQuery = z.object({ path: z.string().max(4096).default("") });

/**
 * Read-only views of a run's working copy, for a reviewer and above: file contents are not a viewer's. Behind the
 * default-deny auth; errors are mapped by the handler in
 * routes.ts (a refused path is a bare 404 `not_found`, a missing working copy 404 `worktree_missing`, no fork
 * point 409 `no_base`).
 */
export function registerChangesRoutes(app: FastifyInstance, deps: ChangesRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/runs/:id/changes", needs("reviewer"), async (req) => listChanges(deps, req.params.id));

  app.get<{ Params: { id: string } }>("/api/runs/:id/diff", needs("reviewer"), async (req) => {
    const { path } = pathQuery.parse(req.query);
    return fileDiff(deps, req.params.id, path);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/files", needs("reviewer"), async (req) => {
    const { path } = dirQuery.parse(req.query);
    return listDir(deps, req.params.id, path);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/file", needs("reviewer"), async (req) => {
    const { path } = pathQuery.parse(req.query);
    return readFile(deps, req.params.id, path);
  });
}
