import { createHash, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

export const TOKEN_COOKIE = "tt_token";

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
    const host = (request.headers.host ?? "").toLowerCase();
    const port = opts.port();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply.code(403).send({ error: "bad_host" });
    }

    const [path = "", query = ""] = request.url.split("?", 2);

    // Bootstrap: GET /?token= trades the token for an HttpOnly cookie. Honoured on "/" only,
    // so the token never has to appear in logs or referrers for any other path.
    if (request.method === "GET" && path === "/" && query !== "") {
      const given = new URLSearchParams(query).get("token");
      if (given !== null) {
        if (!tokenMatches(expected, given)) return reply.code(401).send({ error: "unauthorized" });
        return reply
          .setCookie(TOKEN_COOKIE, opts.token, { httpOnly: true, sameSite: "strict", path: "/" })
          .redirect("/", 302);
      }
    }

    if (path !== "/api" && !path.startsWith("/api/")) return;

    const auth = request.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const fromCookie = app.parseCookie(request.headers.cookie ?? "")[TOKEN_COOKIE];
    if (!tokenMatches(expected, bearer) && !tokenMatches(expected, fromCookie)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}
