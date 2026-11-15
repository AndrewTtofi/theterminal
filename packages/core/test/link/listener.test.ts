import { afterEach, beforeAll, describe, expect, it } from "vitest";
import tls from "node:tls";
import { helloResponseSchema } from "@theterminal/shared";
import type { LinkIdentity } from "../../src/link/identity.js";
import { LinkListener, type ListenerDeps } from "../../src/link/listener.js";
import { registerLinkProtocolRoutes, type LinkProtocolDeps } from "../../src/link/protocol-routes.js";
import { holdPort, newIdentity, rawTlsGet, tcpAccepts } from "./helpers.js";

let server: LinkIdentity;
let paired: LinkIdentity;
let stranger: LinkIdentity;
beforeAll(async () => {
  [server, paired, stranger] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
});

const listeners: LinkListener[] = [];
afterEach(async () => {
  while (listeners.length) await listeners.pop()!.stop();
});

/** A listener that knows `paired` only, serving the hello route for a server named "Mac". */
function listener(over: Partial<ListenerDeps> = {}): LinkListener {
  const link = {
    self: () => ({ machineId: server.machineId, fingerprint: server.fingerprint, name: "Mac", linking: { enabled: true, port: null } }),
  } as unknown as LinkProtocolDeps["link"];
  const l = new LinkListener({
    identity: server,
    peer: (spki) => (spki.equals(paired.publicKeyDer) ? { machineId: paired.machineId } : null),
    pairingOpen: () => false,
    register: (app) => registerLinkProtocolRoutes(app, { link }),
    bind: "127.0.0.1",
    ...over,
  });
  listeners.push(l);
  return l;
}

describe("LinkListener", () => {
  it("answers hello to a paired machine's certificate", async () => {
    const l = listener();
    const port = await l.start(0);
    expect(l.port()).toBe(port);
    const reply = await rawTlsGet(port, "/link/v1/hello", paired);
    expect(reply.kind).toBe("reply");
    if (reply.kind !== "reply") return;
    expect(reply.status).toBe(200);
    const body = helloResponseSchema.parse(JSON.parse(reply.body));
    expect(body).toEqual({ v: 1, machineId: server.machineId, name: "Mac", linking: true });
  });

  // Review Focus 1: an unpaired machine on the LAN.
  it("destroys an unknown machine's connection before any reply while no pairing window is open", async () => {
    const port = await listener().start(0);
    const reply = await rawTlsGet(port, "/link/v1/hello", stranger);
    expect(reply.kind).toBe("closed");
  });

  it("answers an unknown machine 403 unknown_machine while a pairing window is open, on every route but pair", async () => {
    const port = await listener({ pairingOpen: () => true }).start(0);
    const reply = await rawTlsGet(port, "/link/v1/hello", stranger);
    expect(reply).toEqual({ kind: "reply", status: 403, body: JSON.stringify({ error: "unknown_machine" }) });
    const other = await rawTlsGet(port, "/link/v1/anything", stranger);
    expect(other).toEqual({ kind: "reply", status: 403, body: JSON.stringify({ error: "unknown_machine" }) });
  });

  it("refuses plain HTTP", async () => {
    const port = await listener().start(0);
    await expect(fetch(`http://127.0.0.1:${port}/link/v1/hello`)).rejects.toThrow();
  });

  it("destroys a TLS client that sends no certificate, even while a pairing window is open", async () => {
    const port = await listener().start(0);
    expect((await rawTlsGet(port, "/link/v1/hello", null)).kind).toBe("closed");
    const open = await listener({ pairingOpen: () => true }).start(0);
    expect((await rawTlsGet(open, "/link/v1/hello", null)).kind).toBe("closed");
  });

  it("refuses TLS 1.2", async () => {
    const port = await listener().start(0);
    const outcome = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: "127.0.0.1", port, ...paired.tls(), maxVersion: "TLSv1.2", rejectUnauthorized: false });
      s.once("secureConnect", () => {
        s.destroy();
        resolve("connected");
      });
      s.once("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("answers unknown paths 404 not_found without echoing them", async () => {
    const port = await listener().start(0);
    const reply = await rawTlsGet(port, "/api/health?x=TESTKEY", paired);
    expect(reply).toEqual({ kind: "reply", status: 404, body: JSON.stringify({ error: "not_found" }) });
  });

  it("moves to the next port when the first is taken, and stops answering after stop()", async () => {
    const held = await holdPort();
    try {
      const l = listener();
      const port = await l.start(held.port);
      expect(port).toBeGreaterThan(held.port);
      expect(port).toBeLessThanOrEqual(held.port + 20);
      expect(await tcpAccepts(port)).toBe(true);
      await l.stop();
      expect(l.port()).toBeNull();
      expect(await tcpAccepts(port)).toBe(false);
    } finally {
      await held.release();
    }
  });

  it("closes open connections on stop()", async () => {
    const l = listener();
    const port = await l.start(0);
    const socket = tls.connect({ host: "127.0.0.1", port, ...paired.tls(), rejectUnauthorized: false });
    socket.on("error", () => undefined);
    await new Promise<void>((r) => socket.once("secureConnect", () => r()));
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    await l.stop();
    await closed;
  });
});
