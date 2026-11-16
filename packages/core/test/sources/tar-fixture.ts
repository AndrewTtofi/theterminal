import { gzipSync } from "node:zlib";

/** One entry for the test tar writer. `type` is the ustar typeflag; `raw` lets a test hand-craft the header. */
export type FixtureEntry = {
  name: string;
  body?: Buffer | string;
  type?: string;
  mode?: number;
  /** The size written into the header, when a test lies about it. Defaults to the body's length. */
  size?: number;
  /** A ustar prefix field (POSIX ustar only). */
  prefix?: string;
  linkname?: string;
  /** Called with the finished header before it is written, to corrupt it on purpose. */
  mutate?: (header: Buffer) => void;
};

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`fixture: ${value} does not fit in ${length} bytes`);
  bytes.copy(buf, offset);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  writeString(buf, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

export function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum;
}

export function setChecksum(header: Buffer): void {
  writeString(header, 148, 8, checksum(header).toString(8).padStart(6, "0") + "\0 ");
}

/** A 512-byte ustar header. */
export function header(e: FixtureEntry, bodyLength: number): Buffer {
  const h = Buffer.alloc(512);
  writeString(h, 0, 100, e.name);
  writeOctal(h, 100, 8, e.mode ?? 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, e.size ?? bodyLength);
  writeOctal(h, 136, 12, 0);
  writeString(h, 156, 1, e.type ?? "0");
  if (e.linkname) writeString(h, 157, 100, e.linkname);
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  if (e.prefix) writeString(h, 345, 155, e.prefix);
  setChecksum(h);
  e.mutate?.(h);
  return h;
}

function pad(length: number): Buffer {
  return Buffer.alloc((512 - (length % 512)) % 512);
}

/** One pax extended-header record: "<len> <key>=<value>\n", where len counts the whole record. */
export function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
  return `${len}${rest}`;
}

/** An uncompressed tar archive. `end: false` leaves out the two zero blocks. */
export function tar(entries: FixtureEntry[], o: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = typeof e.body === "string" ? Buffer.from(e.body, "utf8") : (e.body ?? Buffer.alloc(0));
    parts.push(header(e, body.length), body, pad(body.length));
  }
  if (o.end !== false) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tgz(entries: FixtureEntry[], o: { end?: boolean } = {}): Buffer {
  return gzipSync(tar(entries, o));
}
