import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS, parsePairingCode } from "@theterminal/shared";
import { PairingWindow, pairingProof } from "../../src/link/pairing.js";

const START = new Date("2026-11-15T12:00:00.000Z");

/** A fresh Ed25519 key's SPKI DER and its fingerprint, generated here (no key material in the repository). */
function keyOf() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { spki, fingerprint: createHash("sha256").update(spki).digest("hex") };
}

function setup(randomBytes?: number[]) {
  const self = keyOf();
  const peer = keyOf();
  let now = START;
  const randomCalls: number[] = [];
  const window = new PairingWindow({
    fingerprint: self.fingerprint,
    now: () => now,
    random: randomBytes
      ? (n) => {
          randomCalls.push(n);
          return Uint8Array.from(randomBytes.slice(0, n));
        }
      : undefined,
  });
  const ekm = Buffer.alloc(32, 7);
  return {
    self,
    peer,
    window,
    ekm,
    randomCalls,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    /** The proof the entering side computes from the code it was shown. */
    proofFor(code: string, e = ekm, spki = peer.spki) {
      const parsed = parsePairingCode(code)!;
      return pairingProof(parsed.secret, "theterminal-pair-v1", e, spki);
    },
  };
}

describe("pairingProof", () => {
  const secret = Uint8Array.from([1, 2, 3, 4]);
  const spki = Buffer.from("spki-der-TESTKEY");

  it("is HMAC-SHA256 hex keyed by the secret over label, EKM and SPKI", () => {
    const ekm = Buffer.alloc(32, 9);
    const expected = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from("theterminal-pair-v1"), ekm, spki]))
      .digest("hex");
    expect(pairingProof(secret, "theterminal-pair-v1", ekm, spki)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and differs when the EKM, the label, the SPKI or the secret differs", () => {
    const ekm = Buffer.alloc(32, 1);
    const a = pairingProof(secret, "theterminal-pair-v1", ekm, spki);
    expect(pairingProof(secret, "theterminal-pair-v1", Buffer.alloc(32, 1), spki)).toBe(a);
    expect(pairingProof(secret, "theterminal-pair-v1", Buffer.alloc(32, 2), spki)).not.toBe(a);
    expect(pairingProof(secret, "theterminal-pair-ack-v1", ekm, spki)).not.toBe(a);
    expect(pairingProof(secret, "theterminal-pair-v1", ekm, Buffer.from("other-TESTKEY"))).not.toBe(a);
    expect(pairingProof(Uint8Array.from([1, 2, 3, 5]), "theterminal-pair-v1", ekm, spki)).not.toBe(a);
  });

  it("refuses a label other than the two pairing labels", () => {
    expect(() => pairingProof(secret, "theterminal-pair-v2" as never, Buffer.alloc(32), spki)).toThrow(TypeError);
  });
});

describe("PairingWindow", () => {
  it("refuses a fingerprint that is not 64 lower-case hex characters", () => {
    expect(() => new PairingWindow({ fingerprint: "ABC" })).toThrow(TypeError);
  });

  it("is closed until opened", () => {
    const t = setup();
    expect(t.window.isOpen()).toBe(false);
    expect(t.window.attempts()).toBe(0);
    expect(t.window.verify("0".repeat(64), t.ekm, t.peer.spki)).toBe("none");
    expect(t.window.secret()).toBeNull();
  });

  it("opens with a code whose parsed prefix is the first 16 hex of the fingerprint and a ten-minute expiry", () => {
    const t = setup([0xde, 0xad, 0xbe, 0xef]);
    const { code, expiresAt } = t.window.open();
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const parsed = parsePairingCode(code)!;
    expect(parsed.fingerprintPrefix).toBe(t.self.fingerprint.slice(0, 16));
    expect([...parsed.secret]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(t.randomCalls).toEqual([4]);
    expect(expiresAt).toBe(new Date(START.getTime() + PAIRING_CODE_TTL_MS).toISOString());
    expect(t.window.isOpen()).toBe(true);
  });

  it("zeroes the random bytes it was given once the code is made, keeping its own copy", () => {
    const self = keyOf();
    const handed: Uint8Array[] = [];
    const window = new PairingWindow({
      fingerprint: self.fingerprint,
      random: (n) => {
        const b = Uint8Array.from([9, 8, 7, 6].slice(0, n));
        handed.push(b);
        return b;
      },
    });
    const { code } = window.open();
    expect([...handed[0]!]).toEqual([0, 0, 0, 0]);
    expect([...parsePairingCode(code)!.secret]).toEqual([9, 8, 7, 6]);
    const peer = keyOf();
    const ekm = Buffer.alloc(32, 3);
    const proof = pairingProof(Uint8Array.from([9, 8, 7, 6]), "theterminal-pair-v1", ekm, peer.spki);
    expect(window.verify(proof, ekm, peer.spki)).toBe("ok");
  });

  it("uses node:crypto randomness by default: two windows get different secrets", () => {
    const t = setup();
    const a = parsePairingCode(t.window.open().code)!.secret;
    const b = parsePairingCode(t.window.open().code)!.secret;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("accepts the right proof once: ok, then none; the secret is handed out once for the ack", () => {
    const t = setup();
    const { code } = t.window.open();
    const secret = parsePairingCode(code)!.secret;
    expect(t.window.secret()).toBeNull();
    expect(t.window.verify(t.proofFor(code), t.ekm, t.peer.spki)).toBe("ok");
    expect(t.window.isOpen()).toBe(false);
    const handed = t.window.secret();
    expect(handed).not.toBeNull();
    expect([...handed!]).toEqual([...secret]);
    expect(t.window.secret()).toBeNull();
    expect(t.window.verify(t.proofFor(code), t.ekm, t.peer.spki)).toBe("none");
  });

  it("binds the proof to the connection's EKM and the peer's SPKI", () => {
    const t = setup();
    const { code } = t.window.open();
    expect(t.window.verify(t.proofFor(code, Buffer.alloc(32, 8)), t.ekm, t.peer.spki)).toBe("rejected");
    expect(t.window.verify(t.proofFor(code, t.ekm, keyOf().spki), t.ekm, t.peer.spki)).toBe("rejected");
    expect(t.window.attempts()).toBe(2);
    expect(t.window.verify(t.proofFor(code), t.ekm, t.peer.spki)).toBe("ok");
  });

  it("rejects an ack-labelled proof in place of the pairing proof", () => {
    const t = setup();
    const { code } = t.window.open();
    const ack = pairingProof(parsePairingCode(code)!.secret, "theterminal-pair-ack-v1", t.ekm, t.peer.spki);
    expect(t.window.verify(ack, t.ekm, t.peer.spki)).toBe("rejected");
  });

  it("keeps the window open through four wrong proofs and cancels it at the fifth", () => {
    expect(PAIRING_MAX_ATTEMPTS).toBe(5);
    const t = setup();
    const { code } = t.window.open();
    const wrong = "a".repeat(64);
    for (let i = 1; i <= 4; i++) {
      expect(t.window.verify(wrong, t.ekm, t.peer.spki)).toBe("rejected");
      expect(t.window.isOpen()).toBe(true);
      expect(t.window.attempts()).toBe(i);
    }
    expect(t.window.verify(wrong, t.ekm, t.peer.spki)).toBe("rejected");
    expect(t.window.isOpen()).toBe(false);
    // The right code after the window cancelled itself finds no window.
    expect(t.window.verify(t.proofFor(code), t.ekm, t.peer.spki)).toBe("none");
    expect(t.window.secret()).toBeNull();
  });

  it("counts a malformed proof as a wrong attempt", () => {
    const t = setup();
    t.window.open();
    for (const bad of ["", "zz", "A".repeat(64), "a".repeat(63), "a".repeat(65), 42 as unknown as string]) {
      t.window.open();
      expect(t.window.verify(bad, t.ekm, t.peer.spki)).toBe("rejected");
      expect(t.window.attempts()).toBe(1);
    }
  });

  it("expires after ten minutes: a window 601 s old answers none", () => {
    const t = setup();
    const { code } = t.window.open();
    t.advance(599_000);
    expect(t.window.isOpen()).toBe(true);
    t.advance(2_000);
    expect(t.window.isOpen()).toBe(false);
    expect(t.window.verify(t.proofFor(code), t.ekm, t.peer.spki)).toBe("none");
    expect(t.window.attempts()).toBe(0);
  });

  it("replaces an earlier window: the old code no longer works and attempts start again", () => {
    const t = setup();
    const first = t.window.open().code;
    t.window.verify("a".repeat(64), t.ekm, t.peer.spki);
    expect(t.window.attempts()).toBe(1);
    const second = t.window.open().code;
    expect(t.window.attempts()).toBe(0);
    if (first !== second) expect(t.window.verify(t.proofFor(first), t.ekm, t.peer.spki)).toBe("rejected");
    expect(t.window.verify(t.proofFor(second), t.ekm, t.peer.spki)).toBe("ok");
  });

  it("cancel closes the window and drops any secret", () => {
    const t = setup();
    const { code } = t.window.open();
    t.window.cancel();
    expect(t.window.isOpen()).toBe(false);
    expect(t.window.verify(t.proofFor(code), t.ekm, t.peer.spki)).toBe("none");
    expect(t.window.secret()).toBeNull();
  });
});
