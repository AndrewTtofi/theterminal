import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEVICES, DEVICE_IDS, PREVIEW_LIMITS, viewport, type NativeTools } from "@theterminal/shared";
import type { Db } from "../db.js";
import { NotFoundError } from "../board/board-service.js";
import { getPreview, getRun, listScreenshots, screenshotProject } from "../events/projections.js";
import type { PreviewService } from "../preview/service.js";
import { screenshotFile } from "../preview/screenshots.js";
import { actorOf, requireRole } from "./auth.js";
import type { PreviewHost } from "./preview-host.js";
import { localOnly } from "./sources-routes.js";
import { previewCsp, serveIndex } from "./static-ui.js";

/** There is no desktop app to show or capture device views (a headless server, or the app refused). */
export class PreviewHostUnavailableError extends Error {
  constructor() {
    super("live device views need the desktop app");
    this.name = "PreviewHostUnavailableError";
  }
}

export type PreviewRouteDeps = {
  db: Db;
  dataDir: string;
  previews: Pick<PreviewService, "plan" | "start" | "view" | "stop" | "seen" | "screenshot">;
  /** The desktop app's device views; absent on a headless server. */
  previewHost?: PreviewHost;
  /** What this computer has for phone app previews (detectTools). */
  nativeTools: () => Promise<NativeTools>;
  /** The built UI, whose index.html the preview page serves; absent when the server serves no UI. */
  uiDir?: string;
};

const ID = z.string().min(1).max(200);
const KIND = z.enum(["web", "ios", "android"]);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const TARGET = z.string().min(1).max(200);
const COORD = z.number().finite().min(0).max(20_000);

const planQuery = z.object({ kind: KIND, target: TARGET.optional() }).strict();
const startBody = z.object({ kind: KIND, key: SHA256, target: TARGET.optional() }).strict();
const stopBody = z.object({ reason: z.enum(["person", "tab_closed"]) }).strict();
const emptyBody = z.object({}).strict();
const screenshotQuery = z.object({ runId: ID }).strict();
const screenshotParams = z.object({ sha: SHA256 });
const viewsBody = z
  .object({
    previewId: ID,
    action: z.enum(["show", "hide", "reload", "close"]),
    devices: z
      .array(z.object({ device: z.enum(DEVICE_IDS as [string, ...string[]]), rotated: z.boolean(), x: COORD, y: COORD, width: COORD, height: COORD }).strict())
      .max(PREVIEW_LIMITS.maxDevices),
  })
  .strict();

type Params = { Params: { id: string } };

const local = (min: Parameters<typeof requireRole>[0]) => ({ preHandler: [requireRole(min), localOnly] });

/**
 * Previews, their screenshots and the desktop app's device views (plan 12's contract). Every preview and host route
 * is on the local listener only. Starting, stopping and screenshotting are a maintainer's at least, and the service
 * lets only the Owner or the person who started the run (Ruling 13); watching is a reviewer's. Screenshots are read
 * by viewers, a file only for a recorded (screenshot, run) pair. Errors are mapped by the handler in routes.ts: fixed
 * codes, never a command, a path or a program's output.
 */
export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewRouteDeps): void {
  const { db, previews, previewHost } = deps;

  app.get<Params>("/api/runs/:id/preview/plan", local("maintainer"), async (req) => {
    const q = planQuery.parse(req.query);
    return previews.plan(actorOf(req), req.params.id, q.kind, q.target);
  });

  app.post<Params>("/api/runs/:id/preview", local("maintainer"), async (req, reply) => {
    const body = startBody.parse(req.body);
    const { view, created } = await previews.start(actorOf(req), req.params.id, {
      kind: body.kind, key: body.key, ...(body.target !== undefined && { target: body.target }),
    });
    return reply.code(created ? 201 : 200).send(view);
  });

  app.get<Params>("/api/previews/:id", local("reviewer"), async (req) => previews.view(req.params.id));

  app.post<Params>("/api/previews/:id/stop", local("maintainer"), async (req, reply) => {
    const { reason } = stopBody.parse(req.body);
    await previews.stop(actorOf(req), req.params.id, reason);
    return reply.code(204).send();
  });

  app.post<Params>("/api/previews/:id/seen", local("reviewer"), async (req, reply) => {
    emptyBody.parse(req.body ?? {});
    previews.seen(req.params.id);
    return reply.code(204).send();
  });

  app.post<Params>("/api/previews/:id/screenshots", local("maintainer"), async (req, reply) => {
    emptyBody.parse(req.body ?? {});
    const screenshots = await previews.screenshot(actorOf(req), req.params.id);
    return reply.code(201).send({ screenshots });
  });

  app.get<Params>("/api/runs/:id/screenshots", { preHandler: requireRole("viewer") }, async (req) => {
    if (getRun(db, req.params.id) === null) throw new NotFoundError("run", "(given)");
    return { screenshots: listScreenshots(db, req.params.id) };
  });

  app.get<{ Params: { sha: string } }>("/api/screenshots/:sha", { preHandler: requireRole("viewer") }, async (req, reply) => {
    const { sha } = screenshotParams.parse(req.params);
    const { runId } = screenshotQuery.parse(req.query);
    const projectId = screenshotProject(db, runId, sha);
    const file = projectId === null ? null : screenshotFile(deps.dataDir, projectId, sha);
    if (file === null) throw new NotFoundError("screenshot", "(given)");
    let png: Buffer;
    try {
      png = readFileSync(file);
    } catch {
      throw new NotFoundError("screenshot", "(given)");
    }
    return reply
      .header("content-type", "image/png")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .header("cache-control", "private, max-age=86400")
      .send(png);
  });

  app.get("/api/host/capabilities", local("reviewer"), async () => ({ previewViews: previewHost !== undefined }));

  /**
   * Lays (or hides, reloads, closes) the device views of a website preview over the Preview tab. The origin is the
   * recorded one, never the request's; showing and reloading need the preview ready, while hiding and closing work on
   * an ended one too, so the views always go.
   */
  app.post("/api/host/preview-views", local("reviewer"), async (req, reply) => {
    const body = viewsBody.parse(req.body);
    if (previewHost === undefined) throw new PreviewHostUnavailableError();
    const rec = getPreview(db, body.previewId);
    const showing = body.action === "show" || body.action === "reload";
    if (rec === null || rec.kind !== "web" || rec.origin === null || (showing && rec.state !== "ready")) {
      throw new NotFoundError("preview", "(given)");
    }
    const views = body.devices.map((d) => {
      const device = DEVICES[d.device as keyof typeof DEVICES];
      return {
        device: d.device, x: d.x, y: d.y, width: d.width, height: d.height, viewport: viewport(d.device as keyof typeof DEVICES, d.rotated),
        scale: device.scale, mobile: device.mobile, userAgent: device.userAgent,
      };
    });
    const ok = await previewHost.views({ previewId: rec.id, origin: rec.origin, action: body.action, views });
    if (!ok) throw new PreviewHostUnavailableError();
    return reply.code(204).send();
  });

  app.get("/api/host/native-tools", local("owner"), async () => deps.nativeTools());

  // The Preview tab's page in a browser (Ruling 23): the UI under a policy that frames exactly this preview's origin.
  app.get<Params>("/preview/:id", local("reviewer"), async (req, reply) => {
    const rec = getPreview(db, req.params.id);
    if (deps.uiDir === undefined || rec === null || rec.kind !== "web" || rec.state !== "ready" || rec.origin === null) {
      throw new NotFoundError("preview", "(given)");
    }
    return serveIndex(reply, previewCsp(rec.origin), deps.uiDir);
  });
}
