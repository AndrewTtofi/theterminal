import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CiStatus, GitHubOverview } from "@theterminal/shared";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_HTTP"] as const;
const TOKEN = "ghp_TESTKEY0000000000";
const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start() {
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_HTTP = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "tt-gh-"));
  dirs.push(dataDir);
  const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), discovery: fakeDiscovery() });
  running.push(s);
  return s;
}

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const send = (s: RunningServer, method: string, path: string, body?: unknown) =>
  fetch(base(s) + path, {
    method,
    headers: { authorization: `Bearer ${s.token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const get = (s: RunningServer, path: string) => send(s, "GET", path);
const connectGitHub = (s: RunningServer, repo: string, token = TOKEN) =>
  send(s, "POST", "/api/connections", { kind: "github", provider: "github", name: "GitHub", config: { repo }, secrets: { token } });

describe("GET /api/github/overview", { timeout: 15000 }, () => {
  it("answers 401 without auth", async () => {
    const s = await start();
    expect((await fetch(`${base(s)}/api/github/overview`)).status).toBe(401);
  });

  it("answers 404 github_not_connected before a connection, and /api/status.ci is null", async () => {
    const s = await start();
    const res = await get(s, "/api/github/overview");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "github_not_connected" });
    expect(((await (await get(s, "/api/status")).json()) as { ci: unknown }).ci).toBeNull();
  });

  it("serves the canned overview after connecting, and /api/status.ci passes", async () => {
    const s = await start();
    expect((await connectGitHub(s, "octo-org/example")).status).toBe(201);
    const res = await get(s, "/api/github/overview");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("TESTKEY");
    expect(text).not.toMatch(/login|email/);
    const o = JSON.parse(text) as GitHubOverview;
    expect(o.repo).toEqual({ fullName: "octo-org/example", defaultBranch: "main", htmlUrl: "https://github.com/octo-org/example", private: false });
    expect(o.branches).toEqual([{ name: "main", isDefault: true }, { name: "feature/e2e", isDefault: false }]);
    expect(o.pulls.map((p) => [p.number, p.title])).toEqual([[7, "Add the thing"]]);
    expect(o.ciRuns.map((r) => [r.headBranch, r.status, r.conclusion])).toEqual([
      ["main", "completed", "success"],
      ["feature/e2e", "in_progress", null],
    ]);
    expect(o.ci.state).toBe("passing");
    expect(o.stale).toBe(false);
    const ci = ((await (await get(s, "/api/status")).json()) as { ci: CiStatus }).ci;
    expect(ci).toEqual(o.ci);
  });

  it("answers 404 repo_not_found for a repository the token cannot see, while /api/status answers ci unknown", async () => {
    const s = await start();
    await connectGitHub(s, "octo/missing");
    const res = await get(s, "/api/github/overview");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo_not_found" });
    const st = await get(s, "/api/status");
    expect(st.status).toBe(200);
    expect(((await st.json()) as { ci: CiStatus }).ci).toEqual({ state: "unknown", url: null, branch: null, updatedAt: null });
  });

  it("answers 502 github_rejected when GitHub refuses the token", async () => {
    const s = await start();
    await connectGitHub(s, "octo-org/example", "ghp_BADKEY0000000000");
    const res = await get(s, "/api/github/overview");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "github_rejected" });
  });

  it("serves the new repository at once after the repository changes", async () => {
    const s = await start();
    const added = (await (await connectGitHub(s, "octo-org/example")).json()) as { id: string };
    expect((await get(s, "/api/github/overview")).status).toBe(200);
    await send(s, "PATCH", `/api/connections/${added.id}`, { config: { repo: "octo/missing" } });
    expect((await get(s, "/api/github/overview")).status).toBe(404);
  });

  it("starts the CI fetch from /api/status on a cold cache", async () => {
    const s = await start();
    await connectGitHub(s, "octo-org/example");
    const first = ((await (await get(s, "/api/status")).json()) as { ci: CiStatus }).ci;
    expect(["unknown", "passing"]).toContain(first.state);
    await vi.waitFor(async () => {
      expect(((await (await get(s, "/api/status")).json()) as { ci: CiStatus }).ci.state).toBe("passing");
    });
  });
});
