import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { NotFoundError } from "../board/board-service.js";
import { cardStory, ledgerExportLines } from "../story/story.js";
import { trimmerFor } from "../ledger/trim.js";
import { needs } from "./auth.js";

export type StoryRouteDeps = {
  db: Db;
  ledger: Ledger;
  /** This machine's redaction, for a linked machine's mirrored entries. Default: the built-in patterns. */
  clean?: (s: string) => string;
};

const exportQuery = z.object({ projectId: z.string().max(200).optional() });

/** Only an id of this shape reaches the download's filename; project ids are UUIDs. */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A card's story and the audit export. Behind the default-deny auth; errors are mapped by the handler in routes.ts. */
export function registerStoryRoutes(app: FastifyInstance, deps: StoryRouteDeps): void {
  const { db, ledger } = deps;

  app.get<{ Params: { id: string } }>("/api/cards/:id/story", needs("viewer"), async (req) =>
    cardStory(db, ledger, req.params.id, deps.clean, trimmerFor(req.principal)),
  );

  // The export carries names: a reviewer's, not a viewer's.
  app.get("/api/ledger/export", needs("reviewer"), async (req, reply) => {
    const { projectId } = exportQuery.parse(req.query);
    // Only a project that exists is exported or named; the id given is never echoed.
    if (projectId !== undefined && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new NotFoundError("project", "(given)");
    }
    const name = projectId === undefined ? "all" : SAFE_ID.test(projectId) ? projectId : "project";
    return reply
      .header("content-type", "application/x-ndjson")
      .header("content-disposition", `attachment; filename="theterminal-ledger-${name}.ndjson"`)
      .header("cache-control", "no-store")
      .send(Readable.from(ledgerExportLines(db, ledger, projectId ?? null, new Date(), deps.clean, trimmerFor(req.principal)), { objectMode: false }));
  });
}
