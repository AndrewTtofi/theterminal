#!/usr/bin/env node
import https from "node:https";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The container's HEALTHCHECK: `node healthcheck.js [port]` asks the remote listener's `GET /healthz` over loopback
 * and exits 0 on `200 { ok: true }`, 1 otherwise, printing nothing. The certificate is not verified: the request
 * never leaves the container, and a self-signed or not-yet-issued certificate must not read as unhealthy.
 * `/healthz` is exempt from the remote Host rule, so this works when the server has a `--remote-domain` too.
 */

const DEFAULT_PORT = 4318;
const TIMEOUT_MS = 4000;
/** `/healthz` answers `{"ok":true}`; anything longer is not it. */
const MAX_BODY = 1024;

/** The `/healthz` URL on loopback, for the given port (the default when it is not one). */
export function healthzUrl(port?: string): string {
  const n = Number(port);
  const p = port !== undefined && Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
  return `https://127.0.0.1:${p}/healthz`;
}

/** Whether `url` answers 200 with exactly `{ ok: true }` within `timeoutMs`. Never throws. */
export function healthy(url: string, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(ok);
    };
    const req = https.get(url, { rejectUnauthorized: false, headers: { accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY) finish(false);
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body) as unknown;
          finish(res.statusCode === 200 && (parsed as { ok?: unknown } | null)?.ok === true);
        } catch {
          finish(false);
        }
      });
      res.on("error", () => finish(false));
    });
    req.on("error", () => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit((await healthy(healthzUrl(process.argv[2]))) ? 0 : 1);
}
