import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_LIMITS, OWNER_ID, type ImportResult, type ImportedProject, type ProjectFiles, type WritebackPreview } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { redact } from "../../src/agents/redact.js";
import { commitEvent } from "../../src/events/commit.js";
import { SourceService, type SourceGitHub } from "../../src/sources/service.js";
import { WritebackService, type WritebackGitHub } from "../../src/sources/writeback.js";
import { sendError } from "../../src/server/routes.js";
import { registerStoryRoutes } from "../../src/server/story-routes.js";
import { registerLedgerStream } from "../../src/server/events-ws.js";
import { registerSourcesRoutes } from "../../src/server/sources-routes.js";
import { TEST_PRINCIPAL, asPrincipal, fakeAuth } from "../fixtures/principal.js";
import { tgz } from "../sources/tar-fixture.js";

const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 20_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

const owner = { kind: "human", id: OWNER_ID } as const;
const OWNER = asPrincipal(OWNER_ID, "owner");
const MAINTAINER = asPrincipal("p-maintainer", "maintainer");
const REVIEWER = asPrincipal("p-reviewer", "reviewer");
const REMOTE = { "x-test-listener": "remote" };
const REMOTE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

let base: string;
let dataDir: string;
let folder: string;
let db: Db;
let ledger: Ledger;
let board: BoardService;
let wt: WorktreeManager;
let app: FastifyInstance;
let port = 0;
const sockets: WebSocket[] = [];

type FakeGitHub = SourceGitHub & WritebackGitHub & { listRepos(): Promise<{ fullName: string; defaultBranch: string; private: boolean }[]> };

function fakeGitHub(): FakeGitHub {
  return {
    async listRepos() {
      return [{ fullName: "octo/site", defaultBranch: "main", private: true }];
    },
    async head() {
      return { branch: "main", commit: REMOTE_COMMIT };
    },
    async tarball() {
      return Readable.from([tgz([{ name: "octo-site-0123456/" , type: "5" }, { name: "octo-site-0123456/README.md", body: "hi\n" }])]);
    },
    async publish(_repo, i) {
      return { branch: i.branch, pullUrl: "https://github.com/octo/site/pull/7" };
    },
  };
}

async function build(o: { pickFolder?: () => Promise<string | null> } = {}): Promise<void> {
  const github = fakeGitHub();
  const sources = new SourceService({ db, ledger, worktrees: wt, board, github, dataDir, redact: (s) => redact(s) });
  const writeback = new WritebackService({ db, ledger, worktrees: wt, github, dataDir });
  app = Fastify();
  fakeAuth(app);
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-listener"] === "remote") request.listener = "remote";
  });
  app.setErrorHandler((err, _req, reply) => sendError(err, reply, app.log));
  registerStoryRoutes(app, { db, ledger });
  registerLedgerStream(app, ledger);
  registerSourcesRoutes(app, { db, sources, writeback, github, ...(o.pickFolder && { pickFolder: o.pickFolder }) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}

const put = (root: string, rel: string, content: string | Buffer): void => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

const inject = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as never }) });

const putFile = (uploadId: string, path: string, body: string | Buffer | Readable, headers = MAINTAINER) =>
  app.inject({
    method: "PUT",
    url: `/api/uploads/${uploadId}/file?path=${encodeURIComponent(path)}`,
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: body as never,
  });

/** A run of `projectId` whose working copy gets `files`, finished. */
async function finishedRun(projectId: string, runId: string, files: Record<string, string>): Promise<void> {
  const w = await wt.createRunWorktree(projectId, runId);
  commitEvent(db, ledger, () => ({
    event: {
      projectId, actor: owner, type: "agent.started",
      payload: { runId, adapter: "fake", authMode: "none", prompt: "change things", cardId: null, worktree: w.relPath, base: w.base },
    },
    result: () => undefined,
  }));
  for (const [rel, content] of Object.entries(files)) put(w.absPath, rel, content);
  commitEvent(db, ledger, () => ({
    event: { projectId, actor: owner, type: "agent.finished", payload: { runId, status: "completed", costUsd: null, error: null } },
    result: () => undefined,
  }));
}

/** A socket as `who`, collecting every frame it is sent. */
function listen(who: Record<string, string>): { frames: string[]; ready: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { [TEST_PRINCIPAL]: who[TEST_PRINCIPAL]! } });
  sockets.push(ws);
  const frames: string[] = [];
  ws.on("message", (d) => frames.push(String(d)));
  return { frames, ready: new Promise((r) => ws.on("open", () => r())) };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sources-routes-")));
  dataDir = join(base, "data");
  folder = join(base, "my-folder");
  mkdirSync(dataDir);
  mkdirSync(folder);
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  board = new BoardService(db, ledger);
  wt = new WorktreeManager(dataDir);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.close();
  db.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("roles and listeners", () => {
  it("a reviewer may not open an upload; a maintainer may not import a folder; the Owner may not import one remotely", async () => {
    await build();
    const project = board.createProject(owner, { name: "P" });
    const up = await inject("POST", `/api/projects/${project.id}/uploads`, REVIEWER, { files: 1, bytes: 1, includeSecrets: false });
    expect(up.statusCode).toBe(403);
    expect(up.json()).toEqual({ error: "forbidden", required: "maintainer" });
    const folderByMaintainer = await inject("POST", "/api/projects/from-folder", MAINTAINER, { path: folder });
    expect(folderByMaintainer.statusCode).toBe(403);
    expect(folderByMaintainer.json()).toEqual({ error: "forbidden", required: "owner" });
    for (const [method, url, body] of [
      ["POST", "/api/projects/from-folder", { path: folder }],
      ["POST", "/api/host/pick-folder", {}],
      ["POST", `/api/projects/${project.id}/apply`, { head: REMOTE_COMMIT }],
    ] as const) {
      const remote = await inject(method, url, { ...OWNER, ...REMOTE }, body);
      expect(remote.statusCode, url).toBe(403);
      expect(remote.json(), url).toEqual({ error: "local_only" });
    }
  });
});

describe("the folder path reaches the Owner alone", () => {
  it("is absent from the reviewer's and the maintainer's export, events and source, and present in the Owner's", async () => {
    await build();
    put(folder, "a.txt", "hello\n");
    const sockets = { reviewer: listen(REVIEWER), maintainer: listen(MAINTAINER), owner: listen(OWNER) };
    await Promise.all(Object.values(sockets).map((s) => s.ready));
    const res = await inject("POST", "/api/projects/from-folder", OWNER, { path: folder });
    expect(res.statusCode).toBe(201);
    const { project, result } = res.json() as ImportedProject;
    expect(result.files).toBe(1);
    const escaped = JSON.stringify(folder).slice(1, -1);
    const leaks = (text: string) => text.includes(folder) || text.includes(escaped);
    await vi.waitFor(() => {
      for (const s of Object.values(sockets)) expect(s.frames.some((f) => f.includes('"project.source_set"'))).toBe(true);
    });
    for (const who of ["reviewer", "maintainer"] as const) {
      expect(sockets[who].frames.join("\n"), who).toContain('"project.source_set"');
      expect(leaks(sockets[who].frames.join("\n")), who).toBe(false);
    }
    expect(leaks(sockets.owner.frames.join("\n"))).toBe(true);

    for (const [who, headers] of [["reviewer", REVIEWER], ["maintainer", MAINTAINER]] as const) {
      const exported = await inject("GET", "/api/ledger/export", headers);
      expect(exported.statusCode, who).toBe(200);
      expect(exported.body, who).toContain('"project.source_set"');
      expect(leaks(exported.body), who).toBe(false);
      const source = await inject("GET", `/api/projects/${project.id}/source`, headers);
      expect(source.statusCode, who).toBe(200);
      expect(source.json(), who).toEqual({ source: { kind: "folder" } });
      expect(leaks(source.body), who).toBe(false);
    }
    expect(leaks((await inject("GET", "/api/ledger/export", OWNER)).body)).toBe(true);
    const ownSource = await inject("GET", `/api/projects/${project.id}/source`, OWNER);
    expect(ownSource.json()).toEqual({ source: { kind: "folder", path: folder } });
  });

  it("the files route names the folder source to a reviewer without its path, and to the Owner with it", async () => {
    await build();
    put(folder, "a.txt", "hello\n");
    put(folder, "src/b.ts", "export {};\n");
    const { project } = (await inject("POST", "/api/projects/from-folder", OWNER, { path: folder })).json() as ImportedProject;
    const reviewer = await inject("GET", `/api/projects/${project.id}/files`, REVIEWER);
    expect(reviewer.statusCode).toBe(200);
    const seen = reviewer.json() as ProjectFiles;
    expect(seen.source).toEqual({ kind: "folder" });
    expect(seen.added).toBe(true);
    expect(seen.entries.map((e) => e.name)).toEqual(["src", "a.txt"]);
    const viewer = await inject("GET", `/api/projects/${project.id}/files`, asPrincipal("p-viewer", "viewer"));
    expect(viewer.statusCode).toBe(403);
    const mine = (await inject("GET", `/api/projects/${project.id}/files`, OWNER)).json() as ProjectFiles;
    expect(mine.source).toEqual({ kind: "folder", path: folder });
  });

  it("a folder that is not there is folder_unavailable, and the data folder is folder_refused", async () => {
    await build();
    const gone = await inject("POST", "/api/projects/from-folder", OWNER, { path: join(base, "gone") });
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toEqual({ error: "folder_unavailable" });
    const data = await inject("POST", "/api/projects/from-folder", OWNER, { path: dataDir });
    expect(data.statusCode).toBe(400);
    expect(data.json()).toEqual({ error: "folder_refused" });
  });
});

describe("the folder picker", () => {
  it("is folder_picker_unavailable without a picker", async () => {
    await build();
    const res = await inject("POST", "/api/host/pick-folder", OWNER, {});
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "folder_picker_unavailable" });
  });

  it("answers the picked path, and picker_busy while another pick is open", async () => {
    let calls = 0;
    await build({
      pickFolder: async () => {
        calls += 1;
        if (calls > 1) {
          const { PickerBusyError } = await import("../../src/server/folder-picker.js");
          throw new PickerBusyError();
        }
        return "/abs";
      },
    });
    const res = await inject("POST", "/api/host/pick-folder", OWNER, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: "/abs" });
    const busy = await inject("POST", "/api/host/pick-folder", OWNER, {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: "picker_busy" });
  });
});

describe("uploads", () => {
  async function open(includeSecrets = false, files = 2): Promise<{ projectId: string; uploadId: string }> {
    const project = board.createProject(owner, { name: "P" });
    const res = await inject("POST", `/api/projects/${project.id}/uploads`, MAINTAINER, { files, bytes: 100, includeSecrets });
    expect(res.statusCode).toBe(201);
    return { projectId: project.id, uploadId: (res.json() as { uploadId: string }).uploadId };
  }

  it("open, two raw PUTs, commit: one ImportResult with both files", async () => {
    await build();
    const { projectId, uploadId } = await open();
    expect((await putFile(uploadId, "a.txt", "alpha\n")).statusCode).toBe(204);
    expect((await putFile(uploadId, "src/b.ts", Buffer.from([0, 1, 2]))).statusCode).toBe(204);
    const res = await inject("POST", `/api/uploads/${uploadId}/commit`, MAINTAINER, {});
    expect(res.statusCode).toBe(200);
    const result = res.json() as ImportResult;
    expect(result).toMatchObject({ files: 2, bytes: 9, skippedCount: 0 });
    expect(readFileSync(join(wt.repoPath(projectId), "a.txt"), "utf8")).toBe("alpha\n");
    // The upload is gone once committed, and is nobody else's to touch before.
    expect((await putFile(uploadId, "c.txt", "x")).json()).toEqual({ error: "upload_not_found" });
  });

  it("another person's upload is upload_not_found; a cancelled one too", async () => {
    await build();
    const { uploadId } = await open();
    const other = await putFile(uploadId, "a.txt", "x", asPrincipal("p-other", "maintainer"));
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: "upload_not_found" });
    expect((await inject("DELETE", `/api/uploads/${uploadId}`, MAINTAINER)).statusCode).toBe(204);
    expect((await inject("POST", `/api/uploads/${uploadId}/commit`, MAINTAINER, {})).json()).toEqual({ error: "upload_not_found" });
  });

  it("a PUT of ../x is path_refused with its reason", async () => {
    await build();
    const { uploadId } = await open();
    const res = await putFile(uploadId, "../x", "x");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "path_refused", reason: "dot_dot" });
  });

  it("a PUT clashing with an earlier file is path_refused conflict, and the upload carries on", async () => {
    await build();
    const { uploadId } = await open();
    expect((await putFile(uploadId, "a", "x")).statusCode).toBe(204);
    const res = await putFile(uploadId, "a/b.txt", "y");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "path_refused", reason: "conflict" });
    expect((await putFile(uploadId, "c.txt", "z")).statusCode).toBe(204);
  });

  it("a PUT streaming one byte over the per-file limit is limit_exceeded, whatever it declared", async () => {
    await build();
    const { uploadId } = await open();
    // Over a real connection: the server answers, then closes it without reading the rest.
    const chunk = Buffer.alloc(1024 * 1024);
    const total = IMPORT_LIMITS.fileBytes + 1;
    const res = await new Promise<{ statusCode: number; json: () => unknown }>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port, method: "PUT", path: `/api/uploads/${uploadId}/file?path=big.bin`,
        headers: { ...MAINTAINER, "content-type": "application/octet-stream", "content-length": String(total) },
      }, (r) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.on("end", () => resolve({ statusCode: r.statusCode ?? 0, json: () => JSON.parse(Buffer.concat(parts).toString("utf8")) }));
      });
      req.on("error", (e) => (answered ? undefined : reject(e)));
      let answered = false;
      req.on("response", () => (answered = true));
      let sent = 0;
      const pump = (): void => {
        while (sent < total) {
          const n = Math.min(chunk.length, total - sent);
          sent += n;
          if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
            req.once("drain", pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "limit_exceeded", limit: "file_bytes" });
  });

  it("declared totals over the limits are limit_exceeded at open", async () => {
    await build();
    const project = board.createProject(owner, { name: "P" });
    const res = await inject("POST", `/api/projects/${project.id}/uploads`, MAINTAINER, { files: IMPORT_LIMITS.files + 1, bytes: 1, includeSecrets: false });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "limit_exceeded", limit: "files" });
  });

  it("a commit holding .env without includeSecrets is possible_secrets with the name", async () => {
    await build();
    const { uploadId } = await open();
    expect((await putFile(uploadId, "a.txt", "a")).statusCode).toBe(204);
    expect((await putFile(uploadId, ".env", "TOKEN=x")).statusCode).toBe(204);
    const res = await inject("POST", `/api/uploads/${uploadId}/commit`, MAINTAINER, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "possible_secrets", names: [".env"] });
  });

  it("a fifth open upload is upload_busy", async () => {
    await build();
    const project = board.createProject(owner, { name: "P" });
    for (let i = 0; i < 4; i++) {
      expect((await inject("POST", `/api/projects/${project.id}/uploads`, MAINTAINER, { files: 1, bytes: 1, includeSecrets: false })).statusCode).toBe(201);
    }
    const res = await inject("POST", `/api/projects/${project.id}/uploads`, MAINTAINER, { files: 1, bytes: 1, includeSecrets: false });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "upload_busy" });
  });
});

describe("GitHub", () => {
  it("uses the Owner's token, so only the Owner lists repositories or imports one", async () => {
    await build();
    expect((await inject("GET", "/api/github/repos", MAINTAINER)).statusCode).toBe(403);
    expect((await inject("POST", "/api/projects/from-github", MAINTAINER, { repo: "octo/site" })).statusCode).toBe(403);
  });

  it("lists the Owner's repositories and creates a project from one", async () => {
    await build();
    const repos = await inject("GET", "/api/github/repos", OWNER);
    expect(repos.statusCode).toBe(200);
    expect(repos.json()).toEqual({ repos: [{ fullName: "octo/site", defaultBranch: "main", private: true }] });
    const res = await inject("POST", "/api/projects/from-github", OWNER, { repo: "octo/site" });
    expect(res.statusCode).toBe(201);
    const { project, result } = res.json() as ImportedProject;
    expect(project.name).toBe("site");
    expect(result.files).toBe(1);
    const source = await inject("GET", `/api/projects/${project.id}/source`, REVIEWER);
    expect(source.json()).toEqual({ source: { kind: "github", repo: "octo/site", branch: "main" } });
  });
});

describe("accept and write-back", () => {
  it("accept twice: 200, then 409 already_accepted", async () => {
    await build();
    put(folder, "keep.txt", "keep\n");
    const { project } = (await inject("POST", "/api/projects/from-folder", OWNER, { path: folder })).json() as ImportedProject;
    await finishedRun(project.id, "run-aaaa1111", { "a.txt": "from the run\n" });
    const first = await inject("POST", "/api/runs/run-aaaa1111/accept", MAINTAINER, {});
    expect(first.statusCode).toBe(200);
    expect((first.json() as { commit: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    const second = await inject("POST", "/api/runs/run-aaaa1111/accept", MAINTAINER, {});
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "already_accepted" });
  });

  it("a clash is merge_conflict; preview, apply, then a stale apply is preview_stale and the next preview nothing_to_write", async () => {
    await build();
    put(folder, "a.txt", "one\n");
    const { project } = (await inject("POST", "/api/projects/from-folder", OWNER, { path: folder })).json() as ImportedProject;
    await finishedRun(project.id, "run-first111", { "a.txt": "first\n" });
    await finishedRun(project.id, "run-second22", { "a.txt": "second\n" });
    expect((await inject("POST", "/api/runs/run-first111/accept", MAINTAINER, {})).statusCode).toBe(200);
    const clash = await inject("POST", "/api/runs/run-second22/accept", MAINTAINER, {});
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual({ error: "merge_conflict" });

    expect((await inject("GET", `/api/projects/${project.id}/writeback`, MAINTAINER)).statusCode).toBe(403);
    const preview = await inject("GET", `/api/projects/${project.id}/writeback`, OWNER);
    expect(preview.statusCode).toBe(200);
    const shown = preview.json() as WritebackPreview;
    expect(shown).toMatchObject({ kind: "folder", files: [{ path: "a.txt", change: "modify" }] });
    const applied = await inject("POST", `/api/projects/${project.id}/apply`, OWNER, { head: shown.head });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ written: 1, deleted: 0, skipped: [] });
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("first\n");
    const again = await inject("POST", `/api/projects/${project.id}/apply`, OWNER, { head: shown.head });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "preview_stale" });
    const none = await inject("GET", `/api/projects/${project.id}/writeback`, OWNER);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: "nothing_to_write" });
    const publish = await inject("POST", `/api/projects/${project.id}/publish`, OWNER, { head: shown.head });
    expect(publish.statusCode).toBe(404);
    expect(publish.json()).toEqual({ error: "no_source" });
  });

  it("a project with no source is no_source; a removed folder is folder_unavailable", async () => {
    await build();
    const plain = board.createProject(owner, { name: "Plain" });
    const res = await inject("GET", `/api/projects/${plain.id}/writeback`, OWNER);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_source" });

    put(folder, "keep.txt", "keep\n");
    const { project } = (await inject("POST", "/api/projects/from-folder", OWNER, { path: folder })).json() as ImportedProject;
    await finishedRun(project.id, "run-bbbb2222", { "b.txt": "b\n" });
    expect((await inject("POST", "/api/runs/run-bbbb2222/accept", MAINTAINER, {})).statusCode).toBe(200);
    const { head } = (await inject("GET", `/api/projects/${project.id}/writeback`, OWNER)).json() as WritebackPreview;
    rmSync(folder, { recursive: true, force: true });
    const gone = await inject("POST", `/api/projects/${project.id}/apply`, OWNER, { head });
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toEqual({ error: "folder_unavailable" });
  });
});
