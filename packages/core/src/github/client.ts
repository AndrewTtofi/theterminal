import { createHash } from "node:crypto";
import { z } from "zod";
import type { CiState, CiStatus, GitHubOverview } from "@theterminal/shared";
import type { GitHubSource } from "../connections/service.js";

/** A network error, a timeout, a 5xx, a malformed or oversized body, or a rate limit with nothing cached. */
export class GitHubUnavailableError extends Error {}
/** A 404 on the repository: it does not exist, or the token cannot see it. */
export class GitHubRepoNotFoundError extends Error {}
/** A 401, or a 403 that is not the rate limit. */
export class GitHubRejectedError extends Error {}
/** No enabled GitHub connection with a token and a repository. */
export class GitHubNotConnectedError extends Error {}

export type GitHubClientDeps = {
  fetch: typeof fetch;
  source: () => GitHubSource;
  now?: () => Date;
  cacheMs?: number;
  timeoutMs?: number;
};

const API = "https://api.github.com";
/** Larger bodies are refused rather than read into memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A rate-limit reset further away than this is not believed. */
const MAX_BLOCK_MS = 60 * 60 * 1000;
const TEXT_MAX = 500;

/** owner/name as the catalog allows it, minus the dot segments a URL would resolve. */
const REPO_NAME = /^(?!\.\.?\/)[A-Za-z0-9_.-]{1,100}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

const UNKNOWN: CiStatus = { state: "unknown", url: null, branch: null, updatedAt: null };

const text = z.string().transform((s) => s.slice(0, TEXT_MAX));
/** Links are shown in the UI, so only https URLs are kept. */
const httpsUrl = z.string().max(2000).regex(/^https:\/\//);
const maybeText = z.string().nullish().transform((s) => (s ?? "").slice(0, TEXT_MAX));

// zod objects drop every key they do not name, so logins, emails and bodies never reach the cache.
const repoSchema = z.object({ full_name: text, default_branch: text, html_url: httpsUrl, private: z.boolean() }).transform((r) => ({
  fullName: r.full_name, defaultBranch: r.default_branch, htmlUrl: r.html_url, private: r.private,
}));
const branchesSchema = z.array(z.object({ name: text })).transform((bs) => bs.slice(0, 100).map((b) => b.name));
const pullsSchema = z
  .array(
    z.object({
      number: z.number().int(), title: text, draft: z.boolean().nullish(), html_url: httpsUrl, updated_at: text,
      head: z.object({ ref: text }), base: z.object({ ref: text }),
    }),
  )
  .transform((ps) =>
    ps.slice(0, 50).map((p) => ({
      number: p.number, title: p.title, headRef: p.head.ref, baseRef: p.base.ref, draft: p.draft ?? false,
      htmlUrl: p.html_url, updatedAt: p.updated_at,
    })),
  );
const runsSchema = z
  .object({
    workflow_runs: z.array(
      z.object({
        id: z.number().int(), name: maybeText, status: maybeText, conclusion: z.string().nullish(), head_branch: maybeText,
        html_url: httpsUrl, updated_at: text,
      }),
    ),
  })
  .transform((r) =>
    r.workflow_runs.slice(0, 10).map((run) => ({
      id: run.id, name: run.name, status: run.status, conclusion: run.conclusion?.slice(0, TEXT_MAX) ?? null,
      headBranch: run.head_branch, htmlUrl: run.html_url, updatedAt: run.updated_at,
    })),
  );

type Parts = {
  repo: z.output<typeof repoSchema>;
  branches: z.output<typeof branchesSchema>;
  pulls: z.output<typeof pullsSchema>;
  runs: z.output<typeof runsSchema>;
};
type Part = keyof Parts;
const PARTS: { part: Part; path: string; schema: z.ZodType<Parts[Part]> }[] = [
  { part: "repo", path: "", schema: repoSchema },
  { part: "branches", path: "/branches?per_page=100", schema: branchesSchema },
  { part: "pulls", path: "/pulls?state=open&per_page=50", schema: pullsSchema },
  { part: "runs", path: "/actions/runs?per_page=10", schema: runsSchema },
];

/** What a response is kept as: its ETag and the fields the overview needs, nothing else. */
type Entry = { etag: string | null; data: Parts[Part] };

type Cache = {
  /** The repository plus a hash of the token: a change of either starts a new cache. */
  key: string;
  entries: Partial<Record<Part, Entry>>;
  overview: GitHubOverview | null;
  /** When the last good fetch finished (ms). */
  fetchedAt: number;
  /** No request before this (ms): set by a rate limit. */
  blockedUntil: number;
  /** When the last fetch failed (ms); background fetches wait the cache window after it. */
  failedAt: number | null;
  inFlight: Promise<GitHubOverview> | null;
};

type Outcome =
  | { kind: "ok"; part: Part; entry: Entry }
  | { kind: "rate_limited"; until: number }
  | { kind: "not_found" }
  | { kind: "rejected" }
  | { kind: "unavailable" };

const RUNNING = new Set(["queued", "in_progress", "waiting", "pending"]);
const FAILING = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** The CI state of the newest run on the default branch. */
export function ciStatusOf(repo: { defaultBranch: string }, runs: GitHubOverview["ciRuns"]): CiStatus {
  const run = runs.find((r) => r.headBranch === repo.defaultBranch);
  if (!run) return UNKNOWN;
  let state: CiState = "unknown";
  if (RUNNING.has(run.status)) state = "running";
  else if (run.conclusion === "success") state = "passing";
  else if (run.conclusion !== null && FAILING.has(run.conclusion)) state = "failing";
  return { state, url: run.htmlUrl, branch: run.headBranch, updatedAt: run.updatedAt };
}

/** Reads at most MAX_BODY_BYTES; null when the body is larger. */
async function boundedText(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read-only GitHub client for the connection's repository. The token goes only in the Authorization header: never in
 * a URL, an error message or the cache key (which holds a hash of it). Each response is cut down to the overview's
 * fields before it is cached with its ETag.
 */
export class GitHubClient {
  private readonly now: () => Date;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private cache: Cache | null = null;

  constructor(private readonly deps: GitHubClientDeps) {
    this.now = deps.now ?? (() => new Date());
    this.cacheMs = deps.cacheMs ?? 30_000;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  /** The overview, from the cache within `cacheMs` of the last good fetch, else revalidated with If-None-Match. */
  overview(): Promise<GitHubOverview> {
    const source = this.deps.source();
    if (!source) return Promise.reject(new GitHubNotConnectedError("GitHub is not connected"));
    const cache = this.cacheFor(source);
    const now = this.now().getTime();
    if (cache.overview && now - cache.fetchedAt < this.cacheMs) return Promise.resolve(cache.overview);
    if (now < cache.blockedUntil) {
      return cache.overview
        ? Promise.resolve({ ...cache.overview, stale: true })
        : Promise.reject(new GitHubUnavailableError("GitHub is rate-limiting requests"));
    }
    if (!cache.inFlight) {
      const pending = this.refresh(source, cache);
      cache.inFlight = pending;
      const clear = () => {
        if (cache.inFlight === pending) cache.inFlight = null;
      };
      pending.then(clear, clear);
    }
    return cache.inFlight;
  }

  /** The CI status from a cached or fresh overview; never throws. */
  async ciStatus(): Promise<CiStatus> {
    try {
      return (await this.overview()).ci;
    } catch {
      return UNKNOWN;
    }
  }

  /**
   * The CI status without waiting on the network: the cached overview's, else unknown. Starts a fetch in the
   * background when the cache is cold or expired, unless one is running, a rate limit holds, or the last one failed
   * within the cache window.
   */
  ciStatusNow(): CiStatus {
    const source = this.deps.source();
    if (!source) return UNKNOWN;
    const cache = this.cacheFor(source);
    const now = this.now().getTime();
    const fresh = cache.overview !== null && now - cache.fetchedAt < this.cacheMs;
    const recentlyFailed = cache.failedAt !== null && now - cache.failedAt < this.cacheMs;
    if (!fresh && !cache.inFlight && now >= cache.blockedUntil && !recentlyFailed) void this.overview().catch(() => undefined);
    return cache.overview?.ci ?? UNKNOWN;
  }

  private cacheFor(source: NonNullable<GitHubSource>): Cache {
    const key = `${source.repo}\n${createHash("sha256").update(source.token).digest("hex")}`;
    if (this.cache?.key !== key) {
      this.cache = { key, entries: {}, overview: null, fetchedAt: 0, blockedUntil: 0, failedAt: null, inFlight: null };
    }
    return this.cache;
  }

  private async refresh(source: NonNullable<GitHubSource>, cache: Cache): Promise<GitHubOverview> {
    if (!REPO_NAME.test(source.repo)) {
      cache.failedAt = this.now().getTime();
      throw new GitHubRepoNotFoundError("Repository not found");
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const outcomes = await Promise.all(PARTS.map((p) => this.get(source, p, cache.entries[p.part], signal)));
    const now = this.now().getTime();
    const limited = outcomes.find((o) => o.kind === "rate_limited");
    if (limited) {
      cache.blockedUntil = Math.min(limited.until, now + MAX_BLOCK_MS);
      if (cache.overview) return { ...cache.overview, stale: true };
      cache.failedAt = now;
      throw new GitHubUnavailableError("GitHub is rate-limiting requests");
    }
    const failure = (kind: Outcome["kind"]) => outcomes.some((o) => o.kind === kind);
    if (!outcomes.every((o) => o.kind === "ok")) {
      cache.failedAt = now;
      if (failure("not_found")) throw new GitHubRepoNotFoundError("Repository not found");
      if (failure("rejected")) throw new GitHubRejectedError("GitHub rejected the token");
      throw new GitHubUnavailableError("Could not reach GitHub");
    }
    for (const o of outcomes) if (o.kind === "ok") cache.entries[o.part] = o.entry;
    const parts = Object.fromEntries(outcomes.map((o) => (o.kind === "ok" ? [o.part, o.entry.data] : []))) as Parts;
    const repo = parts.repo;
    const overview: GitHubOverview = {
      repo,
      branches: parts.branches.map((name) => ({ name, isDefault: name === repo.defaultBranch })),
      pulls: parts.pulls,
      ciRuns: parts.runs,
      ci: ciStatusOf(repo, parts.runs),
      fetchedAt: new Date(now).toISOString(),
      stale: false,
    };
    cache.overview = overview;
    cache.fetchedAt = now;
    cache.failedAt = null;
    return overview;
  }

  private async get(
    source: NonNullable<GitHubSource>,
    { part, path, schema }: (typeof PARTS)[number],
    cached: Entry | undefined,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${source.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let res: Response;
    try {
      res = await this.deps.fetch(`${API}/repos/${source.repo}${path}`, { method: "GET", headers, signal });
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status === 304 && cached) return { kind: "ok", part, entry: cached };
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      await res.body?.cancel().catch(() => undefined);
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(res.headers.get("retry-after"));
      const now = this.now().getTime();
      let until = now + this.cacheMs;
      if (res.headers.has("x-ratelimit-reset") && Number.isFinite(reset)) until = reset * 1000;
      else if (res.headers.has("retry-after") && Number.isFinite(retryAfter)) until = now + retryAfter * 1000;
      return { kind: "rate_limited", until };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) return { kind: "not_found" };
      if (res.status === 401 || res.status === 403) return { kind: "rejected" };
      return { kind: "unavailable" };
    }
    let body: string | null;
    try {
      body = await boundedText(res);
    } catch {
      return { kind: "unavailable" };
    }
    if (body === null) return { kind: "unavailable" };
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { kind: "unavailable" };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { kind: "unavailable" };
    return { kind: "ok", part, entry: { etag: res.headers.get("etag")?.slice(0, 200) ?? null, data: parsed.data } };
  }
}
