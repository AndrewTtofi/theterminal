import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubNotConnectedError,
  GitHubRejectedError,
  GitHubRepoNotFoundError,
  GitHubUnavailableError,
} from "../../src/github/client.js";
import { GitHubRepos } from "../../src/github/repos.js";

const TOKEN = "ghp_TESTKEY0000000000";
const REPO = "octo-org/example";
const API = "https://api.github.com";
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const NEW_TREE = "d".repeat(40);
const NEW_COMMIT = "e".repeat(40);

type Call = { url: string; method: string; headers: Headers; body: unknown; redirect: RequestRedirect | undefined };
type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call);
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function repos(handler: Handler, token: (() => { connectionId: string; token: string } | null) | null = null) {
  const f = fakeFetch(handler);
  const gh = new GitHubRepos({ fetch: f.fetch, token: token ?? (() => ({ connectionId: "c1", token: TOKEN })) });
  return { gh, calls: f.calls };
}

async function readAll(r: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function expectTokenOnlyInHeader(calls: Call[]) {
  for (const c of calls) {
    expect(c.url).not.toContain(TOKEN);
    expect(JSON.stringify(c.body ?? null)).not.toContain(TOKEN);
    if (c.url.startsWith(`${API}/`)) {
      expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(c.headers.get("x-github-api-version")).toBe("2022-11-28");
    } else {
      expect(c.headers.get("authorization")).toBeNull();
    }
  }
}

describe("GitHubRepos", () => {
  it("listRepos maps full_name, default_branch and private, and drops every other key", async () => {
    const { gh, calls } = repos(() =>
      json([
        {
          full_name: REPO, default_branch: "main", private: true, html_url: `https://github.com/${REPO}`,
          owner: { login: "example-owner", email: "owner@example.invalid" }, description: "x",
        },
        { full_name: "octo-org/other", default_branch: "trunk", private: false, id: 5 },
      ]),
    );
    expect(await gh.listRepos()).toEqual([
      { fullName: REPO, defaultBranch: "main", private: true },
      { fullName: "octo-org/other", defaultBranch: "trunk", private: false },
    ]);
    expect(calls.map((c) => c.url)).toEqual([`${API}/user/repos?per_page=100&sort=updated`]);
    expectTokenOnlyInHeader(calls);
  });

  it("head reads the default branch and its commit", async () => {
    const { gh, calls } = repos(({ url }) => {
      if (url === `${API}/repos/${REPO}`) return json({ full_name: REPO, default_branch: "main", private: false });
      if (url === `${API}/repos/${REPO}/commits/main`) return json({ sha: SHA, commit: { author: { email: "a@example.invalid" } } });
      return json({}, 404);
    });
    expect(await gh.head(REPO)).toEqual({ branch: "main", commit: SHA });
    expectTokenOnlyInHeader(calls);
  });

  it("tarball follows a codeload redirect without the Authorization header and returns the body", async () => {
    const location = "https://codeload.github.com/o/r/legacy.tar.gz/x";
    const { gh, calls } = repos(({ url }) => {
      if (url === `${API}/repos/${REPO}/tarball/${SHA}`) return new Response(null, { status: 302, headers: { location } });
      if (url === location) return new Response("archive-bytes", { status: 200 });
      return json({}, 404);
    });
    const body = await gh.tarball(REPO, SHA, new AbortController().signal);
    expect(await readAll(body)).toBe("archive-bytes");
    expect(calls.map((c) => c.url)).toEqual([`${API}/repos/${REPO}/tarball/${SHA}`, location]);
    expect(calls[0]!.redirect).toBe("manual");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]!.headers.get("authorization")).toBeNull();
    expectTokenOnlyInHeader(calls);
  });

  it.each([
    "https://evil.example/",
    "http://codeload.github.com/o/r/legacy.tar.gz/x",
    "https://codeload.github.com.evil.example/x",
    "https://user:pass@codeload.github.com/x",
    "/relative",
  ])("tarball refuses a Location of %s", async (location) => {
    const { gh, calls } = repos(() => new Response(null, { status: 302, headers: { location } }));
    await expect(gh.tarball(REPO, SHA, new AbortController().signal)).rejects.toBeInstanceOf(GitHubUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("tarball refuses an archive larger than 200 MB", async () => {
    const location = "https://codeload.github.com/o/r/legacy.tar.gz/x";
    const { gh } = repos(({ url }) =>
      url === location
        ? new Response("x", { status: 200, headers: { "content-length": String(209_715_201) } })
        : new Response(null, { status: 302, headers: { location } }),
    );
    await expect(gh.tarball(REPO, SHA, new AbortController().signal)).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("tarball cuts off a download that stalls", async () => {
    const location = "https://codeload.github.com/o/r/legacy.tar.gz/x";
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode("part")) });
    const f = fakeFetch(({ url }) =>
      url === location ? new Response(stalled, { status: 200 }) : new Response(null, { status: 302, headers: { location } }),
    );
    const gh = new GitHubRepos({ fetch: f.fetch, token: () => ({ connectionId: "c1", token: TOKEN }), idleTimeoutMs: 50 });
    const body = await gh.tarball(REPO, SHA, new AbortController().signal);
    await expect(readAll(body)).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("publish makes blobs, a tree, a commit, a new ref and a pull request, in that order", async () => {
    const { gh, calls } = repos(({ url, method }) => {
      const p = url.slice(`${API}/repos/${REPO}`.length);
      if (method === "GET" && p === `/git/commits/${BASE}`) return json({ sha: BASE, tree: { sha: TREE } });
      if (method === "POST" && p === "/git/blobs") return json({ sha: "f".repeat(40) }, 201);
      if (method === "POST" && p === "/git/trees") return json({ sha: NEW_TREE }, 201);
      if (method === "POST" && p === "/git/commits") return json({ sha: NEW_COMMIT }, 201);
      if (method === "POST" && p === "/git/refs") return json({ ref: "refs/heads/the-terminal/ab12cd34" }, 201);
      if (method === "POST" && p === "/pulls") return json({ html_url: `https://github.com/${REPO}/pull/9`, number: 9 }, 201);
      return json({}, 404);
    });
    const out = await gh.publish(REPO, {
      base: BASE,
      into: "main",
      branch: "the-terminal/ab12cd34",
      files: [
        { path: "src/a.ts", mode: "100644", content: Buffer.from("hello") },
        { path: "bin/run", mode: "100755", content: Buffer.from("#!/bin/sh\n") },
        { path: "old.txt", mode: "100644", content: null },
      ],
      title: "Changes from The Terminal",
      body: "Two runs accepted.",
    });
    expect(out).toEqual({ branch: "the-terminal/ab12cd34", pullUrl: `https://github.com/${REPO}/pull/9` });

    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url.slice(`${API}/repos/${REPO}`.length));
    expect(posts).toEqual(["/git/blobs", "/git/blobs", "/git/trees", "/git/commits", "/git/refs", "/pulls"]);
    const body = (p: string) => calls.find((c) => c.method === "POST" && c.url.endsWith(p))!.body as Record<string, unknown>;
    expect(calls.filter((c) => c.url.endsWith("/git/blobs")).map((c) => c.body)).toEqual([
      { content: Buffer.from("hello").toString("base64"), encoding: "base64" },
      { content: Buffer.from("#!/bin/sh\n").toString("base64"), encoding: "base64" },
    ]);
    expect(body("/git/trees")).toEqual({
      base_tree: TREE,
      tree: [
        { path: "src/a.ts", mode: "100644", type: "blob", sha: "f".repeat(40) },
        { path: "bin/run", mode: "100755", type: "blob", sha: "f".repeat(40) },
        { path: "old.txt", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(body("/git/commits")).toEqual({ message: "Changes from The Terminal", tree: NEW_TREE, parents: [BASE] });
    expect(body("/git/refs")).toEqual({ ref: "refs/heads/the-terminal/ab12cd34", sha: NEW_COMMIT });
    expect(body("/pulls")).toEqual({ title: "Changes from The Terminal", body: "Two runs accepted.", head: "the-terminal/ab12cd34", base: "main" });
    expect(calls.some((c) => c.url.includes("/git/refs/heads/main"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expectTokenOnlyInHeader(calls);
  });

  it("publish refuses a pull request link outside github.com", async () => {
    const { gh } = repos(({ url, method }) => {
      if (method === "GET") return json({ sha: BASE, tree: { sha: TREE } });
      if (url.endsWith("/pulls")) return json({ html_url: "https://evil.example/pull/9" }, 201);
      return json({ sha: NEW_COMMIT }, 201);
    });
    const err = await gh
      .publish(REPO, { base: BASE, into: "main", branch: "the-terminal/ab12cd34", files: [], title: "t", body: "b" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubUnavailableError);
  });

  it("maps 401 to GitHubRejectedError and 404 to GitHubRepoNotFoundError", async () => {
    await expect(repos(() => json({ message: "Bad credentials" }, 401)).gh.listRepos()).rejects.toBeInstanceOf(GitHubRejectedError);
    await expect(repos(() => json({ message: "Not Found" }, 404)).gh.head(REPO)).rejects.toBeInstanceOf(GitHubRepoNotFoundError);
    await expect(repos(() => json({}, 401)).gh.tarball(REPO, SHA, new AbortController().signal)).rejects.toBeInstanceOf(
      GitHubRejectedError,
    );
    await expect(repos(() => json({}, 503)).gh.listRepos()).rejects.toBeInstanceOf(GitHubUnavailableError);
    await expect(
      repos(() => {
        throw new Error("network down");
      }).gh.listRepos(),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("refuses without a token, and never puts the token in an error message", async () => {
    const { gh, calls } = repos(() => json([]), () => null);
    await expect(gh.listRepos()).rejects.toBeInstanceOf(GitHubNotConnectedError);
    expect(calls).toHaveLength(0);
    const err = (await repos(() => json({ message: TOKEN }, 401)).gh.listRepos().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it("refuses a malformed repository name or commit before any request", async () => {
    const { gh, calls } = repos(() => json({}));
    await expect(gh.head("../etc")).rejects.toBeInstanceOf(GitHubRepoNotFoundError);
    await expect(gh.tarball(REPO, "main?x=1", new AbortController().signal)).rejects.toBeInstanceOf(GitHubUnavailableError);
    expect(calls).toHaveLength(0);
  });
});
