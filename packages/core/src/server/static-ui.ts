import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { PUBLIC_ROUTE } from "./auth.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Defence in depth: never serve dotfiles/dot-dirs, token files or SQLite files, even from inside uiDir. */
function isDenied(relPath: string): boolean {
  const parts = relPath.split(sep);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  return parts.some((p) => p.startsWith(".")) || name === "token" || /\.db(-wal|-shm)?$/.test(name);
}

/**
 * Serves the built UI. "/" is its own explicit public route so the ?token= bootstrap in auth can
 * match it; every other file goes through a public wildcard that cannot leave uiDir.
 */
export function registerStaticUi(app: FastifyInstance, uiDir: string): void {
  const root = realpathSync(resolve(uiDir));

  const serve = (rel: string, reply: import("fastify").FastifyReply) => {
    if (rel.includes("\0")) return reply.code(404).send({ error: "not_found" });
    let file: string;
    try {
      file = realpathSync(resolve(root, rel)); // resolves symlinks too
      if (file !== root && !file.startsWith(root + sep)) throw new Error("outside");
      if (isDenied(file.slice(root.length + 1))) throw new Error("denied");
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.type(TYPES[extname(file).toLowerCase()] ?? "application/octet-stream").send(createReadStream(file));
  };

  app.get("/", { config: PUBLIC_ROUTE }, (_req, reply) => serve("index.html", reply));
  app.get("/*", { config: PUBLIC_ROUTE }, (req, reply) => serve((req.params as { "*": string })["*"], reply));
}
