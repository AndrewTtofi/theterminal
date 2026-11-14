import { StringDecoder } from "node:string_decoder";

/** Handles a server->client request. A rejection is reported to the peer as a generic "denied". */
export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

type Id = number | string;

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INFLIGHT_REQUESTS = 64;
const MAX_TIMED_OUT_IDS = 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams (used for `codex app-server` and
 * `gemini --acp`). The peer is untrusted: input is parsed incrementally, a single line is never
 * buffered beyond `maxLineBytes`, and any protocol violation closes the peer (fail closed).
 *
 * Timeouts: `requestTimeoutMs` applies to each outgoing request on its own. A timeout rejects only
 * that request; the peer stays open, and a late response to a timed-out id is silently dropped.
 */
export class JsonRpcPeer {
  readonly closed: Promise<string>;

  private readonly io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
  private readonly opts: {
    onRequest: RpcHandler;
    onNotification: (method: string, params: unknown) => void;
    allowMissingVersion?: boolean;
  };
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<Id, Pending>();
  private readonly timedOut = new Set<Id>();
  private partialChunks: string[] = [];
  private partialBytes = 0;
  private readonly maxOutputBufferBytes: number;
  private nextId = 1;
  private inflight = 0;
  private closeReason: string | undefined;
  private resolveClosed!: (reason: string) => void;

  constructor(
    io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
    opts: {
      onRequest: RpcHandler;
      onNotification: (method: string, params: unknown) => void;
      maxLineBytes?: number;
      requestTimeoutMs?: number;
      /** Close ("output error") once more than this many bytes are queued unwritten. Default 4 * maxLineBytes. */
      maxOutputBufferBytes?: number;
      /** Accept incoming messages with no `jsonrpc` field (`codex app-server` omits it). A wrong value still closes. */
      allowMissingVersion?: boolean;
    },
  ) {
    this.io = io;
    this.opts = opts;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxOutputBufferBytes = opts.maxOutputBufferBytes ?? 4 * this.maxLineBytes;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closed = new Promise((r) => (this.resolveClosed = r));
    io.input.on("data", this.onData);
    io.input.on("end", this.onEnd);
    io.input.on("error", this.onInputError);
    io.output.on("error", this.onOutputError);
    io.output.on("close", this.onOutputError);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closeReason !== undefined) {
      return Promise.reject(new Error(`rpc closed: ${this.closeReason}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timedOut.add(id);
        if (this.timedOut.size > MAX_TIMED_OUT_IDS) {
          this.timedOut.delete(this.timedOut.values().next().value as Id);
        }
        reject(new Error(`rpc request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(reason: string): void {
    if (this.closeReason !== undefined) return;
    this.closeReason = reason;
    this.io.input.off("data", this.onData);
    this.io.input.off("end", this.onEnd);
    this.io.input.pause();
    this.partialChunks = [];
    this.partialBytes = 0;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`rpc closed: ${reason}`));
    }
    this.pending.clear();
    this.timedOut.clear();
    this.resolveClosed(reason);
  }

  private send(msg: unknown): void {
    if (this.closeReason !== undefined) return;
    try {
      this.io.output.write(JSON.stringify(msg) + "\n");
      const queued = (this.io.output as { writableLength?: number }).writableLength ?? 0;
      if (queued > this.maxOutputBufferBytes) this.close("output error");
    } catch {
      this.close("output error");
    }
  }

  private readonly onEnd = (): void => this.close("eof");
  private readonly onInputError = (): void => this.close("eof");
  private readonly onOutputError = (): void => this.close("output error");

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closeReason !== undefined) return;
    let text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (;;) {
      const nl = text.indexOf("\n");
      if (nl < 0) break;
      const head = text.slice(0, nl);
      const rest = text.slice(nl + 1);
      if (this.partialBytes + Buffer.byteLength(head, "utf8") > this.maxLineBytes) {
        return this.close("protocol error");
      }
      this.partialChunks.push(head);
      const lineText = this.partialChunks.join("");
      this.partialChunks = [];
      this.partialBytes = 0;
      this.handleLine(lineText);
      if (this.closeReason !== undefined) return;
      text = rest;
    }
    if (text.length > 0) {
      this.partialChunks.push(text);
      this.partialBytes += Buffer.byteLength(text, "utf8");
      // Bound memory: do not wait for a newline once the partial line is already too long.
      if (this.partialBytes > this.maxLineBytes) this.close("protocol error");
    }
  };

  private handleLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.close("protocol error");
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return this.close("protocol error");
    if (msg.jsonrpc !== "2.0" && !(this.opts.allowMissingVersion && !("jsonrpc" in msg))) {
      return this.close("protocol error");
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.id !== "number" && typeof msg.id !== "string") {
      return this.close("protocol error");
    }
    if (typeof msg.method === "string") {
      if (hasId) this.handleRequest(msg.id, msg.method, msg.params);
      else {
        try {
          this.opts.onNotification(msg.method, msg.params);
        } catch {
          this.close("protocol error");
        }
      }
      return;
    }
    if (hasId && ("result" in msg || "error" in msg)) return this.handleResponse(msg);
    this.close("protocol error");
  }

  private handleResponse(msg: { id: Id; result?: unknown; error?: { message?: unknown } }): void {
    const p = this.pending.get(msg.id);
    if (!p) {
      if (this.timedOut.delete(msg.id)) return;
      return this.close("protocol error");
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) {
      const m = msg.error && typeof msg.error.message === "string" ? msg.error.message : "error";
      p.reject(new Error(`rpc error: ${m.slice(0, 500)}`));
    } else {
      p.resolve(msg.result);
    }
  }

  private handleRequest(id: Id, method: string, params: unknown): void {
    if (this.inflight >= MAX_INFLIGHT_REQUESTS) return this.close("protocol error");
    this.inflight++;
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(this.opts.onRequest(method, params));
    } catch (err) {
      work = Promise.reject(err);
    }
    work.then(
      (result) => this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result }),
      () => this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: "denied" } }),
    ).finally(() => {
      this.inflight--;
    });
  }
}
