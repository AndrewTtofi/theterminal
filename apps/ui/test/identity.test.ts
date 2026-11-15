import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => webauthn);

import { ensureBrowserKey, hasBrowserKey, isIpLiteral, joinWithKey, joinWithPasskey, keyMessage, passkeysAvailable, signInWithKey, signInWithPasskey } from "../src/identity";
import { FakeIdb } from "./fake-idb";

const ME = { personId: "p1", name: "Reviewer One", role: "reviewer", listener: "remote", method: "key", credentials: [], sessions: [] };

let idb: FakeIdb;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls = () => fetchMock.mock.calls.map(([url, init]) => [url as string, (init as RequestInit | undefined)?.method ?? "GET", (init as RequestInit | undefined)?.body]);

beforeEach(() => {
  idb = new FakeIdb();
  vi.stubGlobal("indexedDB", idb);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  webauthn.startRegistration.mockReset();
  webauthn.startAuthentication.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("identity: the browser key", () => {
  it("makes one non-extractable Ed25519 key, stores it once in IndexedDB tt-identity, and reuses it", async () => {
    const gen = vi.spyOn(crypto.subtle, "generateKey");
    expect(await hasBrowserKey()).toBe(false);
    const a = await ensureBrowserKey();
    const b = await ensureBrowserKey();
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]).toEqual([{ name: "Ed25519" }, false, ["sign"]]);
    expect(idb.puts).toBe(1);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await hasBrowserKey()).toBe(true);
    const stored = idb.dbs.get("tt-identity")!.get("keys")!.get("browser") as { privateKey: CryptoKey; publicKey: string };
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.privateKey.type).toBe("private");
    expect(stored.publicKey).toBe(a.publicKey);
    // Nothing but the public half is kept as text.
    expect(Object.keys(stored).sort()).toEqual(["privateKey", "publicKey"]);
    gen.mockRestore();
  });

  it("signs `theterminal-auth\\n<challenge>\\n<host>` so the server's check passes", async () => {
    const key = await ensureBrowserKey();
    const message = keyMessage("Y2hhbGxlbmdl", "tt-test.local:4318");
    expect(new TextDecoder().decode(message)).toBe("theterminal-auth\nY2hhbGxlbmdl\ntt-test.local:4318");
    const sig = await key.sign(message);
    const pub = createPublicKey({ key: Buffer.from(key.publicKey, "base64url"), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(message), pub, Buffer.from(sig, "base64url"))).toBe(true);
    expect(verify(null, Buffer.from(keyMessage("Y2hhbGxlbmdl", "evil.test")), pub, Buffer.from(sig, "base64url"))).toBe(false);
  });
});

describe("identity: passkeys", () => {
  it("are available only with WebAuthn and a host name, never an IP literal", async () => {
    for (const h of ["127.0.0.1", "192.168.1.20", "[::1]", "::1", "fe80::1"]) expect(isIpLiteral(h), h).toBe(true);
    for (const h of ["tt-test.local", "theterminal.localhost", "example.test"]) expect(isIpLiteral(h), h).toBe(false);
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await passkeysAvailable()).toBe(false);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    expect(await passkeysAvailable()).toBe(location.hostname !== "" && !isIpLiteral(location.hostname));
  });

  it("joins with a passkey: options, the browser's prompt, then verify with the name", async () => {
    fetchMock.mockResolvedValueOnce(json({ challenge: "c1", rp: { id: "tt-test.local" } })).mockResolvedValueOnce(json(ME, 201));
    webauthn.startRegistration.mockResolvedValue({ id: "cred", response: {} });
    expect(await joinWithPasskey("code 1", "Reviewer One")).toEqual(ME);
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "c1", rp: { id: "tt-test.local" } } });
    expect(calls()).toEqual([
      ["/api/join/code%201/passkey/options", "POST", JSON.stringify({ name: "Reviewer One" })],
      ["/api/join/code%201/passkey/verify", "POST", JSON.stringify({ name: "Reviewer One", response: { id: "cred", response: {} } })],
    ]);
  });

  it("signs in with a passkey", async () => {
    fetchMock.mockResolvedValueOnce(json({ challenge: "c2" })).mockResolvedValueOnce(json(ME));
    webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
    expect(await signInWithPasskey()).toEqual(ME);
    expect(calls().map(([u, m]) => `${m} ${u}`)).toEqual(["POST /api/auth/passkey/options", "POST /api/auth/passkey/verify"]);
  });
});

describe("identity: key join and sign-in", () => {
  it("joins with the browser key: challenge, then the signed proof", async () => {
    fetchMock.mockResolvedValueOnce(json({ challenge: "Y2g" })).mockResolvedValueOnce(json(ME, 201));
    await joinWithKey("abc", "Reviewer One");
    const [, , body] = calls()[1]!;
    const sent = JSON.parse(body as string) as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(["challenge", "name", "publicKey", "signature"]);
    expect(sent.challenge).toBe("Y2g");
    const pub = createPublicKey({ key: Buffer.from(sent.publicKey!, "base64url"), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(keyMessage("Y2g", location.host)), pub, Buffer.from(sent.signature!, "base64url"))).toBe(true);
    expect(calls()[1]![0]).toBe("/api/join/abc/key");
  });

  it("signs in with the key already here, and never makes one to sign in with", async () => {
    await expect(signInWithKey()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(idb.puts).toBe(0);
    await ensureBrowserKey();
    fetchMock.mockResolvedValueOnce(json({ challenge: "Y2g" })).mockResolvedValueOnce(json(ME));
    expect(await signInWithKey()).toEqual(ME);
    expect(calls().map(([u]) => u)).toEqual(["/api/auth/key/challenge", "/api/auth/key/verify"]);
  });
});
