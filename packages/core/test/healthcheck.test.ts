import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { healthy, healthzUrl } from "../src/healthcheck.js";
import { selfSignedTlsCertificate } from "../src/server/certs.js";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "healthcheck.js");

const servers: https.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A loopback HTTPS server with a self-signed certificate that answers every request with `body`. */
async function serve(body: string | null, status = 200): Promise<number> {
  const { certPem, keyPem } = await selfSignedTlsCertificate({ hostnames: ["tt-test.local"], addresses: ["127.0.0.1"] });
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    if (body === null) return; // never answers
    res.writeHead(status, { "content-type": "application/json" }).end(req.url === "/healthz" ? body : "{}");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

describe("the container health check", () => {
  it("asks https://127.0.0.1:4318/healthz by default, or the port it is given", () => {
    expect(healthzUrl()).toBe("https://127.0.0.1:4318/healthz");
    expect(healthzUrl("8443")).toBe("https://127.0.0.1:8443/healthz");
    expect(healthzUrl("not a port")).toBe("https://127.0.0.1:4318/healthz");
  });

  it("is healthy only on 200 { ok: true }, over a self-signed certificate", async () => {
    expect(await healthy(healthzUrl(String(await serve('{"ok":true}'))))).toBe(true);
    expect(await healthy(healthzUrl(String(await serve('{"ok":false}'))))).toBe(false);
    expect(await healthy(healthzUrl(String(await serve('{"ok":true}', 503))))).toBe(false);
    expect(await healthy(healthzUrl(String(await serve("not json"))))).toBe(false);
  });

  it("is unhealthy when nothing listens or the server does not answer in time", async () => {
    const closed = await serve("{}");
    await new Promise((r) => servers.pop()!.close(r));
    expect(await healthy(healthzUrl(String(closed)))).toBe(false);
    expect(await healthy(healthzUrl(String(await serve(null))), 200)).toBe(false);
  });

  it("the built script exits 0 when healthy and 1 otherwise, and prints nothing", { timeout: 20_000 }, async () => {
    const run = (port: number) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [CHECK, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("exit", (code) => resolve({ code, out }));
      });
    expect(await run(await serve('{"ok":true}'))).toEqual({ code: 0, out: "" });
    expect(await run(await serve('{"ok":false}'))).toEqual({ code: 1, out: "" });
  });
});
