import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, DirListing, FileContent, FileDiff, LedgerEntry, RunChanges } from "@theterminal/shared";
import { TOKEN_COOKIE } from "../../src/server/auth.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const get = (s: RunningServer, path: string, auth: "cookie" | "none" = "cookie") =>
  fetch(base(s) + path, { headers: auth === "cookie" ? { cookie: `${TOKEN_COOKIE}=${s.token}` } : {} });
const post = (s: RunningServer, path: string, body: unknown) =>
  fetch(base(s) + path, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A server with the fake adapter, one finished run, and `notes.txt` written into its working copy. */
async function start() {
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify([{ message: "done" }]);
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "tt-changes-")));
  dirs.push(dataDir);
  const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED });
  running.push(s);
  const project = (await (await post(s, "/api/projects", { name: "P" })).json()) as { id: string };
  const run = (await (await post(s, `/api/projects/${project.id}/runs`, { adapter: "fake", prompt: "go" })).json()) as AgentRun;
  await vi.waitFor(async () => {
    const r = (await (await get(s, `/api/runs/${run.id}`)).json()) as { run: AgentRun };
    expect(r.run.status).not.toBe("running");
  }, { timeout: 5000 });
  const wt = join(dataDir, run.worktree);
  writeFileSync(join(wt, "notes.txt"), `at ${join(wt, "x")}\n`);
  return { s, run, wt, dataDir };
}

describe("changes routes", { timeout: 20000 }, () => {
  it("serves the changes, a diff, a listing and a file, cleaned", async () => {
    const { s, run, wt } = await start();
    const changes = await get(s, `/api/runs/${run.id}/changes`);
    expect(changes.status).toBe(200);
    expect(((await changes.json()) as RunChanges).files.map((f) => [f.path, f.status])).toEqual([["notes.txt", "untracked"]]);

    const diff = await get(s, `/api/runs/${run.id}/diff?path=notes.txt`);
    expect(diff.status).toBe(200);
    const d = (await diff.json()) as FileDiff;
    expect(d.text!.startsWith("--- /dev/null\n")).toBe(true);
    expect(d.text).not.toContain(wt);

    const files = await get(s, `/api/runs/${run.id}/files`);
    expect(files.status).toBe(200);
    expect(((await files.json()) as DirListing).entries.map((e) => e.name)).toEqual(["notes.txt"]);

    const file = await get(s, `/api/runs/${run.id}/file?path=notes.txt`);
    expect(file.status).toBe(200);
    const f = (await file.json()) as FileContent;
    expect(f.text).not.toContain(wt);
    expect(f.text).toMatch(/^at \.[\\/]x/);
  });

  it("answers a bare 404 not_found for a path that leaves the worktree or an unknown run", async () => {
    const { s, run } = await start();
    for (const route of ["diff", "files", "file"]) {
      for (const p of ["../token", "/etc/hosts", ".git/config", ".git"]) {
        const res = await get(s, `/api/runs/${run.id}/${route}?path=${encodeURIComponent(p)}`);
        expect(res.status, `${route} ${p}`).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    }
    for (const route of ["changes", "diff?path=a", "files", "file?path=a"]) {
      const res = await get(s, `/api/runs/no-such-run/${route}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("400 without a path for diff and file", async () => {
    const { s, run } = await start();
    expect((await get(s, `/api/runs/${run.id}/diff`)).status).toBe(400);
    expect((await get(s, `/api/runs/${run.id}/file`)).status).toBe(400);
  });

  it("404 worktree_missing when the working copy is gone, 409 no_base without a fork point", async () => {
    const { s, run, wt, dataDir } = await start();
    const repoGit = join(dataDir, "projects", run.projectId, "repo", ".git");
    writeFileSync(join(repoGit, "HEAD"), "ref: refs/heads/nowhere\n");
    const nb = await get(s, `/api/runs/${run.id}/changes`);
    expect(nb.status).toBe(409);
    expect(await nb.json()).toEqual({ error: "no_base" });

    rmSync(wt, { recursive: true, force: true });
    for (const route of ["changes", "diff?path=a", "files", "file?path=a"]) {
      const res = await get(s, `/api/runs/${run.id}/${route}`);
      expect(res.status, route).toBe(404);
      expect(await res.json()).toEqual({ error: "worktree_missing" });
    }
  });

  it("401 without the cookie", async () => {
    const { s, run } = await start();
    for (const route of ["changes", "diff?path=notes.txt", "files", "file?path=notes.txt"]) {
      expect((await get(s, `/api/runs/${run.id}/${route}`, "none")).status).toBe(401);
    }
  });

  it("GET /api/ledger?beforeSeq= pages backwards", async () => {
    const { s } = await start();
    const all = (await (await get(s, "/api/ledger")).json()) as LedgerEntry[];
    const head = all.at(-1)!.seq;
    expect(head).toBeGreaterThan(3);
    const page = (await (await get(s, `/api/ledger?beforeSeq=${head}&limit=2`)).json()) as LedgerEntry[];
    expect(page.map((e) => e.seq)).toEqual([head - 2, head - 1]);
    expect((await get(s, "/api/ledger?beforeSeq=0")).status).toBe(400);
  });
});
