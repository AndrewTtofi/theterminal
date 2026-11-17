import { closeSync, constants, createReadStream, fstatSync, openSync, realpathSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
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

/** Defence in depth: never serve dotfiles/dot-dirs, token files, the encrypted secrets or SQLite files, even from inside uiDir. */
function isDenied(relPath: string): boolean {
  const parts = relPath.split(sep);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  return parts.some((p) => p.startsWith(".")) || name === "token" || name === "secrets.enc.json" || /\.db(-wal|-shm|-journal)?$/.test(name);
}

/** The file as given and as resolved through links, for an exact comparison with a served file's real path. */
function forms(p: string): string[] {
  const lexical = resolve(p);
  try {
    return [lexical, realpathSync(lexical)];
  } catch {
    return [lexical];
  }
}

/**
 * The page's content security policy: scripts, styles, images and connections from this origin only (the event stream
 * is same-origin too), inline style attributes allowed (React and the docking library set them), never framed, no
 * <base>, and forms post here only. The built UI has no inline script and no eval.
 */
export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** A preview's recorded origin: plain http on a loopback address with a port (the `preview.ready` schema's shape). */
const PREVIEW_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/;

/**
 * The `/preview/:id` page's policy (plan 12 Ruling 23): UI_CSP changed in exactly two places, framed by the app's own
 * pages (`frame-ancestors 'self'`) and framing exactly the preview's origin (`frame-src <origin>`). Anything but a
 * loopback http origin with a port is refused (TypeError), so nothing else can be written into the policy.
 */
export function previewCsp(origin: string): string {
  const m = PREVIEW_ORIGIN.exec(origin);
  if (m === null || Number(m[1]) > 65_535) throw new TypeError("not a preview origin");
  return UI_CSP.replace("frame-ancestors 'none'", `frame-src ${origin}; frame-ancestors 'self'`);
}

function secure(reply: FastifyReply, csp: string = UI_CSP): FastifyReply {
  return reply
    .header("content-security-policy", csp)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer");
}

/**
 * Sends the UI's `index.html` from `uiDir` under the policy `csp`, with the page's other headers; 404 when it cannot be
 * read as a regular file. The page routes use UI_CSP; the preview page its own (previewCsp).
 */
export function serveIndex(reply: FastifyReply, csp: string, uiDir: string): FastifyReply {
  secure(reply, csp);
  let file: string;
  let fd: number;
  try {
    const root = realpathSync(resolve(uiDir));
    file = realpathSync(resolve(root, "index.html"));
    if (!file.startsWith(root + sep)) throw new Error("outside");
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return reply.code(404).send({ error: "not_found" });
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a file");
  } catch {
    closeSync(fd);
    return reply.code(404).send({ error: "not_found" });
  }
  return reply.type(TYPES[".html"]!).send(createReadStream(file, { fd }));
}

/** An invite code as the join page's path carries it: one plain segment, nothing a file path could use. */
const JOIN_CODE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Serves the built UI. "/" is its own explicit public route so the ?token= bootstrap in auth can
 * match it; every other file goes through a public wildcard that cannot leave uiDir. The join page
 * (`/join/<code>`) and the sign-in page (`/sign-in`) are the same single-page app: both serve the fixed
 * index.html and nothing else, so neither can reach a file or an API route.
 */
export function registerStaticUi(app: FastifyInstance, uiDir: string, opts: { deny?: string[] } = {}): void {
  const root = realpathSync(resolve(uiDir));
  // Files that must never be served whatever their name: the secret store's key file, wherever the CLI put it.
  const deniedFiles = new Set((opts.deny ?? []).flatMap(forms));

  const serve = (rel: string, reply: FastifyReply) => {
    secure(reply);
    if (rel.includes("\0")) return reply.code(404).send({ error: "not_found" });
    let file: string;
    let fd: number;
    try {
      file = realpathSync(resolve(root, rel)); // resolves symlinks too
      if (file !== root && !file.startsWith(root + sep)) throw new Error("outside");
      if (deniedFiles.has(file) || isDenied(file.slice(root.length + 1))) throw new Error("denied");
      // Open first, then judge what was opened: a swap between a check and the open cannot change what is served.
      // O_NONBLOCK and O_NOFOLLOW are POSIX-only (undefined on Windows): a FIFO must not block the open, nor a link
      // placed after the realpath be followed.
      fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error("not a file");
    } catch {
      closeSync(fd);
      return reply.code(404).send({ error: "not_found" });
    }
    // The stream owns the descriptor and closes it (autoClose) when the response ends or fails.
    return reply.type(TYPES[extname(file).toLowerCase()] ?? "application/octet-stream").send(createReadStream(file, { fd }));
  };

  app.get("/", { config: PUBLIC_ROUTE }, (_req, reply) => serveIndex(reply, UI_CSP, root));
  app.get("/sign-in", { config: PUBLIC_ROUTE }, (_req, reply) => serveIndex(reply, UI_CSP, root));
  app.get("/join/*", { config: PUBLIC_ROUTE }, (req, reply) => {
    const code = (req.params as { "*": string })["*"];
    return JOIN_CODE.test(code) ? serveIndex(reply, UI_CSP, root) : secure(reply).code(404).send({ error: "not_found" });
  });
  app.get("/*", { config: PUBLIC_ROUTE }, (req, reply) => serve((req.params as { "*": string })["*"], reply));
}
