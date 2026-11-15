import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { LINKING_ACK, PAIRING_LABEL, encodePairingCode, parsePairingCode } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import type { SecretStore } from "../../src/secrets/store.js";
import { HumanRequiredError } from "../../src/intake/service.js";
import { SecretInTextError } from "../../src/intake/recorded-text.js";
import { NotFoundError } from "../../src/board/board-service.js";
import { LinkListener } from "../../src/link/listener.js";
import { LinkClient, MachineUnreachableError, RemoteRefusedError } from "../../src/link/client.js";
import {
  IdentityUnavailableError, LinkService, LinkingDisabledError, NoPairingError, PairingCodeMismatchError, PairingRejectedError,
  SelfPairingError, type LinkServiceDeps,
} from "../../src/link/service.js";
import { fakeDiscovery, type Discovered, type Discovery } from "../../src/link/discovery.js";
import { registerLinkProtocolRoutes } from "../../src/link/protocol-routes.js";
import { holdPort, rawTlsGet, tcpAccepts, tlsServer } from "./helpers.js";
import { pairingProof } from "../../src/link/pairing.js";
import { IDENTITY_ACCOUNT, LinkIdentity } from "../../src/link/identity.js";

const owner = { kind: "human", id: "owner" } as const;

const services: LinkService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.shutdown();
});

function makeService(
  o: { db?: Db; secrets?: SecretStore; platform?: NodeJS.Platform; discovery?: Discovery; interfaces?: LinkServiceDeps["interfaces"] } = {},
) {
  const db = o.db ?? openDatabase(":memory:");
  const ledger = new Ledger(db);
  const secrets = o.secrets ?? new MemorySecretStore();
  const link: LinkService = new LinkService({
    db,
    ledger,
    secrets,
    listener: (deps) => new LinkListener(deps),
    client: (identity, timeoutMs) => new LinkClient({ identity, ...(timeoutMs !== undefined && { timeoutMs }) }),
    registerProtocol: (app) => registerLinkProtocolRoutes(app, { link }),
    discovery: o.discovery ?? fakeDiscovery(),
    bind: "127.0.0.1",
    ...(o.platform && { platform: o.platform }),
    ...(o.interfaces && { interfaces: o.interfaces }),
  });
  services.push(link);
  return { db, ledger, secrets, link };
}

const types = (ledger: Ledger) => ledger.list().map((e) => e.type);

/** Pairs `other`'s identity into `db` as a known machine, as Task 4's pairing would record it. */
function recordPaired(db: Db, ledger: Ledger, other: LinkIdentity, port: number) {
  commitEvent(db, ledger, () => ({
    event: {
      projectId: null,
      actor: owner,
      type: "machine.paired",
      payload: {
        machineId: other.machineId, name: "GPU box", publicKey: other.publicKeyBase64, fingerprint: other.fingerprint,
        address: `127.0.0.1:${port}`, role: "entered_code",
      },
    },
    result: () => undefined,
  }));
}

describe("LinkService identity", () => {
  it("creates the identity once and records exactly one machine.identity_created", async () => {
    const { db, ledger, secrets, link } = makeService();
    await link.load();
    expect(link.identityState()).toBe("ok");
    expect(types(ledger)).toEqual(["machine.identity_created"]);
    const self = link.self()!;
    expect(self.machineId).toMatch(/^[0-9a-f]{32}$/);
    expect(self.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(self.linking).toEqual({ enabled: false, port: null });
    // Loading again over the same store and db records nothing more.
    const again = makeService({ db, secrets }).link;
    await again.load();
    expect(again.self()!.machineId).toBe(self.machineId);
    expect(types(ledger)).toEqual(["machine.identity_created"]);
    expect(JSON.stringify(ledger.list())).not.toContain("PRIVATE KEY");
  });

  it("records the identity in a new data folder whose keychain already holds a key", async () => {
    const secrets = new MemorySecretStore();
    await makeService({ secrets }).link.load();
    const fresh = makeService({ secrets });
    await fresh.link.load();
    expect(types(fresh.ledger)).toEqual(["machine.identity_created"]);
  });

  it("names the computer by platform until it is renamed", async () => {
    const mac = makeService({ platform: "darwin" }).link;
    await mac.load();
    expect(mac.self()!.name).toBe("Mac");
    const win = makeService({ platform: "win32" }).link;
    await win.load();
    expect(win.self()!.name).toBe("Windows PC");
    const linux = makeService({ platform: "linux" }).link;
    await linux.load();
    expect(linux.self()!.name).toBe("Linux PC");
  });

  it("records a new name, refusing a secret and a name over 40 characters", async () => {
    const { ledger, link } = makeService();
    await link.load();
    await link.setName(owner, "GPU box");
    expect(link.self()!.name).toBe("GPU box");
    expect(types(ledger)).toEqual(["machine.identity_created", "machine.named"]);
    await expect(link.setName(owner, "x".repeat(41))).rejects.toBeInstanceOf(ZodError);
    await expect(link.setName(owner, "sk-ant-TESTKEY000000abcdef")).rejects.toBeInstanceOf(SecretInTextError);
    await expect(link.setName({ kind: "agent", id: "a" }, "Mac")).rejects.toBeInstanceOf(HumanRequiredError);
    expect(types(ledger)).toHaveLength(2);
  });

  it("treats a stored key that cannot be read as unavailable, with one fixed warning holding no key material", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(IDENTITY_ACCOUNT, "-----BEGIN PRIVATE KEY-----\nTESTKEYnotakey\n-----END PRIVATE KEY-----\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { ledger, link } = makeService({ secrets });
      await link.load();
      expect(link.identityState()).toBe("unavailable");
      expect(link.self()).toBeNull();
      expect(ledger.list()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toHaveLength(1);
      expect(String(warn.mock.calls[0]![0])).not.toMatch(/TESTKEY|PRIVATE KEY/);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for an unavailable keychain, which is reported through identityState", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { link } = makeService({ secrets: new MemorySecretStore({ failOn: new Set(["get"]) }) });
      await link.load();
      expect(link.identityState()).toBe("unavailable");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reports an unavailable keychain: no identity, no linking, nothing recorded", async () => {
    const { ledger, link } = makeService({ secrets: new MemorySecretStore({ failOn: new Set(["get"]) }) });
    await link.load();
    expect(link.identityState()).toBe("unavailable");
    expect(link.self()).toBeNull();
    await expect(link.enableLinking(owner, LINKING_ACK, 0)).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(link.enableLinking(owner, LINKING_ACK, 0)).rejects.toThrow("this computer's identity is unavailable (keychain)");
    expect(ledger.list()).toEqual([]);
  });
});

describe("LinkService linking opt-in", () => {
  it("starts the listener first, then records machine.linking_enabled with the bound port", async () => {
    const { db, ledger, link } = makeService({ platform: "darwin" });
    await link.load();
    const port = await link.enableLinking(owner, LINKING_ACK, 0);
    expect(port).toBeGreaterThan(0);
    expect(link.self()!.linking).toEqual({ enabled: true, port });
    const enabled = ledger.list().find((e) => e.type === "machine.linking_enabled")!;
    expect(enabled.payload).toEqual({ port, acknowledgement: LINKING_ACK });
    expect(enabled.actor).toEqual(owner);
    // The hello route answers on it, to a paired machine and only to one.
    const peer = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    expect((await rawTlsGet(port, "/link/v1/hello", peer)).kind).toBe("closed");
    recordPaired(db, ledger, peer, 1);
    const reply = await rawTlsGet(port, "/link/v1/hello", peer);
    expect(reply).toEqual({
      kind: "reply", status: 200, body: JSON.stringify({ v: 1, machineId: link.self()!.machineId, name: "Mac", linking: true }),
    });
    // Enabling again while on records nothing more and keeps the port.
    expect(await link.enableLinking(owner, LINKING_ACK, 0)).toBe(port);
    expect(types(ledger).filter((t) => t === "machine.linking_enabled")).toHaveLength(1);
  });

  it("refuses a wrong sentence and a non-human actor, starting nothing", async () => {
    const { ledger, link } = makeService();
    await link.load();
    await expect(link.enableLinking(owner, `${LINKING_ACK} `, 0)).rejects.toBeInstanceOf(ZodError);
    await expect(link.enableLinking({ kind: "system", id: "x" }, LINKING_ACK, 0)).rejects.toBeInstanceOf(HumanRequiredError);
    await expect(link.enableLinking({ kind: "agent", id: "x" }, LINKING_ACK, 0)).rejects.toBeInstanceOf(HumanRequiredError);
    expect(link.self()!.linking).toEqual({ enabled: false, port: null });
    expect(types(ledger)).toEqual(["machine.identity_created"]);
  });

  it("records nothing when the listener cannot bind", async () => {
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const link = new LinkService({
      db, ledger, secrets: new MemorySecretStore(), bind: "127.0.0.1", discovery: fakeDiscovery(),
      listener: (deps) => {
        const l = new LinkListener(deps);
        l.start = async () => {
          throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
        };
        return l;
      },
      client: (identity) => new LinkClient({ identity }),
      registerProtocol: () => undefined,
    });
    services.push(link);
    await link.load();
    await expect(link.enableLinking(owner, LINKING_ACK, 0)).rejects.toThrow("EADDRINUSE");
    expect(types(ledger)).toEqual(["machine.identity_created"]);
    expect(link.self()!.linking).toEqual({ enabled: false, port: null });
  });

  it("keeps linking enabled with a warning when a recorded opt-in cannot bind at load", async () => {
    const db = openDatabase(":memory:");
    const secrets = new MemorySecretStore();
    const first = makeService({ db, secrets }).link;
    await first.load();
    await first.enableLinking(owner, LINKING_ACK, 0);
    await first.shutdown();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const link = new LinkService({
        db, ledger: new Ledger(db), secrets, bind: "127.0.0.1", discovery: fakeDiscovery(),
        listener: (deps) => {
          const l = new LinkListener(deps);
          l.start = async () => {
            throw Object.assign(new Error("listen EADDRINUSE 127.0.0.1"), { code: "EADDRINUSE" });
          };
          return l;
        },
        client: (identity) => new LinkClient({ identity }),
        registerProtocol: () => undefined,
      });
      services.push(link);
      await link.load();
      expect(link.self()!.linking).toEqual({ enabled: true, port: null });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain("127.0.0.1");
    } finally {
      warn.mockRestore();
    }
  });

  it("disableLinking records the change and the port stops answering", async () => {
    const { ledger, link } = makeService();
    await link.load();
    const port = await link.enableLinking(owner, LINKING_ACK, 0);
    expect(await tcpAccepts(port)).toBe(true);
    await expect(link.disableLinking({ kind: "system", id: "x" })).rejects.toBeInstanceOf(HumanRequiredError);
    await link.disableLinking(owner);
    expect(await tcpAccepts(port)).toBe(false);
    expect(link.self()!.linking).toEqual({ enabled: false, port: null });
    expect(types(ledger)).toEqual(["machine.identity_created", "machine.linking_enabled", "machine.linking_disabled"]);
  });

  // Global Constraints: the opt-in persists until machine.linking_disabled.
  it("a new service over the same db and store starts the listener on load(), and not after a disable", async () => {
    const db = openDatabase(":memory:");
    const secrets = new MemorySecretStore();
    const first = makeService({ db, secrets }).link;
    await first.load();
    const port = await first.enableLinking(owner, LINKING_ACK, 0);
    await first.shutdown();
    expect(await tcpAccepts(port)).toBe(false);

    const second = makeService({ db, secrets }).link;
    await second.load();
    const reopened = second.self()!.linking;
    expect(reopened.enabled).toBe(true);
    expect(reopened.port).toBeGreaterThanOrEqual(port); // the same port, or the next free one
    expect(await tcpAccepts(reopened.port!)).toBe(true);
    await second.disableLinking(owner);
    await second.shutdown();

    const third = makeService({ db, secrets }).link;
    await third.load();
    expect(third.self()!.linking).toEqual({ enabled: false, port: null });
  });
});

describe("LinkService listener lifecycle", () => {
  it("a second load() with the opt-in recorded keeps one listener and leaks none", async () => {
    const started: LinkListener[] = [];
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const link: LinkService = new LinkService({
      db, ledger, secrets: new MemorySecretStore(), bind: "127.0.0.1", discovery: fakeDiscovery(),
      listener: (deps) => {
        const l = new LinkListener(deps);
        started.push(l);
        return l;
      },
      client: (identity) => new LinkClient({ identity }),
      registerProtocol: (app) => registerLinkProtocolRoutes(app, { link }),
    });
    services.push(link);
    await link.load();
    const port = await link.enableLinking(owner, LINKING_ACK, 0);
    await link.load();
    expect(started).toHaveLength(1);
    expect(link.self()!.linking.port).toBe(port);
    await link.disableLinking(owner);
    expect(await tcpAccepts(port)).toBe(false);
    expect(started.every((l) => l.port() === null)).toBe(true);
  });
});

describe("LinkService machines and hello", () => {
  it("answers hello between two paired services and caches the result", async () => {
    const a = makeService({ platform: "darwin" });
    const b = makeService({ platform: "linux" });
    await a.link.load();
    await b.link.load();
    await b.link.setName(owner, "GPU box");
    const bPort = await b.link.enableLinking(owner, LINKING_ACK, 0);
    const aId = (await LinkIdentity.load({ secrets: a.secrets, onCreated: () => undefined }));
    const bId = (await LinkIdentity.load({ secrets: b.secrets, onCreated: () => undefined }));
    recordPaired(a.db, a.ledger, bId, bPort);
    recordPaired(b.db, b.ledger, aId, 1);

    expect(a.link.machines().map((m) => m.id)).toEqual([bId.machineId]);
    expect(a.link.presence()).toEqual([expect.objectContaining({ id: bId.machineId, online: null, checkedAt: null })]);
    expect(a.link.peerFor(bId.machineId)).toEqual({ machineId: bId.machineId, address: `127.0.0.1:${bPort}`, publicKeyDer: bId.publicKeyDer });
    expect(() => a.link.peerFor("0".repeat(32))).toThrow(NotFoundError);
    expect(b.link.peerCheck(aId.publicKeyDer)).toEqual({ machineId: aId.machineId });
    expect(b.link.peerCheck(bId.publicKeyDer)).toBeNull();

    expect(await a.link.hello(bId.machineId)).toBe(true);
    const [row] = a.link.presence();
    expect(row!.online).toBe(true);
    expect(row!.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    // Cached for 15 s: B going away is not seen until then.
    await b.link.disableLinking(owner);
    expect(await a.link.hello(bId.machineId)).toBe(true);
  });

  it("answers hello false for a machine that is not listening, or whose key is not the pinned one", async () => {
    const a = makeService();
    await a.link.load();
    const stranger = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const held = await holdPort();
    await held.release();
    recordPaired(a.db, a.ledger, stranger, held.port);
    expect(await a.link.hello(stranger.machineId)).toBe(false);
    expect(a.link.presence()[0]!.online).toBe(false);
    expect(await a.link.hello("f".repeat(32))).toBe(false);
  });
});

describe("LinkService pairing", () => {
  /** S shows a code; E enters it. Both bind loopback and share the in-process fake discovery. */
  async function pairOfServices() {
    const s = makeService({ platform: "darwin" });
    const e = makeService({ platform: "linux" });
    await s.link.load();
    await e.link.load();
    await s.link.setName(owner, "Studio Mac");
    await e.link.setName(owner, "GPU box");
    const sPort = await s.link.enableLinking(owner, LINKING_ACK, 0);
    const ePort = await e.link.enableLinking(owner, LINKING_ACK, 0);
    return { s, e, sPort, ePort };
  }
  const paired = (ledger: Ledger) => ledger.list().filter((x) => x.type === "machine.paired");

  it("pairs two machines with a shown code: each ledger records the other's id, key and fingerprint", async () => {
    const { s, e, sPort, ePort } = await pairOfServices();
    const shown = s.link.showCode();
    expect(shown.code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(Date.parse(shown.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(s.link.pairingState()).toEqual({ open: true, attempts: 0 });

    const machine = await e.link.pair(owner, `127.0.0.1:${sPort}`, shown.code.toLowerCase());
    const sSelf = s.link.self()!;
    const eSelf = e.link.self()!;
    expect(machine).toMatchObject({ id: sSelf.machineId, name: "Studio Mac", fingerprint: sSelf.fingerprint, address: `127.0.0.1:${sPort}`, role: "entered_code" });

    const [onE] = paired(e.ledger);
    const [onS] = paired(s.ledger);
    expect(paired(e.ledger)).toHaveLength(1);
    expect(paired(s.ledger)).toHaveLength(1);
    const sKey = (await LinkIdentity.load({ secrets: s.secrets, onCreated: () => undefined })).publicKeyBase64;
    const eKey = (await LinkIdentity.load({ secrets: e.secrets, onCreated: () => undefined })).publicKeyBase64;
    expect(onE!.payload).toEqual({
      machineId: sSelf.machineId, name: "Studio Mac", publicKey: sKey, fingerprint: sSelf.fingerprint,
      address: `127.0.0.1:${sPort}`, role: "entered_code",
    });
    expect(onS!.payload).toEqual({
      machineId: eSelf.machineId, name: "GPU box", publicKey: eKey, fingerprint: eSelf.fingerprint,
      address: `127.0.0.1:${ePort}`, role: "showed_code",
    });
    expect(onE!.actor).toEqual(owner);
    expect(onS!.actor).toEqual(owner);
    // The window was used up; nothing about the code or any private key reached either ledger.
    expect(s.link.pairingState()).toEqual({ open: false, attempts: 0 });
    for (const ledger of [s.ledger, e.ledger]) {
      const text = JSON.stringify(ledger.list());
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain(shown.code);
      expect(text).not.toContain(shown.code.replace(/-/g, ""));
    }
    // Pinned both ways from now on.
    expect(await e.link.hello(sSelf.machineId)).toBe(true);
    expect(await s.link.hello(eSelf.machineId)).toBe(true);
  });

  it("checks the code's fingerprint against the certificate before sending anything", async () => {
    const { s, e, sPort } = await pairOfServices();
    s.link.showCode();
    const other = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const wrongPrefix = encodePairingCode(other.fingerprint, Uint8Array.from([1, 2, 3, 4]));
    await expect(e.link.pair(owner, `127.0.0.1:${sPort}`, wrongPrefix)).rejects.toBeInstanceOf(PairingCodeMismatchError);
    expect(s.link.pairingState()).toEqual({ open: true, attempts: 0 });
    expect(paired(e.ledger)).toEqual([]);
    expect(paired(s.ledger)).toEqual([]);
  });

  it("a wrong secret is rejected by the showing side and counted there", async () => {
    const { s, e, sPort } = await pairOfServices();
    const shown = s.link.showCode();
    const { secret } = parsePairingCode(shown.code)!;
    secret[0] = secret[0]! ^ 0xff;
    const wrong = encodePairingCode(s.link.self()!.fingerprint, secret);
    await expect(e.link.pair(owner, `127.0.0.1:${sPort}`, wrong)).rejects.toBeInstanceOf(PairingRejectedError);
    expect(s.link.pairingState()).toEqual({ open: true, attempts: 1 });
    expect(paired(e.ledger)).toEqual([]);
    expect(paired(s.ledger)).toEqual([]);
    // The right code still works afterwards.
    await e.link.pair(owner, `127.0.0.1:${sPort}`, shown.code);
    expect(paired(s.ledger)).toHaveLength(1);
  });

  it("five wrong secrets close the window: the sixth try finds no code", async () => {
    const { s, e, sPort } = await pairOfServices();
    const shown = s.link.showCode();
    const { secret } = parsePairingCode(shown.code)!;
    const fp = s.link.self()!.fingerprint;
    for (let i = 1; i <= 5; i++) {
      const wrong = Uint8Array.from(secret);
      wrong[3] = wrong[3]! ^ i;
      await expect(e.link.pair(owner, `127.0.0.1:${sPort}`, encodePairingCode(fp, wrong))).rejects.toBeInstanceOf(PairingRejectedError);
    }
    expect(s.link.pairingState()).toEqual({ open: false, attempts: 0 });
    await expect(e.link.pair(owner, `127.0.0.1:${sPort}`, shown.code)).rejects.toBeInstanceOf(NoPairingError);
  });

  it("answers no code when the other machine shows none, and after a cancel", async () => {
    const { s, e, sPort } = await pairOfServices();
    const code = encodePairingCode(s.link.self()!.fingerprint, Uint8Array.from([9, 9, 9, 9]));
    await expect(e.link.pair(owner, `127.0.0.1:${sPort}`, code)).rejects.toBeInstanceOf(NoPairingError);
    const shown = s.link.showCode();
    s.link.cancelCode();
    expect(s.link.pairingState().open).toBe(false);
    await expect(e.link.pair(owner, `127.0.0.1:${sPort}`, shown.code)).rejects.toBeInstanceOf(NoPairingError);
  });

  it("counts the machine it just paired with as online on the side that entered the code, before any hello", async () => {
    const { s, e, sPort } = await pairOfServices();
    // E reached S over TLS to pair, so E knows S answered; S was only reached, so it says nothing until it checks.
    const counted: Array<{ linked: number; online: number }> = [];
    const stop = e.ledger.onAppend((x) => {
      if (x.type === "machine.paired") queueMicrotask(() => counted.push(e.link.counts()));
    });
    await e.link.pair(owner, `127.0.0.1:${sPort}`, s.link.showCode().code);
    stop();
    expect(counted).toEqual([{ linked: 1, online: 1 }]);
    expect(e.link.counts()).toEqual({ linked: 1, online: 1 });
    expect(e.link.presence()[0]!.online).toBe(true);
    expect(s.link.counts()).toEqual({ linked: 1, online: 0 });
  });

  it("refuses to pair with itself, and refuses a malformed code or address before connecting", async () => {
    const { e, ePort } = await pairOfServices();
    const own = e.link.showCode();
    await expect(e.link.pair(owner, `127.0.0.1:${ePort}`, own.code)).rejects.toBeInstanceOf(SelfPairingError);
    expect(paired(e.ledger)).toEqual([]);
    const bad = await e.link.pair(owner, `127.0.0.1:${ePort}`, "not a code").catch((err: unknown) => err);
    expect(bad).toBeInstanceOf(ZodError);
    expect((bad as ZodError).issues[0]!.path).toEqual(["code"]);
    const badAddress = await e.link.pair(owner, "https://x:1", own.code).catch((err: unknown) => err);
    expect(badAddress).toBeInstanceOf(ZodError);
    expect((badAddress as ZodError).issues[0]!.path).toEqual(["address"]);
    await expect(e.link.pair({ kind: "agent", id: "a" }, `127.0.0.1:${ePort}`, own.code)).rejects.toBeInstanceOf(HumanRequiredError);
  });

  it("reports an address where nothing listens as unreachable", async () => {
    const { s, e } = await pairOfServices();
    const shown = s.link.showCode();
    const held = await holdPort();
    await held.release();
    const err = await e.link.pair(owner, `127.0.0.1:${held.port}`, shown.code).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(MachineUnreachableError);
    expect((err as MachineUnreachableError).machineId).toBeNull();
  });

  it("shows a code only while linking is on, with this computer's local network addresses", async () => {
    const interfaces = () => ({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
    });
    const { link } = makeService({ interfaces });
    await link.load();
    expect(() => link.showCode()).toThrow(LinkingDisabledError);
    const port = await link.enableLinking(owner, LINKING_ACK, 0);
    expect(link.showCode().addresses).toEqual([`192.168.1.20:${port}`]);
    await link.disableLinking(owner);
    expect(link.pairingState().open).toBe(false);
    expect(() => link.showCode()).toThrow(LinkingDisabledError);
  });

  it("lists the other machine once it enables linking, and stops browsing a minute after the last look", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let browsing = 0;
      const inner = fakeDiscovery();
      const counting: Discovery = {
        publish: (i) => inner.publish(i),
        unpublish: () => inner.unpublish(),
        browse: (fn) => {
          browsing++;
          const stop = inner.browse(fn);
          return () => {
            browsing--;
            stop();
          };
        },
        destroy: () => inner.destroy(),
      };
      const s = makeService({ discovery: counting });
      const e = makeService();
      await s.link.load();
      await e.link.load();
      await e.link.setName(owner, "GPU box");
      expect(s.link.discovered()).toEqual([]);
      expect(browsing).toBe(1);
      const ePort = await e.link.enableLinking(owner, LINKING_ACK, 0);
      const found: Discovered[] = s.link.discovered();
      expect(found).toEqual([expect.objectContaining({ machineId: e.link.self()!.machineId, name: "GPU box", address: `127.0.0.1:${ePort}` })]);
      expect(browsing).toBe(1);
      vi.advanceTimersByTime(59_000);
      s.link.discovered();
      vi.advanceTimersByTime(59_000);
      expect(browsing).toBe(1);
      vi.advanceTimersByTime(2_000);
      expect(browsing).toBe(0);
      // A rename is announced at once; disabling withdraws the record.
      await e.link.setName(owner, "Big GPU box");
      expect(s.link.discovered()[0]!.name).toBe("Big GPU box");
      await e.link.disableLinking(owner);
      expect(s.link.discovered()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unpair removes the machine, and its next request is refused", async () => {
    const { s, e, sPort } = await pairOfServices();
    await e.link.pair(owner, `127.0.0.1:${sPort}`, s.link.showCode().code);
    const eId = e.link.self()!.machineId;
    const sId = s.link.self()!.machineId;
    await expect(s.link.unpair({ kind: "agent", id: "a" }, eId)).rejects.toBeInstanceOf(HumanRequiredError);
    await expect(s.link.unpair(owner, "0".repeat(32))).rejects.toBeInstanceOf(NotFoundError);
    await s.link.unpair(owner, eId);
    expect(s.link.machines()).toEqual([]);
    expect(s.ledger.list().at(-1)).toMatchObject({ type: "machine.unpaired", payload: { machineId: eId, name: "GPU box" } });
    const client = new LinkClient({ identity: await LinkIdentity.load({ secrets: e.secrets, onCreated: () => undefined }) });
    const peer = e.link.peerFor(sId);
    // With no code shown, the unknown key is dropped at the TLS layer...
    await expect(client.request(peer, "GET", "/link/v1/hello")).rejects.toBeInstanceOf(MachineUnreachableError);
    // ...and while a code is shown it reaches the listener, which refuses every route but pairing.
    s.link.showCode();
    const refused = await client.request(peer, "GET", "/link/v1/hello").catch((x: unknown) => x);
    expect(refused).toBeInstanceOf(RemoteRefusedError);
    expect(refused).toMatchObject({ status: 403, code: "unknown_machine" });
  });
});

describe("LinkService pairing, against a misbehaving machine", () => {
  /** A TLS server under `identity` that answers every request with `reply(ekm)`, as raw HTTP. */
  async function fakeShower(identity: LinkIdentity, reply: (ekm: Buffer) => unknown) {
    return tlsServer(identity, (socket) => {
      let seen = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        seen += chunk;
        const end = seen.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/content-length: (\d+)/i.exec(seen.slice(0, end))?.[1] ?? 0);
        if (seen.length < end + 4 + length) return;
        const ekm = (socket.exportKeyingMaterial as (n: number, l: string) => Buffer).call(socket, 32, PAIRING_LABEL);
        const body = JSON.stringify(reply(ekm));
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      });
    });
  }

  it("refuses a reply whose proof is wrong, or whose machine id is not the key it presented, recording nothing", async () => {
    const e = makeService();
    await e.link.load();
    const fake = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const secret = Uint8Array.from([5, 6, 7, 8]);
    const code = encodePairingCode(fake.fingerprint, secret);

    const wrongProof = await fakeShower(fake, () => ({ v: 1, machineId: fake.machineId, name: "Fake", port: 4418, proof: "a".repeat(64) }));
    try {
      await expect(e.link.pair(owner, `127.0.0.1:${wrongProof.port}`, code)).rejects.toBeInstanceOf(PairingRejectedError);
    } finally {
      await wrongProof.close();
    }
    const otherId = await fakeShower(fake, (ekm) => ({
      v: 1, machineId: "b".repeat(32), name: "Fake", port: 4418,
      proof: pairingProof(Uint8Array.from([5, 6, 7, 8]), "theterminal-pair-ack-v1", ekm, fake.publicKeyDer),
    }));
    try {
      await expect(e.link.pair(owner, `127.0.0.1:${otherId.port}`, code)).rejects.toBeInstanceOf(PairingRejectedError);
    } finally {
      await otherId.close();
    }
    // The right proof from the right key is accepted: the two refusals above were the proof and the id.
    const honest = await fakeShower(fake, (ekm) => ({
      v: 1, machineId: fake.machineId, name: "Fake", port: 4418,
      proof: pairingProof(Uint8Array.from([5, 6, 7, 8]), "theterminal-pair-ack-v1", ekm, fake.publicKeyDer),
    }));
    try {
      const m = await e.link.pair(owner, `127.0.0.1:${honest.port}`, code);
      expect(m).toMatchObject({ id: fake.machineId, address: "127.0.0.1:4418", role: "entered_code" });
    } finally {
      await honest.close();
    }
    expect(e.ledger.list().filter((x) => x.type === "machine.paired")).toHaveLength(1);
  });

  it("the showing side refuses a machine id that is not the presented key, without counting an attempt", async () => {
    const s = makeService();
    await s.link.load();
    const sPort = await s.link.enableLinking(owner, LINKING_ACK, 0);
    const shown = s.link.showCode();
    const { secret } = parsePairingCode(shown.code)!;
    const intruder = await LinkIdentity.load({ secrets: new MemorySecretStore(), onCreated: () => undefined });
    const { socket } = await LinkClient.connectUnpinned(intruder, `127.0.0.1:${sPort}`, 5_000);
    try {
      const ekm = (socket.exportKeyingMaterial as (n: number, l: string) => Buffer).call(socket, 32, PAIRING_LABEL);
      const reply = await LinkClient.postOnSocket(socket, `127.0.0.1:${sPort}`, "/link/v1/pair", {
        v: 1, machineId: "c".repeat(32), name: "Intruder", port: 4418,
        proof: pairingProof(secret, "theterminal-pair-v1", ekm, intruder.publicKeyDer),
      }, 5_000);
      expect(reply).toEqual({ status: 400, body: { error: "invalid_input" } });
    } finally {
      socket.destroy();
    }
    expect(s.link.pairingState()).toEqual({ open: true, attempts: 0 });
    expect(s.link.machines()).toEqual([]);
  });

  it("gives a failed multicast discovery another try when linking starts", async () => {
    let available = false;
    const calls: string[] = [];
    const discovery = {
      available: () => available,
      publish: () => calls.push("publish"),
      unpublish: () => calls.push("unpublish"),
      browse: (fn: (l: Discovered[]) => void) => {
        fn([]);
        return () => undefined;
      },
      destroy: () => {
        calls.push("destroy");
        available = true;
      },
    };
    const { link } = makeService({ discovery });
    await link.load();
    await link.enableLinking(owner, LINKING_ACK, 0);
    expect(calls).toEqual(["destroy", "publish"]);
  });
});
