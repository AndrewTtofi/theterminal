import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { DEFAULT_SHARE_OPTIONS, shareOptionsSchema } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { projectDigests } from "../share/digests.js";
import { SHARE_HEADER_CSP } from "../share/render.js";
import type { ShareService } from "../share/service.js";
import { actorOf, needs } from "./auth.js";

export type ShareRouteDeps = { db: Db; ledger: Ledger; share: ShareService };

const previewBody = shareOptionsSchema.partial();
const confirmBody = z
  .object({ previewId: z.string().min(1).max(200), contentHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const digestsQuery = z
  .object({ days: z.enum(["7", "14", "30"]).default("7") })
  .strict()
  .transform((q) => ({ days: Number(q.days) as 7 | 14 | 30 }));

type Params = { Params: { id: string } };

/** A saved page, with the link server's headers, which keep it inert even if it were opened on the app's own origin. */
function sendPage(reply: FastifyReply, html: string): FastifyReply {
  return reply
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", SHARE_HEADER_CSP)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "no-store")
    .send(html);
}

/**
 * The share page (preview, confirm, saved pages) and the daily digests. Behind the default-deny auth; errors are
 * mapped by the handler in routes.ts.
 */
export function registerShareRoutes(app: FastifyInstance, deps: ShareRouteDeps): void {
  const { db, ledger, share } = deps;

  // Only the Owner decides what leaves the machine: the preview and the confirm are theirs; the saved pages anyone's.
  app.post<Params>("/api/projects/:id/share/preview", needs("owner"), async (req) => {
    const options = { ...DEFAULT_SHARE_OPTIONS, ...previewBody.parse(req.body ?? {}) };
    const p = await share.preview(req.params.id, options);
    return { previewId: p.previewId, contentHash: p.contentHash, bytes: p.bytes, expiresAt: p.expiresAt, html: p.html, snapshot: p.snapshot };
  });

  app.post<Params>("/api/projects/:id/share/confirm", needs("owner"), async (req, reply) => {
    const { previewId, contentHash } = confirmBody.parse(req.body);
    return reply.code(201).send(share.confirm(actorOf(req), req.params.id, previewId, contentHash));
  });

  app.get<Params>("/api/projects/:id/share/snapshots", needs("viewer"), async (req) => share.list(req.params.id));

  app.get<Params>("/api/share/snapshots/:id", needs("viewer"), async (req, reply) => sendPage(reply, share.readHtml(req.params.id)));

  app.get<Params>("/api/share/snapshots/:id/download", needs("viewer"), async (req, reply) => {
    const html = share.readHtml(req.params.id); // the id passed the id check, so it is safe in the file name
    return sendPage(reply.header("content-disposition", `attachment; filename="theterminal-share-${req.params.id.slice(0, 8)}.html"`), html);
  });

  app.get<Params>("/api/projects/:id/digests", needs("viewer"), async (req) =>
    projectDigests(db, ledger, req.params.id, digestsQuery.parse(req.query).days),
  );
}
