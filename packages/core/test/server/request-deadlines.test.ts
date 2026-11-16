import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { installRequestDeadlines, isStreamedUpload } from "../../src/server/request-deadlines.js";

// Short limits so the tests run in well under a second each: the whole request within 300 ms, and a streamed upload
// cut off after 300 ms without a byte (checked every 50 ms).
const LIMITS = { wholeMs: 300, idleMs: 300, checkMs: 50 };

let server: http.Server | null = null;
afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A server whose handler reads the whole body and answers with its length. */
async function start(): Promise<number> {
  const s = http.createServer({ requestTimeout: 0 });
  installRequestDeadlines(s, LIMITS);
  s.on("request", (req, res) => {
    let n = 0;
    req.on("data", (c: Buffer) => (n += c.length));
    req.on("end", () => res.end(String(n)));
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as AddressInfo).port;
}

/**
 * Sends the request head, then one byte every `everyMs` until `bytes` are sent (or the socket closes). Resolves with
 * the first response line, or "closed" when the server closed the connection without an answer.
 */
function trickle(port: number, head: string, bytes: number, everyMs: number): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    let answer = "";
    let timer: NodeJS.Timeout | undefined;
    c.on("connect", () => {
      c.write(`${head}\r\nhost: 127.0.0.1\r\nconnection: close\r\ncontent-length: ${bytes}\r\n\r\n`);
      let sent = 0;
      timer = setInterval(() => {
        if (sent >= bytes || c.destroyed) return clearInterval(timer);
        c.write("a");
        sent += 1;
      }, everyMs);
    });
    c.on("data", (d) => (answer += String(d)));
    c.on("error", () => undefined);
    c.on("close", () => {
      clearInterval(timer);
      resolve(answer === "" ? "closed" : answer.split("\r\n")[0]!);
    });
    c.on("end", () => c.end());
  });
}

describe("isStreamedUpload", () => {
  it("is the PUT of one upload file, with or without its query", () => {
    expect(isStreamedUpload("PUT", "/api/uploads/u1/file?path=a.txt")).toBe(true);
    expect(isStreamedUpload("PUT", "/api/uploads/u1/file")).toBe(true);
    expect(isStreamedUpload("POST", "/api/uploads/u1/file")).toBe(false);
    expect(isStreamedUpload("PUT", "/api/uploads/u1/commit")).toBe(false);
    expect(isStreamedUpload("PUT", "/api/uploads/u1/file/x")).toBe(false);
    expect(isStreamedUpload("PUT", "/api/uploads//file")).toBe(false);
    expect(isStreamedUpload("PUT", "/x/api/uploads/u1/file")).toBe(false);
    expect(isStreamedUpload(undefined, undefined)).toBe(false);
  });
});

describe("installRequestDeadlines", () => {
  it("cuts off any other request whose body is still arriving after the whole-request limit", async () => {
    const port = await start();
    // 20 bytes, one every 40 ms: about 800 ms, well past the 300 ms limit, though never idle.
    expect(await trickle(port, "POST /api/anything HTTP/1.1", 20, 40)).toBe("closed");
  });

  it("leaves a quick request alone", async () => {
    const port = await start();
    expect(await trickle(port, "POST /api/anything HTTP/1.1", 3, 10)).toBe("HTTP/1.1 200 OK");
  });

  it("lets a streamed upload run past the whole-request limit while bytes keep arriving", async () => {
    const port = await start();
    expect(await trickle(port, "PUT /api/uploads/u1/file?path=a.txt HTTP/1.1", 20, 40)).toBe("HTTP/1.1 200 OK");
  });

  it("cuts off a streamed upload after the idle limit without a byte", async () => {
    const port = await start();
    // One byte every 600 ms: the gap is twice the idle limit.
    const started = Date.now();
    expect(await trickle(port, "PUT /api/uploads/u1/file?path=a.txt HTTP/1.1", 5, 600)).toBe("closed");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
