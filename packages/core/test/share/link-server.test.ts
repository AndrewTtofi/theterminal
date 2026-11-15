import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { LedgerEntry } from "@theterminal/shared";
import {
  AddressNotAllowedError, LinkNotActiveError, MAX_TOKEN_FAILURES, ShareLinkActiveError, ShareLinkManager,
  shareAddresses, shareFastifyOptions, type LinkManagerDeps, type ShareAddress,
} from "../../src/share/link-server.js";
import { HumanRequiredError } from "../../src/intake/service.js";
import { NotFoundError } from "../../src/board/board-service.js";
import { SHARE_CSP } from "../../src/share/render.js";
import { emit, human, world, type World } from "./setup.js";

const HTML = "<!doctype html><html><head><title>Book Club · The Terminal</title></head><body>ok</body></html>";
const HASH = createHash("sha256").update(HTML).digest("hex");
const LOOPBACK: ShareAddress[] = [{ address: "127.0.0.1", scope: "this_computer", label: "This computer only" }];
const HEADER_CSP = `${SHARE_CSP}; frame-ancestors 'none'`;
const T0 = new Date("2026-11-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** A token-shaped string (43 base64url characters, like a real one) that is not the link's token. */
const wrongToken = (i: number) => `wrong${String(i).padStart(2, "0")}`.padEnd(43, "A");

class SnapshotTamperedError extends Error {}

type Setup = { w: World; m: ShareLinkManager; clock: { now: Date }; projectId: string; shareId: string };
const managers: ShareLinkManager[] = [];

function confirmSnapshot(w: World, projectId: string, shareId: string): void {
  emit(w, projectId, "share.confirmed", {
    shareId, contentHash: HASH, bytes: Buffer.byteLength(HTML), sections: ["overview"],
    options: { digestDays: 7, includePrompts: false, includeHardware: false },
    headSeq: 0,
  }, human);
}

function setup(over: Partial<LinkManagerDeps> = {}): Setup {
  const w = world();
  const projectId = w.board.createProject(human, { name: "Book Club", pitch: "Reading lists" }).id;
  const shareId = "share1";
  confirmSnapshot(w, projectId, shareId);
  const clock = { now: T0 };
  let n = 0;
  const m = new ShareLinkManager({
    db: w.db, ledger: w.ledger, service: { readHtml: () => HTML }, port: 0, addresses: () => LOOPBACK,
    now: () => clock.now, newId: () => `link${++n}`, ...over,
  });
  managers.push(m);
  return { w, m, clock, projectId, shareId };
}

const shareEntries = (w: World): LedgerEntry[] => w.ledger.list({}).filter((e) => e.type.startsWith("share.link") || /^share\.(revoked|expired|stopped)$/.test(e.type));

type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
/** A raw HTTP request, so the Host header and the method are exactly what the test says. */
function raw(port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}`, connection: "close" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const portOf = (url: string) => Number(new URL(url).port);
const tokenOf = (url: string) => new URL(url).pathname.slice(1);

afterEach(async () => {
  vi.useRealTimers();
  while (managers.length > 0) await managers.pop()!.shutdown();
});

describe("shareAddresses", () => {
  it("offers loopback first, then each non-internal IPv4, never IPv6 or an internal interface", () => {
    const fixture = {
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: "::1", family: "IPv6", internal: true },
      ],
      en0: [
        { address: "192.0.2.10", family: "IPv4", internal: false },
        { address: "2001:db8::1", family: "IPv6", internal: false },
      ],
    } as unknown as NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
    expect(shareAddresses(fixture)).toEqual([
      { address: "127.0.0.1", scope: "this_computer", label: "This computer only" },
      { address: "192.0.2.10", scope: "local_network", label: "Local network (192.0.2.10)" },
    ]);
  });

  it("orders local addresses by interface name then address, and lists each address once", () => {
    const fixture = {
      wlan0: [{ address: "192.0.2.30", family: "IPv4", internal: false }],
      en1: [
        { address: "192.0.2.21", family: "IPv4", internal: false },
        { address: "192.0.2.20", family: "IPv4", internal: false },
      ],
      en9: [{ address: "192.0.2.20", family: "IPv4", internal: false }],
    } as unknown as NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
    expect(shareAddresses(fixture).map((a) => a.address)).toEqual(["127.0.0.1", "192.0.2.20", "192.0.2.21", "192.0.2.30"]);
  });
});

describe("ShareLinkManager", () => {
  it("creates a link that serves exactly the confirmed bytes with strict headers, and records only its digest", async () => {
    const { w, m, shareId, projectId } = setup();
    const { link, url } = await m.create(human, shareId, "127.0.0.1", 1440);
    const created = shareEntries(w).find((e) => e.type === "share.link_created")!;
    const p = created.payload as { tokenDigest: string; scope: string; expiresAt: string; port: number; shareId: string };
    expect(p.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.tokenDigest).toBe(createHash("sha256").update(tokenOf(url)).digest("hex"));
    expect(p.scope).toBe("this_computer");
    expect(p.expiresAt).toBe(new Date(T0.getTime() + DAY_MS).toISOString());
    expect(p.port).toBe(portOf(url));
    expect(created.projectId).toBe(projectId);
    expect(link.state).toBe("active");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(HEADER_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const head = await raw(portOf(url), `/${tokenOf(url)}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    // The token never comes back: not in the list, not in the ledger.
    expect(JSON.stringify(m.list())).not.toContain(tokenOf(url));
    expect(JSON.stringify(w.ledger.list({}))).not.toContain(tokenOf(url));
    expect(m.activeCount()).toBe(1);
  });

  it("answers 404 {} for a wrong token and an unknown path alike, and nothing else is reachable", async () => {
    const { m, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    const port = portOf(url);
    expect((await fetch(url + "x")).status).toBe(404);
    const wrong = await raw(port, `/${wrongToken(1)}`);
    const unknown = await raw(port, "/api/ledger");
    const root = await raw(port, "/");
    const dir = await raw(port, `/${tokenOf(url)}/`);
    const nested = await raw(port, `/${tokenOf(url)}/x`);
    for (const r of [wrong, unknown, root, dir, nested]) {
      expect(r.status).toBe(404);
      expect(r.body).toBe("{}");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe(HEADER_CSP);
    }
    expect(wrong.headers["content-type"]).toBe(unknown.headers["content-type"]);
  });

  it("refuses other methods with 405 and a foreign Host with 403", async () => {
    const { m, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    const port = portOf(url);
    const path = `/${tokenOf(url)}`;
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await raw(port, path, { method });
      expect([method, r.status, r.body]).toEqual([method, 405, "{}"]);
    }
    const evil = await raw(port, path, { host: "evil.test" });
    expect([evil.status, evil.body]).toEqual([403, "{}"]);
    const otherPort = await raw(port, path, { host: `127.0.0.1:${port + 1}` });
    expect(otherPort.status).toBe(403);
    expect((await fetch(url)).status).toBe(200);
  });

  it(`revokes the link after ${MAX_TOKEN_FAILURES} wrong tokens, and the right one stops working`, async () => {
    const { w, m, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    const port = portOf(url);
    for (let i = 0; i < MAX_TOKEN_FAILURES - 1; i++) expect((await raw(port, `/${wrongToken(i)}`)).status).toBe(404);
    expect(m.list()[0]!.state).toBe("active");
    await raw(port, `/${wrongToken(99)}`);
    await vi.waitFor(() => expect(m.list()[0]!.state).toBe("revoked"));
    const revoked = shareEntries(w).find((e) => e.type === "share.revoked")!;
    expect(revoked.payload).toEqual({ linkId: "link1", reason: "too_many_failures" });
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();
    expect(m.activeCount()).toBe(0);
  });

  it("does not count requests that could never be a token towards revocation", async () => {
    const { m, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    for (let i = 0; i < MAX_TOKEN_FAILURES + 5; i++) await raw(portOf(url), "/favicon.ico");
    expect(m.list()[0]!.state).toBe("active");
    expect((await fetch(url)).status).toBe(200);
  });

  it("expires when its timer fires: the listener closes and share.expired is recorded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { w, m, clock, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    clock.now = new Date(T0.getTime() + 60 * 60_000 + 1);
    vi.advanceTimersByTime(60 * 60_000 + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(m.list()[0]!.state).toBe("expired"));
    expect(shareEntries(w).map((e) => e.type)).toEqual(["share.link_created", "share.expired"]);
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();
    expect(m.activeCount()).toBe(0);
  });

  it("refuses a request made after expiry even before the timer fires", async () => {
    const { w, m, clock, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    clock.now = new Date(T0.getTime() + 60 * 60_000);
    expect((await raw(portOf(url), `/${tokenOf(url)}`)).status).toBe(404);
    await vi.waitFor(() => expect(m.list()[0]!.state).toBe("expired"));
    expect(shareEntries(w).filter((e) => e.type === "share.expired")).toHaveLength(1);
  });

  it("revokes at the owner's request at once; a second revoke is LinkNotActiveError", async () => {
    const { w, m, shareId } = setup();
    const { link, url } = await m.create(human, shareId, "127.0.0.1", 60);
    await m.revoke(human, link.id);
    expect(m.list()[0]!.state).toBe("revoked");
    expect(shareEntries(w).at(-1)!.payload).toEqual({ linkId: link.id, reason: "owner" });
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();
    await expect(m.revoke(human, link.id)).rejects.toBeInstanceOf(LinkNotActiveError);
    await expect(m.revoke(human, "nope")).rejects.toBeInstanceOf(LinkNotActiveError);
    await expect(m.revoke({ kind: "agent", id: "run-1" }, link.id)).rejects.toBeInstanceOf(HumanRequiredError);
  });

  it("allows one live link per project", async () => {
    const { m, shareId } = setup();
    await m.create(human, shareId, "127.0.0.1", 60);
    await expect(m.create(human, shareId, "127.0.0.1", 60)).rejects.toBeInstanceOf(ShareLinkActiveError);
    expect(m.activeCount()).toBe(1);
  });

  it("allows one live link per project even when two creates race", async () => {
    const { m, shareId } = setup();
    const results = await Promise.allSettled([
      m.create(human, shareId, "127.0.0.1", 60), m.create(human, shareId, "127.0.0.1", 60),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ShareLinkActiveError);
    expect(m.activeCount()).toBe(1);
  });

  it("refuses an address it does not offer, with nothing listening and nothing recorded", async () => {
    const { w, m, shareId } = setup();
    const before = w.ledger.headSeq();
    for (const address of ["0.0.0.0", "192.0.2.1", "::", "::1", "localhost"]) {
      await expect(m.create(human, shareId, address, 60)).rejects.toBeInstanceOf(AddressNotAllowedError);
    }
    expect(w.ledger.headSeq()).toBe(before);
    expect(m.activeCount()).toBe(0);
  });

  it("never binds a wildcard or IPv6 address even if one is offered", async () => {
    const offered: ShareAddress[] = [
      { address: "0.0.0.0", scope: "local_network", label: "x" },
      { address: "::", scope: "local_network", label: "x" },
    ];
    const { w, m, shareId } = setup({ addresses: () => offered });
    const before = w.ledger.headSeq();
    await expect(m.create(human, shareId, "0.0.0.0", 60)).rejects.toBeInstanceOf(AddressNotAllowedError);
    await expect(m.create(human, shareId, "::", 60)).rejects.toBeInstanceOf(AddressNotAllowedError);
    expect(w.ledger.headSeq()).toBe(before);
  });

  it("validates the duration, the actor and the snapshot before listening", async () => {
    const { w, m, shareId } = setup();
    const before = w.ledger.headSeq();
    await expect(m.create(human, shareId, "127.0.0.1", 5)).rejects.toBeInstanceOf(ZodError);
    await expect(m.create({ kind: "system", id: "runner" }, shareId, "127.0.0.1", 60)).rejects.toBeInstanceOf(HumanRequiredError);
    await expect(m.create(human, "nope", "127.0.0.1", 60)).rejects.toBeInstanceOf(NotFoundError);
    expect(w.ledger.headSeq()).toBe(before);
    expect(m.activeCount()).toBe(0);
  });

  it("refuses a tampered snapshot before listening", async () => {
    const { w, m, shareId } = setup({ service: { readHtml: () => { throw new SnapshotTamperedError("tampered"); } } });
    const before = w.ledger.headSeq();
    await expect(m.create(human, shareId, "127.0.0.1", 60)).rejects.toBeInstanceOf(SnapshotTamperedError);
    expect(w.ledger.headSeq()).toBe(before);
    expect(m.activeCount()).toBe(0);
  });

  it("refuses a token source that is not 32 random bytes", async () => {
    const { m, shareId } = setup({ randomToken: () => "short" });
    await expect(m.create(human, shareId, "127.0.0.1", 60)).rejects.toThrow(/token/);
    expect(m.activeCount()).toBe(0);
  });

  it("closes the listener when the ledger refuses the commit", async () => {
    const { w, m, shareId } = setup();
    w.ledger.readOnly = true;
    await expect(m.create(human, shareId, "127.0.0.1", 60)).rejects.toThrow();
    expect(m.activeCount()).toBe(0);
    w.ledger.readOnly = false;
    // The project is free for a new link: nothing was left live or recorded.
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    expect((await fetch(url)).status).toBe(200);
  });

  it("uses a fresh token for every link", async () => {
    const { m, shareId } = setup();
    const a = await m.create(human, shareId, "127.0.0.1", 60);
    await m.revoke(human, a.link.id);
    const b = await m.create(human, shareId, "127.0.0.1", 60);
    expect(tokenOf(a.url)).not.toBe(tokenOf(b.url));
    expect((await raw(portOf(b.url), `/${tokenOf(a.url)}`)).status).toBe(404);
  });

  it("shutdown stops every live link with reason shutdown and the port refuses connections", async () => {
    const { w, m, shareId } = setup();
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    expect(m.activeCount()).toBe(1);
    await m.shutdown();
    expect(m.activeCount()).toBe(0);
    expect(shareEntries(w).at(-1)!.payload).toEqual({ linkId: "link1", reason: "shutdown" });
    expect(m.list()[0]!.state).toBe("stopped");
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();
  });

  it("recoverOnStartup stops every link the ledger left active and opens nothing", async () => {
    const { w, m, shareId, projectId } = setup();
    emit(w, projectId, "share.link_created", {
      linkId: "stale", shareId, tokenDigest: "a".repeat(64), expiresAt: new Date(T0.getTime() + DAY_MS).toISOString(),
      port: 4400, scope: "this_computer",
    }, human);
    expect(m.list()[0]!.state).toBe("active");
    m.recoverOnStartup();
    const stopped = shareEntries(w).at(-1)!;
    expect(stopped.type).toBe("share.stopped");
    expect(stopped.payload).toEqual({ linkId: "stale", reason: "restart" });
    expect(stopped.projectId).toBe(projectId);
    expect(m.list()[0]!.state).toBe("stopped");
    expect(m.activeCount()).toBe(0);
  });

  it("refuses new links once shut down", async () => {
    const { m, shareId } = setup();
    await m.shutdown();
    await expect(m.create(human, shareId, "127.0.0.1", 60)).rejects.toThrow();
    expect(m.activeCount()).toBe(0);
  });

  it("lets a request that reaches a closing listener through to the routes (404 {} with the headers), never a bare 503", async () => {
    // Over real sockets the window is too small to hit (closing drops every connection), so drive the listener's
    // own options through inject: with Fastify's return503OnClosing a closing app answers 503 without our headers.
    const app = Fastify(shareFastifyOptions());
    app.get("/x", async (_req, reply) => reply.header("x-content-type-options", "nosniff").code(404).send({}));
    await app.ready();
    const closing = app.close();
    const r = await app.inject({ method: "GET", url: "/x" });
    await closing;
    expect([r.statusCode, r.body, r.headers["x-content-type-options"]]).toEqual([404, "{}", "nosniff"]);
  });

  it("logs a fixed sentence when a background end cannot be recorded, and still closes the listener", async () => {
    const log = vi.fn();
    const { w, m, shareId } = setup({ log });
    const { url } = await m.create(human, shareId, "127.0.0.1", 60);
    w.ledger.readOnly = true;
    for (let i = 0; i < MAX_TOKEN_FAILURES; i++) await raw(portOf(url), `/${wrongToken(i)}`);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("The Terminal: a share link was closed but its end could not be recorded"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(m.activeCount()).toBe(0);
    await expect(fetch(url).then((r) => r.status)).rejects.toThrow();
    w.ledger.readOnly = false;
  });

  it("lists links by project", async () => {
    const { m, shareId, projectId } = setup();
    await m.create(human, shareId, "127.0.0.1", 60);
    expect(m.list(projectId)).toHaveLength(1);
    expect(m.list("other")).toHaveLength(0);
  });
});
