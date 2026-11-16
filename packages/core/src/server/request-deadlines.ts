import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** `PUT /api/uploads/:id/file`, the one route whose body is a whole file streamed in (up to 50 MiB). */
const UPLOAD_FILE = /^\/api\/uploads\/[^/?#]+\/file(?:\?|$)/;

/** Whether this request is one file of an upload, which may take longer than a minute on a slow link. */
export function isStreamedUpload(method: string | undefined, url: string | undefined): boolean {
  return method === "PUT" && url !== undefined && UPLOAD_FILE.test(url);
}

export type RequestDeadlines = {
  /** Every other request must have arrived in full (body included) within this long of its headers. */
  wholeMs: number;
  /** A streamed upload is cut off when no byte has arrived for this long. */
  idleMs: number;
  /** How often a streamed upload's progress is checked. */
  checkMs: number;
};

/**
 * Replaces Node's whole-request timeout (`requestTimeout`, which the server is created with at 0) by one that spares
 * upload files: a file of 50 MiB on a slow link would otherwise be cut off after a minute. Every other request must
 * arrive in full within `wholeMs` of its headers (Node's header timeout still bounds the headers); an upload file
 * instead must keep sending, and is cut off after `idleMs` without a byte. A request cut off has its connection closed.
 * The checks end once the request has arrived in full or its answer is sent.
 */
export function installRequestDeadlines(server: Server, d: RequestDeadlines): void {
  server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
    const socket = req.socket;
    let timer: NodeJS.Timeout;
    if (isStreamedUpload(req.method, req.url)) {
      let seen = socket.bytesRead;
      let quietSince = Date.now();
      timer = setInterval(() => {
        if (req.complete) return stop();
        const now = Date.now();
        if (socket.bytesRead !== seen) {
          seen = socket.bytesRead;
          quietSince = now;
        } else if (now - quietSince >= d.idleMs) {
          stop();
          socket.destroy();
        }
      }, d.checkMs);
    } else {
      timer = setTimeout(() => {
        if (!req.complete) socket.destroy();
      }, d.wholeMs);
    }
    timer.unref();
    function stop(): void {
      clearInterval(timer);
      clearTimeout(timer);
    }
    res.once("close", stop);
    res.once("finish", stop);
  });
}
