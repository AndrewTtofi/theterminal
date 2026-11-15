import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { LINKING_ACK } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import type { SecretStore } from "../../src/secrets/store.js";
import { HumanRequiredError } from "../../src/intake/service.js";
import { SecretInTextError } from "../../src/intake/recorded-text.js";
import { NotFoundError } from "../../src/board/board-service.js";
import { LinkListener } from "../../src/link/listener.js";
import { LinkClient } from "../../src/link/client.js";
import { IdentityUnavailableError, LinkService } from "../../src/link/service.js";
import { registerLinkProtocolRoutes } from "../../src/link/protocol-routes.js";
import { holdPort, rawTlsGet, tcpAccepts } from "./helpers.js";
import { LinkIdentity } from "../../src/link/identity.js";

const owner = { kind: "human", id: "owner" } as const;

const services: LinkService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.shutdown();
});

function makeService(o: { db?: Db; secrets?: SecretStore; platform?: NodeJS.Platform } = {}) {
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
    bind: "127.0.0.1",
    ...(o.platform && { platform: o.platform }),
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
      db, ledger, secrets: new MemorySecretStore(), bind: "127.0.0.1",
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
        db, ledger: new Ledger(db), secrets, bind: "127.0.0.1",
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
