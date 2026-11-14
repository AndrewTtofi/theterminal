import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../../src/agents/jsonrpc.js";

function make(opts: Partial<ConstructorParameters<typeof JsonRpcPeer>[1]> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: any[] = [];
  let buf = "";
  output.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      sent.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const notes: Array<[string, unknown]> = [];
  const peer = new JsonRpcPeer(
    { input, output },
    {
      onRequest: async () => "ok",
      onNotification: (m, p) => notes.push([m, p]),
      ...opts,
    },
  );
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { input, output, sent, notes, peer, tick };
}
const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("JsonRpcPeer", () => {
  it("round trips a request", async () => {
    const { input, sent, peer, tick } = make();
    const p = peer.request("ping", { a: 1 });
    await tick();
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } });
    input.write(line({ jsonrpc: "2.0", id: 1, result: { pong: true } }));
    await expect(p).resolves.toEqual({ pong: true });
  });

  it("rejects on an error response", async () => {
    const { input, peer, tick } = make();
    const p = peer.request("x");
    await tick();
    input.write(line({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "nope" } }));
    await expect(p).rejects.toThrow(/nope/);
  });

  it("answers server requests via onRequest", async () => {
    const { input, sent, tick } = make({ onRequest: async (m, p) => ({ m, p }) });
    input.write(line({ jsonrpc: "2.0", id: "s1", method: "fs/read", params: [1] }));
    await tick();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: "s1", result: { m: "fs/read", p: [1] } });
  });

  it("sends result null when onRequest returns undefined", async () => {
    const { input, sent, tick } = make({ onRequest: async () => undefined });
    input.write(line({ jsonrpc: "2.0", id: 5, method: "m" }));
    await tick();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 5, result: null });
  });

  it("never leaks onRequest error text", async () => {
    const { input, sent, tick } = make({
      onRequest: async () => {
        throw new Error("secret /home/alice/key");
      },
    });
    input.write(line({ jsonrpc: "2.0", id: 2, method: "m" }));
    await tick();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "denied" } });
  });

  it("delivers notifications", async () => {
    const { input, notes, tick } = make();
    input.write(line({ jsonrpc: "2.0", method: "note", params: { z: 1 } }));
    await tick();
    expect(notes).toEqual([["note", { z: 1 }]]);
  });

  it("handles CRLF and multi-byte UTF-8 split across chunks", async () => {
    const { input, notes, tick } = make();
    const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "n", params: "héllo €" }) + "\r\n");
    const cut = buf.indexOf(0xe2) + 1; // split inside the euro sign
    input.write(buf.subarray(0, cut));
    input.write(buf.subarray(cut));
    await tick();
    expect(notes).toEqual([["n", "héllo €"]]);
  });

  it("closes on invalid JSON and rejects pending", async () => {
    const { input, peer, tick } = make();
    const p = peer.request("x");
    const assertion = expect(p).rejects.toThrow("rpc closed: protocol error");
    await tick();
    input.write("{not json\n");
    await expect(peer.closed).resolves.toBe("protocol error");
    await assertion;
  });

  it("closes on a wrong jsonrpc version", async () => {
    const { input, peer } = make();
    input.write(line({ jsonrpc: "1.0", method: "n" }));
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("closes on a missing jsonrpc version by default", async () => {
    const { input, peer } = make();
    input.write(line({ method: "n" }));
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("accepts messages without a jsonrpc version when allowed, but still rejects a wrong one", async () => {
    const { input, notes, peer, tick } = make({ allowMissingVersion: true });
    const p = peer.request("ping");
    input.write(line({ id: 1, result: "pong" }));
    await expect(p).resolves.toBe("pong");
    input.write(line({ method: "n", params: 1 }));
    await tick();
    expect(notes).toEqual([["n", 1]]);
    input.write(line({ jsonrpc: "1.0", method: "n" }));
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("closes on a response to an unknown id", async () => {
    const { input, peer } = make();
    input.write(line({ jsonrpc: "2.0", id: 99, result: 1 }));
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("closes on an oversize line without waiting for a newline", async () => {
    const { input, peer } = make({ maxLineBytes: 1024 });
    input.write("a".repeat(2000)); // no newline
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("closes on a 9 MiB line streamed in chunks", async () => {
    const { input, peer } = make();
    const chunk = "a".repeat(64 * 1024);
    for (let i = 0; i < 144 && !input.destroyed; i++) input.write(chunk);
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("closes on a 100-request flood", async () => {
    const { input, peer } = make({ onRequest: () => new Promise(() => {}) });
    for (let i = 0; i < 100; i++) input.write(line({ jsonrpc: "2.0", id: i, method: "m" }));
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("allows exactly 64 requests in flight", async () => {
    const { input, peer, tick } = make({ onRequest: () => new Promise(() => {}) });
    for (let i = 0; i < 64; i++) input.write(line({ jsonrpc: "2.0", id: i, method: "m" }));
    await tick();
    let closed = false;
    void peer.closed.then(() => (closed = true));
    await tick();
    expect(closed).toBe(false);
    peer.close("done");
  });

  it("closes with eof on input end", async () => {
    const { input, peer } = make();
    const p = peer.request("x");
    const assertion = expect(p).rejects.toThrow("rpc closed: eof");
    input.end();
    await expect(peer.closed).resolves.toBe("eof");
    await assertion;
  });

  it("closes with output error", async () => {
    const { output, peer } = make();
    output.destroy(new Error("boom"));
    await expect(peer.closed).resolves.toBe("output error");
  });

  it("close is idempotent; later requests reject and writes are ignored", async () => {
    const { sent, peer, tick } = make();
    peer.close("first");
    peer.close("second");
    await expect(peer.closed).resolves.toBe("first");
    await expect(peer.request("x")).rejects.toThrow("rpc closed: first");
    peer.notify("n");
    await tick();
    expect(sent).toEqual([]);
  });

  it("times out one request without closing the peer", async () => {
    const { input, peer, tick } = make({ requestTimeoutMs: 20 });
    await expect(peer.request("slow")).rejects.toThrow(/timed out/);
    // a late response for the timed-out id is tolerated, not a protocol error
    input.write(line({ jsonrpc: "2.0", id: 1, result: 1 }));
    await tick();
    const p = peer.request("again");
    await tick();
    input.write(line({ jsonrpc: "2.0", id: 2, result: "fine" }));
    await expect(p).resolves.toBe("fine");
    peer.close("done");
  });
  it("closes when the output never drains and buffered bytes pass the cap", async () => {
    const input = new PassThrough();
    const output = new Writable({ highWaterMark: 1024, write() {} }); // never calls back
    const peer = new JsonRpcPeer(
      { input, output },
      {
        onRequest: async () => "x".repeat(100 * 1024),
        onNotification: () => {},
        maxOutputBufferBytes: 1024 * 1024,
      },
    );
    for (let i = 0; i < 2000 && !input.destroyed; i++) {
      input.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: "m" }) + "\n");
      await new Promise((r) => setImmediate(r));
    }
    await expect(peer.closed).resolves.toBe("output error");
    expect(output.writableLength).toBeLessThan(2 * 1024 * 1024);
  });

  it("closes with protocol error when onNotification throws", async () => {
    const { input, peer } = make({
      onNotification: () => {
        throw new Error("boom");
      },
    });
    input.write(line({ jsonrpc: "2.0", method: "n" }));
    await expect(peer.closed).resolves.toBe("protocol error");
  });

  it("builds a line to the cap in small chunks quickly", async () => {
    const { input, peer } = make({ maxLineBytes: 4 * 1024 * 1024 });
    const chunk = "a".repeat(256);
    const t = Date.now();
    for (let i = 0; i < 16385 && !input.destroyed; i++) input.write(chunk);
    await expect(peer.closed).resolves.toBe("protocol error");
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("closes and rejects pending when the output is destroyed without an error", async () => {
    const { output, peer, tick } = make();
    const p = peer.request("x");
    const assertion = expect(p).rejects.toThrow("rpc closed: output error");
    await tick();
    output.destroy();
    await expect(peer.closed).resolves.toBe("output error");
    await assertion;
  });

  it("truncates peer-controlled error text", async () => {
    const { input, peer, tick } = make();
    const p = peer.request("x");
    await tick();
    input.write(line({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "e".repeat(5000) } }));
    const err = await p.catch((e) => e as Error);
    expect(err.message.length).toBeLessThan(600);
    peer.close("done");
  });
});
