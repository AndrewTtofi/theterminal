import { createReadStream, rmSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LinkProtocolDeps } from "../protocol-routes.js";
import { LinkWorker } from "../worker.js";

type RunParams = { runId: string };
type ActionParams = { runId: string; actionId: string };

/** The JSON body of a start: a 20 000-character prompt escaped as JSON can pass the listener's 64 KiB default. */
const START_BODY_LIMIT = 256 * 1024;

/** The paired machine this request came from; the listener's hook already refused any other, checked again here. */
function peerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const peer = request.linkPeer?.machineId ?? null;
  if (peer === null) void reply.code(403).send({ error: "unknown_machine" });
  return peer;
}

/**
 * The remote-run routes a paired requester calls on this computer (the worker). Each checks the run id with the
 * runner's pattern before any path is built and acts only on runs accepted from the machine whose pin opened the
 * connection; errors are answered by the listener's error handler (the workspace server's codes).
 */
export function registerRuns(app: FastifyInstance, deps: LinkProtocolDeps): void {
  const worker = deps.worker;
  if (worker === undefined) return;
  // Each listener start: uploads left from before (expired, without an owner, or cut off by a crash) are removed.
  worker.sweep();

  app.register(async (scope) => {
    // The repository arrives as a raw body: the route streams it to a file itself, counting bytes (no body limit
    // applies to a body the parser leaves unread).
    scope.addContentTypeParser("application/octet-stream", (_request, _payload, done) => done(null, undefined));

    scope.post<{ Params: RunParams }>("/link/v1/runs/:runId/repo", async (request, reply) => {
      const peer = peerOf(request, reply);
      if (peer === null) return reply;
      const runId = LinkWorker.runId(request.params.runId);
      try {
        await worker.receiveRepo(peer, runId, request.raw, request.headers["content-length"]);
      } catch (err) {
        // The rest of the body is never read: the connection closes once the refusal is sent.
        reply.header("connection", "close");
        reply.raw.once("finish", () => request.raw.socket.destroy());
        throw err;
      }
      return reply.code(204).send();
    });
  });

  app.post<{ Params: RunParams }>("/link/v1/runs/:runId/start", { bodyLimit: START_BODY_LIMIT }, async (request, reply) => {
    const peer = peerOf(request, reply);
    if (peer === null) return reply;
    const run = await worker.acceptRun(peer, LinkWorker.runId(request.params.runId), request.body);
    return reply.code(201).send(run);
  });

  app.get<{ Params: RunParams; Querystring: { afterSeq?: string } }>("/link/v1/runs/:runId/events", (request, reply) => {
    const peer = peerOf(request, reply);
    if (peer === null) return reply;
    const { runId, afterSeq } = worker.openStream(peer, request.params.runId, request.query.afterSeq);
    reply.hijack();
    worker.pipeStream(runId, afterSeq, reply.raw);
    return reply;
  });

  app.post<{ Params: ActionParams }>("/link/v1/runs/:runId/actions/:actionId/decision", async (request, reply) => {
    const peer = peerOf(request, reply);
    if (peer === null) return reply;
    return worker.decide(peer, request.params.runId, request.params.actionId, request.body);
  });

  app.post<{ Params: RunParams }>("/link/v1/runs/:runId/stop", async (request, reply) => {
    const peer = peerOf(request, reply);
    if (peer === null) return reply;
    return worker.stop(peer, request.params.runId);
  });

  app.get<{ Params: RunParams }>("/link/v1/runs/:runId/changes", async (request, reply) => {
    const peer = peerOf(request, reply);
    if (peer === null) return reply;
    const { file, size } = await worker.exportChanges(peer, request.params.runId);
    const stream = createReadStream(file);
    // Deleted once read (or abandoned): the worker keeps no copy of what it sent.
    stream.once("close", () => rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 }));
    return reply.header("content-length", size).type("application/octet-stream").send(stream);
  });
}
