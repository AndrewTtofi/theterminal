import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { LinkIdentity } from "../../src/link/identity.js";
import { LinkListener } from "../../src/link/listener.js";
import {
  LinkClient, LinkProtocolError, MachineKeyMismatchError, MachineUnreachableError, RemoteRefusedError, type Peer,
} from "../../src/link/client.js";
import { holdPort, newIdentity, tlsServer } from "./helpers.js";

let server: LinkIdentity;
let me: LinkIdentity;
let other: LinkIdentity;
beforeAll(async () => {
  [server, me, other] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const counter = { json: 0, uploaded: -1 };

function routes(app: FastifyInstance): void {
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => {
    let n = 0;
    payload.on("data", (c: Buffer) => (n += c.length));
    payload.on("end", () => done(null, n));
    payload.on("error", (e) => done(e));
  });
  app.post("/t/json", async (req) => {
    counter.json++;
    return { echo: (req.body as { x: number }).x, peer: req.linkPeer?.machineId };
  });
  app.get("/t/json", async () => {
    counter.json++;
    return { echo: 1 };
  });
  app.get("/t/stream", (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
    reply.raw.write('{"n":1}\n{"n":');
    setTimeout(() => {
      reply.raw.write('2}\n{"n":3}\n');
      reply.raw.end();
    }, 20);
  });
  app.get("/t/cut", (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
    reply.raw.write('{"n":1}\n');
    setTimeout(() => reply.raw.socket?.destroy(), 20);
  });
  app.get("/t/big", (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/octet-stream" });
    reply.raw.write(Buffer.alloc(800, 1));
    reply.raw.write(Buffer.alloc(800, 2));
    reply.raw.end();
  });
  app.get("/t/declared", async (_req, reply) => reply.type("application/octet-stream").send(Buffer.alloc(2000, 3)));
  app.get("/t/small", async (_req, reply) => reply.type("application/octet-stream").send(Buffer.from("bundle bytes")));
  app.post("/t/upload", async (req) => {
    counter.uploaded = req.body as number;
    return { ok: true };
  });
  app.get("/t/huge-json", async () => ({ pad: "x".repeat(1_100_000) }));
}

async function startListener(): Promise<number> {
  const l = new LinkListener({
    identity: server,
    peer: (spki) => (spki.equals(me.publicKeyDer) ? { machineId: me.machineId } : null),
    pairingOpen: () => false,
    register: routes,
    bind: "127.0.0.1",
  });
  const port = await l.start(0);
  cleanups.push(() => l.stop());
  return port;
}

const peerAt = (port: number, key = server.publicKeyDer): Peer => ({ machineId: server.machineId, address: `127.0.0.1:${port}`, publicKeyDer: key });
const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "tt-link-")), name);

describe("LinkClient.request", () => {
  it("sends JSON to the pinned machine and parses the reply with the schema", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    const body = await client.request(peerAt(port), "POST", "/t/json", { x: 41 }, z.object({ echo: z.number(), peer: z.string() }));
    expect(body).toEqual({ echo: 41, peer: me.machineId });
  });

  it("refuses a server whose key is not the pinned one before sending anything", async () => {
    const port = await startListener();
    const before = counter.json;
    const client = new LinkClient({ identity: me });
    await expect(client.request(peerAt(port, other.publicKeyDer), "POST", "/t/json", { x: 1 })).rejects.toBeInstanceOf(MachineKeyMismatchError);
    await expect(client.request(peerAt(port, other.publicKeyDer), "GET", "/t/json")).rejects.toThrow(
      "the machine's key does not match the one paired",
    );
    expect(counter.json).toBe(before);
  });

  it("reports a closed port as unreachable, with the machine id", async () => {
    const held = await holdPort();
    await held.release(); // now nothing listens there
    const client = new LinkClient({ identity: me });
    const err = await client.request(peerAt(held.port), "GET", "/t/json").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MachineUnreachableError);
    expect((err as MachineUnreachableError).machineId).toBe(server.machineId);
    expect((err as Error).message).toBe("machine unreachable");
  });

  it("reports a server that never answers as unreachable after the timeout", async () => {
    const silent = await tlsServer(server, () => undefined);
    cleanups.push(silent.close);
    const client = new LinkClient({ identity: me, timeoutMs: 300 });
    await expect(client.request(peerAt(silent.port), "GET", "/t/json")).rejects.toBeInstanceOf(MachineUnreachableError);
  });

  it("turns a non-2xx JSON reply into RemoteRefusedError with its status and code", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    const err = await client.request(peerAt(port), "GET", "/t/nothing-here").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteRefusedError);
    expect((err as RemoteRefusedError).status).toBe(404);
    expect((err as RemoteRefusedError).code).toBe("not_found");
  });

  it("refuses a JSON reply over 1 MiB and a reply the schema rejects", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    await expect(client.request(peerAt(port), "GET", "/t/huge-json")).rejects.toBeInstanceOf(LinkProtocolError);
    await expect(client.request(peerAt(port), "GET", "/t/json", undefined, z.object({ echo: z.string() }))).rejects.toBeInstanceOf(LinkProtocolError);
  });

  it("refuses an address that is not host:port", async () => {
    const client = new LinkClient({ identity: me });
    await expect(client.request({ ...peerAt(1), address: "https://example.test/x" }, "GET", "/t/json")).rejects.toThrow();
  });
});

describe("LinkClient.stream", () => {
  it("delivers NDJSON lines in order and resolves when the server ends", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    const lines: string[] = [];
    await client.stream(peerAt(port), "/t/stream", async (line) => {
      await new Promise((r) => setTimeout(r, 5));
      lines.push(line);
    }, new AbortController().signal);
    expect(lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it("rejects with MachineUnreachableError when the server cuts the stream", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    const lines: string[] = [];
    await expect(client.stream(peerAt(port), "/t/cut", async (l) => void lines.push(l), new AbortController().signal)).rejects.toBeInstanceOf(
      MachineUnreachableError,
    );
    expect(lines).toEqual(['{"n":1}']);
  });

  it("refuses a stream from a server whose key is not the pinned one", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    await expect(client.stream(peerAt(port, other.publicKeyDer), "/t/stream", async () => undefined, new AbortController().signal)).rejects.toBeInstanceOf(
      MachineKeyMismatchError,
    );
  });

  it("resolves when the caller aborts", async () => {
    const silent = await startListener();
    const client = new LinkClient({ identity: me });
    const abort = new AbortController();
    const done = client.stream(peerAt(silent), "/t/cut", async () => abort.abort(), abort.signal);
    await expect(done).resolves.toBeUndefined();
  });
});

describe("LinkClient.upload and download", () => {
  it("downloads a file within the limit", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    const file = tmpFile("in.bundle");
    await client.download(peerAt(port), "/t/small", file, 1000);
    expect(readFileSync(file, "utf8")).toBe("bundle bytes");
  });

  it("aborts a download past maxBytes with 413 too_large and removes the partial file", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    for (const path of ["/t/big", "/t/declared"]) {
      const file = tmpFile("in.bundle");
      const err = await client.download(peerAt(port), path, file, 1000).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteRefusedError);
      expect((err as RemoteRefusedError).status).toBe(413);
      expect((err as RemoteRefusedError).code).toBe("too_large");
      expect(existsSync(file)).toBe(false);
    }
  });

  it("uploads a file as application/octet-stream, and refuses one over maxBytes before connecting", async () => {
    const port = await startListener();
    const client = new LinkClient({ identity: me });
    const file = tmpFile("out.bundle");
    writeFileSync(file, Buffer.alloc(1234, 7));
    await client.upload(peerAt(port), "/t/upload", file, 2000);
    expect(counter.uploaded).toBe(1234);
    const err = await client.upload(peerAt(port), "/t/upload", file, 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteRefusedError);
    expect((err as RemoteRefusedError).status).toBe(413);
  });
});

describe("LinkClient.connectUnpinned", () => {
  it("returns the server's SPKI over an open TLS 1.3 socket", async () => {
    const port = await startListener();
    const { socket, peerSpki } = await LinkClient.connectUnpinned(me, `127.0.0.1:${port}`, 3000);
    try {
      expect(peerSpki.equals(server.publicKeyDer)).toBe(true);
      expect(socket.getProtocol()).toBe("TLSv1.3");
    } finally {
      socket.destroy();
    }
  });

  it("reports a closed port as unreachable", async () => {
    const held = await holdPort();
    await held.release();
    await expect(LinkClient.connectUnpinned(me, `127.0.0.1:${held.port}`, 3000)).rejects.toBeInstanceOf(MachineUnreachableError);
  });
});
