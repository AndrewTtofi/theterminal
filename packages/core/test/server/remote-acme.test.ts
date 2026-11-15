import { X509Certificate } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor, LedgerEntry } from "@theterminal/shared";
import { ACME_ACCOUNT_SECRET, ACME_KEY_SECRET, AcmeError, fakeAcme, type AcmeClientLike } from "../../src/server/acme.js";
import { RemoteInputError } from "../../src/server/remote.js";
import { closeAll, harness, type Harness } from "../fixtures/remote-harness.js";

const OWNER: Actor = { kind: "human", id: "owner" };
const DOMAIN = "tt-test.local";
const DAY = 86_400_000;
const ACME = { tls: "acme" as const, domain: DOMAIN, port: 0, bind: "127.0.0.1", acmePort: 0 };

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAll();
});

const remoteEntries = (h: Harness): LedgerEntry[] => h.ledger.list({ limit: 500 }).filter((e) => e.type.startsWith("remote."));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function served(port: number): Promise<{ fingerprint: string; pem: string }> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername: DOMAIN, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.destroy();
      resolve({ fingerprint: c.fingerprint256, pem: `-----BEGIN CERTIFICATE-----\n${c.raw.toString("base64")}\n-----END CERTIFICATE-----\n` });
    });
    s.on("error", reject);
  });
}

type Plain = { status: number; headers: http.IncomingHttpHeaders; body: string };
function plain(port: number, path: string, method = "GET", host = DOMAIN): Promise<Plain> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

/** fakeAcme, which also fetches its own token from the plain listener while the order is open. */
function recordingFake(h: () => Harness) {
  const seen: Plain[] = [];
  let calls = 0;
  const client: AcmeClientLike = {
    kind: "fake",
    order: (req) => {
      calls++;
      return fakeAcme.order({
        ...req,
        challenge: {
          create: async (token, keyAuth) => {
            await req.challenge.create(token, keyAuth);
            seen.push(await plain(h().remote.challengePort()!, `/.well-known/acme-challenge/${token}`));
            seen.push({ status: 0, headers: {}, body: `${token}|${keyAuth}` });
          },
          remove: req.challenge.remove,
        },
      });
    },
  };
  return { client, seen, calls: () => calls };
}

describe("tls: acme", () => {
  it("serves the challenge during the order, then commits certificate_changed and enabled for the domain", async () => {
    let h!: Harness;
    const rec = recordingFake(() => h);
    h = await harness({ acmeClient: rec.client });
    const s = await h.remote.enable(OWNER, ACME);
    const [fetched, expected] = rec.seen;
    const [token, keyAuth] = expected!.body.split("|");
    expect(fetched!.status).toBe(200);
    expect(fetched!.body).toBe(keyAuth);
    expect(fetched!.headers["content-type"]).toMatch(/^text\/plain/);

    const entries = remoteEntries(h);
    expect(entries.map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled"]);
    expect(entries[0]!.payload).toMatchObject({ tls: "acme", domain: DOMAIN, fingerprint: s.fingerprint });
    expect(entries[1]!.payload).toMatchObject({ tls: "acme", domain: DOMAIN, port: s.port, bind: "127.0.0.1" });
    expect(entries[1]!.seq).toBe(entries[0]!.seq + 1);

    const cert = await served(s.port);
    expect(cert.fingerprint).toBe(s.fingerprint);
    expect(new X509Certificate(cert.pem).checkHost(DOMAIN)).toBe(DOMAIN);
    expect(h.remote.state()).toMatchObject({ enabled: true, listening: true, tls: "acme", acme: { lastError: null } });

    // After the order the token is gone, though the plain listener stays up for renewals.
    const after = await plain(h.remote.challengePort()!, `/.well-known/acme-challenge/${token}`);
    expect(after.status).toBe(301);
    expect(after.body).not.toContain(keyAuth!);
  });

  it("keeps the account key and certificate key out of the ledger and every file", async () => {
    const h = await harness({ acmeClient: fakeAcme });
    await h.remote.enable(OWNER, ACME);
    const account = (await h.secrets.get(ACME_ACCOUNT_SECRET))!;
    const key = (await h.secrets.get(ACME_KEY_SECRET))!;
    expect(account).toMatch(/PRIVATE KEY/);
    const bodyOf = (pem: string) => pem.split("\n").slice(1, -2).join("");
    const ledger = JSON.stringify(h.ledger.list({ limit: 500 }));
    for (const pem of [account, key]) expect(ledger).not.toContain(bodyOf(pem).slice(0, 40));
    for (const f of files(h.root)) {
      const text = readFileSync(f).toString("latin1");
      expect(text).not.toContain("PRIVATE KEY");
      for (const pem of [account, key]) expect(text).not.toContain(bodyOf(pem).slice(0, 40));
    }
  });

  it("redirects GET and HEAD that are not a pending token to the configured domain, and 404s other methods", async () => {
    const h = await harness({ acmeClient: fakeAcme });
    const { port: tlsPort } = await h.remote.enable(OWNER, ACME);
    const port = h.remote.challengePort()!;
    for (const method of ["GET", "HEAD"] as const) {
      for (const [path, target] of [
        ["/", "/"],
        ["/api/me", "/api/me"],
        ["/healthz", "/healthz"],
        ["/.well-known/acme-challenge/", "/.well-known/acme-challenge/"],
        ["/.well-known/acme-challenge/abc", "/.well-known/acme-challenge/abc"],
        ["/.well-known/acme-challenge/abc?x=1", "/.well-known/acme-challenge/abc?x=1"],
        [`/${"a".repeat(2100)}`, "/"],
      ] as const) {
        const r = await plain(port, path, method);
        expect(r.status, `${method} ${path.slice(0, 40)}`).toBe(301);
        expect(r.headers.location).toBe(`https://${DOMAIN}:${tlsPort}${target}`);
        expect(r.body).toBe(method === "HEAD" ? "" : r.body);
      }
      // The target comes from the configured domain, never the request's Host.
      const evil = await plain(port, "/x", method, "evil.example");
      expect(evil.status).toBe(301);
      expect(evil.headers.location).toBe(`https://${DOMAIN}:${tlsPort}/x`);
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const r = await plain(port, "/.well-known/acme-challenge/abc", method);
      expect(r.status, method).toBe(404);
      expect(r.headers.location).toBeUndefined();
    }
  });

  it("an absolute-form request target redirects to / on the configured domain", async () => {
    const h = await harness({ acmeClient: fakeAcme });
    const { port: tlsPort } = await h.remote.enable(OWNER, ACME);
    const port = h.remote.challengePort()!;
    const r = await plain(port, "http://evil.example/steal", "GET", "evil.example");
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe(`https://${DOMAIN}:${tlsPort}/`);
  });

  it("requires a domain, and an AcmeManager", async () => {
    const h = await harness({ acmeClient: fakeAcme });
    const err = await h.remote.enable(OWNER, { ...ACME, domain: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteInputError);
    expect((err as RemoteInputError).code).toBe("acme_domain_required");
    const bare = await harness();
    const none = await bare.remote.enable(OWNER, ACME).catch((e: unknown) => e);
    expect((none as RemoteInputError).code).toBe("acme_unavailable");
    expect(remoteEntries(h)).toEqual([]);
    expect(remoteEntries(bare)).toEqual([]);
  });

  it("a failed order records nothing, closes the plain listener and keeps the type for the Owner", async () => {
    const client: AcmeClientLike = {
      kind: "fake",
      async order() {
        throw new AcmeError("urn:ietf:params:acme:error:dns");
      },
    };
    const h = await harness({ acmeClient: client });
    const err = await h.remote.enable(OWNER, ACME).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect((err as AcmeError).type).toBe("urn:ietf:params:acme:error:dns");
    expect(remoteEntries(h)).toEqual([]);
    expect(h.remote.challengePort()).toBeNull();
    expect(h.remote.state()).toMatchObject({ enabled: false, listening: false, acme: { lastError: "urn:ietf:params:acme:error:dns" } });
  });

  it("a challenge port in use is an AcmeError and records nothing", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const h = await harness({ acmeClient: fakeAcme });
      const err = await h.remote.enable(OWNER, { ...ACME, acmePort: busy }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AcmeError);
      expect((err as AcmeError).type).toBe("unknown");
      expect(remoteEntries(h)).toEqual([]);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it("disable closes the plain listener too", async () => {
    const h = await harness({ acmeClient: fakeAcme });
    await h.remote.enable(OWNER, ACME);
    const port = h.remote.challengePort()!;
    await h.remote.disable(OWNER);
    expect(h.remote.challengePort()).toBeNull();
    expect(await connectRefused(port)).toBe(true);
    expect(remoteEntries(h).at(-1)!.type).toBe("remote.disabled");
  });

  it("re-enabling reuses a certificate that is not due, without a new order", async () => {
    let h!: Harness;
    const rec = recordingFake(() => h);
    h = await harness({ acmeClient: rec.client });
    const first = await h.remote.enable(OWNER, ACME);
    await h.remote.disable(OWNER);
    const second = await h.remote.enable(OWNER, ACME);
    expect(rec.calls()).toBe(1);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(remoteEntries(h).map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled", "remote.disabled", "remote.enabled"]);
  });

  it("after a restart listens again with the stored certificate and reopens the plain listener", async () => {
    let h!: Harness;
    const rec = recordingFake(() => h);
    h = await harness({ acmeClient: rec.client });
    const first = await h.remote.enable(OWNER, ACME);
    h = await h.restart();
    await h.remote.startIfEnabled();
    expect(rec.calls()).toBe(1);
    expect(h.remote.state().listening).toBe(true);
    expect((await served(first.port)).fingerprint).toBe(first.fingerprint);
    // The harness's deps put the plain listener on an ephemeral port (port 80 outside tests).
    expect(h.remote.challengePort()).not.toBeNull();
    const r = await plain(h.remote.challengePort()!, "/");
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe(`https://${DOMAIN}:${first.port}/`);
    expect(remoteEntries(h).at(-1)!.type).toBe("remote.enabled");
  });
});

describe("renewal", () => {
  async function renewing(client?: AcmeClientLike) {
    let now = new Date("2026-11-15T00:00:00.000Z");
    let h!: Harness;
    const rec = recordingFake(() => h);
    h = await harness({ acmeClient: client ?? rec.client, now: () => now });
    const s = await h.remote.enable(OWNER, ACME);
    const expires = new Date(s.expiresAt!).getTime();
    return { h, s, rec, expires, setNow: (d: Date) => (now = d) };
  }

  it("does nothing at 60 days left; at 20 days left swaps the served certificate and records it", async () => {
    const { h, s, rec, expires, setNow } = await renewing();
    setNow(new Date(expires - 60 * DAY));
    await h.remote.renewalTick();
    expect(rec.calls()).toBe(1);
    expect(remoteEntries(h)).toHaveLength(2);

    setNow(new Date(expires - 20 * DAY));
    await h.remote.renewalTick();
    expect(rec.calls()).toBe(2);
    const entries = remoteEntries(h);
    expect(entries.map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled", "remote.certificate_changed"]);
    const last = entries.at(-1)!;
    expect(last.actor).toEqual({ kind: "system", id: "remote" });
    expect(last.payload).toMatchObject({ tls: "acme", domain: DOMAIN });
    const fp = (last.payload as { fingerprint: string }).fingerprint;
    expect(fp).not.toBe(s.fingerprint);
    expect((await served(s.port)).fingerprint).toBe(fp);
    expect(h.remote.state()).toMatchObject({ fingerprint: fp, listening: true });
  });

  it("backs off after a failure and keeps serving the current certificate", async () => {
    let mode: "ok" | "fail" = "ok";
    let calls = 0;
    const client: AcmeClientLike = {
      kind: "fake",
      async order(req) {
        calls++;
        if (mode === "fail") throw new AcmeError("urn:ietf:params:acme:error:rateLimited");
        return fakeAcme.order(req);
      },
    };
    const { h, s, expires, setNow } = await renewing(client);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setNow(new Date(expires - 20 * DAY));
    mode = "fail";
    await h.remote.renewalTick();
    expect(calls).toBe(2);
    expect(h.remote.state().acme).toEqual({ lastError: "urn:ietf:params:acme:error:rateLimited" });
    expect((await served(s.port)).fingerprint).toBe(s.fingerprint);
    // One failure skips the next tick; two skip the next three.
    await h.remote.renewalTick();
    expect(calls).toBe(2);
    await h.remote.renewalTick();
    expect(calls).toBe(3);
    for (let i = 0; i < 3; i++) await h.remote.renewalTick();
    expect(calls).toBe(3);
    mode = "ok";
    await h.remote.renewalTick();
    expect(calls).toBe(4);
    expect(h.remote.state().acme).toEqual({ lastError: null });
    expect(remoteEntries(h).at(-1)!.type).toBe("remote.certificate_changed");
    expect(console.error).toHaveBeenCalledWith("the remote certificate could not be renewed; trying again later");
  });

  it("a renewal the ledger refuses backs off, and the next attempt reuses the stored certificate without a new order", async () => {
    const { h, s, rec, expires, setNow } = await renewing();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setNow(new Date(expires - 20 * DAY));
    h.ledger.readOnly = true;
    await h.remote.renewalTick();
    expect(rec.calls()).toBe(2);
    expect(remoteEntries(h)).toHaveLength(2);
    expect((await served(s.port)).fingerprint).toBe(s.fingerprint);
    expect(h.remote.state().acme).toEqual({ lastError: "unknown" });
    // Backed off: the next tick is skipped.
    await h.remote.renewalTick();
    expect(rec.calls()).toBe(2);
    h.ledger.readOnly = false;
    await h.remote.renewalTick();
    expect(rec.calls()).toBe(2);
    const last = remoteEntries(h).at(-1)!;
    expect(last.type).toBe("remote.certificate_changed");
    const fp = (last.payload as { fingerprint: string }).fingerprint;
    expect(fp).not.toBe(s.fingerprint);
    expect((await served(s.port)).fingerprint).toBe(fp);
    expect(h.remote.state().acme).toEqual({ lastError: null });
  });

  it("schedules the 12-hour check unref'd and stops it on disable", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const { h } = await renewing();
    const call = set.mock.calls.find((c) => c[1] === 12 * 60 * 60 * 1000);
    expect(call).toBeDefined();
    const timer = set.mock.results[set.mock.calls.indexOf(call!)]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await h.remote.disable(OWNER);
    expect(clear).toHaveBeenCalledWith(timer);
  });
});

describe("routes", () => {
  it("PUT /api/remote answers 502 acme_failed with the type, and GET shows lastError to the Owner only", async () => {
    const client: AcmeClientLike = {
      kind: "fake",
      async order() {
        throw new AcmeError("urn:ietf:params:acme:error:dns");
      },
    };
    const h = await harness({ acmeClient: client });
    const res = await h.app.inject({ method: "PUT", url: "/api/remote", headers: { "x-test-as": "owner" }, payload: { enabled: true, ...ACME, port: undefined } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "acme_failed", type: "urn:ietf:params:acme:error:dns" });
    expect(remoteEntries(h)).toEqual([]);
    const owner = await h.app.inject({ method: "GET", url: "/api/remote", headers: { "x-test-as": "owner" } });
    expect(owner.json().acme).toEqual({ lastError: "urn:ietf:params:acme:error:dns" });
    const viewer = await h.app.inject({ method: "GET", url: "/api/remote", headers: { "x-test-as": "viewer" } });
    expect(viewer.json()).toEqual({ enabled: false, listening: false });
  });

  it("an unlisted or oversized type reaches the UI as unknown", async () => {
    for (const type of ["<script>alert(1)</script>", `urn:ietf:params:acme:error:${"x".repeat(273)}`]) {
      const client: AcmeClientLike = {
        kind: "fake",
        async order() {
          throw new AcmeError(type);
        },
      };
      const h = await harness({ acmeClient: client });
      const res = await h.app.inject({ method: "PUT", url: "/api/remote", headers: { "x-test-as": "owner" }, payload: { enabled: true, ...ACME, port: undefined } });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "acme_failed", type: "unknown" });
    }
  });

  it("PUT /api/remote with tls acme and no domain → 400 acme_domain_required", async () => {
    const h = await harness({ acmeClient: fakeAcme });
    const res = await h.app.inject({ method: "PUT", url: "/api/remote", headers: { "x-test-as": "owner" }, payload: { enabled: true, tls: "acme", bind: "127.0.0.1", acmePort: 0 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_input", code: "acme_domain_required" });
  });
});
