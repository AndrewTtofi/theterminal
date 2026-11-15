import { X509Certificate, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * Test-only issuer for certificates signed by another key (a CA and its leaf), EC or RSA, so certs.ts can be
 * tested on chains and RSA keys. Written separately from certs.ts's encoder on purpose.
 */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const head = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...head]), body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const out = [a * 40 + b];
  for (const v of rest) {
    const c = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) c.unshift(0x80 | (x & 0x7f));
    out.push(...c);
  }
  return der(0x06, Buffer.from(out));
}
const name = (cn: string) => seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))));
function utc(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  return der(0x17, Buffer.from(s));
}
const ext = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), der(0x04, value));

export function issueCertificate(i: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  issuerKey: KeyObject;
  ca: boolean;
  notBefore: Date;
  notAfter: Date;
  dnsNames?: string[];
}): string {
  const alg =
    i.issuerKey.asymmetricKeyType === "rsa" ? seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00])) : seq(oid("1.2.840.10045.4.3.2"));
  const serial = randomBytes(12);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const exts = i.ca
    ? [ext("2.5.29.19", true, seq(Buffer.from([0x01, 0x01, 0xff]))), ext("2.5.29.15", true, der(0x03, Buffer.from([0x01, 0x06])))]
    : [
        ext("2.5.29.19", true, seq()),
        ext("2.5.29.15", true, der(0x03, Buffer.from([0x05, 0xa0]))),
        ext("2.5.29.17", false, seq(...(i.dnsNames ?? []).map((n) => der(0x82, Buffer.from(n))))),
      ];
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    alg,
    name(i.issuer),
    seq(utc(i.notBefore), utc(i.notAfter)),
    name(i.subject),
    i.publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(...exts)),
  );
  const cert = seq(tbs, alg, der(0x03, Buffer.from([0]), sign("sha256", tbs, i.issuerKey)));
  return new X509Certificate(cert).toString();
}
