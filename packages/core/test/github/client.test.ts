import { describe, expect, it, vi } from "vitest";
import type { GitHubOverview } from "@theterminal/shared";
import {
  GitHubClient,
  GitHubNotConnectedError,
  GitHubRejectedError,
  GitHubRepoNotFoundError,
  GitHubUnavailableError,
  ciStatusOf,
} from "../../src/github/client.js";

const TOKEN = "ghp_TESTKEY0000000000";
const OTHER_TOKEN = "ghp_TESTKEY1111111111";
const REPO = "octo-org/example";
const API = `https://api.github.com/repos/${REPO}`;
const URLS = [
  API,
  `${API}/branches?per_page=100`,
  `${API}/pulls?state=open&per_page=50`,
  `${API}/actions/runs?per_page=10`,
];

const bodies: Record<string, unknown> = {
  [API]: {
    full_name: REPO, default_branch: "main", html_url: `https://github.com/${REPO}`, private: true,
    owner: { login: "example-owner", email: "owner@example.invalid" },
  },
  [`${API}/branches?per_page=100`]: [
    { name: "main", commit: { sha: "abc" }, protected: true },
    { name: "feature/x", commit: { sha: "def" }, protected: false },
  ],
  [`${API}/pulls?state=open&per_page=50`]: [
    {
      number: 7, title: "Add the thing", draft: true, html_url: `https://github.com/${REPO}/pull/7`, updated_at: "2026-11-01T00:00:00Z",
      head: { ref: "feature/x", user: { login: "example-user" } }, base: { ref: "main" },
      user: { login: "example-user", email: "user@example.invalid" }, body: "long description",
    },
  ],
  [`${API}/actions/runs?per_page=10`]: {
    total_count: 2,
    workflow_runs: [
      {
        id: 2, name: "CI", status: "in_progress", conclusion: null, head_branch: "feature/x",
        html_url: `https://github.com/${REPO}/actions/runs/2`, updated_at: "2026-11-02T00:00:00Z", actor: { login: "example-user" },
      },
      {
        id: 1, name: "CI", status: "completed", conclusion: "success", head_branch: "main",
        html_url: `https://github.com/${REPO}/actions/runs/1`, updated_at: "2026-11-01T00:00:00Z", actor: { login: "example-user" },
      },
    ],
  },
};

type Call = { url: string; headers: Headers };
type Handler = (url: string, headers: Headers) => Response | Promise<Response>;

const ok: Handler = (url) =>
  new Response(JSON.stringify(bodies[url] ?? {}), { status: bodies[url] ? 200 : 404, headers: { etag: `"etag-${URLS.indexOf(url)}"` } });

function fakeFetch(initial: Handler = ok) {
  const calls: Call[] = [];
  let handler = initial;
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    return handler(url, headers);
  });
  return { fetch: f as unknown as typeof fetch, calls, set: (h: Handler) => (handler = h) };
}

function clock(start = Date.parse("2026-11-15T12:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms), ms: () => t };
}

function client(opts: { handler?: Handler; repo?: () => string; token?: () => string; connected?: () => boolean } = {}) {
  const f = fakeFetch(opts.handler);
  const c = clock();
  const gh = new GitHubClient({
    fetch: f.fetch,
    now: c.now,
    source: () =>
      opts.connected && !opts.connected() ? null : { connectionId: "g1", token: opts.token?.() ?? TOKEN, repo: opts.repo?.() ?? REPO },
  });
  return { gh, f, c };
}

const rateLimited = (reset: number): Handler => () =>
  new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
  });

describe("GitHubClient.overview", () => {
  it("sends the four GETs with the exact headers and the token only in the Authorization header", async () => {
    const { gh, f } = client();
    await gh.overview();
    expect(f.calls.map((c) => c.url).sort()).toEqual([...URLS].sort());
    for (const call of f.calls) {
      expect(call.url).not.toContain("TESTKEY");
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(call.headers.get("accept")).toBe("application/vnd.github+json");
      expect(call.headers.get("if-none-match")).toBeNull();
    }
  });

  it("returns only the overview's fields: no logins, emails or bodies", async () => {
    const { gh } = client();
    const o = await gh.overview();
    expect(o).toEqual<GitHubOverview>({
      repo: { fullName: REPO, defaultBranch: "main", htmlUrl: `https://github.com/${REPO}`, private: true },
      branches: [{ name: "main", isDefault: true }, { name: "feature/x", isDefault: false }],
      pulls: [{
        number: 7, title: "Add the thing", headRef: "feature/x", baseRef: "main", draft: true,
        htmlUrl: `https://github.com/${REPO}/pull/7`, updatedAt: "2026-11-01T00:00:00Z",
      }],
      ciRuns: [
        { id: 2, name: "CI", status: "in_progress", conclusion: null, headBranch: "feature/x", htmlUrl: `https://github.com/${REPO}/actions/runs/2`, updatedAt: "2026-11-02T00:00:00Z" },
        { id: 1, name: "CI", status: "completed", conclusion: "success", headBranch: "main", htmlUrl: `https://github.com/${REPO}/actions/runs/1`, updatedAt: "2026-11-01T00:00:00Z" },
      ],
      ci: { state: "passing", url: `https://github.com/${REPO}/actions/runs/1`, branch: "main", updatedAt: "2026-11-01T00:00:00Z" },
      fetchedAt: "2026-11-15T12:00:00.000Z",
      stale: false,
    });
  });

  it("keeps no login, email or body in the cache", async () => {
    const { gh } = client();
    await gh.overview();
    const cached = JSON.stringify((gh as unknown as { cache: unknown }).cache);
    expect(cached).not.toMatch(/login|email|example-user|example-owner|long description/);
    expect(cached).not.toContain("TESTKEY");
  });

  it("answers from the cache without a request within 30 s", async () => {
    const { gh, f, c } = client();
    const first = await gh.overview();
    c.advance(29_000);
    expect(await gh.overview()).toEqual(first);
    expect(f.calls).toHaveLength(4);
  });

  it("revalidates each URL with If-None-Match after 30 s, and a 304 keeps the cached body", async () => {
    const { gh, f, c } = client();
    const first = await gh.overview();
    c.advance(30_000);
    f.set((url, headers) => {
      expect(headers.get("if-none-match")).toBe(`"etag-${URLS.indexOf(url)}"`);
      return new Response(null, { status: 304 });
    });
    const second = await gh.overview();
    expect(f.calls).toHaveLength(8);
    expect(second).toEqual({ ...first, fetchedAt: "2026-11-15T12:00:30.000Z" });
  });

  it("does not serve one repository's cache for another, nor one token's for another", async () => {
    let repo = REPO;
    let token = TOKEN;
    const { gh, f } = client({ repo: () => repo, token: () => token });
    await gh.overview();
    token = OTHER_TOKEN;
    await gh.overview();
    expect(f.calls).toHaveLength(8);
    expect(f.calls[4]!.headers.get("if-none-match")).toBeNull();
    repo = "octo-org/missing";
    await expect(gh.overview()).rejects.toBeInstanceOf(GitHubRepoNotFoundError);
    expect(f.calls).toHaveLength(12);
  });

  it("throws GitHubRepoNotFoundError on a 404 for the repository", async () => {
    const { gh } = client({ repo: () => "octo-org/missing" });
    await expect(gh.overview()).rejects.toBeInstanceOf(GitHubRepoNotFoundError);
  });

  it.each(["../octo-org", "octo-org/..", "./x", "octo-org/.", "octo-org/example/extra"])(
    "refuses the repository name %s without a request",
    async (repo) => {
      const { gh, f } = client({ repo: () => repo });
      await expect(gh.overview()).rejects.toBeInstanceOf(GitHubRepoNotFoundError);
      expect(f.calls).toHaveLength(0);
    },
  );

  it("throws GitHubRejectedError on a 401, and on a 403 without the rate limit", async () => {
    const a = client({ handler: () => new Response("{}", { status: 401 }) });
    await expect(a.gh.overview()).rejects.toBeInstanceOf(GitHubRejectedError);
    const b = client({ handler: () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "41" } }) });
    await expect(b.gh.overview()).rejects.toBeInstanceOf(GitHubRejectedError);
  });

  it("throws GitHubUnavailableError on a network error, a 5xx and an oversized body", async () => {
    const a = client({ handler: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(a.gh.overview()).rejects.toBeInstanceOf(GitHubUnavailableError);
    const b = client({ handler: () => new Response("{}", { status: 502 }) });
    await expect(b.gh.overview()).rejects.toBeInstanceOf(GitHubUnavailableError);
    const huge = JSON.stringify([{ name: "x".repeat(9 * 1024 * 1024) }]);
    const c = client({ handler: (url) => (url.includes("/branches") ? new Response(huge) : ok(url, new Headers())) });
    await expect(c.gh.overview()).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("throws GitHubNotConnectedError without a source", async () => {
    const { gh, f } = client({ connected: () => false });
    await expect(gh.overview()).rejects.toBeInstanceOf(GitHubNotConnectedError);
    expect(f.calls).toHaveLength(0);
  });

  it("on a rate limit after a good fetch serves the cached overview as stale and sends nothing before the reset", async () => {
    const { gh, f, c } = client();
    const first = await gh.overview();
    c.advance(30_000);
    const reset = Math.floor(c.ms() / 1000) + 120;
    f.set(rateLimited(reset));
    expect(await gh.overview()).toEqual({ ...first, stale: true });
    const sent = f.calls.length;
    c.advance(60_000); // past the cache window, before the reset
    expect(await gh.overview()).toEqual({ ...first, stale: true });
    expect(gh.ciStatusNow()).toEqual(first.ci);
    expect(f.calls).toHaveLength(sent);
    c.advance(61_000); // past the reset
    f.set(ok);
    expect((await gh.overview()).stale).toBe(false);
    expect(f.calls.length).toBeGreaterThan(sent);
  });

  it("treats a 429 as a rate limit, waiting the cache window when there is no reset header", async () => {
    const { gh, f, c } = client();
    await gh.overview();
    c.advance(30_000);
    f.set(() => new Response("{}", { status: 429 }));
    expect((await gh.overview()).stale).toBe(true);
    const sent = f.calls.length;
    c.advance(29_000);
    await gh.overview();
    expect(f.calls).toHaveLength(sent);
  });

  it("on a rate limit with a cold cache throws GitHubUnavailableError, and ciStatus resolves unknown", async () => {
    const { gh } = client({ handler: rateLimited(Math.floor(Date.parse("2026-11-15T12:00:00Z") / 1000) + 600) });
    await expect(gh.overview()).rejects.toBeInstanceOf(GitHubUnavailableError);
    expect(await gh.ciStatus()).toEqual({ state: "unknown", url: null, branch: null, updatedAt: null });
  });
});

describe("GitHubClient.ciStatus and ciStatusNow", () => {
  const UNKNOWN = { state: "unknown", url: null, branch: null, updatedAt: null };

  it("ciStatus never throws", async () => {
    const { gh } = client({ handler: () => Promise.reject(new Error("boom")) });
    expect(await gh.ciStatus()).toEqual(UNKNOWN);
  });

  it("ciStatusNow answers unknown on a cold cache and starts a fetch; then answers from the cache", async () => {
    const { gh, f } = client();
    expect(gh.ciStatusNow()).toEqual(UNKNOWN);
    expect(f.calls).toHaveLength(4);
    await vi.waitFor(() => expect(gh.ciStatusNow().state).toBe("passing"));
    expect(f.calls).toHaveLength(4);
  });

  it("ciStatusNow does not retry a failed fetch within the cache window", async () => {
    const { gh, f, c } = client({ repo: () => "octo-org/missing" });
    gh.ciStatusNow();
    await vi.waitFor(() => expect(f.calls).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 0));
    c.advance(10_000);
    expect(gh.ciStatusNow()).toEqual(UNKNOWN);
    expect(f.calls).toHaveLength(4);
  });

  it("ciStatusNow answers unknown without a source", () => {
    const { gh, f } = client({ connected: () => false });
    expect(gh.ciStatusNow()).toEqual(UNKNOWN);
    expect(f.calls).toHaveLength(0);
  });
});

describe("ciStatusOf", () => {
  const run = (status: string, conclusion: string | null, headBranch = "main") => ({
    id: 1, name: "CI", status, conclusion, headBranch, htmlUrl: "https://github.com/octo-org/example/actions/runs/1", updatedAt: "2026-11-01T00:00:00Z",
  });
  const repo = { defaultBranch: "main" };

  it.each([
    ["queued", null, "running"],
    ["in_progress", null, "running"],
    ["waiting", null, "running"],
    ["pending", null, "running"],
    ["completed", "success", "passing"],
    ["completed", "failure", "failing"],
    ["completed", "timed_out", "failing"],
    ["completed", "startup_failure", "failing"],
    ["completed", "action_required", "failing"],
    ["completed", "cancelled", "unknown"],
    ["completed", "skipped", "unknown"],
    ["completed", "neutral", "unknown"],
  ] as const)("status %s, conclusion %s → %s", (status, conclusion, state) => {
    expect(ciStatusOf(repo, [run(status, conclusion)])).toEqual({
      state, url: "https://github.com/octo-org/example/actions/runs/1", branch: "main", updatedAt: "2026-11-01T00:00:00Z",
    });
  });

  it("uses the newest run on the default branch", () => {
    const runs = [run("in_progress", null, "feature/x"), { ...run("completed", "failure"), id: 3 }, run("completed", "success")];
    expect(ciStatusOf(repo, runs).state).toBe("failing");
  });

  it("is unknown when no run is on the default branch", () => {
    expect(ciStatusOf(repo, [run("completed", "success", "feature/x")])).toEqual(UNKNOWN_STATUS);
    expect(ciStatusOf(repo, [])).toEqual(UNKNOWN_STATUS);
  });
});

const UNKNOWN_STATUS = { state: "unknown", url: null, branch: null, updatedAt: null };
