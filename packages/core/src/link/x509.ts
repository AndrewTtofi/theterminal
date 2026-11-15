import { createHash, sign, type KeyObject } from "node:crypto";

/**
 * A minimal DER encoder for one shape of certificate: a self-signed X.509 v3 certificate for an Ed25519 key, which
 * node:tls serves and pins by its key. Validity is effectively unbounded; trust comes from pinning the key, not dates.
 */
export const CERT_NOT_BEFORE = "20000101000000Z";
export const CERT_NOT_AFTER = "99991231235959Z";

const OID_ED25519 = [1, 3, 101, 112];
const OID_COMMON_NAME = [2, 5, 4, 3];
const OID_BASIC_CONSTRAINTS = [2, 5, 29, 19];

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);
const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
const booleanTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));

/** A non-negative INTEGER in its minimal two's-complement form. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1]! < 0x80) start++;
  const body = bytes.subarray(start);
  return tlv(0x02, body[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body);
}

function oid(parts: number[]): Buffer {
  const out = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const groups: number[] = [];
    for (let v = part; ; v = Math.floor(v / 128)) {
      groups.unshift(v & 0x7f);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(out));
}

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. `time` is GeneralizedTime text. */
function time(generalized: string): Buffer {
  const year = Number(generalized.slice(0, 4));
  return year < 2050
    ? tlv(0x17, Buffer.from(generalized.slice(2), "ascii"))
    : tlv(0x18, Buffer.from(generalized, "ascii"));
}

const name = (cn: string): Buffer => sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(cn))));

/** A DER certificate for `publicKey`, signed by `privateKey`, with issuer = subject = CN=<cn>. */
export function selfSignedCertificate(privateKey: KeyObject, publicKey: KeyObject, cn: string): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const serial = createHash("sha256").update(spki).digest().subarray(0, 16);
  serial[0]! &= 0x7f;
  const algorithm = sequence(oid(OID_ED25519));
  const basicConstraints = sequence(oid(OID_BASIC_CONSTRAINTS), booleanTrue(), octetString(sequence()));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name(cn),
    sequence(time(CERT_NOT_BEFORE), time(CERT_NOT_AFTER)),
    name(cn),
    spki,
    explicit(3, sequence(basicConstraints)),
  );
  return sequence(tbs, algorithm, bitString(sign(null, tbs, privateKey)));
}

export function derToPem(der: Buffer, label: "CERTIFICATE"): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
