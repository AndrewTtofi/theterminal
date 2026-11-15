import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINKING_ACK, encodePairingCode, parsePairingCode, type LedgerEntry, type Machine } from "@theterminal/shared";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { holdPort } from "../link/helpers.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Every server gets a memory store (never the real keychain) and the in-process discovery (never multicast).
async function start(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-link-routes-"));
  dirs.push(dataDir);
  const s = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(),
    discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0, ...opts,
  });
  running.push(s);
  return s;
}

const send = (s: RunningServer, method: string, path: string, body?: unknown, o: { authed?: boolean } = {}) =>
  fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: {
      ...(o.authed !== false && { authorization: `Bearer ${s.token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
/** With the session token but a Host header naming another site (fetch cannot set Host). */
const foreignHost = (s: RunningServer, method: string, path: string, body?: unknown) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: s.port, method, path,
        headers: {
          host: "evil.example", authorization: `Bearer ${s.token}`,
          ...(payload !== undefined && { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const ledger = (s: RunningServer) => json<LedgerEntry[]>(send(s, "GET", "/api/ledger"));
type Overview = {
  identity: "ok" | "unavailable";
  self: { machineId: string; fingerprint: string; name: string; linking: { enabled: boolean; port: number | null } } | null;
  machines: Array<Machine & { online: boolean | null; checkedAt: string | null }>;
  discovered: Array<{ machineId: string; name: string; address: string; seenAt: string }>;
};
type Status = { machines: { linked: number; online: number; keyChanged: number } };

async function enabled(s: RunningServer) {
  const res = await send(s, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK });
  expect(res.status).toBe(200);
  return (await res.json()) as NonNullable<Overview["self"]>;
}

describe("link routes", { timeout: 30_000 }, () => {
  it("GET /api/link/machines lists the paired machines without asking them or browsing the network", async () => {
    const discovery = fakeDiscovery();
    const browse = vi.spyOn(discovery, "browse");
    const s = await start({ discovery });
    const res = await send(s, "GET", "/api/link/machines");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect((await send(s, "GET", "/api/link/machines", undefined, { authed: false })).status).toBe(401);
    expect(browse).not.toHaveBeenCalled();
    await send(s, "GET", "/api/link");
    expect(browse).toHaveBeenCalled(); // the full overview, which the Machines view asks for, still browses
  });

  it("GET /api/link/verify is 401 without auth, and with nothing mirrored answers ok with nothing checked", async () => {
    const s = await start();
    expect((await send(s, "GET", "/api/link/verify", undefined, { authed: false })).status).toBe(401);
    expect(await json(send(s, "GET", "/api/link/verify"))).toEqual({ ok: true, checked: 0, badSeqs: [] });
  });

  it("the first start records this computer's identity at seq 1", async () => {
    const s = await start();
    const [first] = await ledger(s);
    expect(first).toMatchObject({ seq: 1, type: "machine.identity_created" });
  });

  it("GET /api/link: identity, self, machines and discovered", async () => {
    const s = await start();
    const overview = await json<Overview>(send(s, "GET", "/api/link"));
    expect(overview.identity).toBe("ok");
    expect(overview.self).toMatchObject({ linking: { enabled: false, port: null } });
    expect(overview.self!.machineId).toMatch(/^[0-9a-f]{32}$/);
    expect(overview.machines).toEqual([]);
    expect(overview.discovered).toEqual([]);
  });

  it("an unavailable keychain answers self null, and 503 identity_unavailable where an identity is needed", async () => {
    const s = await start({ secrets: new MemorySecretStore({ failOn: new Set(["get"]) }) });
    const overview = await json<Overview>(send(s, "GET", "/api/link"));
    expect(overview).toEqual({ identity: "unavailable", self: null, machines: [], discovered: [] });
    for (const [method, path, body] of [
      ["POST", "/api/link/enable", { acknowledgement: LINKING_ACK }],
      ["POST", "/api/link/name", { name: "Mac" }],
      ["POST", "/api/link/disable", undefined],
      ["POST", "/api/link/code", undefined],
    ] as const) {
      const res = await send(s, method, path, body);
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: "identity_unavailable" });
    }
  });

  it("POST /api/link/name records the name and answers self", async () => {
    const s = await start();
    const self = await json<Overview["self"]>(send(s, "POST", "/api/link/name", { name: "GPU box" }));
    expect(self!.name).toBe("GPU box");
    expect((await ledger(s)).at(-1)).toMatchObject({ type: "machine.named", payload: { name: "GPU box" }, actor: { kind: "human", id: "owner" } });
    expect((await send(s, "POST", "/api/link/name", { name: "x".repeat(41) })).status).toBe(400);
    expect((await send(s, "POST", "/api/link/name", { name: "Mac", extra: 1 })).status).toBe(400);
  });

  it("POST /api/link/enable needs the exact sentence; POST /api/link/disable takes no body", async () => {
    const s = await start();
    const wrong = await send(s, "POST", "/api/link/enable", { acknowledgement: "yes" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_input" });
    const self = await enabled(s);
    expect(self.linking.enabled).toBe(true);
    expect(self.linking.port).toBeGreaterThan(0);
    expect((await ledger(s)).at(-1)).toMatchObject({ type: "machine.linking_enabled", payload: { port: self.linking.port, acknowledgement: LINKING_ACK } });
    const off = await send(s, "POST", "/api/link/disable");
    expect(off.status).toBe(200);
    expect(((await off.json()) as Overview["self"])!.linking).toEqual({ enabled: false, port: null });
    expect((await ledger(s)).at(-1)!.type).toBe("machine.linking_disabled");
  });

  it("POST /api/link/code: 409 linking_disabled while off; a code, its expiry and addresses while on; DELETE withdraws it", async () => {
    const s = await start();
    const off = await send(s, "POST", "/api/link/code");
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "linking_disabled" });
    const self = await enabled(s);
    const res = await send(s, "POST", "/api/link/code");
    expect(res.status).toBe(200);
    const code = (await res.json()) as { code: string; expiresAt: string; addresses: string[] };
    expect(parsePairingCode(code.code)!.fingerprintPrefix).toBe(self.fingerprint.slice(0, 16));
    expect(Date.parse(code.expiresAt)).toBeGreaterThan(Date.now());
    for (const a of code.addresses) expect(a).toMatch(new RegExp(`^\\d+\\.\\d+\\.\\d+\\.\\d+:${self.linking.port}$`));
    expect((await send(s, "DELETE", "/api/link/code")).status).toBe(204);
  });

  it("POST /api/link/pair links two servers; GET /api/link and /api/status count the machine on both sides", async () => {
    const shower = await start();
    const enterer = await start();
    await send(shower, "POST", "/api/link/name", { name: "Studio Mac" });
    await send(enterer, "POST", "/api/link/name", { name: "GPU box" });
    const sSelf = await enabled(shower);
    const eSelf = await enabled(enterer);
    // The in-process discovery lets each find the other.
    const found = await json<Overview>(send(enterer, "GET", "/api/link"));
    expect(found.discovered).toEqual([expect.objectContaining({ machineId: sSelf.machineId, name: "Studio Mac", address: `127.0.0.1:${sSelf.linking.port}` })]);

    const { code } = await json<{ code: string }>(send(shower, "POST", "/api/link/code"));
    const res = await send(enterer, "POST", "/api/link/pair", { address: `127.0.0.1:${sSelf.linking.port}`, code });
    expect(res.status).toBe(201);
    const machine = (await res.json()) as Machine;
    expect(machine).toMatchObject({ id: sSelf.machineId, name: "Studio Mac", fingerprint: sSelf.fingerprint, role: "entered_code" });

    const shown = (await ledger(shower)).filter((e) => e.type === "machine.paired");
    expect(shown).toEqual([expect.objectContaining({ payload: expect.objectContaining({ machineId: eSelf.machineId, name: "GPU box", role: "showed_code" }) })]);

    const overview = await json<Overview>(send(enterer, "GET", "/api/link"));
    expect(overview.machines).toEqual([expect.objectContaining({ id: sSelf.machineId, online: true })]);
    expect(overview.machines[0]!.checkedAt).not.toBeNull();
    expect((await json<Status>(send(enterer, "GET", "/api/status"))).machines).toEqual({ linked: 1, online: 1, keyChanged: 0 });
    // The showing side has not checked yet: linked, not online.
    expect((await json<Status>(send(shower, "GET", "/api/status"))).machines).toEqual({ linked: 1, online: 0, keyChanged: 0 });

    // Unlink: 204, then the row is gone; an unknown id is 404.
    expect((await send(enterer, "DELETE", `/api/link/machines/${sSelf.machineId}`)).status).toBe(204);
    expect((await json<Status>(send(enterer, "GET", "/api/status"))).machines).toEqual({ linked: 0, online: 0, keyChanged: 0 });
    const missing = await send(enterer, "DELETE", `/api/link/machines/${"0".repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
  });

  it("maps each pairing failure to its status and code", async () => {
    const shower = await start();
    const enterer = await start();
    const sSelf = await enabled(shower);
    const eSelf = await enabled(enterer);
    const at = `127.0.0.1:${sSelf.linking.port}`;
    const pair = (address: string, code: string) => send(enterer, "POST", "/api/link/pair", { address, code });
    const expectError = async (res: Response, status: number, error: string) => {
      expect(res.status, error).toBe(status);
      expect(await res.json()).toMatchObject({ error });
    };

    await expectError(await pair(at, encodePairingCode(sSelf.fingerprint, Uint8Array.from([1, 2, 3, 4]))), 404, "no_pairing");
    const { code } = await json<{ code: string }>(send(shower, "POST", "/api/link/code"));
    await expectError(await pair(at, encodePairingCode(eSelf.fingerprint, Uint8Array.from([1, 2, 3, 4]))), 400, "pairing_code_mismatch");
    const secret = parsePairingCode(code)!.secret;
    secret[0] = secret[0]! ^ 1;
    await expectError(await pair(at, encodePairingCode(sSelf.fingerprint, secret)), 403, "pairing_rejected");
    const own = await json<{ code: string }>(send(enterer, "POST", "/api/link/code"));
    await expectError(await pair(`127.0.0.1:${eSelf.linking.port}`, own.code), 400, "self_pairing");
    const held = await holdPort();
    await held.release();
    await expectError(await pair(`127.0.0.1:${held.port}`, code), 502, "machine_unreachable");
    const badCode = await pair(at, "nope");
    await expectError(badCode, 400, "invalid_input");
    await expectError(await send(enterer, "POST", "/api/link/pair", { address: at }), 400, "invalid_input");
    expect((await ledger(enterer)).filter((e) => e.type === "machine.paired")).toEqual([]);
  });

  it("every route needs the session and the workspace host", async () => {
    const s = await start();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/api/link"],
      ["POST", "/api/link/name", { name: "Mac" }],
      ["POST", "/api/link/enable", { acknowledgement: LINKING_ACK }],
      ["POST", "/api/link/disable"],
      ["POST", "/api/link/code"],
      ["DELETE", "/api/link/code"],
      ["POST", "/api/link/pair", { address: "127.0.0.1:1", code: "x" }],
      ["DELETE", `/api/link/machines/${"0".repeat(32)}`],
      ["GET", `/api/link/machines/${"0".repeat(32)}/capacity`],
    ];
    for (const [method, path, body] of routes) {
      const anon = await send(s, method, path, body, { authed: false });
      expect(anon.status, `${method} ${path}`).toBe(401);
      const foreign = await foreignHost(s, method, path, body);
      expect(foreign, `${method} ${path}`).toEqual({ status: 403, body: { error: "bad_host" } });
    }
    // Nothing was recorded or started.
    expect((await ledger(s)).map((e) => e.type)).toEqual(["machine.identity_created"]);
  });
});
