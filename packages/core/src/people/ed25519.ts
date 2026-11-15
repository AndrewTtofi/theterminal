import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/**
 * Ed25519 key login: a person proves they hold the private key for a public key by signing
 * `theterminal-auth\n<challenge>\n<host>` (UTF-8), so a signature is bound to one single-use challenge and to the
 * host the client connected to. Uses node:crypto only. Every check fails closed: malformed input is `false`, never
 * an exception.
 */

const B64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;

/** Decodes canonical base64url only (no padding, no stray characters), so one key has one spelling. */
function decode(s: unknown): Buffer | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 2000 || !B64URL.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/** `base64url(sha256(der))` of an SPKI public key given as base64url DER: 43 characters. Throws on bad input. */
export function keyCredentialId(publicKeySpkiB64url: string): string {
  const der = decode(publicKeySpkiB64url);
  if (!der) throw new Error("public key is not base64url");
  return createHash("sha256").update(der).digest("base64url");
}

/** Constant-time comparison of two credential ids (or any two strings); empty strings never match. */
export function credentialIdEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  // Hash first so the comparison is fixed-length and does not leak the length of either side.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const HOST_CHARS = /^[\x21-\x7e]+$/;

export function verifyKeyLogin(i: { publicKey: string; challenge: string; host: string; signature: string }): boolean {
  try {
    const der = decode(i.publicKey);
    const sig = decode(i.signature);
    if (!der || !sig || sig.length !== ED25519_SIGNATURE_BYTES) return false;
    if (typeof i.challenge !== "string" || i.challenge.length > 200 || !decode(i.challenge)) return false;
    if (typeof i.host !== "string" || i.host.length > 300 || !HOST_CHARS.test(i.host)) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    const message = Buffer.from(`theterminal-auth\n${i.challenge}\n${i.host}`, "utf8");
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}
