import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { describe, it, expect } from "vitest";
import { credentialIdEquals, keyCredentialId, verifyKeyLogin } from "../../src/people/ed25519.js";

const spki = (k: KeyObject) => k.export({ type: "spki", format: "der" }).toString("base64url");
const challenge = () => randomBytes(32).toString("base64url");
const message = (c: string, host: string) => Buffer.from(`theterminal-auth\n${c}\n${host}`, "utf8");
const HOST = "tt-test.local:4318";

function signed(c = challenge(), host = HOST) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { publicKey: spki(publicKey), challenge: c, host, signature: sign(null, message(c, host), privateKey).toString("base64url"), privateKey };
}

describe("verifyKeyLogin", () => {
  it("accepts an Ed25519 signature over the challenge and host", () => {
    const s = signed();
    expect(verifyKeyLogin({ publicKey: s.publicKey, challenge: s.challenge, host: s.host, signature: s.signature })).toBe(true);
  });

  it("refuses a wrong host, a wrong challenge or another key", () => {
    const s = signed();
    expect(verifyKeyLogin({ ...s, host: "evil.example.org:4318" })).toBe(false);
    expect(verifyKeyLogin({ ...s, challenge: challenge() })).toBe(false);
    expect(verifyKeyLogin({ ...s, publicKey: signed().publicKey })).toBe(false);
  });

  it("refuses a tampered signature and a signature that is not 64 bytes", () => {
    const s = signed();
    const sig = Buffer.from(s.signature, "base64url");
    sig[10] = (sig[10] ?? 0) ^ 1;
    expect(verifyKeyLogin({ ...s, signature: sig.toString("base64url") })).toBe(false);
    expect(verifyKeyLogin({ ...s, signature: Buffer.concat([Buffer.from(s.signature, "base64url"), Buffer.from([0])]).toString("base64url") })).toBe(false);
    expect(verifyKeyLogin({ ...s, signature: "" })).toBe(false);
  });

  it("refuses an RSA or EC key even with a valid signature from it", () => {
    const c = challenge();
    for (const [type, opts] of [["rsa", { modulusLength: 2048 }], ["ec", { namedCurve: "P-256" }]] as const) {
      const { privateKey, publicKey } = generateKeyPairSync(type as "rsa", opts as { modulusLength: number });
      const sig = sign("sha256", message(c, HOST), privateKey).toString("base64url");
      expect(verifyKeyLogin({ publicKey: spki(publicKey), challenge: c, host: HOST, signature: sig })).toBe(false);
    }
  });

  it("refuses malformed input without throwing", () => {
    const s = signed();
    expect(verifyKeyLogin({ ...s, publicKey: "not base64url!" })).toBe(false);
    expect(verifyKeyLogin({ ...s, publicKey: Buffer.from("garbage").toString("base64url") })).toBe(false);
    expect(verifyKeyLogin({ ...s, signature: s.signature + "=" })).toBe(false);
    expect(verifyKeyLogin({ ...s, challenge: "" })).toBe(false);
    expect(verifyKeyLogin({ ...s, challenge: "a\nb" })).toBe(false);
    expect(verifyKeyLogin({ ...s, host: "" })).toBe(false);
    expect(verifyKeyLogin({ ...s, host: "a\nb" })).toBe(false);
    expect(verifyKeyLogin({ ...(s as object), publicKey: 5 } as never)).toBe(false);
  });

  it("refuses a signature bound to a challenge with a host suffix moved into it", () => {
    // `theterminal-auth\n<c>\n<host>`: newline is never valid in a challenge or host, so the split is unambiguous.
    const s = signed("abc", "x\ny");
    expect(verifyKeyLogin({ ...s, challenge: "abc\nx", host: "y" })).toBe(false);
  });
});

describe("keyCredentialId", () => {
  it("is base64url(sha256(der)), 43 characters, stable for the same key", () => {
    const s = signed();
    const id = keyCredentialId(s.publicKey);
    expect(id).toHaveLength(43);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyCredentialId(s.publicKey)).toBe(id);
    expect(keyCredentialId(signed().publicKey)).not.toBe(id);
  });

  it("throws on input that is not canonical base64url", () => {
    expect(() => keyCredentialId("a+b/")).toThrow();
    expect(() => keyCredentialId("")).toThrow();
  });
});

describe("credentialIdEquals", () => {
  it("compares in constant time and handles different lengths", () => {
    const id = keyCredentialId(signed().publicKey);
    expect(credentialIdEquals(id, id)).toBe(true);
    expect(credentialIdEquals(id, keyCredentialId(signed().publicKey))).toBe(false);
    expect(credentialIdEquals(id, id.slice(1))).toBe(false);
    expect(credentialIdEquals("", "")).toBe(false);
  });
});
