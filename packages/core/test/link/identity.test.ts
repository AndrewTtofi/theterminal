import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { MACHINE_ID, FINGERPRINT } from "@theterminal/shared";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { SecretStoreUnavailableError } from "../../src/secrets/store.js";
import { IDENTITY_ACCOUNT, LinkIdentity, fingerprintOf, machineIdOf, verifySignature } from "../../src/link/identity.js";

describe("LinkIdentity", () => {
  it("creates a key in an empty store once, and reloads the same identity afterwards", async () => {
    const secrets = new MemorySecretStore();
    const onCreated = vi.fn();
    const first = await LinkIdentity.load({ secrets, onCreated });
    expect(secrets.size()).toBe(1);
    expect(await secrets.get(IDENTITY_ACCOUNT)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(onCreated).toHaveBeenCalledTimes(1);
    const info = onCreated.mock.calls[0]![0] as { machineId: string; publicKey: string; fingerprint: string };
    expect(Object.keys(info).sort()).toEqual(["fingerprint", "machineId", "publicKey"]);
    expect(info.machineId).toMatch(MACHINE_ID);
    expect(info.publicKey).toMatch(/^[A-Za-z0-9+/]{59}=$/);
    expect(info.publicKey).toHaveLength(60);
    expect(info.fingerprint).toMatch(FINGERPRINT);
    expect(info).toEqual({ machineId: first.machineId, publicKey: first.publicKeyBase64, fingerprint: first.fingerprint });

    const again = vi.fn();
    const second = await LinkIdentity.load({ secrets, onCreated: again });
    expect(second.machineId).toBe(first.machineId);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);
    expect(again).not.toHaveBeenCalled();
    expect(secrets.size()).toBe(1);
  });

  it("derives the machine id and fingerprint from the SPKI", async () => {
    const identity = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const digest = createHash("sha256").update(identity.publicKeyDer).digest("hex");
    expect(identity.publicKeyDer).toHaveLength(44);
    expect(identity.publicKeyDer.toString("base64")).toBe(identity.publicKeyBase64);
    expect(fingerprintOf(identity.publicKeyDer)).toBe(digest);
    expect(machineIdOf(identity.publicKeyDer)).toBe(digest.slice(0, 32));
    expect(identity.fingerprint).toBe(digest);
    expect(identity.machineId).toBe(digest.slice(0, 32));
  });

  it("serves a self-signed certificate for its own key", async () => {
    const identity = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const { key, cert } = identity.tls();
    expect(key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(cert).toBe(identity.certPem);
    const x509 = new X509Certificate(cert);
    expect(x509.subject).toBe(`CN=tt-${identity.machineId}`);
    expect(x509.publicKey.export({ type: "spki", format: "der" }).equals(identity.publicKeyDer)).toBe(true);
    expect(x509.checkPrivateKey(createPrivateKey(key))).toBe(true);
  });

  it("signs data that verifySignature accepts, and rejects a flipped byte or garbage", async () => {
    const identity = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const data = Buffer.from("an entry to mirror");
    const signature = identity.sign(data);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifySignature(identity.publicKeyDer, data, signature)).toBe(true);
    const flipped = Buffer.from(data);
    flipped[0]! ^= 1;
    expect(verifySignature(identity.publicKeyDer, flipped, signature)).toBe(false);
    const badSig = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
    expect(verifySignature(identity.publicKeyDer, data, badSig)).toBe(false);
    expect(verifySignature(identity.publicKeyDer, data, "not hex")).toBe(false);
    expect(verifySignature(Buffer.from("not a key"), data, signature)).toBe(false);
    const other = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    expect(verifySignature(other.publicKeyDer, data, signature)).toBe(false);
  });

  it("propagates an unavailable keychain and creates nothing", async () => {
    const onCreated = vi.fn();
    await expect(
      LinkIdentity.load({ secrets: new MemorySecretStore({ failOn: new Set(["get"]) }), onCreated }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    const noSet = new MemorySecretStore({ failOn: new Set(["set"]) });
    await expect(LinkIdentity.load({ secrets: noSet, onCreated })).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("never exposes the private key through enumeration or serialisation", async () => {
    const identity = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    expect(JSON.stringify(identity)).not.toContain("PRIVATE KEY");
    expect(Object.values(identity).some((v) => String(v).includes("PRIVATE KEY"))).toBe(false);
    expect(Object.keys(identity)).not.toContain("key");
    expect(identity.tls().key).toContain("PRIVATE KEY");
  });
});
