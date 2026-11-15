import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { SecretStore } from "../secrets/store.js";
import { derToPem, selfSignedCertificate } from "./x509.js";

/** The keychain account holding this machine's Ed25519 private key, as a PKCS#8 PEM. */
export const IDENTITY_ACCOUNT = "link/identity";

/** The first 16 bytes of SHA-256 over the SPKI DER, as 32 lower-case hex characters. */
export function machineIdOf(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest().subarray(0, 16).toString("hex");
}

/** SHA-256 over the SPKI DER, as 64 lower-case hex characters. */
export function fingerprintOf(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex");
}

/** Whether `signatureHex` is a valid Ed25519 signature of `data` by the SPKI DER key; false on any error. */
export function verifySignature(publicKeyDer: Buffer, data: Buffer, signatureHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, data, key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export type IdentityCreated = { machineId: string; publicKey: string; fingerprint: string };

/**
 * This machine's link identity: an Ed25519 key kept in the keychain and a self-signed certificate for it.
 * The private key lives only in a private field: it is handed to node:tls by `tls()` and never logged or serialised.
 */
export class LinkIdentity {
  readonly machineId: string;
  readonly fingerprint: string;
  readonly publicKeyDer: Buffer;
  readonly publicKeyBase64: string;
  readonly certPem: string;
  readonly #key: KeyObject;
  readonly #keyPem: string;

  private constructor(keyPem: string) {
    this.#keyPem = keyPem;
    this.#key = createPrivateKey(keyPem);
    if (this.#key.asymmetricKeyType !== "ed25519") throw new Error("link identity is not an Ed25519 key");
    const publicKey = createPublicKey(this.#key);
    this.publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    this.publicKeyBase64 = this.publicKeyDer.toString("base64");
    this.fingerprint = fingerprintOf(this.publicKeyDer);
    this.machineId = machineIdOf(this.publicKeyDer);
    this.certPem = derToPem(selfSignedCertificate(this.#key, publicKey, `tt-${this.machineId}`), "CERTIFICATE");
  }

  /**
   * Loads the key from `secrets`, or generates and stores one and then calls `onCreated`.
   * A `SecretStoreUnavailableError` propagates; nothing is created when the store cannot be read or written.
   */
  static async load(deps: { secrets: SecretStore; onCreated: (info: IdentityCreated) => void }): Promise<LinkIdentity> {
    const stored = await deps.secrets.get(IDENTITY_ACCOUNT);
    if (stored !== null) return new LinkIdentity(stored);
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await deps.secrets.set(IDENTITY_ACCOUNT, pem);
    const identity = new LinkIdentity(pem);
    deps.onCreated({ machineId: identity.machineId, publicKey: identity.publicKeyBase64, fingerprint: identity.fingerprint });
    return identity;
  }

  /** The PEM key and certificate for node:tls. */
  tls(): { key: string; cert: string } {
    return { key: this.#keyPem, cert: this.certPem };
  }

  /** An Ed25519 signature of `data`, as 128 hex characters. */
  sign(data: Buffer): string {
    return sign(null, data, this.#key).toString("hex");
  }
}
