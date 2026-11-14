import { createHash, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

export const TOKEN_COOKIE = "tt_token";
/**
 * The workspace's own hostname. Browsers do not separate cookies by port, so the session cookie
 * lives on this host-only name and is never sent to other local servers on 127.0.0.1 or localhost.
 */
export const APP_HOST = "theterminal.localhost";
/** Route config marking a route as reachable without a token: `{ config: PUBLIC_ROUTE }`. */
export const PUBLIC_ROUTE = { public: true } as const;
type PublicConfig = { public?: boolean };

const digest = (s: string) => createHash("sha256").update(s).digest();

function tokenMatches(expected: Buffer, given: unknown): boolean {
  return typeof given === "string" && timingSafeEqual(expected, digest(given));
}

/**
 * Local security guard: stops other websites (CSRF, DNS rebinding) and other local apps from
 * reaching the workspace. The Host check applies to every request; the token check to /api/*.
 */
export function registerAuth(app: FastifyInstance, opts: { token: string; port: () => number }): void {
  const expected = digest(opts.token);
  app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    // Rejections on a WebSocket upgrade must also drop the socket, or it stays open forever.
    const reject = (code: number, error: string) => {
      if (request.headers.upgrade) {
        reply.header("connection", "close");
        reply.raw.once("finish", () => request.raw.socket.destroy());
      }
      return reply.code(code).send({ error });
    };

    const port = opts.port();
    const host = (request.headers.host ?? "").toLowerCase();
    const appHost = `${APP_HOST}:${port}`;
    if (host !== appHost && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reject(403, "bad_host");
    }

    // Default-deny, keyed on the matched route (find-my-way matches the decoded path, so the raw
    // URL cannot be trusted). Only routes registered with config.public skip the token.
    const routeUrl = request.routeOptions.url;
    const isPublic = routeUrl !== undefined && (request.routeOptions.config as PublicConfig | undefined)?.public === true;

    // Bootstrap: GET /?token= trades the token for an HttpOnly cookie. Honoured on "/" only,
    // so the token never has to appear in logs or referrers for any other path.
    if (request.method === "GET" && routeUrl === "/") {
      const given = new URL(request.url, "http://localhost").searchParams.get("token");
      if (given !== null) {
        if (!tokenMatches(expected, given)) return reject(401, "unauthorized");
        // Only the app hostname may receive the cookie; loopback hosts are bounced there.
        if (host !== appHost) return reply.redirect(`http://${appHost}/?token=${encodeURIComponent(given)}`, 302);
        return reply
          .setCookie(TOKEN_COOKIE, opts.token, { httpOnly: true, sameSite: "strict", path: "/" })
          .redirect("/", 302);
      }
    }

    if (isPublic) return;

    // SameSite ignores ports, so a page on another loopback port would carry our cookie.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const o = origin.toLowerCase();
      if (o !== `http://${appHost}` && o !== `http://127.0.0.1:${port}` && o !== `http://localhost:${port}`) {
        return reject(403, "bad_origin");
      }
    }

    const auth = request.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const fromCookie = app.parseCookie(request.headers.cookie ?? "")[TOKEN_COOKIE];
    if (!tokenMatches(expected, bearer) && !tokenMatches(expected, fromCookie)) {
      return reject(401, "unauthorized");
    }
  });
}
