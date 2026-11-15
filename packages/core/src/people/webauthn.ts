import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import type { FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Credential } from "@theterminal/shared";

/**
 * Passkeys (WebAuthn), wrapping @simplewebauthn/server. User verification is required on every ceremony, the
 * origin and RP ID are compared exactly, cross-origin (iframe) ceremonies are refused, and a signature counter
 * that does not go up is refused once either side is non-zero. Every failure is one `InvalidCredentialError`
 * whose message never carries the library's text.
 *
 * Challenges: the caller issues a canonical base64url challenge (ChallengeStore: 32 random bytes) and passes it
 * here. The options carry those same bytes, so `options.challenge === challenge` and `challengeOf(response)`
 * gives back the string to consume. The caller burns the challenge *before* calling a verify function, so a
 * failed verification cannot be retried; the library compares it again inside, which is harmless.
 */

export type Rp = { rpId: string; origin: string };

export class InvalidCredentialError extends Error {
  constructor() {
    super("invalid credential");
    this.name = "InvalidCredentialError";
  }
}

const RP_NAME = "The Terminal";
const ALGORITHMS = [-8, -7]; // Ed25519, ES256
const B64URL = /^[A-Za-z0-9_-]+$/;
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;

function canonical(s: unknown, max = 2000): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= max && B64URL.test(s) && Buffer.from(s, "base64url").toString("base64url") === s;
}

function challengeBytes(challenge: string): Uint8Array<ArrayBuffer> {
  if (!canonical(challenge, 200)) throw new Error("challenge is not canonical base64url");
  return Uint8Array.from(Buffer.from(challenge, "base64url"));
}

function listenerOfRequest(request: FastifyRequest): "local" | "remote" {
  const set = (request as { listener?: unknown }).listener;
  if (set === "local" || set === "remote") return set;
  return (request.raw.socket as TLSSocket | undefined)?.encrypted === true ? "remote" : "local";
}

/** The RP for a request: the Host's hostname and the origin the browser sees. Null for an IP literal (no passkeys). */
export function rpFor(request: FastifyRequest): Rp | null {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length > 300) return null;
  const m = HOST.exec(host);
  if (!m) return null;
  const hostname = (m[1] ?? "").toLowerCase();
  const port = m[2];
  if (hostname.startsWith("[") || isIP(hostname) !== 0) return null;
  if (hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  const scheme = listenerOfRequest(request) === "remote" ? "https" : "http";
  const defaultPort = scheme === "https" ? "443" : "80";
  const origin = `${scheme}://${hostname}${port === undefined || port === defaultPort ? "" : `:${port}`}`;
  return { rpId: hostname, origin };
}

export async function registrationOptions(
  rp: Rp,
  user: { id: string; name: string },
  exclude: Credential[],
  challenge: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpId,
    userID: Uint8Array.from(Buffer.from(user.id, "utf8")),
    userName: user.name,
    userDisplayName: user.name,
    challenge: challengeBytes(challenge),
    attestationType: "none",
    excludeCredentials: exclude
      .filter((c) => c.kind === "passkey")
      .map((c) => ({ id: c.credentialId, transports: c.kind === "passkey" ? c.transports : [] })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

export async function authenticationOptions(rp: Rp, challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.rpId,
    challenge: challengeBytes(challenge),
    allowCredentials: [],
    userVerification: "required",
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clientData(response: unknown): Record<string, unknown> | null {
  if (!isRecord(response) || !isRecord(response.response)) return null;
  const raw = response.response.clientDataJSON;
  if (!canonical(raw, 10_000)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The challenge a response claims to answer (from its clientDataJSON), for the caller to consume; null if none. */
export function challengeOf(response: unknown): string | null {
  const c = clientData(response)?.challenge;
  return canonical(c, 200) ? c : null;
}

/** Refuses anything the library would let through that our rules do not: cross-origin ceremonies, a top origin. */
function sameOriginOnly(response: unknown): void {
  const cd = clientData(response);
  if (!cd || cd.crossOrigin === true || cd.topOrigin !== undefined) throw new InvalidCredentialError();
}

function transportsOf(response: Record<string, unknown>): string[] {
  const t = isRecord(response.response) ? response.response.transports : undefined;
  if (!Array.isArray(t)) return [];
  return t.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 32).slice(0, 10);
}

export async function verifyRegistration(rp: Rp, challenge: string, response: unknown): Promise<Credential> {
  try {
    if (!isRecord(response) || !canonical(challenge, 200)) throw new InvalidCredentialError();
    sameOriginOnly(response);
    const result = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    const info = result.registrationInfo;
    if (!result.verified || !info || !info.userVerified) throw new InvalidCredentialError();
    if (info.origin !== rp.origin || info.rpID !== rp.rpId) throw new InvalidCredentialError();
    const credentialId = info.credential.id;
    const publicKey = Buffer.from(info.credential.publicKey).toString("base64url");
    if (!canonical(credentialId) || credentialId !== response.id || !canonical(publicKey)) throw new InvalidCredentialError();
    return { kind: "passkey", credentialId, publicKey, transports: transportsOf(response), label: "Passkey" };
  } catch {
    throw new InvalidCredentialError();
  }
}

export async function verifyAuthentication(
  rp: Rp,
  challenge: string,
  response: unknown,
  cred: Credential & { counter: number },
): Promise<{ newCounter: number }> {
  try {
    if (!isRecord(response) || !canonical(challenge, 200)) throw new InvalidCredentialError();
    if (cred.kind !== "passkey" || response.id !== cred.credentialId || response.rawId !== cred.credentialId) {
      throw new InvalidCredentialError();
    }
    if (!Number.isInteger(cred.counter) || cred.counter < 0) throw new InvalidCredentialError();
    sameOriginOnly(response);
    const result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: Uint8Array.from(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports as AuthenticatorTransport[],
      },
    });
    const info = result.authenticationInfo;
    if (!result.verified || !info.userVerified) throw new InvalidCredentialError();
    if (info.origin !== rp.origin || info.rpID !== rp.rpId) throw new InvalidCredentialError();
    // The library refuses this too; checked again here because it is the replay rule.
    if ((cred.counter > 0 || info.newCounter > 0) && info.newCounter <= cred.counter) throw new InvalidCredentialError();
    return { newCounter: info.newCounter };
  } catch {
    throw new InvalidCredentialError();
  }
}
