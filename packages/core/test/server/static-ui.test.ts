import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { UI_CSP, previewCsp, registerStaticUi, serveIndex } from "../../src/server/static-ui.js";

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

  it("never serves database files or their companions, dotfiles, the token or the secrets file, even from inside uiDir", async () => {
    const app = await setup();
    const names = ["ledger.db", "ledger.db-wal", "ledger.db-shm", "ledger.db-journal", "LEDGER.DB-JOURNAL", "x.DB", "token", "TOKEN", "secrets.enc.json", ".env"];
    for (const name of names) writeFileSync(join(apps.length ? dirs[dirs.length - 1]! : "", "ui", name), "secret");
    for (const name of names) {
      const res = await app.inject({ method: "GET", url: `/${name}` });
      expect(res.statusCode, name).toBe(404);
      expect(res.body, name).not.toContain("secret");
    }
    expect((await app.inject({ method: "GET", url: "/assets/app.js" })).statusCode).toBe(200);
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

describe("registerStaticUi: the favicon", () => {
  it("serves the UI's favicon.svg as SVG, without sign-in, under the CSP that lets the page show it", async () => {
    const app = await setup();
    // The real favicon, as the UI build copies it from public/ to the root of the served directory.
    const favicon = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "apps", "ui", "public", "favicon.svg");
    copyFileSync(favicon, join(dirs[dirs.length - 1]!, "ui", "favicon.svg"));
    const res = await app.inject({ method: "GET", url: "/favicon.svg" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toMatch(/^<svg /);
    // The page links it from this origin, which img-src 'self' allows.
    expect(String(res.headers["content-security-policy"])).toContain("img-src 'self'");
  });
});

describe("the preview page's policy (Ruling 23)", () => {
  it("is UI_CSP with frame-ancestors 'self' and frame-src for exactly the preview's origin", () => {
    const csp = previewCsp("http://127.0.0.1:5173");
    expect(csp).toBe(UI_CSP.replace("frame-ancestors 'none'", "frame-src http://127.0.0.1:5173; frame-ancestors 'self'"));
    expect(previewCsp("http://[::1]:3000")).toContain("frame-src http://[::1]:3000;");
  });

  it("refuses anything but a loopback http origin with a port", () => {
    for (const bad of ["https://127.0.0.1:5173", "http://example.com:80", "http://127.0.0.1", "http://127.0.0.1:5173; script-src *", "*", "http://127.0.0.1:70000"]) {
      expect(() => previewCsp(bad), bad).toThrow();
    }
  });

  it("serveIndex serves index.html under the given policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-static-ui-"));
    dirs.push(root);
    writeFileSync(join(root, "index.html"), "<html>ui</html>");
    const app = Fastify();
    apps.push(app);
    app.get("/p", (_req, reply) => serveIndex(reply, previewCsp("http://127.0.0.1:5173"), root));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/p" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<html>ui</html>");
    expect(res.headers["content-security-policy"]).toBe(previewCsp("http://127.0.0.1:5173"));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
