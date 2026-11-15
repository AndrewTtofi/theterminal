import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Rp } from "../../src/people/webauthn.js";

/**
 * Test-only software authenticator: an ES256 key from node:crypto, "none" attestation, a signature counter that
 * goes up by one per assertion, and a small CBOR encoder. Written separately from @simplewebauthn/server so the
 * tests do not check the library against itself. Overrides let a test produce responses a real browser would not:
 * the uv flag clear, another origin or RP ID, a cross-origin assertion.
 */
type Cbor = number | string | Uint8Array | boolean | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) return Buffer.from([m | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("cbor: integers only");
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === "boolean") return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries: [Cbor, Cbor][] = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type SoftOverrides = { uv?: boolean; origin?: string; rpId?: string; crossOrigin?: boolean };

export function softAuthenticator(rp: Rp) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cosePublicKey = cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]),
  );
  const credentialId = randomBytes(16);
  let counter = 0;
  let userHandle: string | undefined;

  const authData = (o: SoftOverrides, extra: Buffer[], flags: number, count: number) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(count);
    const f = flags | UP | (o.uv === false ? 0 : UV);
    return Buffer.concat([sha256(o.rpId ?? rp.rpId), Buffer.from([f]), c, ...extra]);
  };
  const clientData = (type: string, challenge: string, o: SoftOverrides) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: o.origin ?? rp.origin, crossOrigin: o.crossOrigin ?? false }));

  return {
    cosePublicKey,
    credentialId: b64u(credentialId),
    get counter() {
      return counter;
    },
    register(options: PublicKeyCredentialCreationOptionsJSON, o: SoftOverrides = {}): RegistrationResponseJSON {
      userHandle = options.user.id;
      const len = Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]);
      const ad = authData(o, [Buffer.alloc(16), len, credentialId, cosePublicKey], AT, counter);
      const attestationObject = cbor({ fmt: "none", attStmt: {}, authData: ad });
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", options.challenge, o)),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    authenticate(options: PublicKeyCredentialRequestOptionsJSON, o: SoftOverrides = {}): AuthenticationResponseJSON {
      counter += 1;
      const ad = authData(o, [], 0, counter);
      const cd = clientData("webauthn.get", options.challenge, o);
      const signature = sign("sha256", Buffer.concat([ad, sha256(cd)]), privateKey);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(ad),
          signature: b64u(signature),
          ...(userHandle ? { userHandle } : {}),
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
