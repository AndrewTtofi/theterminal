import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { X509Certificate, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CertificateError,
  certFingerprint,
  loadProvided,
  localAddresses,
  selfSignedTlsCertificate,
} from "../../src/server/certs.js";
import { issueCertificate } from "../fixtures/x509.js";

/** Plan 8's CERT_FINGERPRINT (shared/people.ts), repeated here so this leaf module's test has no cross-task import. */
const CERT_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
const DAY = 86_400_000;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tt-certs-"));
  dirs.push(d);
  return d;
};

let consoleCalls: unknown[][];
beforeEach(() => {
  consoleCalls = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
  }
});
afterEach(() => {
  // Nothing in this module may log: a log line could carry a path or key material.
  expect(consoleCalls).toEqual([]);
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace with a ui dir, a data dir holding ledger.db and token, and a separate certs dir. */
function workspace() {
  const root = tmp();
  const uiDir = join(root, "ui");
  const dataDir = join(root, "data");
  const certs = join(root, "certs");
  for (const d of [uiDir, dataDir, certs]) mkdirSync(d);
  writeFileSync(join(dataDir, "ledger.db"), "sqlite");
  writeFileSync(join(dataDir, "token"), "TESTKEY-token");
  return { root, uiDir, dataDir, certs, deny: { uiDir, dataDir } };
}

async function writePair(dir: string, i: Parameters<typeof selfSignedTlsCertificate>[0] = { hostnames: ["tt-test.local"], addresses: [] }) {
  const m = await selfSignedTlsCertificate(i);
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  writeFileSync(certFile, m.certPem);
  writeFileSync(keyFile, m.keyPem);
  return { m, certFile, keyFile };
}

/** Runs fn, expects a CertificateError, and checks it leaks neither a path nor key material. */
function refusal(fn: () => unknown, ...secrets: string[]): CertificateError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CertificateError);
  const err = caught as CertificateError;
  const text = `${err.message} ${String(err.stack)} ${JSON.stringify(err)} ${String((err as { cause?: unknown }).cause ?? "")}`;
  expect(text).not.toContain(tmpdir());
  for (const d of dirs) expect(text).not.toContain(d);
  expect(text).not.toMatch(/PRIVATE KEY|BEGIN/);
  for (const s of secrets) expect(text).not.toContain(s);
  expect((err as { cause?: unknown }).cause).toBeUndefined();
  return err;
}

describe("selfSignedTlsCertificate", () => {
  it("makes an ECDSA P-256 certificate with the hostnames and addresses as SANs, valid for ten years", async () => {
    const now = new Date("2026-11-15T10:20:30.456Z");
    const m = await selfSignedTlsCertificate({ hostnames: ["tt-test.local"], addresses: ["192.168.1.10"], now: () => now });
    const x = new X509Certificate(m.certPem);
    expect(x.subjectAltName).toBe("DNS:tt-test.local, IP Address:192.168.1.10");
    expect(x.checkHost("tt-test.local")).toBe("tt-test.local");
    expect(x.checkIP("192.168.1.10")).toBe("192.168.1.10");
    expect(x.subject).toBe("CN=The Terminal");
    expect(x.issuer).toBe("CN=The Terminal");
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]); // serverAuth
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkPrivateKey(createPrivateKey(m.keyPem))).toBe(true);
    expect(m.keyPem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(m.subjectAltNames).toEqual(["tt-test.local", "192.168.1.10"]);
    expect(x.validFromDate.toISOString()).toBe("2026-11-15T10:20:30.000Z");
    expect(m.expiresAt).toBe(new Date(Date.parse("2026-11-15T10:20:30.000Z") + 3650 * DAY).toISOString());
    expect(x.validToDate.toISOString()).toBe(m.expiresAt);
  });

  it("reports the fingerprint in the CERT_FINGERPRINT form, equal to fingerprint256 and certFingerprint", async () => {
    const m = await selfSignedTlsCertificate({ hostnames: ["tt-test.local"], addresses: ["192.168.1.10"] });
    expect(m.fingerprint).toMatch(CERT_FINGERPRINT);
    expect(m.fingerprint).toBe(new X509Certificate(m.certPem).fingerprint256);
    expect(certFingerprint(m.certPem)).toBe(m.fingerprint);
  });

  it("uses a fresh key and a random positive serial every time", async () => {
    const i = { hostnames: ["tt-test.local"], addresses: [] };
    const [a, b] = await Promise.all([selfSignedTlsCertificate(i), selfSignedTlsCertificate(i)]);
    const [xa, xb] = [new X509Certificate(a.certPem), new X509Certificate(b.certPem)];
    expect(xa.serialNumber).not.toBe(xb.serialNumber);
    expect(xa.serialNumber).toMatch(/^[0-9A-F]{16,}$/);
    expect(Number.parseInt(xa.serialNumber.slice(0, 2), 16)).toBeLessThan(0x80);
    expect(a.keyPem).not.toBe(b.keyPem);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("encodes IPv6 addresses, dates past 2049 and a custom lifetime", async () => {
    const m = await selfSignedTlsCertificate({
      hostnames: ["localhost"],
      addresses: ["::1", "fe80::1:2", "::ffff:10.0.0.1"],
      now: () => new Date("2049-12-31T00:00:00Z"),
      days: 2,
    });
    const x = new X509Certificate(m.certPem);
    expect(x.checkIP("::1")).toBe("::1");
    expect(x.checkIP("fe80::1:2")).toBe("fe80::1:2");
    expect(x.subjectAltName).toBe("DNS:localhost, IP Address:0:0:0:0:0:0:0:1, IP Address:FE80:0:0:0:0:0:1:2, IP Address:0:0:0:0:0:FFFF:A00:1");
    expect(m.expiresAt).toBe("2050-01-02T00:00:00.000Z");
    expect(x.validToDate.toISOString()).toBe(m.expiresAt);
  });

  it("drops duplicate names and refuses invalid input", async () => {
    const m = await selfSignedTlsCertificate({ hostnames: ["TT-Test.local", "tt-test.local"], addresses: ["10.0.0.1", "10.0.0.1"] });
    expect(m.subjectAltNames).toEqual(["tt-test.local", "10.0.0.1"]);
    for (const bad of [
      { hostnames: [], addresses: [] },
      { hostnames: ["bad host"], addresses: [] },
      { hostnames: ["-x.local"], addresses: [] },
      { hostnames: ["a".repeat(64) + ".local"], addresses: [] },
      { hostnames: [], addresses: ["999.1.1.1"] },
      { hostnames: [], addresses: ["tt-test.local"] },
      { hostnames: [], addresses: ["fe80::1%en0"] },
      { hostnames: [], addresses: ["fe80::1%25eth0"] },
      { hostnames: ["tt-test.local"], addresses: [], days: 0 },
      { hostnames: ["tt-test.local"], addresses: [], days: 1.5 },
      { hostnames: ["tt-test.local"], addresses: [], days: 3651 },
    ]) {
      await expect(selfSignedTlsCertificate(bad)).rejects.toBeInstanceOf(CertificateError);
    }
  });
});

describe("certFingerprint", () => {
  it("refuses something that is not a certificate", () => {
    refusal(() => certFingerprint("not a certificate"));
  });
});

describe("loadProvided", () => {
  it("loads a matching certificate and key", async () => {
    const w = workspace();
    const { m, certFile, keyFile } = await writePair(w.certs, { hostnames: ["tt-test.local"], addresses: ["192.168.1.10"] });
    const got = loadProvided(certFile, keyFile, w.deny);
    expect(got.fingerprint).toBe(m.fingerprint);
    expect(got.fingerprint).toMatch(CERT_FINGERPRINT);
    expect(got.expiresAt).toBe(m.expiresAt);
    expect(got.subjectAltNames).toEqual(["tt-test.local", "192.168.1.10"]);
    expect(new X509Certificate(got.certPem).fingerprint256).toBe(m.fingerprint);
    expect(new X509Certificate(got.certPem).checkPrivateKey(createPrivateKey(got.keyPem))).toBe(true);
    expect(got.keyPem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("accepts CRLF files and an EC key in SEC1 form with its parameters block", async () => {
    const w = workspace();
    const { m, certFile, keyFile } = await writePair(w.certs);
    const sec1 = createPrivateKey(m.keyPem).export({ type: "sec1", format: "pem" }) as string;
    const params = "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n";
    writeFileSync(keyFile, (params + sec1).replace(/\n/g, "\r\n"));
    writeFileSync(certFile, m.certPem.replace(/\n/g, "\r\n"));
    expect(loadProvided(certFile, keyFile, w.deny).fingerprint).toBe(m.fingerprint);
  });

  it("refuses a key that does not match the certificate, without a path in the message", async () => {
    const w = workspace();
    const { certFile } = await writePair(w.certs);
    const other = await selfSignedTlsCertificate({ hostnames: ["tt-test.local"], addresses: [] });
    const otherKey = join(w.certs, "other-key.pem");
    writeFileSync(otherKey, other.keyPem);
    const err = refusal(() => loadProvided(certFile, otherKey, w.deny), other.keyPem.split("\n")[1]!);
    expect(err.code).toBe("mismatch");
  });

  it("refuses an expired or not yet valid certificate", async () => {
    const w = workspace();
    const old = await writePair(w.certs, { hostnames: ["tt-test.local"], addresses: [], now: () => new Date(Date.now() - 10 * DAY), days: 1 });
    expect(refusal(() => loadProvided(old.certFile, old.keyFile, w.deny)).code).toBe("expired");
    const future = await writePair(w.certs, { hostnames: ["tt-test.local"], addresses: [], now: () => new Date(Date.now() + 10 * DAY) });
    expect(refusal(() => loadProvided(future.certFile, future.keyFile, w.deny)).code).toBe("not_yet_valid");
    // An injected clock is honoured too.
    const ok = await writePair(w.certs);
    expect(refusal(() => loadProvided(ok.certFile, ok.keyFile, w.deny, { now: () => new Date(Date.now() + 3651 * DAY) })).code).toBe("expired");
  });

  it("refuses missing files and directories as unreadable", async () => {
    const w = workspace();
    const { certFile, keyFile } = await writePair(w.certs);
    expect(refusal(() => loadProvided(join(w.certs, "missing.pem"), keyFile, w.deny)).code).toBe("unreadable");
    expect(refusal(() => loadProvided(certFile, join(w.certs, "missing.pem"), w.deny)).code).toBe("unreadable");
    expect(refusal(() => loadProvided(w.certs, keyFile, w.deny)).code).toBe("unreadable");
    expect(refusal(() => loadProvided("", keyFile, w.deny)).code).toBe("unreadable");
    expect(refusal(() => loadProvided(`${certFile}\0`, keyFile, w.deny)).code).toBe("unreadable");
  });

  it("refuses oversized files", async () => {
    const w = workspace();
    const { m, certFile, keyFile } = await writePair(w.certs);
    const bigCert = join(w.certs, "big-cert.pem");
    writeFileSync(bigCert, m.certPem + "\n".repeat(65 * 1024));
    expect(refusal(() => loadProvided(bigCert, keyFile, w.deny)).code).toBe("too_large");
    const bigKey = join(w.certs, "big-key.pem");
    writeFileSync(bigKey, m.keyPem + "\n".repeat(65 * 1024));
    expect(refusal(() => loadProvided(certFile, bigKey, w.deny)).code).toBe("too_large");
  });

  it("refuses a certificate file that holds a private key, without echoing it", async () => {
    const w = workspace();
    const { m, certFile, keyFile } = await writePair(w.certs);
    writeFileSync(certFile, m.certPem + m.keyPem);
    const keyLine = m.keyPem.split("\n")[1]!;
    expect(refusal(() => loadProvided(certFile, keyFile, w.deny), keyLine).code).toBe("invalid_certificate");
  });

  it("refuses garbage, a chain out of order, and a key file with a certificate or two keys", async () => {
    const w = workspace();
    const { m, certFile, keyFile } = await writePair(w.certs);
    const other = await selfSignedTlsCertificate({ hostnames: ["tt-test.local"], addresses: [] });
    const bad = join(w.certs, "bad.pem");

    writeFileSync(bad, "not a certificate");
    expect(refusal(() => loadProvided(bad, keyFile, w.deny)).code).toBe("invalid_certificate");
    writeFileSync(bad, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    expect(refusal(() => loadProvided(bad, keyFile, w.deny)).code).toBe("invalid_certificate");
    writeFileSync(bad, m.certPem + other.certPem); // the second did not issue the first
    expect(refusal(() => loadProvided(bad, keyFile, w.deny)).code).toBe("invalid_certificate");

    writeFileSync(bad, "TESTKEY not a key");
    expect(refusal(() => loadProvided(certFile, bad, w.deny), "TESTKEY").code).toBe("invalid_key");
    writeFileSync(bad, m.keyPem + m.certPem);
    expect(refusal(() => loadProvided(certFile, bad, w.deny)).code).toBe("invalid_key");
    writeFileSync(bad, m.keyPem + other.keyPem);
    expect(refusal(() => loadProvided(certFile, bad, w.deny)).code).toBe("invalid_key");
  });

  it("refuses a passphrase-protected key and a key type browsers cannot use", async () => {
    const w = workspace();
    const { certFile } = await writePair(w.certs);
    const enc = join(w.certs, "enc.pem");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeFileSync(enc, privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "TESTKEY" }));
    expect(refusal(() => loadProvided(certFile, enc, w.deny)).code).toBe("invalid_key");
    const ed = join(w.certs, "ed.pem");
    writeFileSync(ed, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(refusal(() => loadProvided(certFile, ed, w.deny)).code).toBe("invalid_key");
    const rsa = join(w.certs, "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(refusal(() => loadProvided(certFile, rsa, w.deny)).code).toBe("invalid_key");
  });

  describe("chains and key types", () => {
    const year = 365 * DAY;
    /** A CA key and a leaf key, the leaf issued by the CA; dates per certificate. */
    function chain(o: { caFrom?: number; caTo?: number } = {}) {
      const ca = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const now = Date.now();
      const caPem = issueCertificate({
        subject: "Test CA",
        issuer: "Test CA",
        publicKey: ca.publicKey,
        issuerKey: ca.privateKey,
        ca: true,
        notBefore: new Date(o.caFrom ?? now - DAY),
        notAfter: new Date(o.caTo ?? now + year),
      });
      const leafPem = issueCertificate({
        subject: "tt-test.local",
        issuer: "Test CA",
        publicKey: leaf.publicKey,
        issuerKey: ca.privateKey,
        ca: false,
        notBefore: new Date(now - DAY),
        notAfter: new Date(now + year),
        dnsNames: ["tt-test.local"],
      });
      return { caPem, leafPem, leafKey: leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string };
    }
    function write(dir: string, certPem: string, keyPem: string) {
      const certFile = join(dir, "chain.pem");
      const keyFile = join(dir, "chain-key.pem");
      writeFileSync(certFile, certPem);
      writeFileSync(keyFile, keyPem);
      return { certFile, keyFile };
    }

    it("accepts a leaf followed by its intermediate, and keeps both in certPem", () => {
      const w = workspace();
      const c = chain();
      const f = write(w.certs, c.leafPem + c.caPem, c.leafKey);
      const got = loadProvided(f.certFile, f.keyFile, w.deny);
      expect(got.fingerprint).toBe(new X509Certificate(c.leafPem).fingerprint256);
      expect(got.certPem).toBe(c.leafPem + c.caPem);
      expect(got.subjectAltNames).toEqual(["tt-test.local"]);
    });

    it("refuses a chain whose intermediate has expired or is not valid yet, though the leaf is fine", () => {
      const w = workspace();
      const old = chain({ caFrom: Date.now() - 3 * DAY, caTo: Date.now() - DAY });
      let f = write(w.certs, old.leafPem + old.caPem, old.leafKey);
      expect(refusal(() => loadProvided(f.certFile, f.keyFile, w.deny)).code).toBe("expired");
      const early = chain({ caFrom: Date.now() + DAY, caTo: Date.now() + year });
      f = write(w.certs, early.leafPem + early.caPem, early.leafKey);
      expect(refusal(() => loadProvided(f.certFile, f.keyFile, w.deny)).code).toBe("not_yet_valid");
    });

    it("accepts an RSA-2048 key", () => {
      const w = workspace();
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = issueCertificate({
        subject: "tt-test.local",
        issuer: "tt-test.local",
        publicKey: rsa.publicKey,
        issuerKey: rsa.privateKey,
        ca: false,
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + 30 * DAY),
        dnsNames: ["tt-test.local"],
      });
      const f = write(w.certs, pem, rsa.privateKey.export({ type: "pkcs1", format: "pem" }) as string);
      const got = loadProvided(f.certFile, f.keyFile, w.deny);
      expect(got.fingerprint).toBe(new X509Certificate(pem).fingerprint256);
      expect(createPrivateKey(got.keyPem).asymmetricKeyType).toBe("rsa");
    });
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO as unreadable without blocking on it", async () => {
    const w = workspace();
    const { certFile } = await writePair(w.certs);
    const fifo = join(w.certs, "fifo.pem");
    execFileSync("mkfifo", [fifo]);
    expect(refusal(() => loadProvided(certFile, fifo, w.deny)).code).toBe("unreadable");
    expect(refusal(() => loadProvided(fifo, certFile, w.deny)).code).toBe("unreadable");
  }, 5_000);

  describe("deny list", () => {
    it("refuses a certificate inside uiDir even though it is a valid pair", async () => {
      const w = workspace();
      const nested = join(w.uiDir, "assets");
      mkdirSync(nested);
      const { certFile, keyFile } = await writePair(nested);
      expect(refusal(() => loadProvided(certFile, keyFile, w.deny)).code).toBe("path_denied");
      const outside = await writePair(w.certs);
      expect(refusal(() => loadProvided(outside.certFile, keyFile, w.deny)).code).toBe("path_denied");
      expect(refusal(() => loadProvided(w.uiDir, outside.keyFile, w.deny)).code).toBe("path_denied");
    });

    it("refuses the data dir's ledger.db (and its journal files) and token, in any letter case, before reading them", async () => {
      const w = workspace();
      const { certFile, keyFile } = await writePair(w.certs);
      for (const name of ["ledger.db", "ledger.db-wal", "ledger.db-shm", "ledger.db-journal", "token", "LEDGER.DB", "Token"]) {
        // The -wal etc. files do not exist: a denial, not "unreadable", proves the check runs before any read.
        expect(refusal(() => loadProvided(certFile, join(w.dataDir, name), w.deny)).code).toBe("path_denied");
        expect(refusal(() => loadProvided(join(w.dataDir, name), keyFile, w.deny)).code).toBe("path_denied");
      }
      // Relative segments do not get around it.
      expect(refusal(() => loadProvided(certFile, join(w.dataDir, "sub", "..", "ledger.db"), w.deny)).code).toBe("path_denied");
    });

    it("refuses a symbolic link that points at a denied file", async () => {
      const w = workspace();
      const { certFile } = await writePair(w.certs);
      const link = join(w.certs, "innocent.pem");
      try {
        symlinkSync(join(w.dataDir, "token"), link);
      } catch {
        return; // Windows without the symlink privilege: nothing to test.
      }
      expect(refusal(() => loadProvided(certFile, link, w.deny), "TESTKEY-token").code).toBe("path_denied");
    });

    it("allows other files in the data dir", async () => {
      const w = workspace();
      const remote = join(w.dataDir, "remote");
      mkdirSync(remote);
      const { certFile, keyFile } = await writePair(remote);
      expect(() => loadProvided(certFile, keyFile, w.deny)).not.toThrow();
    });
  });
});

describe("localAddresses", () => {
  it("adds .local to a bare hostname and lists non-internal IPv4 addresses only", () => {
    const got = localAddresses({
      hostname: () => "Studio",
      networkInterfaces: () => ({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
        en0: [
          { address: "192.168.1.10", family: "IPv4", internal: false } as never,
          { address: "fe80::1", family: "IPv6", internal: false } as never,
        ],
        en1: [{ address: "192.168.1.10", family: "IPv4", internal: false } as never, { address: "10.0.0.5", family: "IPv4", internal: false } as never],
        none: undefined,
      }),
    });
    expect(got).toEqual({ hostnames: ["studio.local"], addresses: ["192.168.1.10", "10.0.0.5"] });
  });

  it("keeps a dotted hostname and drops one that is not a valid DNS name", () => {
    const os = (hostname: string) => ({ hostname: () => hostname, networkInterfaces: () => ({}) });
    expect(localAddresses(os("box.example.org")).hostnames).toEqual(["box.example.org"]);
    expect(localAddresses(os("bad name")).hostnames).toEqual([]);
  });

  it("reads the real machine by default and returns names a certificate accepts", async () => {
    const got = localAddresses();
    for (const a of got.addresses) expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    if (got.hostnames.length + got.addresses.length > 0) {
      await expect(selfSignedTlsCertificate(got)).resolves.toBeDefined();
    }
  });
});
