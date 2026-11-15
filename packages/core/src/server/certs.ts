import { X509Certificate, createPrivateKey, generateKeyPair, randomBytes, sign, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { isIP } from "node:net";
import * as nodeOs from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

/**
 * TLS material for the remote listener. Names chosen not to collide with Plan 6's
 * link/x509.ts selfSignedCertificate and link/identity.ts fingerprintOf.
 *
 * The certificate is built here with a small DER encoder and signed with node:crypto. @peculiar/x509 2.x
 * cannot be imported without a global Reflect metadata polyfill (it pulls in tsyringe), which would be a new
 * dependency, and a self-signed server certificate needs only a handful of fixed fields.
 */
export type CertMaterial = {
  certPem: string;
  keyPem: string;
  /** AA:BB:…, SHA-256 of the certificate DER, upper-case: CERT_FINGERPRINT. */
  fingerprint: string;
  expiresAt: string;
  subjectAltNames: string[];
};

export type CertificateErrorCode =
  | "invalid_input"
  | "unreadable"
  | "too_large"
  | "path_denied"
  | "invalid_certificate"
  | "invalid_key"
  | "mismatch"
  | "expired"
  | "not_yet_valid";

/** Fixed messages: never a path, never file contents, never key material. */
const MESSAGES: Record<CertificateErrorCode, string> = {
  invalid_input: "The certificate names or lifetime are not valid.",
  unreadable: "The certificate or key file could not be read.",
  too_large: "The certificate or key file is too large.",
  path_denied: "The certificate or key file is in a location that is not allowed.",
  invalid_certificate: "The certificate file does not hold a valid PEM certificate.",
  invalid_key: "The key file does not hold a usable unencrypted PEM private key.",
  mismatch: "The certificate and the key do not match.",
  expired: "The certificate has expired.",
  not_yet_valid: "The certificate is not valid yet.",
};

export class CertificateError extends Error {
  readonly code: CertificateErrorCode;
  constructor(code: CertificateErrorCode) {
    super(MESSAGES[code]);
    this.name = "CertificateError";
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;
/** Generous for a leaf plus a few intermediates; a real key file is a few KiB at most. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_CHAIN = 8;
const CN = "The Terminal";

// ---------- DER ----------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);
const bitString = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
const octets = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const explicit = (n: number, c: Buffer) => tlv(0xa0 | n, c);
const TRUE = Buffer.from([0x01, 0x01, 0xff]);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const out: number[] = [a * 40 + b];
  for (const v of rest) {
    const chunk: number[] = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) chunk.unshift(0x80 | (x & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(d: Date): Buffer {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(p(y % 100) + rest)) : tlv(0x18, Buffer.from(p(y, 4) + rest));
}

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split(".").map(Number));
  let text = ip;
  const tail: number[] = [];
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const b = v4[2]!.split(".").map(Number);
    tail.push((b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!);
    text = v4[1]!.endsWith("::") ? v4[1]! : v4[1]!.slice(0, -1);
  }
  const [head, back] = text.includes("::") ? text.split("::") : [text, undefined];
  const parse = (s: string | undefined) => (s ? s.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const front = parse(head);
  const end = [...parse(back), ...tail];
  const groups = back === undefined ? [...front, ...tail] : [...front, ...new Array(8 - front.length - end.length).fill(0), ...end];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(g, i * 2));
  return out;
}

// ---------- input checks ----------

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function validHostname(h: string): boolean {
  return h.length > 0 && h.length <= 253 && h.split(".").every((l) => LABEL.test(l));
}

// ---------- self-signed ----------

const generateEc = promisify(generateKeyPair);

export async function selfSignedTlsCertificate(i: {
  hostnames: string[];
  addresses: string[];
  now?: () => Date;
  days?: number;
}): Promise<CertMaterial> {
  const days = i.days ?? MAX_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new CertificateError("invalid_input");
  if (!Array.isArray(i.hostnames) || !Array.isArray(i.addresses)) throw new CertificateError("invalid_input");
  const hostnames = [...new Set(i.hostnames.map((h) => String(h).toLowerCase()))];
  const addresses = [...new Set(i.addresses.map(String))];
  if (!hostnames.every(validHostname) || !addresses.every((a) => !a.includes("%") && isIP(a) !== 0)) throw new CertificateError("invalid_input");
  if (hostnames.length + addresses.length === 0) throw new CertificateError("invalid_input");

  const start = new Date(Math.floor((i.now ?? (() => new Date()))().getTime() / 1000) * 1000);
  const end = new Date(start.getTime() + days * DAY_MS);
  const { publicKey, privateKey } = await generateEc("ec", { namedCurve: "P-256" });

  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, and no leading zero byte to strip
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), utf8(CN))));
  const san = seq(
    ...hostnames.map((h) => tlv(0x82, Buffer.from(h, "ascii"))),
    ...addresses.map((a) => tlv(0x87, ipBytes(a))),
  );
  const extensions = seq(
    seq(oid("2.5.29.19"), TRUE, octets(seq())), // basicConstraints: not a CA
    seq(oid("2.5.29.15"), TRUE, octets(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage: digitalSignature
    seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))), // extKeyUsage: serverAuth
    seq(oid("2.5.29.17"), octets(san)),
  );
  const tbs = seq(
    explicit(0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name,
    seq(time(start), time(end)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, extensions),
  );
  const der = seq(tbs, ecdsaSha256, bitString(sign("sha256", tbs, privateKey)));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
  return {
    certPem,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    fingerprint: new X509Certificate(der).fingerprint256,
    expiresAt: end.toISOString(),
    subjectAltNames: [...hostnames, ...addresses],
  };
}

export function certFingerprint(certPem: string): string {
  try {
    return new X509Certificate(certPem).fingerprint256;
  } catch {
    throw new CertificateError("invalid_certificate");
  }
}

// ---------- provided files ----------

/** Lower-cased so the check holds on case-insensitive file systems; over-denying on Linux is harmless. */
const fold = (p: string) => p.toLowerCase();
const DENIED_DATA_FILES = ["ledger.db", "ledger.db-wal", "ledger.db-shm", "ledger.db-journal", "token", "secrets.enc.json"];

/**
 * What a provided certificate or key path may never name: anything under the UI folder (served without a sign-in),
 * the data folder's ledger, token and encrypted secrets, and the file store's key file wherever the CLI put it.
 */
export type CertDenyList = { uiDir: string | null; dataDir: string; keyFile?: string | null };

function forms(p: string): string[] {
  const lexical = resolve(p);
  try {
    return [lexical, realpathSync(lexical)];
  } catch {
    return [lexical];
  }
}

function isDenied(candidates: string[], deny: CertDenyList): boolean {
  const uiRoots = deny.uiDir === null ? [] : forms(deny.uiDir).map(fold);
  const dataFiles = [
    ...forms(deny.dataDir).flatMap((d) => DENIED_DATA_FILES.map((f) => fold(join(d, f)))),
    ...(deny.keyFile ? forms(deny.keyFile).map(fold) : []),
  ];
  return candidates.map(fold).some((c) => dataFiles.includes(c) || uiRoots.some((u) => c === u || c.startsWith(u.endsWith(sep) ? u : u + sep)));
}

/** Deny-list check on the path as given and as resolved through links, both before anything is read. */
function readBounded(file: string, deny: CertDenyList): string {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) throw new CertificateError("unreadable");
  const lexical = resolve(file);
  if (isDenied([lexical], deny)) throw new CertificateError("path_denied");
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    throw new CertificateError("unreadable");
  }
  if (isDenied([real], deny)) throw new CertificateError("path_denied");

  // Stat before opening: opening a FIFO or a device can block forever, so only a regular file is opened.
  let before: BigIntStats;
  try {
    before = lstatSync(real, { bigint: true });
  } catch {
    throw new CertificateError("unreadable");
  }
  if (!before.isFile()) throw new CertificateError("unreadable");
  if (before.size > BigInt(MAX_FILE_BYTES)) throw new CertificateError("too_large");

  let fd: number;
  try {
    // O_NONBLOCK and O_NOFOLLOW are POSIX-only (undefined on Windows): a swap to a FIFO or a link after the
    // stat must neither block the open nor be followed. The identity check below refuses any swap.
    fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new CertificateError("unreadable");
  }
  try {
    let st: BigIntStats;
    try {
      st = fstatSync(fd, { bigint: true });
    } catch {
      throw new CertificateError("unreadable");
    }
    // The file opened must be the file checked: a swap between the check and the open is refused.
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) throw new CertificateError("unreadable");
    if (st.size > BigInt(MAX_FILE_BYTES)) throw new CertificateError("too_large");
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    try {
      for (let n = -1; n !== 0 && total < buf.length; total += n) n = readSync(fd, buf, total, buf.length - total, null);
    } catch {
      throw new CertificateError("unreadable");
    }
    if (total > MAX_FILE_BYTES) throw new CertificateError("too_large"); // grew after the stat
    return buf.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

type PemBlock = { label: string; text: string };
function pemBlocks(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END \1-----/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    blocks.push({ label: m[1]!, text: `-----BEGIN ${m[1]}-----\n${m[2]!.replace(/\r/g, "")}-----END ${m[1]}-----\n` });
  }
  return blocks;
}
const beginMarkers = (text: string) => (text.match(/-----BEGIN /g) ?? []).length;

function parseChain(text: string): X509Certificate[] {
  const blocks = pemBlocks(text);
  // Every BEGIN must be a well-formed CERTIFICATE block: a stray private key never ends up in certPem.
  if (blocks.length === 0 || blocks.length > MAX_CHAIN || beginMarkers(text) !== blocks.length) throw new CertificateError("invalid_certificate");
  if (blocks.some((b) => b.label !== "CERTIFICATE")) throw new CertificateError("invalid_certificate");
  let chain: X509Certificate[];
  try {
    chain = blocks.map((b) => new X509Certificate(b.text));
  } catch {
    throw new CertificateError("invalid_certificate");
  }
  for (let k = 0; k + 1 < chain.length; k++) {
    if (!chain[k]!.checkIssued(chain[k + 1]!) || !chain[k]!.verify(chain[k + 1]!.publicKey)) throw new CertificateError("invalid_certificate");
  }
  return chain;
}

const KEY_LABELS = new Set(["PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY"]);
function parseKey(text: string): KeyObject {
  const blocks = pemBlocks(text);
  if (blocks.length === 0 || beginMarkers(text) !== blocks.length) throw new CertificateError("invalid_key");
  const keys = blocks.filter((b) => b.label !== "EC PARAMETERS");
  if (keys.length !== 1 || !KEY_LABELS.has(keys[0]!.label) || blocks.length - keys.length > 1) throw new CertificateError("invalid_key");
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: keys[0]!.text, format: "pem" });
  } catch {
    throw new CertificateError("invalid_key");
  }
  const d = key.asymmetricKeyDetails;
  const usable =
    (key.asymmetricKeyType === "ec" && (d?.namedCurve === "prime256v1" || d?.namedCurve === "secp384r1")) ||
    (key.asymmetricKeyType === "rsa" && (d?.modulusLength ?? 0) >= 2048);
  if (!usable) throw new CertificateError("invalid_key");
  return key;
}

function sanList(x: X509Certificate): string[] {
  return (x.subjectAltName ?? "")
    .split(", ")
    .map((s) => /^(?:DNS|IP Address):(.+)$/.exec(s)?.[1])
    .filter((s): s is string => s !== undefined);
}

/**
 * Loads an Owner-provided certificate (optionally followed by its intermediates) and private key. Both paths
 * are checked against the deny list before either file is opened; errors carry a fixed message only. `uiDir` is
 * null when the server serves no UI folder (then only the data folder's files are denied).
 */
export function loadProvided(
  certFile: string,
  keyFile: string,
  deny: CertDenyList,
  opts: { now?: () => Date } = {},
): CertMaterial {
  const certText = readBounded(certFile, deny);
  const keyText = readBounded(keyFile, deny);
  const chain = parseChain(certText);
  const key = parseKey(keyText);
  const leaf = chain[0]!;
  let matches = false;
  try {
    matches = leaf.checkPrivateKey(key);
  } catch {
    matches = false;
  }
  if (!matches) throw new CertificateError("mismatch");
  const now = (opts.now ?? (() => new Date()))().getTime();
  // Every certificate in the chain, not only the leaf: an expired intermediate breaks the chain for clients.
  if (chain.some((c) => now < c.validFromDate.getTime())) throw new CertificateError("not_yet_valid");
  if (chain.some((c) => now > c.validToDate.getTime())) throw new CertificateError("expired");
  return {
    certPem: chain.map((c) => c.toString()).join(""),
    keyPem: key.export({ type: "pkcs8", format: "pem" }) as string,
    fingerprint: leaf.fingerprint256,
    expiresAt: leaf.validToDate.toISOString(),
    subjectAltNames: sanList(leaf),
  };
}

// ---------- local names ----------

type OsLike = Pick<typeof nodeOs, "hostname" | "networkInterfaces">;

/** os.hostname() (+ ".local" when it has no dot) and the non-internal IPv4 addresses, for the self-signed SANs. */
export function localAddresses(os: OsLike = nodeOs): { hostnames: string[]; addresses: string[] } {
  const raw = os.hostname().toLowerCase();
  const host = raw.includes(".") ? raw : `${raw}.local`;
  const addresses = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      const family = n.family as string | number;
      if (!n.internal && (family === "IPv4" || family === 4) && isIP(n.address) === 4) addresses.add(n.address);
    }
  }
  return { hostnames: validHostname(host) ? [host] : [], addresses: [...addresses] };
}
