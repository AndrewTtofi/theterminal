import https from "node:https";
import tls, { type TLSSocket } from "node:tls";
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { machineAddressSchema } from "@theterminal/shared";
import type { LinkIdentity } from "./identity.js";

/** The machine did not answer: refused, timed out, or the connection was cut. Nothing about the cause is kept. */
export class MachineUnreachableError extends Error {
  /**
   * `machineId` is the paired machine's id; null when none is known yet (pairing), and then `address` names where
   * the connection was tried. The message is fixed either way.
   */
  constructor(
    public readonly machineId: string | null,
    public readonly address?: string,
  ) {
    super("machine unreachable");
    this.name = "MachineUnreachableError";
  }
}

/** The machine at that address presented a key other than the one paired; nothing was sent to it. */
export class MachineKeyMismatchError extends Error {
  constructor() {
    super("the machine's key does not match the one paired");
    this.name = "MachineKeyMismatchError";
  }
}

/** The machine answered with a non-2xx status; `code` is its `error` field (or `unknown`). */
export class RemoteRefusedError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(`the machine refused: ${code}`);
    this.name = "RemoteRefusedError";
  }
}

/** The machine's reply could not be read: too large, not JSON, or not the expected shape. Never carries the reply. */
export class LinkProtocolError extends Error {
  constructor() {
    super("the machine sent a reply that could not be read");
    this.name = "LinkProtocolError";
  }
}

export type Peer = { machineId: string; address: string; publicKeyDer: Buffer };

/** JSON replies, refusal bodies and each NDJSON line are capped at this many bytes. */
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
/** How long a stream may stay silent before it is treated as cut (the caller then reconnects). */
const DEFAULT_STREAM_IDLE_MS = 120_000;

const refusalSchema = z.object({ error: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/), message: z.string().max(500).optional() });

/** `host:port` as `machineAddressSchema` allows it, with a port in range. Throws a ZodError otherwise. */
export function parseAddress(address: string): { host: string; port: number } {
  const valid = machineAddressSchema.parse(address);
  const at = valid.lastIndexOf(":");
  const port = Number(valid.slice(at + 1));
  z.number().int().min(1).max(65535).parse(port);
  return { host: valid.slice(0, at), port };
}

/** TLS options of every link connection: TLS 1.3 only, our certificate, and no CA or hostname check (the pin is). */
function tlsOptions(identity: LinkIdentity) {
  return {
    ...identity.tls(),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
    minVersion: "TLSv1.3" as const,
    maxVersion: "TLSv1.3" as const,
  };
}

/** The SPKI DER of the certificate the other side presented, or null. */
function presentedSpki(socket: TLSSocket): Buffer | null {
  try {
    if (socket.getProtocol() !== "TLSv1.3") return null;
    const cert = socket.getPeerX509Certificate();
    return cert ? cert.publicKey.export({ type: "spki", format: "der" }) : null;
  } catch {
    return null;
  }
}

/** Reads a response body up to `max` bytes; past it the response is destroyed and LinkProtocolError thrown. */
async function readCapped(res: IncomingMessage, max: number, machineId: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) {
        res.destroy();
        throw new LinkProtocolError();
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof LinkProtocolError) throw err;
    throw new MachineUnreachableError(machineId);
  }
  if (!res.complete) throw new MachineUnreachableError(machineId);
  return Buffer.concat(chunks);
}

/** A non-2xx response as RemoteRefusedError, reading at most MAX_JSON_BYTES of its body. */
async function refusal(res: IncomingMessage, machineId: string): Promise<RemoteRefusedError> {
  const status = res.statusCode ?? 0;
  let body: unknown;
  try {
    body = JSON.parse((await readCapped(res, MAX_JSON_BYTES, machineId)).toString("utf8"));
  } catch (err) {
    if (err instanceof MachineUnreachableError) throw err;
    body = undefined;
  }
  const parsed = refusalSchema.safeParse(body);
  return parsed.success ? new RemoteRefusedError(status, parsed.data.error, parsed.data.message) : new RemoteRefusedError(status, "unknown");
}

const ok = (res: IncomingMessage) => (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;

/**
 * Pinned requests to a paired machine over mutual TLS 1.3. The machine's key is checked on `secureConnect`, before
 * the request line or body is written; a mismatch destroys the socket. Every socket has a timeout.
 */
export class LinkClient {
  private readonly identity: LinkIdentity;
  private readonly timeoutMs: number;
  private readonly streamIdleMs: number;

  constructor(deps: { identity: LinkIdentity; timeoutMs?: number; streamIdleMs?: number }) {
    this.identity = deps.identity;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleMs = deps.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
  }

  /** A JSON request; the reply is parsed with `schema` when given. */
  async request<T>(peer: Peer, method: "GET" | "POST", path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers: OutgoingHttpHeaders = { accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    const { res } = await this.open(peer, method, path, headers, (req) => req.end(payload));
    if (!ok(res)) throw await refusal(res, peer.machineId);
    return this.json(res, peer, schema);
  }

  /** An NDJSON stream: each non-empty line goes to `onFrame`, one at a time. Resolves on a clean end or an abort. */
  async stream(peer: Peer, path: string, onFrame: (line: string) => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const { req, res } = await this.open(peer, "GET", path, { accept: "application/x-ndjson" }, (r) => r.end(), signal);
    if (!ok(res)) throw await refusal(res, peer.machineId);
    res.socket.setTimeout(this.streamIdleMs);
    const abort = () => req.destroy();
    signal.addEventListener("abort", abort, { once: true });
    const decoder = new StringDecoder("utf8");
    const deliver = async (line: string) => {
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new LinkProtocolError();
      if (line.length === 0) return;
      try {
        await onFrame(line);
      } catch (err) {
        throw new CallerError(err);
      }
    };
    let pending = "";
    try {
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          pending += decoder.write(chunk);
          let nl: number;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl).replace(/\r$/, "");
            pending = pending.slice(nl + 1);
            await deliver(line);
            if (signal.aborted) return;
          }
          if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) throw new LinkProtocolError();
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof CallerError || err instanceof LinkProtocolError) req.destroy();
        if (err instanceof CallerError) throw err.cause;
        if (err instanceof LinkProtocolError) throw err;
        throw new MachineUnreachableError(peer.machineId);
      }
      if (signal.aborted) return;
      if (!res.complete) throw new MachineUnreachableError(peer.machineId);
      try {
        await deliver((pending + decoder.end()).replace(/\r$/, ""));
      } catch (err) {
        throw err instanceof CallerError ? err.cause : err;
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** Sends a file as application/octet-stream; one over `maxBytes` is refused before connecting. */
  async upload(peer: Peer, path: string, file: string, maxBytes: number): Promise<void> {
    const size = statSync(file).size;
    if (size > maxBytes) throw new RemoteRefusedError(413, "too_large");
    const headers: OutgoingHttpHeaders = { accept: "application/json", "content-type": "application/octet-stream", "content-length": size };
    const { res } = await this.open(peer, "POST", path, headers, (req) => {
      const source = createReadStream(file);
      source.on("error", () => req.destroy(new MachineUnreachableError(peer.machineId)));
      source.pipe(req);
    });
    if (!ok(res)) throw await refusal(res, peer.machineId);
    await this.json(res, peer);
  }

  /** Saves a response body to `file`; past `maxBytes` it aborts with 413 `too_large`. A failed download leaves no file. */
  async download(peer: Peer, path: string, file: string, maxBytes: number): Promise<void> {
    const { req, res } = await this.open(peer, "GET", path, { accept: "application/octet-stream" }, (r) => r.end());
    if (!ok(res)) throw await refusal(res, peer.machineId);
    const declared = Number(res.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.destroy();
      throw new RemoteRefusedError(413, "too_large");
    }
    const out = createWriteStream(file);
    const remove = () => rmSync(file, { force: true });
    let size = 0;
    try {
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            throw new RemoteRefusedError(413, "too_large");
          }
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } catch (err) {
        if (err instanceof RemoteRefusedError) throw err;
        throw new MachineUnreachableError(peer.machineId);
      }
      if (!res.complete) throw new MachineUnreachableError(peer.machineId);
      await new Promise<void>((resolve, reject) => {
        out.once("error", reject);
        out.end(() => resolve());
      });
    } catch (err) {
      out.destroy();
      await new Promise<void>((r) => (out.closed ? r() : out.once("close", () => r())));
      remove();
      throw err;
    }
  }

  /**
   * Pairing only: a TLS 1.3 connection that checks no pin, returning the server's SPKI so the caller can compare its
   * fingerprint with the pairing code before sending anything.
   */
  static connectUnpinned(identity: LinkIdentity, address: string, timeoutMs: number): Promise<{ socket: TLSSocket; peerSpki: Buffer }> {
    const { host, port } = parseAddress(address);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, ...tlsOptions(identity) });
      socket.setTimeout(timeoutMs, () => socket.destroy(new MachineUnreachableError(null, address)));
      let settled = false;
      socket.once("secureConnect", () => {
        const spki = presentedSpki(socket);
        settled = true;
        if (spki === null) {
          socket.destroy();
          reject(new LinkProtocolError());
          return;
        }
        resolve({ socket, peerSpki: spki });
      });
      socket.on("error", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new MachineUnreachableError(null, address));
      });
    });
  }

  private async json<T>(res: IncomingMessage, peer: Peer, schema?: z.ZodType<T>): Promise<T> {
    const raw = await readCapped(res, MAX_JSON_BYTES, peer.machineId);
    if (raw.length === 0 && schema === undefined) return undefined as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new LinkProtocolError();
    }
    if (schema === undefined) return parsed as T;
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new LinkProtocolError();
    return checked.data;
  }

  /**
   * Opens a request and waits for its response headers. `send` writes the request (headers and body) only after the
   * server's key matched the pin; until then nothing has been written to the socket.
   */
  private open(
    peer: Peer,
    method: "GET" | "POST",
    path: string,
    headers: OutgoingHttpHeaders,
    send: (req: ClientRequest) => void,
    signal?: AbortSignal,
  ): Promise<{ req: ClientRequest; res: IncomingMessage }> {
    const { host, port } = parseAddress(peer.address);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        req.destroy();
      };
      const req = https.request({
        host,
        port,
        method,
        path,
        headers,
        agent: false,
        servername: undefined,
        ...tlsOptions(this.identity),
      });
      req.setTimeout(this.timeoutMs, () => fail(new MachineUnreachableError(peer.machineId)));
      const onAbort = () => fail(new MachineUnreachableError(peer.machineId));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.once("socket", (socket) => {
        const tlsSocket = socket as TLSSocket;
        const check = () => {
          const spki = presentedSpki(tlsSocket);
          if (spki === null || !spki.equals(peer.publicKeyDer)) {
            tlsSocket.destroy();
            fail(new MachineKeyMismatchError());
            return;
          }
          send(req);
        };
        if (tlsSocket.getProtocol() !== null && !tlsSocket.connecting) check();
        else tlsSocket.once("secureConnect", check);
      });
      req.once("response", (res) => {
        signal?.removeEventListener("abort", onAbort);
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        resolve({ req, res });
      });
      req.on("error", () => fail(new MachineUnreachableError(peer.machineId)));
    });
  }
}

/** Wraps an error thrown by the caller's `onFrame`, so it is rethrown as is rather than read as a cut connection. */
class CallerError extends Error {
  constructor(cause: unknown) {
    super("onFrame failed", { cause });
  }
}
