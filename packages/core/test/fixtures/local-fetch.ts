import http from "node:http";
import { APP_HOST } from "../../src/server/auth.js";

/**
 * `fetch` to the local listener as a browser on the workspace's own hostname sends it: the connection goes to
 * 127.0.0.1 and the Host header is `theterminal.localhost:<port>`, where alone a local session is honoured. Node's
 * fetch drops a Host header given to it, and Node on Windows does not resolve *.localhost, hence the raw request.
 * `url` names the loopback address and port; the body, when given, is a string.
 */
export function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  const headers: Record<string, string> = { host: `${APP_HOST}:${u.port}` };
  for (const [k, v] of new Headers(init.headers ?? {})) headers[k] = v;
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string") throw new TypeError("localFetch: the body must be a string");
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: u.port, method: init.method ?? "GET", path: `${u.pathname}${u.search}`, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
        }
        const empty = status === 204 || status === 205 || status === 304;
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: h }));
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
