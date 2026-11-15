import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import { connect, createServer, type TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { PAIRING_LABEL } from "@theterminal/shared";
import { CERT_NOT_AFTER, CERT_NOT_BEFORE, derToPem, selfSignedCertificate } from "../../src/link/x509.js";

const pair = () => generateKeyPairSync("ed25519");
const spki = (k: KeyObject) => k.export({ type: "spki", format: "der" });
const pkcs8 = (k: KeyObject) => k.export({ type: "pkcs8", format: "pem" }) as string;

describe("selfSignedCertificate", () => {
  it("builds a v3 Ed25519 certificate Node parses and verifies", () => {
    const { privateKey, publicKey } = pair();
    const der = selfSignedCertificate(privateKey, publicKey, "tt-test");
    const cert = new X509Certificate(der);
    expect(cert.subject).toBe("CN=tt-test");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.validFrom).toBe("Jan  1 00:00:00 2000 GMT");
    expect(cert.validTo).toBe("Dec 31 23:59:59 9999 GMT");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(privateKey)).toBe(true);
    const certSpki = cert.publicKey.export({ type: "spki", format: "der" });
    expect(certSpki).toHaveLength(44);
    expect(certSpki.equals(spki(publicKey))).toBe(true);
    expect(cert.ca).toBe(false);
    expect(CERT_NOT_BEFORE).toBe("20000101000000Z");
    expect(CERT_NOT_AFTER).toBe("99991231235959Z");
  });

  /** An Ed25519 key from a fixed seed whose SHA-256 SPKI digest starts 00 eb: the serial's first byte is zero. */
  const zeroLedSerialKey = (): { privateKey: KeyObject; publicKey: KeyObject } => {
    const seed = Buffer.alloc(32);
    seed.writeUInt32BE(384, 28);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  };
  /** The serial INTEGER's DER content, read right after the v3 version field ([0] INTEGER 2). */
  const serialDer = (der: Buffer): Buffer => {
    const version = Buffer.from("a003020102", "hex");
    const at = der.indexOf(version) + version.length;
    expect(der[at]).toBe(0x02);
    return der.subarray(at + 2, at + 2 + der[at + 1]!);
  };

  for (const [label, keys] of [["a random key", pair], ["a key whose serial starts with a zero byte", zeroLedSerialKey]] as const) {
    it(`derives a positive serial from the key and is deterministic (${label})`, () => {
      const { privateKey, publicKey } = keys();
      const a = new X509Certificate(selfSignedCertificate(privateKey, publicKey, "tt-a"));
      const b = new X509Certificate(selfSignedCertificate(privateKey, publicKey, "tt-a"));
      expect(a.serialNumber).toBe(b.serialNumber);
      // Node prints the serial's magnitude in hex, without leading zero bytes and with "-" were it negative.
      expect(a.serialNumber).toMatch(/^[0-9A-F]{1,32}$/i);
      const serial = BigInt(`0x${a.serialNumber}`);
      expect(serial > 0n && serial < 1n << 127n).toBe(true);
      // The DER INTEGER is positive (its first content byte below 0x80) and minimal, at most 16 bytes.
      const content = serialDer(a.raw);
      expect(content[0]).toBeLessThan(0x80);
      expect(content.length).toBeLessThanOrEqual(16);
      expect(content.length === 1 || content[0] !== 0 || content[1]! >= 0x80).toBe(true);
      // Ed25519 signatures are deterministic, so the whole certificate is.
      expect(a.raw.equals(b.raw)).toBe(true);
    });
  }

  it("wraps DER in a PEM block of 64-column base64", () => {
    const { privateKey, publicKey } = pair();
    const der = selfSignedCertificate(privateKey, publicKey, "tt-test");
    const pem = derToPem(der, "CERTIFICATE");
    expect(pem.startsWith("-----BEGIN CERTIFICATE-----\n")).toBe(true);
    expect(pem.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    const body = pem.split("\n").slice(1, -2);
    expect(body.every((line) => line.length <= 64)).toBe(true);
    expect(new X509Certificate(pem).raw.equals(der)).toBe(true);
  });

  it("serves two in-process TLS 1.3 peers with mutual self-signed certificates and equal keying material", { timeout: 20_000 }, async () => {
    const server = pair();
    const client = pair();
    const serverCert = derToPem(selfSignedCertificate(server.privateKey, server.publicKey, "tt-server"), "CERTIFICATE");
    const clientCert = derToPem(selfSignedCertificate(client.privateKey, client.publicKey, "tt-client"), "CERTIFICATE");
    const tlsServer = createServer({
      key: pkcs8(server.privateKey), cert: serverCert, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3",
    });
    const serverSide = new Promise<TLSSocket>((resolve) => {
      tlsServer.once("secureConnection", resolve);
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const { port } = tlsServer.address() as AddressInfo;
    try {
      const socket = connect({
        host: "127.0.0.1", port, key: pkcs8(client.privateKey), cert: clientCert, rejectUnauthorized: false, minVersion: "TLSv1.3",
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      const accepted = await serverSide;
      expect(socket.getProtocol()).toBe("TLSv1.3");
      const seenByClient = new X509Certificate(socket.getPeerCertificate(true).raw);
      const seenByServer = new X509Certificate(accepted.getPeerCertificate(true).raw);
      expect(seenByClient.publicKey.export({ type: "spki", format: "der" }).equals(spki(server.publicKey))).toBe(true);
      expect(seenByServer.publicKey.export({ type: "spki", format: "der" }).equals(spki(client.publicKey))).toBe(true);
      const a = socket.exportKeyingMaterial(32, PAIRING_LABEL);
      const b = accepted.exportKeyingMaterial(32, PAIRING_LABEL);
      expect(a).toHaveLength(32);
      expect(a.equals(b)).toBe(true);
      socket.destroy();
      accepted.destroy();
    } finally {
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    }
  });
});
