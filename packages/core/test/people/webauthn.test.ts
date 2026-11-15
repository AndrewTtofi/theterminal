import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { describe, it, expect } from "vitest";
import {
  InvalidCredentialError,
  authenticationOptions,
  challengeOf,
  registrationOptions,
  rpFor,
  verifyAuthentication,
  verifyRegistration,
  type Rp,
} from "../../src/people/webauthn.js";
import { softAuthenticator } from "../fixtures/webauthn.js";

const RP: Rp = { rpId: "tt-test.local", origin: "https://tt-test.local:4318" };
const USER = { id: "person-1", name: "Ada" };
const challenge = () => randomBytes(32).toString("base64url");

function req(host: string | undefined, tls: boolean, listener?: "local" | "remote"): FastifyRequest {
  return { headers: host === undefined ? {} : { host }, raw: { socket: { encrypted: tls } }, ...(listener ? { listener } : {}) } as unknown as FastifyRequest;
}

async function registered(rp: Rp = RP) {
  const auth = softAuthenticator(rp);
  const c = challenge();
  const options = await registrationOptions(rp, USER, [], c);
  const cred = await verifyRegistration(rp, c, auth.register(options));
  return { auth, cred: { ...cred, counter: 0 } };
}

async function expectInvalid(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidCredentialError);
  expect((err as Error).message).toBe("invalid credential");
}

describe("rpFor", () => {
  it("uses https for the remote listener and the hostname as the RP ID", () => {
    expect(rpFor(req("tt-test.local:4318", true))).toEqual({ rpId: "tt-test.local", origin: "https://tt-test.local:4318" });
    expect(rpFor(req("tt-test.local:4318", false, "remote"))).toEqual({ rpId: "tt-test.local", origin: "https://tt-test.local:4318" });
  });
  it("uses http for the local listener", () => {
    expect(rpFor(req("theterminal.localhost:4317", false))).toEqual({ rpId: "theterminal.localhost", origin: "http://theterminal.localhost:4317" });
    expect(rpFor(req("theterminal.localhost:4317", true, "local"))?.origin).toBe("http://theterminal.localhost:4317");
  });
  it("lower-cases the host", () => {
    expect(rpFor(req("TT-Test.Local:4318", true))).toEqual({ rpId: "tt-test.local", origin: "https://tt-test.local:4318" });
  });
  it("is null for IP literals, a missing or malformed Host", () => {
    expect(rpFor(req("192.168.1.10:4318", true))).toBeNull();
    expect(rpFor(req("[::1]:4318", true))).toBeNull();
    expect(rpFor(req("127.0.0.1", false))).toBeNull();
    expect(rpFor(req(undefined, true))).toBeNull();
    expect(rpFor(req("", true))).toBeNull();
    expect(rpFor(req("evil.example/x:4318", true))).toBeNull();
    expect(rpFor(req("a b:4318", true))).toBeNull();
    expect(rpFor(req("host:99999", true))).toBeNull();
    expect(rpFor(req("user@host:4318", true))).toBeNull();
  });
});

describe("rpFor default ports", () => {
  it("drops :443 from a remote origin and :80 from a local one, as browsers do, and keeps any other port", () => {
    expect(rpFor(req("tt-test.local:443", true))).toEqual({ rpId: "tt-test.local", origin: "https://tt-test.local" });
    expect(rpFor(req("theterminal.localhost:80", false))).toEqual({ rpId: "theterminal.localhost", origin: "http://theterminal.localhost" });
    expect(rpFor(req("tt-test.local:80", true))?.origin).toBe("https://tt-test.local:80");
    expect(rpFor(req("theterminal.localhost:443", false))?.origin).toBe("http://theterminal.localhost:443");
  });
});

describe("options", () => {
  it("uses the person id as the user handle, hashed to 32 bytes when it would exceed WebAuthn's 64", async () => {
    const short = await registrationOptions(RP, USER, [], challenge());
    expect(Buffer.from(short.user.id, "base64url").toString("utf8")).toBe("person-1");
    const long = await registrationOptions(RP, { id: "p".repeat(65), name: "Ada" }, [], challenge());
    expect(Buffer.from(long.user.id, "base64url")).toEqual(createHash("sha256").update("p".repeat(65)).digest());
    const exact = await registrationOptions(RP, { id: "q".repeat(64), name: "Ada" }, [], challenge());
    expect(Buffer.from(exact.user.id, "base64url").toString("utf8")).toBe("q".repeat(64));
  });
  it("registration requires a resident key and user verification, ES256 and Ed25519, no attestation", async () => {
    const c = challenge();
    const o = await registrationOptions(RP, USER, [{ kind: "passkey", credentialId: "AAAA", publicKey: "AAAA", transports: ["internal"], label: "x" }], c);
    expect(o.challenge).toBe(c);
    expect(o.rp).toEqual({ name: "The Terminal", id: "tt-test.local" });
    expect(o.authenticatorSelection?.userVerification).toBe("required");
    expect(o.authenticatorSelection?.residentKey).toBe("required");
    expect(o.attestation).toBe("none");
    expect(o.pubKeyCredParams.map((p) => p.alg).sort((a, b) => a - b)).toEqual([-8, -7]);
    expect(o.excludeCredentials).toEqual([{ id: "AAAA", type: "public-key", transports: ["internal"] }]);
    expect(o.user.name).toBe("Ada");
  });
  it("authentication is discoverable and requires user verification", async () => {
    const c = challenge();
    const o = await authenticationOptions(RP, c);
    expect(o.challenge).toBe(c);
    expect(o.rpId).toBe("tt-test.local");
    expect(o.userVerification).toBe("required");
    expect(o.allowCredentials ?? []).toEqual([]);
  });
  it("refuses a challenge that is not canonical base64url", async () => {
    await expect(authenticationOptions(RP, "not base64url!")).rejects.toThrow();
    await expect(registrationOptions(RP, USER, [], "")).rejects.toThrow();
  });
});

describe("verifyRegistration", () => {
  it("yields a passkey whose publicKey is the base64url of the COSE bytes", async () => {
    const auth = softAuthenticator(RP);
    const c = challenge();
    const response = auth.register(await registrationOptions(RP, USER, [], c));
    expect(challengeOf(response)).toBe(c);
    const cred = await verifyRegistration(RP, c, response);
    expect(cred.kind).toBe("passkey");
    expect(cred.credentialId).toBe(response.id);
    expect(cred.publicKey).toBe(Buffer.from(auth.cosePublicKey).toString("base64url"));
    expect(cred.kind === "passkey" && cred.transports).toEqual(["internal"]);
  });
  it("refuses a wrong challenge, origin or RP ID, or no user verification, with a fixed message", async () => {
    const c = challenge();
    const o = await registrationOptions(RP, USER, [], c);
    await expectInvalid(verifyRegistration(RP, challenge(), softAuthenticator(RP).register(o)));
    await expectInvalid(verifyRegistration(RP, c, softAuthenticator({ ...RP, origin: "https://tt-test.local:4319" }).register(o)));
    await expectInvalid(verifyRegistration(RP, c, softAuthenticator({ ...RP, origin: "http://tt-test.local:4318" }).register(o)));
    await expectInvalid(verifyRegistration(RP, c, softAuthenticator({ rpId: "evil.example.org", origin: RP.origin }).register(o)));
    await expectInvalid(verifyRegistration(RP, c, softAuthenticator(RP).register(o, { uv: false })));
  });
  it("refuses garbage", async () => {
    await expectInvalid(verifyRegistration(RP, challenge(), null));
    await expectInvalid(verifyRegistration(RP, challenge(), { id: "x" }));
    await expectInvalid(verifyRegistration(RP, challenge(), "string"));
  });
});

describe("verifyAuthentication", () => {
  it("verifies an assertion and returns the next counter", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    const response = auth.authenticate(await authenticationOptions(RP, c));
    expect(challengeOf(response)).toBe(c);
    expect(await verifyAuthentication(RP, c, response, cred)).toEqual({ newCounter: 1 });
    const c2 = challenge();
    expect(await verifyAuthentication(RP, c2, auth.authenticate(await authenticationOptions(RP, c2)), { ...cred, counter: 1 })).toEqual({ newCounter: 2 });
  });
  it("refuses the same assertion replayed (counter not increased)", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    const response = auth.authenticate(await authenticationOptions(RP, c));
    const { newCounter } = await verifyAuthentication(RP, c, response, cred);
    await expectInvalid(verifyAuthentication(RP, c, response, { ...cred, counter: newCounter }));
  });
  it("refuses a counter that went backwards", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    await expectInvalid(verifyAuthentication(RP, c, auth.authenticate(await authenticationOptions(RP, c)), { ...cred, counter: 5 }));
  });
  it("refuses an assertion without the uv flag", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    await expectInvalid(verifyAuthentication(RP, c, auth.authenticate(await authenticationOptions(RP, c), { uv: false }), cred));
  });
  it("refuses a wrong challenge", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    await expectInvalid(verifyAuthentication(RP, challenge(), auth.authenticate(await authenticationOptions(RP, c)), cred));
  });
  it("refuses another origin or RP ID, exactly", async () => {
    const { auth, cred } = await registered();
    for (const rp of [
      { ...RP, origin: "https://tt-test.local:4319" },
      { ...RP, origin: "https://tt-test.local" },
      { ...RP, origin: "http://tt-test.local:4318" },
      { ...RP, origin: "https://TT-test.local:4318" },
    ]) {
      const c = challenge();
      await expectInvalid(verifyAuthentication(RP, c, auth.authenticate(await authenticationOptions(RP, c), { origin: rp.origin }), cred));
    }
    const c = challenge();
    await expectInvalid(verifyAuthentication(RP, c, auth.authenticate(await authenticationOptions(RP, c), { rpId: "evil.example.org" }), cred));
    const c2 = challenge();
    await expectInvalid(verifyAuthentication({ rpId: "other.local", origin: "https://other.local:4318" }, c2, auth.authenticate(await authenticationOptions(RP, c2)), cred));
  });
  it("refuses a cross-origin assertion", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    await expectInvalid(verifyAuthentication(RP, c, auth.authenticate(await authenticationOptions(RP, c), { crossOrigin: true }), cred));
  });
  it("refuses a forged assertion: a tampered signature, another key, or another credential's id", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    const good = auth.authenticate(await authenticationOptions(RP, c));
    const sig = Buffer.from(good.response.signature, "base64url");
    sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 1;
    await expectInvalid(verifyAuthentication(RP, c, { ...good, response: { ...good.response, signature: sig.toString("base64url") } }, cred));
    // Signed by another authenticator, presented against this credential.
    const other = await registered();
    const c2 = challenge();
    await expectInvalid(verifyAuthentication(RP, c2, other.auth.authenticate(await authenticationOptions(RP, c2)), cred));
    // This authenticator's assertion relabelled with another credential id.
    const c3 = challenge();
    const a = auth.authenticate(await authenticationOptions(RP, c3));
    await expectInvalid(verifyAuthentication(RP, c3, { ...a, id: other.cred.credentialId, rawId: other.cred.credentialId }, cred));
    // Tampered authenticator data (counter bumped after signing).
    const c4 = challenge();
    const b = auth.authenticate(await authenticationOptions(RP, c4));
    const ad = Buffer.from(b.response.authenticatorData, "base64url");
    ad[36] = (ad[36] ?? 0) + 1;
    await expectInvalid(verifyAuthentication(RP, c4, { ...b, response: { ...b.response, authenticatorData: ad.toString("base64url") } }, cred));
  });
  it("refuses a registration response, garbage and a key credential", async () => {
    const { auth, cred } = await registered();
    const c = challenge();
    await expectInvalid(verifyAuthentication(RP, c, auth.register(await registrationOptions(RP, USER, [], c)), cred));
    await expectInvalid(verifyAuthentication(RP, c, null, cred));
    await expectInvalid(verifyAuthentication(RP, c, { id: cred.credentialId }, cred));
    const a = auth.authenticate(await authenticationOptions(RP, c));
    await expectInvalid(verifyAuthentication(RP, c, a, { kind: "key", credentialId: cred.credentialId, publicKey: cred.publicKey, label: "k", counter: 0 }));
  });
});

describe("challengeOf", () => {
  it("is null for anything without a readable clientDataJSON challenge", () => {
    expect(challengeOf(null)).toBeNull();
    expect(challengeOf({ response: { clientDataJSON: "!!" } })).toBeNull();
    expect(challengeOf({ response: { clientDataJSON: Buffer.from("{}").toString("base64url") } })).toBeNull();
    expect(challengeOf({ response: { clientDataJSON: Buffer.from('{"challenge":5}').toString("base64url") } })).toBeNull();
  });
});
