import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { FINGERPRINT, PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS, encodePairingCode } from "@theterminal/shared";

/**
 * Pairing: the showing machine opens a window and displays a one-time code (its fingerprint prefix plus a 4-byte
 * secret); the entering machine types it, checks the prefix against the certificate it was shown, and proves it
 * knows the secret with an HMAC bound to that TLS connection (its exported keying material) and its own public key.
 * The showing side answers with the same HMAC under the ack label, so each side proves the code to the other.
 *
 * The secret is short (32 bits), which is why a window lives ten minutes and closes itself after five wrong proofs.
 */

export type PairingProofLabel = "theterminal-pair-v1" | "theterminal-pair-ack-v1";
const LABELS: ReadonlySet<string> = new Set<PairingProofLabel>(["theterminal-pair-v1", "theterminal-pair-ack-v1"]);
const SECRET_BYTES = 4;
const PROOF = /^[0-9a-f]{64}$/;

/** HMAC-SHA256 in lower-case hex, keyed by the code's secret, over label ‖ EKM ‖ SPKI DER. */
export function pairingProof(secret: Uint8Array, label: PairingProofLabel, ekm: Buffer, spkiDer: Buffer): string {
  if (!LABELS.has(label)) throw new TypeError("unknown pairing proof label");
  return createHmac("sha256", secret).update(label, "utf8").update(ekm).update(spkiDer).digest("hex");
}

type OpenWindow = { secret: Uint8Array; expiresAt: number; attempts: number };

export class PairingWindow {
  private readonly fingerprint: string;
  private readonly now: () => Date;
  private readonly random: (n: number) => Uint8Array;
  private window: OpenWindow | null = null;
  /** The secret of the window an "ok" consumed, kept only until the ack proof is made. */
  private consumed: Uint8Array | null = null;

  constructor(deps: { fingerprint: string; now?: () => Date; random?: (n: number) => Uint8Array }) {
    if (!FINGERPRINT.test(deps.fingerprint)) throw new TypeError("fingerprint must be 64 lower-case hex characters");
    this.fingerprint = deps.fingerprint;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? ((n) => new Uint8Array(randomBytes(n)));
  }

  /** Opens a fresh window with a new secret, replacing any earlier one (and its attempt count). */
  open(): { code: string; expiresAt: string } {
    this.clear();
    const secret = Uint8Array.from(this.random(SECRET_BYTES));
    if (secret.length !== SECRET_BYTES) throw new TypeError(`random must return ${SECRET_BYTES} bytes`);
    const code = encodePairingCode(this.fingerprint, secret);
    const expiresAt = this.now().getTime() + PAIRING_CODE_TTL_MS;
    this.window = { secret, expiresAt, attempts: 0 };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  isOpen(): boolean {
    return this.current() !== null;
  }

  /** Wrong proofs counted against the open window; 0 when none is open. */
  attempts(): number {
    return this.current()?.attempts ?? 0;
  }

  cancel(): void {
    this.clear();
  }

  /**
   * Checks the entering side's proof for this connection. "none": no window is open (never opened, expired,
   * cancelled or already used). "rejected": a wrong or malformed proof, counted; the window closes itself at
   * PAIRING_MAX_ATTEMPTS. "ok": the window is consumed and its secret kept for one `secret()` call.
   */
  verify(proof: string, ekm: Buffer, peerSpki: Buffer): "ok" | "rejected" | "none" {
    const w = this.current();
    if (!w) return "none";
    const expected = Buffer.from(pairingProof(w.secret, "theterminal-pair-v1", ekm, peerSpki), "hex");
    // The format check depends only on the attacker's own input; the comparison itself is constant-time.
    const wellFormed = typeof proof === "string" && PROOF.test(proof);
    const given = wellFormed ? Buffer.from(proof, "hex") : Buffer.alloc(expected.length);
    if (timingSafeEqual(given, expected) && wellFormed) {
      this.consumed = w.secret;
      this.window = null;
      return "ok";
    }
    w.attempts++;
    if (w.attempts >= PAIRING_MAX_ATTEMPTS) this.clear();
    return "rejected";
  }

  /** The consumed window's secret for the ack proof: once, after "ok"; null otherwise. */
  secret(): Uint8Array | null {
    const s = this.consumed;
    if (!s) return null;
    this.consumed = null;
    const copy = Uint8Array.from(s);
    s.fill(0);
    return copy;
  }

  private current(): OpenWindow | null {
    const w = this.window;
    if (!w) return null;
    if (this.now().getTime() >= w.expiresAt) {
      this.clear();
      return null;
    }
    return w;
  }

  private clear(): void {
    this.window?.secret.fill(0);
    this.window = null;
    this.consumed?.fill(0);
    this.consumed = null;
  }
}
