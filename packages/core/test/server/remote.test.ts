import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CERT_FINGERPRINT, DEFAULT_REMOTE, type Actor, type LedgerEntry } from "@theterminal/shared";
import { CertificateError, selfSignedTlsCertificate } from "../../src/server/certs.js";
import {
  OwnerCredentialRequiredError,
  REMOTE_FILES_SECRET,
  REMOTE_KEY_SECRET,
  RemoteInputError,
  RemoteStartError,
  remoteHostAllowed,
} from "../../src/server/remote.js";
import { closeAll, harness, pinnedRequest, type Harness } from "../fixtures/remote-harness.js";

const OWNER: Actor = { kind: "human", id: "owner" };

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

/** The certificate the TLS listener actually serves. */
function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const fp = s.getPeerCertificate().fingerprint256;
      s.destroy();
      resolve(fp);
    });
    s.on("error", reject);
  });
}

async function ipv6LoopbackAvailable(): Promise<boolean> {
  const s = net.createServer();
  return new Promise((resolve) => {
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => s.close(() => resolve(true)));
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

async function enabled(h: Harness, extra: Parameters<Harness["remote"]["enable"]>[1] = {}) {
  const state = await h.remote.enable(OWNER, { port: 0, bind: "127.0.0.1", ...extra });
  return { state, port: state.port, fp: state.fingerprint! };
}

describe("remoteHostAllowed", () => {
  const own = { port: 4318, domain: null, names: ["127.0.0.1", "192.168.1.10", "::1", "tt-test.local"] };
  it.each([
    ["192.168.1.10:4318", true],
    ["127.0.0.1:4318", true],
    ["[::1]:4318", true],
    ["[::1]:4318".toUpperCase(), true],
    ["tt-test.local:4318", true],
    ["TT-Test.Local:4318", true],
    ["192.168.1.11:4318", false],
    ["10.0.0.1:4318", false],
    ["[fe80::1]:4318", false],
    ["other.local:4318", false],
    ["evil.example.org:4318", false],
    ["192.168.1.10:4317", false],
    ["[::1]:4317", false],
    ["::1:4318", false],
    ["[::1%en0]:4318", false],
    ["192.168.1.10", false],
    ["192.168.1.10:443", false],
    ["", false],
    ["192.168.1.10:4318:4318", false],
  ])("without a domain, %s → %s", (host, ok) => {
    expect(remoteHostAllowed(host, own)).toBe(ok);
  });

  it.each([
    ["example.test", true],
    ["example.test:443", true],
    ["example.test:4318", true],
    ["EXAMPLE.Test:4318", true],
    ["Example.TEST", true],
    ["example.test:4317", false],
    ["example.test:80", false],
    ["example.test:", false],
    ["x.example.test", false],
    ["example.test.evil.org", false],
    ["evil.example.org", false],
    ["evil.example.org:443", false],
    ["127.0.0.1:4318", false],
    ["tt-test.local:4318", false],
  ])("with the domain example.test, %s → %s", (host, ok) => {
    expect(remoteHostAllowed(host, { ...own, domain: "example.test" })).toBe(ok);
  });
});

describe("RemoteListener", () => {
  it("is off before anything is enabled, with the shared default bind", async () => {
    const h = await harness();
    expect(h.remote.state()).toEqual({ ...DEFAULT_REMOTE, listening: false, addresses: [] });
  });

  it("commits certificate_changed then enabled, keeps the key in the secret store, and serves the recorded fingerprint", async () => {
    const h = await harness();
    const { state, port, fp } = await enabled(h);
    const entries = remoteEntries(h);
    expect(entries.map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled"]);
    expect(entries[1]!.seq).toBe(entries[0]!.seq + 1);
    expect(entries[1]!.payload).toEqual({ port, bind: "127.0.0.1", domain: null, tls: "self_signed", fingerprint: fp });
    expect(entries[0]!.actor).toEqual(OWNER);
    expect(port).toBeGreaterThan(0);
    expect(fp).toMatch(CERT_FINGERPRINT);
    expect(state).toMatchObject({ enabled: true, port, bind: "127.0.0.1", tls: "self_signed", fingerprint: fp });
    expect(h.remote.state()).toMatchObject({ listening: true, addresses: ["127.0.0.1"] });

    const key = await h.secrets.get(REMOTE_KEY_SECRET);
    expect(key).toMatch(/BEGIN PRIVATE KEY/);
    const keyBody = key!.split("\n")[1]!;
    for (const f of files(h.dataDir)) {
      const text = readFileSync(f).toString("latin1");
      expect(text, f).not.toContain("PRIVATE KEY");
      expect(text, f).not.toContain(keyBody);
    }
    const certPem = readFileSync(join(h.dataDir, "remote", "cert.pem"), "utf8");
    expect(new X509Certificate(certPem).fingerprint256).toBe(fp);
    expect(new X509Certificate(certPem).checkHost("tt-test.local")).toBe("tt-test.local");
    expect(new X509Certificate(certPem).checkIP("192.168.1.10")).toBe("192.168.1.10");

    expect(await servedFingerprint(port)).toBe(fp);
    expect(h.remote.state().fingerprint).toBe(await servedFingerprint(port));
  });

  it("answers /healthz to a pinned client and a wrong pin is refused by the client", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h);
    const res = await pinnedRequest(port, fp, { path: "/healthz" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const wrong = fp.replace(/^../, fp.startsWith("00") ? "11" : "00");
    await expect(pinnedRequest(port, wrong, { path: "/healthz" })).rejects.toThrow("fingerprint mismatch");
  });

  it("answers HEAD /healthz over TLS with no body", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h);
    const res = await pinnedRequest(port, fp, { method: "HEAD", path: "/healthz" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });

  it("marks requests over TLS as remote and the plain listener's as local, and ignores X-Forwarded-For", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h);
    const res = await pinnedRequest(port, fp, { path: "/whoami", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ listener: "remote", ip: "127.0.0.1" });
    const local = await fetch(`http://127.0.0.1:${h.localPort}/whoami`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(await local.json()).toEqual({ listener: "local", ip: "127.0.0.1" });
  });

  it("gives a plain-HTTP request to the TLS port no HTTP response (no downgrade)", async () => {
    const h = await harness();
    const { port } = await enabled(h);
    const received = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error("the TLS port kept a plain-HTTP socket open"));
      }, 5000);
      s.setEncoding("latin1");
      s.on("data", (c: string) => (data += c));
      s.on("error", () => undefined);
      s.on("close", () => {
        clearTimeout(timer);
        resolve(data);
      });
    });
    expect(received).not.toMatch(/HTTP\/1\.[01]/);
    expect(received).not.toContain("ok");
  });

  it("applies the remote Host check over TLS: the listener's own address only, and /healthz is exempt", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h);
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `tt-test.local:${port}` })).status).toBe(200);
    const evil = await pinnedRequest(port, fp, { path: "/whoami", host: `evil.example.org:${port}` });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body)).toEqual({ error: "bad_host" });
    // bound to 127.0.0.1, so neither another address nor IPv6 loopback is this listener's
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `192.168.1.11:${port}` })).status).toBe(403);
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `[::1]:${port}` })).status).toBe(403);
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await pinnedRequest(port, fp, { path: "/healthz", host: `evil.example.org:${port}` })).status).toBe(200);
  });

  it("accepts a bracketed IPv6 Host when the listener is bound to IPv6 loopback", async (ctx) => {
    if (!(await ipv6LoopbackAvailable())) ctx.skip();
    const h = await harness();
    const { port, fp } = await h.remote.enable(OWNER, { port: 0, bind: "::1" }).then((s) => ({ port: s.port, fp: s.fingerprint! }));
    const ok = await pinnedRequest(port, fp, { connectHost: "::1", path: "/whoami", host: `[::1]:${port}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ listener: "remote", ip: "::1" });
    expect((await pinnedRequest(port, fp, { connectHost: "::1", path: "/whoami", host: `[::1]:${port + 1}` })).status).toBe(403);
    expect((await pinnedRequest(port, fp, { connectHost: "::1", path: "/whoami", host: `127.0.0.1:${port}` })).status).toBe(403);
  });

  it("with a domain set, the domain alone, :443 or the port pass the Host check; an evil host does not", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h, { domain: "example.test" });
    for (const host of ["example.test", "example.test:443", `example.test:${port}`, `EXAMPLE.test:${port}`]) {
      expect((await pinnedRequest(port, fp, { path: "/whoami", host })).status, host).toBe(200);
    }
    for (const host of ["evil.example.org", "evil.example.org:443", `evil.example.org:${port}`, "example.test:80", `127.0.0.1:${port}`]) {
      expect((await pinnedRequest(port, fp, { path: "/whoami", host })).status, host).toBe(403);
    }
  });

  it("with a domain set, only that domain passes the Host check but /healthz on 127.0.0.1 still answers", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h, { domain: "work.example.org" });
    expect(new X509Certificate(readFileSync(join(h.dataDir, "remote", "cert.pem"), "utf8")).checkHost("work.example.org")).toBe(
      "work.example.org",
    );
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `127.0.0.1:${port}` })).status).toBe(403);
    expect((await pinnedRequest(port, fp, { path: "/whoami", host: `work.example.org:${port}` })).status).toBe(200);
    const health = await pinnedRequest(port, fp, { path: "/healthz", host: `127.0.0.1:${port}` });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
  });

  it("disable commits remote.disabled and closes the port", async () => {
    const h = await harness();
    const { port } = await enabled(h);
    await h.remote.disable(OWNER);
    expect(remoteEntries(h).at(-1)).toMatchObject({ type: "remote.disabled", actor: OWNER, payload: {} });
    expect(h.remote.state()).toMatchObject({ enabled: false, listening: false, addresses: [] });
    expect(await connectRefused(port)).toBe(true);
    await h.remote.disable(OWNER);
    expect(remoteEntries(h).filter((e) => e.type === "remote.disabled")).toHaveLength(1);
  });

  it("disable closes connections that are already open", async () => {
    const h = await harness();
    const { port } = await enabled(h);
    const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
    await new Promise((r) => s.once("secureConnect", r));
    const closed = new Promise((r) => s.once("close", r));
    s.on("error", () => undefined);
    await h.remote.disable(OWNER);
    await closed;
  });

  it("reuses the certificate on a second enable", async () => {
    const h = await harness();
    const first = await enabled(h);
    await h.remote.disable(OWNER);
    const second = await enabled(h);
    expect(second.fp).toBe(first.fp);
    expect(remoteEntries(h).map((e) => e.type)).toEqual([
      "remote.certificate_changed",
      "remote.enabled",
      "remote.disabled",
      "remote.enabled",
    ]);
    expect(await servedFingerprint(second.port)).toBe(first.fp);
  });

  it("re-enabling while listening restarts on the new port without a disabled entry", async () => {
    const h = await harness();
    const first = await enabled(h);
    const second = await enabled(h);
    expect(second.port).not.toBe(first.port);
    expect(await connectRefused(first.port)).toBe(true);
    expect(await servedFingerprint(second.port)).toBe(first.fp);
    expect(remoteEntries(h).map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled", "remote.enabled"]);
  });

  it("makes a new certificate when the stored one has expired", async () => {
    let now = new Date("2026-11-15T00:00:00Z");
    const h = await harness({ now: () => now });
    const first = await enabled(h);
    await h.remote.disable(OWNER);
    now = new Date("2037-01-01T00:00:00Z");
    const second = await enabled(h);
    expect(second.fp).not.toBe(first.fp);
    expect(remoteEntries(h).filter((e) => e.type === "remote.certificate_changed")).toHaveLength(2);
  });

  it("refuses to enable until the Owner has a credential, and records nothing", async () => {
    const h = await harness({ owner: { has: false } });
    await expect(enabled(h)).rejects.toBeInstanceOf(OwnerCredentialRequiredError);
    expect(remoteEntries(h)).toEqual([]);
    expect(h.remote.state().listening).toBe(false);
  });

  it("a port already in use → RemoteStartError, with remote.disabled after remote.enabled", async () => {
    const h = await harness();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const err = await h.remote.enable(OWNER, { port, bind: "127.0.0.1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteStartError);
      expect((err as Error).message).toBe("the remote listener could not start");
      const types = remoteEntries(h).map((e) => e.type);
      expect(types.slice(-2)).toEqual(["remote.enabled", "remote.disabled"]);
      expect(remoteEntries(h).at(-1)!.actor).toEqual({ kind: "system", id: "remote" });
      expect(h.remote.state()).toMatchObject({ enabled: false, listening: false });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("binds what the state or configuration says, and keeps a configured address on the next enable", async () => {
    const h = await harness();
    expect(h.remote.state().bind).toBe(DEFAULT_REMOTE.bind);
    // a wildcard bind's Host names are the machine's addresses, loopback and its own names
    expect(h.remote.hostRule()).toEqual({ port: 4318, domain: null, names: ["192.168.1.10", "127.0.0.1", "tt-test.local"] });
    const first = await h.remote.enable(OWNER, { port: 0, bind: "127.0.0.1" });
    expect(first.bind).toBe("127.0.0.1");
    expect(h.remote.hostRule().names).toEqual(["127.0.0.1", "tt-test.local"]);
    const second = await h.remote.enable(OWNER, { port: 0 });
    expect(second.bind).toBe("127.0.0.1");
    expect(remoteEntries(h).filter((e) => e.type === "remote.enabled").map((e) => (e.payload as { bind: string }).bind)).toEqual([
      "127.0.0.1",
      "127.0.0.1",
    ]);
  });

  it.each([
    [{ bind: "example.com" }],
    [{ bind: "fe80::1%en0" }],
    [{ bind: "0.0.0.0 " }],
    [{ port: 70000 }],
    [{ port: -1 }],
    [{ port: 1.5 }],
    [{ domain: "localhost" }],
    [{ domain: "1.2.3.4" }],
    [{ tls: "acme" as const }],
    [{ tls: "provided" as const }],
    [{ tls: "provided" as const, certFile: "/x.pem" }],
  ])("refuses bad input %j before anything is recorded", async (input) => {
    const h = await harness();
    await expect(h.remote.enable(OWNER, { port: 0, bind: "127.0.0.1", ...input })).rejects.toBeInstanceOf(RemoteInputError);
    expect(remoteEntries(h)).toEqual([]);
  });

  it("serves a provided certificate, keeping its paths in the secret store and out of the ledger", async () => {
    const h = await harness();
    const m = await selfSignedTlsCertificate({ hostnames: ["mine.example.org"], addresses: [] });
    const certFile = join(h.root, "mine-cert.pem");
    const keyFile = join(h.root, "mine-key.pem");
    writeFileSync(certFile, m.certPem);
    writeFileSync(keyFile, m.keyPem);
    const { port, fp } = await enabled(h, { tls: "provided", certFile, keyFile });
    expect(fp).toBe(m.fingerprint);
    expect(await servedFingerprint(port)).toBe(m.fingerprint);
    expect(JSON.parse((await h.secrets.get(REMOTE_FILES_SECRET))!)).toEqual({ certFile, keyFile });
    const ledgerText = JSON.stringify(h.ledger.list({ limit: 500 }));
    expect(ledgerText).not.toContain("mine-cert");
    expect(ledgerText).not.toContain("mine-key");
    expect(remoteEntries(h)[0]).toMatchObject({ type: "remote.certificate_changed", payload: { tls: "provided", fingerprint: fp } });

    // a later enable in the same mode reuses the stored paths
    await h.remote.disable(OWNER);
    const again = await enabled(h, { tls: "provided" });
    expect(again.fp).toBe(fp);
  });

  it("refuses provided files inside the UI folder, without recording anything", async () => {
    const h = await harness();
    const m = await selfSignedTlsCertificate({ hostnames: ["mine.example.org"], addresses: [] });
    writeFileSync(join(h.uiDir, "cert.pem"), m.certPem);
    writeFileSync(join(h.root, "key.pem"), m.keyPem);
    const err = await enabled(h, { tls: "provided", certFile: join(h.uiDir, "cert.pem"), keyFile: join(h.root, "key.pem") }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CertificateError);
    expect((err as CertificateError).code).toBe("path_denied");
    expect((err as Error).message).not.toContain(h.root);
    expect(remoteEntries(h)).toEqual([]);
    expect(await h.secrets.get(REMOTE_FILES_SECRET)).toBeNull();
  });

  it("startIfEnabled after a restart over the same db listens again with the same certificate", async () => {
    const h = await harness();
    const { port, fp } = await enabled(h);
    const h2 = await h.restart();
    expect(h2.remote.state()).toMatchObject({ enabled: true, port, fingerprint: fp, listening: false });
    await h2.remote.startIfEnabled();
    expect(h2.remote.state().listening).toBe(true);
    expect(await servedFingerprint(port)).toBe(fp);
    expect(remoteEntries(h2).map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled"]);
  });

  it("startIfEnabled does nothing when remote access is off", async () => {
    const h = await harness();
    await h.remote.startIfEnabled();
    expect(h.remote.state().listening).toBe(false);
    expect(remoteEntries(h)).toEqual([]);
  });

  it("startIfEnabled that cannot listen logs a fixed line and commits remote.disabled as the system", async () => {
    const h = await harness();
    const { port } = await enabled(h);
    const h2Promise = h.restart();
    const h2 = await h2Promise;
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await h2.remote.startIfEnabled();
      expect(log).toHaveBeenCalledWith("remote access could not start, so it is now off");
      expect(remoteEntries(h2).at(-1)).toMatchObject({ type: "remote.disabled", actor: { kind: "system", id: "remote" } });
      expect(h2.remote.state()).toMatchObject({ enabled: false, listening: false });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("close stops listening without recording anything", async () => {
    const h = await harness();
    const { port } = await enabled(h);
    const before = remoteEntries(h).length;
    await h.remote.close();
    expect(await connectRefused(port)).toBe(true);
    expect(remoteEntries(h)).toHaveLength(before);
  });
});
