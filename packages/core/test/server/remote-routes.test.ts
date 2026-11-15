import { writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REMOTE, type Actor } from "@theterminal/shared";
import { remoteLabel, remoteStatus } from "../../src/server/remote-routes.js";
import { closeAll, freePort, harness, pinnedRequest, principal, type Harness } from "../fixtures/remote-harness.js";

const OWNER: Actor = { kind: "human", id: "owner" };

afterEach(closeAll);

const put = (h: Harness, as: string | null, body: unknown) =>
  h.app.inject({
    method: "PUT",
    url: "/api/remote",
    headers: { ...(as && { "x-test-as": as }), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
const get = (h: Harness, as: string | null) =>
  h.app.inject({ method: "GET", url: "/api/remote", headers: { ...(as && { "x-test-as": as }) } });

describe("GET /healthz", () => {
  it("answers { ok: true } and nothing else, without a principal", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const head = await h.app.inject({ method: "HEAD", url: "/healthz" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
  });
});

describe("GET /api/remote", () => {
  it("gives the Owner the whole state and everyone else only enabled and listening", async () => {
    const h = await harness();
    const port = await freePort();
    expect((await put(h, "owner", { enabled: true, port, bind: "127.0.0.1" })).statusCode).toBe(200);
    const owner = (await get(h, "owner")).json();
    expect(owner).toMatchObject({ enabled: true, listening: true, port, bind: "127.0.0.1", addresses: ["127.0.0.1"], tls: "self_signed" });
    expect(owner.fingerprint).toBe(h.remote.state().fingerprint);
    for (const role of ["viewer", "reviewer", "maintainer"]) {
      const res = await get(h, role);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true, listening: true });
    }
  });

  it("refuses a request without a principal", async () => {
    const h = await harness();
    expect((await get(h, null)).statusCode).toBe(401);
  });
});

describe("PUT /api/remote", () => {
  it("lets the Owner turn remote access on and off from the local listener", async () => {
    const h = await harness();
    const port = await freePort();
    const on = await put(h, "owner", { enabled: true, port, bind: "127.0.0.1" });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ enabled: true, listening: true, port });
    const types = h.ledger.list().map((e) => e.type);
    expect(types).toEqual(["remote.certificate_changed", "remote.enabled"]);
    expect(h.ledger.list().at(-1)!.actor).toEqual(OWNER);

    const off = await put(h, "owner", { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, listening: false });
    expect(h.ledger.list().at(-1)!.type).toBe("remote.disabled");
  });

  it.each(["viewer", "reviewer", "maintainer"])("refuses a %s with 403", async (role) => {
    const h = await harness();
    const res = await put(h, role, { enabled: true, port: await freePort(), bind: "127.0.0.1" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", required: "owner" });
    expect(h.ledger.list()).toEqual([]);
  });

  it("refuses a request without a principal", async () => {
    const h = await harness();
    expect((await put(h, null, { enabled: false })).statusCode).toBe(401);
  });

  it("refuses enabling over the remote listener (409 remote_only_from_local) but allows disabling", async () => {
    const h = await harness();
    const { port, fingerprint } = await h.remote.enable(OWNER, { port: 0, bind: "127.0.0.1" });
    const body = JSON.stringify({ enabled: true, port, bind: "127.0.0.1" });
    const res = await pinnedRequest(port, fingerprint!, { method: "PUT", path: "/api/remote", headers: { "x-test-as": "owner" }, body });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "remote_only_from_local" });
    expect(h.ledger.list().map((e) => e.type)).toEqual(["remote.certificate_changed", "remote.enabled"]);

    const off = await pinnedRequest(port, fingerprint!, {
      method: "PUT",
      path: "/api/remote",
      headers: { "x-test-as": "owner" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(JSON.parse(off.body)).toMatchObject({ enabled: false, listening: false });
    expect(off.headers.connection).toBe("close");
    expect(h.ledger.list().at(-1)!.type).toBe("remote.disabled");
    await expect(pinnedRequest(port, fingerprint!, { path: "/healthz" })).rejects.toThrow();
  });

  it.each([
    [{}],
    [{ enabled: "yes" }],
    [{ enabled: true, port: 0 }],
    [{ enabled: true, port: 65536 }],
    [{ enabled: true, bind: "evil.example.org" }],
    [{ enabled: true, domain: "not a domain" }],
    [{ enabled: true, tls: "plain" }],
    [{ enabled: true, extra: 1 }],
    [{ enabled: true, certFile: "x".repeat(5000) }],
    [{ enabled: true, tls: "provided" }],
    [{ enabled: true, tls: "acme", domain: "work.example.org" }],
  ])("answers 400 invalid_input for %j", async (body) => {
    const h = await harness();
    const res = await put(h, "owner", body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    expect(h.ledger.list()).toEqual([]);
  });

  it("answers 409 owner_credential_required until the Owner has a credential", async () => {
    const h = await harness({ owner: { has: false } });
    const res = await put(h, "owner", { enabled: true, port: await freePort(), bind: "127.0.0.1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "owner_credential_required" });
  });

  it("answers 502 remote_start_failed when the port is taken", async () => {
    const h = await harness();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    try {
      const res = await put(h, "owner", { enabled: true, port: (blocker.address() as AddressInfo).port, bind: "127.0.0.1" });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "remote_start_failed" });
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("answers 400 certificate_invalid with a code and no path for a denied certificate file", async () => {
    const h = await harness();
    writeFileSync(join(h.uiDir, "cert.pem"), "x");
    writeFileSync(join(h.root, "key.pem"), "x");
    const res = await put(h, "owner", {
      enabled: true,
      port: await freePort(),
      bind: "127.0.0.1",
      tls: "provided",
      certFile: join(h.uiDir, "cert.pem"),
      keyFile: join(h.root, "key.pem"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "certificate_invalid", code: "path_denied" });
    expect(res.body).not.toContain(h.root);
  });

  it("answers 423 when the ledger is read-only", async () => {
    const h = await harness();
    h.ledger.readOnly = true;
    const res = await put(h, "owner", { enabled: true, port: await freePort(), bind: "127.0.0.1" });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toEqual({ error: "ledger_read_only" });
  });
});

describe("remote status for /api/status", () => {
  const base = { ...DEFAULT_REMOTE, bind: "127.0.0.1", listening: false, addresses: [] as string[], acme: { lastError: null } };

  it("labels for the Owner: off, then the first address with the port, the domain when set, IPv6 bracketed", () => {
    expect(remoteLabel(base)).toBe("off");
    expect(remoteLabel({ ...base, enabled: true, port: 4318, listening: true, addresses: ["192.168.1.10", "10.0.0.2"] })).toBe(
      "192.168.1.10:4318",
    );
    expect(remoteLabel({ ...base, enabled: true, port: 4318, domain: "work.example.org", listening: true, addresses: ["192.168.1.10"] })).toBe(
      "work.example.org:4318",
    );
    expect(remoteLabel({ ...base, enabled: true, port: 4318, bind: "::1", listening: true, addresses: ["::1"] })).toBe("[::1]:4318");
    expect(remoteLabel({ ...base, enabled: true, port: 4318, bind: "127.0.0.1", listening: false, addresses: [] })).toBe("127.0.0.1:4318");
  });

  it("gives the label to the Owner only", () => {
    const on = { ...base, enabled: true, port: 4318, listening: true, addresses: ["192.168.1.10"] };
    expect(remoteStatus(on, principal("owner"))).toEqual({ enabled: true, listening: true, label: "192.168.1.10:4318" });
    for (const role of ["viewer", "reviewer", "maintainer"] as const) {
      const s = remoteStatus(on, principal(role));
      expect(s).toEqual({ enabled: true, listening: true });
      expect("label" in s).toBe(false);
    }
    expect("label" in remoteStatus(on, null)).toBe(false);
  });

  it("follows a real listener: off, then <address>:<port>", async () => {
    const h = await harness();
    expect(remoteStatus(h.remote.state(), principal("owner")).label).toBe("off");
    const { port } = await h.remote.enable(OWNER, { port: 0, bind: "127.0.0.1" });
    expect(remoteStatus(h.remote.state(), principal("owner")).label).toBe(`127.0.0.1:${port}`);
  });
});
