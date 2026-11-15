import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerStaticUi } from "../../src/server/static-ui.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "tt-static-ui-"));
  dirs.push(root);
  const uiDir = join(root, "ui");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<html>ui</html>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "token"), "zq-TESTKEY-static-0000");
  const app = Fastify();
  apps.push(app);
  registerStaticUi(app, uiDir);
  // A stand-in API route: the page routes must never answer for it.
  app.get("/api/join/:code", async () => ({ api: true }));
  await app.ready();
  return app;
}

describe("registerStaticUi: the join and sign-in pages", () => {
  it("serves index.html for /join/<code> and /sign-in", async () => {
    const app = await setup();
    for (const url of ["/join/abc", "/join/AbC_-123", "/sign-in"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toContain("text/html");
      expect(res.body, url).toBe("<html>ui</html>");
    }
  });

  it("serves index.html for /join/<code> whatever the fragment would say (a fragment never reaches the server)", async () => {
    const app = await setup();
    const res = await app.inject({ method: "GET", url: "/join/abc?x=1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<html>ui</html>");
  });

  it("answers 404 for a join path that is not one plain code, and never serves a file from it", async () => {
    const app = await setup();
    for (const url of ["/join/../token", "/join/%2e%2e/token", "/join/a/b", "/join/", "/join/a%00b", "/join/..%2ftoken", `/join/${"a".repeat(201)}`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("TESTKEY");
      expect(res.body, url).not.toContain("<html>");
    }
  });

  it("leaves the API routes and the other files as they were", async () => {
    const app = await setup();
    expect((await app.inject({ method: "GET", url: "/api/join/abc" })).json()).toEqual({ api: true });
    expect((await app.inject({ method: "GET", url: "/assets/app.js" })).body).toBe("console.log(1)");
    expect((await app.inject({ method: "GET", url: "/" })).body).toBe("<html>ui</html>");
    expect((await app.inject({ method: "GET", url: "/sign-in/extra" })).statusCode).toBe(404);
  });

  it("serves every page and file with a strict content security policy, nosniff and no referrer", async () => {
    const app = await setup();
    const CSP =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    for (const url of ["/", "/sign-in", "/join/abc", "/assets/app.js"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-security-policy"], url).toBe(CSP);
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(res.headers["referrer-policy"], url).toBe("no-referrer");
    }
    // A refused path gets the same headers; the API routes are not this module's.
    const missing = await app.inject({ method: "GET", url: "/join/../token" });
    expect(missing.headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "GET", url: "/api/join/abc" })).headers["content-security-policy"]).toBeUndefined();
  });
});
