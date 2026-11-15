import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { DEFAULT_SHARE_OPTIONS, shareOptionsSchema } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { projectDigests } from "../share/digests.js";
import { SHARE_CSP } from "../share/render.js";
import type { ShareService } from "../share/service.js";

export type ShareRouteDeps = { db: Db; ledger: Ledger; share: ShareService };

const actor = { kind: "human", id: "owner" } as const;

const previewBody = shareOptionsSchema.partial();
const confirmBody = z
  .object({ previewId: z.string().min(1).max(200), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const digestsQuery = z
  .object({ days: z.enum(["7", "14", "30"]).default("7") })
  .strict()
  .transform((q) => ({ days: Number(q.days) as 7 | 14 | 30 }));

type Params = { Params: { id: string } };

/** A saved page, with headers that keep it inert even if it were opened on the app's own origin. */
function sendPage(reply: FastifyReply, html: string): FastifyReply {
  return reply
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", SHARE_CSP)
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "no-store")
    .send(html);
}

/**
 * The share page (preview, confirm, saved pages) and the daily digests. Behind the default-deny auth; errors are
 * mapped by the handler in routes.ts.
 */
export function registerShareRoutes(app: FastifyInstance, deps: ShareRouteDeps): void {
  const { db, ledger, share } = deps;

  app.post<Params>("/api/projects/:id/share/preview", async (req) => {
    const options = { ...DEFAULT_SHARE_OPTIONS, ...previewBody.parse(req.body ?? {}) };
    const p = await share.preview(req.params.id, options);
    return { previewId: p.previewId, contentHash: p.contentHash, bytes: p.bytes, expiresAt: p.expiresAt, html: p.html, snapshot: p.snapshot };
  });

  app.post<Params>("/api/projects/:id/share/confirm", async (req, reply) => {
    const { previewId, contentHash } = confirmBody.parse(req.body);
    return reply.code(201).send(share.confirm(actor, req.params.id, previewId, contentHash));
  });

  app.get<Params>("/api/projects/:id/share/snapshots", async (req) => share.list(req.params.id));

  app.get<Params>("/api/share/snapshots/:id", async (req, reply) => sendPage(reply, share.readHtml(req.params.id)));

  app.get<Params>("/api/share/snapshots/:id/download", async (req, reply) => {
    const html = share.readHtml(req.params.id); // the id passed the id check, so it is safe in the file name
    return sendPage(reply.header("content-disposition", `attachment; filename="theterminal-share-${req.params.id.slice(0, 8)}.html"`), html);
  });

  app.get<Params>("/api/projects/:id/digests", async (req) =>
    projectDigests(db, ledger, req.params.id, digestsQuery.parse(req.query).days),
  );
}
