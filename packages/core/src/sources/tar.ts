import { Readable, Transform, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { IMPORT_LIMITS } from "@theterminal/shared";

/**
 * A streaming reader for gzip tar archives (a GitHub tarball), on node:zlib only.
 *
 * It never writes anything: it hands each entry to the caller with its body as a stream, and the caller (ImportStaging)
 * decides what to keep. It does not judge paths either. A hostile path (`../x`, `/etc/x`) is passed on as it is, never
 * quietly turned into a harmless-looking one, so that the caller's path rules see it and refuse it. Everything that
 * could make the reader itself use unbounded memory or time is limited while streaming: compressed bytes, entries,
 * each entry's declared size, the sum of declared sizes, metadata headers and path length.
 */

/** One archive entry. `path` has its first segment (`owner-repo-sha/`) removed. */
export type TarEntry = { path: string; kind: "file" | "dir" | "link" | "other"; size: number; mode: number };

export type TarReadOptions = {
  maxCompressedBytes: number;
  /** Files, links and the rest count; directories do not (see maxDirectories), nor do pax or GNU metadata headers. */
  maxEntries: number;
  /** The most directory entries. Defaults to five times IMPORT_LIMITS.files. */
  maxDirectories?: number;
  /** The largest declared size of one entry whose body is read. Defaults to 50 MiB (IMPORT_LIMITS.fileBytes). */
  maxEntryBytes?: number;
  /** The largest sum of declared entry sizes. Defaults to 200 MiB (IMPORT_LIMITS.bytes). */
  maxTotalBytes?: number;
  /** The longest path, in UTF-8 bytes. Defaults to 4096. */
  maxPathBytes?: number;
};

/** The archive is not a well-formed gzip tar: bad gzip, a bad header checksum, a bad number, or a stream cut short. */
export class TarInvalidError extends Error {
  constructor(detail: string) {
    super(`invalid tar archive: ${detail}`);
    this.name = "TarInvalidError";
  }
}

export type TarLimit = "compressed" | "entries" | "file_bytes" | "bytes" | "header" | "path";

/** The archive breaks one of the reader's limits. */
export class TarLimitError extends Error {
  constructor(readonly limit: TarLimit) {
    super(`tar archive over the ${limit} limit`);
    this.name = "TarLimitError";
  }
}

const BLOCK = 512;
const DEFAULT_ENTRY_BYTES = IMPORT_LIMITS.fileBytes;
const DEFAULT_TOTAL_BYTES = IMPORT_LIMITS.bytes;
/** A repository with 2000 files can hold many more directories; they cost no body, only a header each. */
const DEFAULT_DIRECTORIES = IMPORT_LIMITS.files * 5;
const DEFAULT_PATH_BYTES = 4096;
/** The largest pax or GNU metadata body held in memory. */
const MAX_META_BYTES = 64 * 1024;
/** Metadata headers in a row before a real entry; real archives use at most two or three. */
const MAX_META_RUN = 8;
/** The largest piece of a body handed to the caller at once. */
const MAX_CHUNK = 64 * 1024;
/** Decompressed bytes allowed after the end marker (GitHub pads to a 10 KiB record). */
const MAX_TRAILER_BYTES = 1024 * 1024;

const EMPTY = Buffer.alloc(0);

function isZlibError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

/** Reads exact byte counts out of the decompressed stream, without holding more than one chunk at a time. */
class ByteSource {
  private buf: Buffer = EMPTY;
  private ended = false;
  private readonly it: AsyncIterator<Buffer>;

  constructor(stream: Readable, private readonly failure: () => unknown) {
    this.it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    let r: IteratorResult<Buffer>;
    try {
      r = await this.it.next();
    } catch (e) {
      throw this.mapError(e);
    }
    const stored = this.failure();
    if (stored) throw this.mapError(stored);
    if (r.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value as Uint8Array);
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    return true;
  }

  private mapError(e: unknown): unknown {
    const stored = this.failure();
    const err = stored ?? e;
    if (err instanceof TarLimitError || err instanceof TarInvalidError) return err;
    if (isZlibError(err)) return new TarInvalidError("not a valid gzip stream");
    return err;
  }

  /** Exactly `n` bytes; null at a clean end of stream before any of them; TarInvalidError when cut short. */
  async exact(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (!(await this.fill())) {
        if (this.buf.length === 0) return null;
        throw new TarInvalidError("archive cut short");
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** The next `n` bytes as pieces of at most MAX_CHUNK bytes. */
  async *chunks(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill())) throw new TarInvalidError("archive cut short");
      const take = Math.min(left, this.buf.length, MAX_CHUNK);
      const out = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      yield out;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.chunks(n)) { /* discarded */ }
  }

  /** Reads to the end of the stream, refusing more than `limit` bytes. */
  async drainToEnd(limit: number): Promise<void> {
    let seen = this.buf.length;
    this.buf = EMPTY;
    while (seen <= limit) {
      if (!(await this.fill())) return;
      seen += this.buf.length;
      this.buf = EMPTY;
    }
    throw new TarInvalidError("too much data after the end of the archive");
  }
}

/** A NUL-terminated header field as UTF-8. */
function cstring(h: Buffer, offset: number, length: number): string {
  const field = h.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
}

/** A numeric header field: octal text, or GNU base-256 when the top bit is set. */
function parseNumber(h: Buffer, offset: number, length: number): number {
  if (h[offset] & 0x80) {
    if (h[offset] === 0xff) throw new TarInvalidError("negative number in a header");
    let value = h[offset] & 0x7f;
    for (let i = offset + 1; i < offset + length; i += 1) value = value * 256 + h[i];
    return value;
  }
  const text = h.subarray(offset, offset + length).toString("latin1").replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarInvalidError("bad number in a header");
  return parseInt(text, 8);
}

function isZeroBlock(h: Buffer): boolean {
  for (let i = 0; i < BLOCK; i += 1) if (h[i] !== 0) return false;
  return true;
}

function verifyChecksum(h: Buffer): void {
  const stored = parseNumber(h, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (stored !== unsigned && stored !== signed) throw new TarInvalidError("bad header checksum");
}

type Pending = { path?: string; size?: number };

/** pax extended-header records: "<len> <key>=<value>\n", where len counts the whole record. Only path and size apply. */
function parsePax(body: Buffer, into: Pending, checkPath: (p: string) => void): void {
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space < 0 || space - pos > 10) throw new TarInvalidError("bad pax record");
    const lenText = body.subarray(pos, space).toString("latin1");
    if (!/^[1-9][0-9]*$/.test(lenText)) throw new TarInvalidError("bad pax record");
    const len = Number(lenText);
    const end = pos + len;
    if (end > body.length || end <= space + 1 || body[end - 1] !== 0x0a) throw new TarInvalidError("bad pax record");
    const kv = body.subarray(space + 1, end - 1).toString("utf8");
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new TarInvalidError("bad pax record");
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    if (key === "path") {
      if (value.includes("\0") || value === "") throw new TarInvalidError("bad pax path");
      checkPath(value);
      into.path = value;
    } else if (key === "size") {
      if (!/^[0-9]{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TarInvalidError("bad pax size");
      into.size = Number(value);
    }
    pos = end;
  }
}

/**
 * Removes the archive's top folder (`owner-repo-sha/`). A path whose first segment is not an ordinary name (it is
 * absolute, `.`, `..`, or holds a backslash or a colon) is returned unchanged, so the caller's path rules refuse it.
 */
function stripFirstSegment(raw: string): string {
  const p = raw.replace(/\/+$/, "");
  const slash = p.indexOf("/");
  const first = slash < 0 ? p : p.slice(0, slash);
  if (first === "" || first === "." || first === ".." || first.includes("\\") || first.includes(":")) return raw;
  return slash < 0 ? "" : p.slice(slash + 1);
}

function kindOf(type: string): TarEntry["kind"] {
  if (type === "0" || type === "\0" || type === "7") return "file";
  if (type === "5") return "dir";
  if (type === "1" || type === "2") return "link";
  return "other";
}

/** Types that never carry data blocks (links, devices, directories, fifos). Their size field is ignored. */
const BODILESS = new Set(["1", "2", "3", "4", "5", "6"]);

/**
 * Reads a gzip tar stream entry by entry. `onEntry` must consume or `resume()` the body; the reader waits for it
 * before going on. A link's or a device's body is never yielded (it gets an empty stream). On any failure the input
 * is destroyed and the error is passed on: TarInvalidError, TarLimitError, or the callback's own error.
 */
export async function readTarGz(
  input: Readable,
  onEntry: (e: TarEntry, body: Readable) => Promise<void>,
  opts: TarReadOptions,
): Promise<void> {
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_ENTRY_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_TOTAL_BYTES;
  const maxPathBytes = opts.maxPathBytes ?? DEFAULT_PATH_BYTES;
  const maxDirectories = opts.maxDirectories ?? DEFAULT_DIRECTORIES;

  let compressed = 0;
  let streamFailure: unknown = null;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      compressed += chunk.length;
      if (compressed > opts.maxCompressedBytes) cb(new TarLimitError("compressed"));
      else cb(null, chunk);
    },
  });
  const gunzip = createGunzip();
  pipeline(input, counter, gunzip, (err) => {
    if (err && !streamFailure) streamFailure = err;
  });
  const src = new ByteSource(gunzip, () => streamFailure);

  const checkPath = (p: string): void => {
    if (Buffer.byteLength(p, "utf8") > maxPathBytes) throw new TarLimitError("path");
  };

  /** Hands one entry and its body to the callback, applying backpressure, and waits for the callback. */
  const deliver = async (entry: TarEntry, size: number): Promise<void> => {
    let wakeUp: (() => void) | null = null;
    const wake = (): void => {
      const w = wakeUp;
      wakeUp = null;
      w?.();
    };
    const body = new Readable({ highWaterMark: MAX_CHUNK, read: wake });
    body.on("close", wake);
    body.on("error", () => { /* the callback sees it; never unhandled */ });
    let settled = false;
    let failure: { e: unknown } | null = null;
    const done = Promise.resolve()
      .then(() => onEntry(entry, body))
      .then(
        () => { settled = true; wake(); },
        (e: unknown) => { settled = true; failure = { e }; wake(); },
      );
    try {
      for await (const chunk of src.chunks(size)) {
        if (failure) break;
        if (settled || body.destroyed) continue;
        if (!body.push(chunk) && !settled && !body.destroyed) {
          await new Promise<void>((resolve) => { wakeUp = resolve; });
        }
      }
    } catch (e) {
      body.destroy(e as Error);
      await done;
      throw e;
    }
    if (!body.destroyed && !failure) body.push(null);
    await done;
    if (failure) throw (failure as { e: unknown }).e;
  };

  const parse = async (): Promise<void> => {
    let entries = 0;
    let directories = 0;
    let total = 0;
    let metaRun = 0;
    let pending: Pending = {};
    for (;;) {
      const h = await src.exact(BLOCK);
      if (!h) throw new TarInvalidError("no end-of-archive marker");
      if (isZeroBlock(h)) {
        const next = await src.exact(BLOCK);
        if (!next || !isZeroBlock(next)) throw new TarInvalidError("broken end-of-archive marker");
        await src.drainToEnd(MAX_TRAILER_BYTES);
        return;
      }
      verifyChecksum(h);
      const type = String.fromCharCode(h[156]);
      const headerSize = parseNumber(h, 124, 12);

      if (type === "x" || type === "g" || type === "L" || type === "K") {
        metaRun += 1;
        if (metaRun > MAX_META_RUN) throw new TarInvalidError("too many metadata headers in a row");
        if (headerSize > MAX_META_BYTES) throw new TarLimitError("header");
        const meta = headerSize === 0 ? EMPTY : await src.exact(headerSize);
        if (!meta) throw new TarInvalidError("archive cut short");
        await src.skip((BLOCK - (headerSize % BLOCK)) % BLOCK);
        if (type === "x") {
          parsePax(meta, pending, checkPath);
        } else if (type === "L") {
          const nul = meta.indexOf(0);
          const name = meta.subarray(0, nul < 0 ? meta.length : nul).toString("utf8");
          if (name === "") throw new TarInvalidError("empty GNU long name");
          checkPath(name);
          pending.path = name;
        }
        // "g" (pax global) and "K" (GNU long link name) are read and ignored.
        continue;
      }
      metaRun = 0;

      if (type === "5") {
        directories += 1;
        if (directories > maxDirectories) throw new TarLimitError("entries");
      } else {
        entries += 1;
        if (entries > opts.maxEntries) throw new TarLimitError("entries");
      }

      let raw = pending.path;
      if (raw === undefined) {
        const name = cstring(h, 0, 100);
        const magic = h.subarray(257, 263).toString("latin1");
        const prefix = magic === "ustar\0" ? cstring(h, 345, 155) : "";
        raw = prefix ? `${prefix}/${name}` : name;
        checkPath(raw);
      }
      const kind = kindOf(type);
      const size = BODILESS.has(type) ? 0 : (pending.size ?? headerSize);
      pending = {};

      if (size > maxEntryBytes) throw new TarLimitError("file_bytes");
      total += size;
      if (total > maxTotalBytes) throw new TarLimitError("bytes");

      const path = stripFirstSegment(raw);
      const mode = parseNumber(h, 100, 8) & 0o7777;
      if (path === "") {
        await src.skip(size);
      } else if (kind === "file") {
        await deliver({ path, kind, size, mode }, size);
      } else {
        // Directories, links, devices and unknown types: the body (if any) is skipped, never yielded.
        await deliver({ path, kind, size: kind === "other" ? size : 0, mode }, 0);
        await src.skip(size);
      }
      await src.skip((BLOCK - (size % BLOCK)) % BLOCK);
    }
  };

  try {
    await parse();
  } catch (e) {
    input.destroy();
    gunzip.destroy();
    throw e;
  }
}
