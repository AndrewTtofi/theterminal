import { X509Certificate, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import {
  ACME_ACCOUNT_SECRET,
  ACME_CERT_FILE,
  ACME_DIRECTORY,
  ACME_KEY_SECRET,
  ACME_STAGING,
  AcmeError,
  AcmeManager,
  RENEW_BEFORE_MS,
  fakeAcme,
  realAcme,
  selectAcmeClient,
  type AcmeClientLike,
} from "../../src/server/acme.js";

const DAY = 86_400_000;
const DOMAIN = "tt-test.local";
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(opts: { client?: AcmeClientLike; now?: () => Date } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-acme-"));
  roots.push(dataDir);
  const secrets = new MemorySecretStore();
  const mgr = new AcmeManager({ secrets, dataDir, client: opts.client ?? fakeAcme, now: opts.now });
  return { dataDir, secrets, mgr };
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const failing = (type: unknown): AcmeClientLike => ({
  kind: "fake",
  async order() {
    throw new AcmeError(type as string);
  },
});

describe("constants", () => {
  it("names Let's Encrypt's directories and a 30-day renewal window", () => {
    expect(ACME_DIRECTORY).toBe("https://acme-v02.api.letsencrypt.org/directory");
    expect(ACME_STAGING).toBe("https://acme-staging-v02.api.letsencrypt.org/directory");
    expect(RENEW_BEFORE_MS).toBe(30 * DAY);
  });
});

describe("AcmeManager.obtain with fakeAcme", () => {
  it("serves the challenge only while the order is open, and issues a certificate for the domain", async () => {
    const seen: Array<string | null> = [];
    let token = "";
    let mgr!: AcmeManager;
    const client: AcmeClientLike = {
      kind: "fake",
      order: (req) =>
        fakeAcme.order({
          ...req,
          challenge: {
            create: async (t, k) => {
              await req.challenge.create(t, k);
              token = t;
              seen.push(mgr.challengeResponse(t));
            },
            remove: req.challenge.remove,
          },
        }),
    };
    ({ mgr } = setup({ client }));
    expect(mgr.challengeResponse("anything")).toBeNull();
    const m = await mgr.obtain(DOMAIN);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^${token}\\.[A-Za-z0-9_-]+$`));
    expect(mgr.challengeResponse(token)).toBeNull();
    const x = new X509Certificate(m.certPem);
    expect(x.checkHost(DOMAIN)).toBe(DOMAIN);
    expect(x.checkPrivateKey(createPrivateKey(m.keyPem))).toBe(true);
    expect(m.fingerprint).toBe(x.fingerprint256);
    expect(new Date(m.expiresAt).getTime()).toBe(new Date(x.validTo).getTime());
  });

  it("keeps the account key and the certificate key in the secret store only", async () => {
    const { mgr, secrets, dataDir } = setup();
    const m = await mgr.obtain(DOMAIN);
    const account = await secrets.get(ACME_ACCOUNT_SECRET);
    expect(account).toMatch(/BEGIN PRIVATE KEY/);
    expect(await secrets.get(ACME_KEY_SECRET)).toBe(m.keyPem);
    expect(readFileSync(join(dataDir, "remote", ACME_CERT_FILE), "utf8")).toBe(m.certPem);
    const body = (pem: string) => pem.split("\n")[1]!;
    for (const f of files(dataDir)) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/PRIVATE KEY/);
      expect(text).not.toContain(body(account!));
      expect(text).not.toContain(body(m.keyPem));
    }
  });

  it("writes the certificate file before storing its key, so a failed key write never pairs a new key with an old file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tt-acme-"));
    roots.push(dataDir);
    const inner = new MemorySecretStore();
    const certPath = join(dataDir, "remote", ACME_CERT_FILE);
    let fileAtKeyWrite: string | null = null;
    let failKey = false;
    const secrets = {
      get: (a: string) => inner.get(a),
      delete: (a: string) => inner.delete(a),
      async set(a: string, v: string) {
        if (a === ACME_KEY_SECRET) {
          try {
            fileAtKeyWrite = readFileSync(certPath, "utf8");
          } catch {
            fileAtKeyWrite = null;
          }
          if (failKey) throw new Error("store unavailable");
        }
        return inner.set(a, v);
      },
    };
    const mgr = new AcmeManager({ secrets, dataDir, client: fakeAcme });
    const m = await mgr.obtain(DOMAIN);
    expect(fileAtKeyWrite).toBe(m.certPem);
    failKey = true;
    await expect(mgr.obtain(DOMAIN)).rejects.toBeInstanceOf(AcmeError);
    // The file moved on but the key did not: load() refuses the mismatched pair instead of serving it.
    expect(await mgr.load(DOMAIN)).toBeNull();
  });

  it("creates the account key once and reuses it", async () => {
    const { mgr, secrets } = setup();
    await mgr.obtain(DOMAIN);
    const first = await secrets.get(ACME_ACCOUNT_SECRET);
    await mgr.obtain(DOMAIN);
    expect(await secrets.get(ACME_ACCOUNT_SECRET)).toBe(first);
  });

  it("refuses an invalid domain before any order", async () => {
    let calls = 0;
    const { mgr } = setup({ client: { kind: "fake", order: async (r) => (calls++, fakeAcme.order(r)) } });
    await expect(mgr.obtain("not a domain")).rejects.toBeInstanceOf(AcmeError);
    expect(calls).toBe(0);
  });

  it("refuses a certificate that does not cover the domain", async () => {
    const { mgr, secrets } = setup({
      client: { kind: "fake", order: (r) => fakeAcme.order({ ...r, domain: "other.example.org" }) },
    });
    const err = await mgr.obtain(DOMAIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect((err as AcmeError).type).toBe("unknown");
    expect(await secrets.get(ACME_KEY_SECRET)).toBeNull();
  });

  it("fails with the connection type when the challenge is not served", async () => {
    const { mgr } = setup();
    const err = await mgr.obtain(DOMAIN, { probe: async () => null }).catch((e: unknown) => e);
    expect((err as AcmeError).type).toBe("urn:ietf:params:acme:error:connection");
    const wrong = await mgr.obtain(DOMAIN, { probe: async () => "wrong" }).catch((e: unknown) => e);
    expect((wrong as AcmeError).type).toBe("urn:ietf:params:acme:error:unauthorized");
  });
});

describe("AcmeError", () => {
  it("keeps an ACME error type and has a fixed message", async () => {
    const { mgr } = setup({ client: failing("urn:ietf:params:acme:error:dns") });
    const err = (await mgr.obtain(DOMAIN).catch((e: unknown) => e)) as AcmeError;
    expect(err).toBeInstanceOf(AcmeError);
    expect(err.type).toBe("urn:ietf:params:acme:error:dns");
    expect(err.message).toBe("certificate could not be obtained");
  });

  it("allowlists and caps the type", () => {
    expect(new AcmeError("urn:ietf:params:acme:error:rateLimited").type).toBe("urn:ietf:params:acme:error:rateLimited");
    expect(new AcmeError(`urn:ietf:params:acme:error:${"a".repeat(273)}`).type).toBe("unknown");
    expect(new AcmeError("<script>").type).toBe("unknown");
    expect(new AcmeError("urn:ietf:params:acme:error:dns<script>").type).toBe("unknown");
    expect(new AcmeError("urn:ietf:params:acme:error:").type).toBe("unknown");
    expect(new AcmeError(42 as unknown as string).type).toBe("unknown");
  });

  it("turns any other failure into unknown without the detail text", async () => {
    const { mgr } = setup({
      client: {
        kind: "fake",
        async order() {
          throw new Error("detail from the server: TESTKEY-detail");
        },
      },
    });
    const err = (await mgr.obtain(DOMAIN).catch((e: unknown) => e)) as AcmeError;
    expect(err).toBeInstanceOf(AcmeError);
    expect(err.type).toBe("unknown");
    expect(JSON.stringify({ m: err.message, s: String(err) })).not.toContain("TESTKEY");
  });

  it("clears pending challenges when an order fails", async () => {
    let token = "";
    const { mgr } = setup({
      client: {
        kind: "fake",
        async order(req) {
          token = "tok_fail";
          await req.challenge.create(token, "tok_fail.thumb");
          throw new AcmeError("urn:ietf:params:acme:error:dns");
        },
      },
    });
    await expect(mgr.obtain(DOMAIN)).rejects.toBeInstanceOf(AcmeError);
    expect(mgr.challengeResponse(token)).toBeNull();
  });
});

describe("challengeResponse", () => {
  it("answers only exact, well-formed tokens", async () => {
    let inside: Record<string, string | null> = {};
    let mgr!: AcmeManager;
    ({ mgr } = setup({
      client: {
        kind: "fake",
        async order(req) {
          await req.challenge.create("Abc_-123", "Abc_-123.thumb");
          inside = {
            exact: mgr.challengeResponse("Abc_-123"),
            prefix: mgr.challengeResponse("Abc_-12"),
            upper: mgr.challengeResponse("ABC_-123"),
            dots: mgr.challengeResponse("../Abc_-123"),
            long: mgr.challengeResponse("a".repeat(300)),
            notString: mgr.challengeResponse(42 as unknown as string),
          };
          throw new AcmeError("urn:ietf:params:acme:error:dns");
        },
      },
    }));
    await mgr.obtain(DOMAIN).catch(() => undefined);
    expect(inside).toEqual({ exact: "Abc_-123.thumb", prefix: null, upper: null, dots: null, long: null, notString: null });
  });
});

describe("load and renewIfDue", () => {
  it("reloads a stored certificate for the same domain only", async () => {
    const { mgr } = setup();
    const m = await mgr.obtain(DOMAIN);
    expect((await mgr.load(DOMAIN))?.fingerprint).toBe(m.fingerprint);
    expect(await mgr.load("other.example.org")).toBeNull();
  });

  it("returns null while more than 30 days remain and a new certificate within 30 days", async () => {
    let now = new Date("2026-11-15T00:00:00.000Z");
    const { mgr } = setup({ now: () => now });
    const m = await mgr.obtain(DOMAIN);
    const expires = new Date(m.expiresAt).getTime();
    now = new Date(expires - 60 * DAY);
    expect(await mgr.renewIfDue(DOMAIN, m)).toBeNull();
    now = new Date(expires - 20 * DAY);
    const renewed = await mgr.renewIfDue(DOMAIN, m);
    expect(renewed).not.toBeNull();
    expect(renewed!.fingerprint).not.toBe(m.fingerprint);
    expect(new Date(renewed!.expiresAt).getTime()).toBeGreaterThan(expires);
  });
});

describe("selectAcmeClient", () => {
  it("picks the fake only under both test flags", () => {
    expect(selectAcmeClient({})).toBe(realAcme);
    expect(selectAcmeClient({ THETERMINAL_FAKE_ACME: "1" })).toBe(realAcme);
    expect(selectAcmeClient({ THETERMINAL_FAKE_AGENT: "1" })).toBe(realAcme);
    expect(selectAcmeClient({ THETERMINAL_FAKE_AGENT: "true", THETERMINAL_FAKE_ACME: "1" })).toBe(realAcme);
    expect(selectAcmeClient({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_ACME: "1" })).toBe(fakeAcme);
    expect(realAcme.kind).toBe("real");
    expect(fakeAcme.kind).toBe("fake");
  });
});
