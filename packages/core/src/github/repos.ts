import { Readable, Transform, pipeline } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import type { GitHubRepoChoice } from "@theterminal/shared";
import {
  GitHubNotConnectedError,
  GitHubRejectedError,
  GitHubRepoNotFoundError,
  GitHubUnavailableError,
  REPO_NAME,
  boundedText,
} from "./client.js";

/** A repository the person can pick to start a project from (the shared type of the API contract). */
export type { GitHubRepoChoice };

export type GitHubToken = { connectionId: string; token: string } | null;

export type GitHubReposDeps = {
  fetch: typeof fetch;
  token: () => GitHubToken;
  /** Per API call (default 30 s). */
  timeoutMs?: number;
  /** A download that sends nothing for this long is cut off (default 60 s); there is no total deadline. */
  idleTimeoutMs?: number;
};

export type PublishFile = { path: string; mode: "100644" | "100755"; content: Buffer | null };
export type PublishInput = { base: string; into: string; branch: string; files: PublishFile[]; title: string; body: string };

const API = "https://api.github.com";
const CODELOAD = "https://codeload.github.com";
/** 200 MiB: the compressed archive is refused beyond this. */
const MAX_ARCHIVE_BYTES = 209_715_200;
const TEXT_MAX = 500;
const SHA = /^[0-9a-f]{40}$/;
/** A branch name safe to place in a URL path segment and a ref. */
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

const text = z.string().transform((s) => s.slice(0, TEXT_MAX));
const sha = z.string().regex(SHA);

// zod objects drop every key they do not name, so logins, emails and descriptions go no further.
const reposSchema = z
  .array(z.object({ full_name: text, default_branch: text, private: z.boolean() }))
  .transform((rs) =>
    rs
      .slice(0, 100)
      .filter((r) => REPO_NAME.test(r.full_name))
      .map((r): GitHubRepoChoice => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private })),
  );
const repoSchema = z.object({ default_branch: z.string().regex(BRANCH) });
const shaSchema = z.object({ sha });
const commitSchema = z.object({ tree: z.object({ sha }) });
const pullSchema = z.object({ html_url: z.string().max(2000).regex(/^https:\/\/github\.com\//) });

/**
 * The person's GitHub repositories: list them, read a head, download an archive and publish a branch with a pull
 * request. The token goes only in the Authorization header of requests to api.github.com: never in a URL, a body, an
 * error message, or the request that follows the archive redirect.
 */
export class GitHubRepos {
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly deps: GitHubReposDeps) {
    this.timeoutMs = deps.timeoutMs ?? 30_000;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 60_000;
  }

  /** The first 100 repositories, most recently updated first. */
  listRepos(): Promise<GitHubRepoChoice[]> {
    return this.call("GET", "/user/repos?per_page=100&sort=updated", reposSchema);
  }

  /** The default branch and its newest commit. */
  async head(repo: string): Promise<{ branch: string; commit: string }> {
    checkRepo(repo);
    const { default_branch: branch } = await this.call("GET", `/repos/${repo}`, repoSchema);
    const { sha: commit } = await this.call("GET", `/repos/${repo}/commits/${encodeURIComponent(branch)}`, shaSchema);
    return { branch, commit };
  }

  /**
   * The gzip tar archive of `commit`. GitHub answers with a redirect; only one to codeload.github.com is followed, and
   * without the token. The archive is cut off past 200 MiB or after a minute without data.
   */
  async tarball(repo: string, commit: string, signal: AbortSignal): Promise<Readable> {
    checkRepo(repo);
    if (!SHA.test(commit)) throw new GitHubUnavailableError("Invalid commit");
    const auth = this.authHeaders();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    if (signal.aborted) throw signal.reason ?? new GitHubUnavailableError("Download cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    const detach = () => signal.removeEventListener("abort", onAbort);
    let handedOver = false;
    try {
      const first = await this.send(`${API}/repos/${repo}/tarball/${commit}`, {
        method: "GET", headers: auth, redirect: "manual", signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
      await first.body?.cancel().catch(() => undefined);
      if (first.status < 300 || first.status >= 400) throw errorFor(first);
      const location = codeloadUrl(first.headers.get("location"));
      if (!location) throw new GitHubUnavailableError("GitHub redirected the download somewhere unexpected");

      const headerTimer = setTimeout(() => ctl.abort(new GitHubUnavailableError("GitHub did not answer")), this.timeoutMs);
      let res: Response;
      try {
        // A fresh header set: the token never leaves for codeload.github.com, and no further redirect is followed.
        res = await this.send(location, { method: "GET", headers: { Accept: "application/octet-stream" }, redirect: "error", signal: ctl.signal });
      } finally {
        clearTimeout(headerTimer);
      }
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new GitHubUnavailableError("Could not download the repository");
      }
      const declared = Number(res.headers.get("content-length"));
      if (res.headers.has("content-length") && Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
        await res.body.cancel().catch(() => undefined);
        throw new GitHubUnavailableError("The repository archive is larger than 200 MB");
      }
      const out = this.boundedDownload(res.body, ctl, detach);
      handedOver = true;
      return out;
    } finally {
      if (!handedOver) detach();
    }
  }

  /**
   * One commit with the combined change, on a new branch, and a pull request against `into`. Never moves an existing
   * branch: the only ref written is the new `refs/heads/<branch>`.
   */
  async publish(repo: string, i: PublishInput): Promise<{ branch: string; pullUrl: string }> {
    checkRepo(repo);
    if (!SHA.test(i.base)) throw new GitHubUnavailableError("Invalid base commit");
    if (!BRANCH.test(i.branch) || !BRANCH.test(i.into)) throw new GitHubUnavailableError("Invalid branch name");
    for (const f of i.files) {
      const segments = f.path.split("/");
      if (!f.path || f.path.startsWith("/") || f.path.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
        throw new GitHubUnavailableError("Invalid file path");
      }
    }
    const at = `/repos/${repo}`;
    const { tree: baseTree } = await this.call("GET", `${at}/git/commits/${i.base}`, commitSchema);
    const tree: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const f of i.files) {
      let blob: string | null = null;
      if (f.content !== null) {
        ({ sha: blob } = await this.call("POST", `${at}/git/blobs`, shaSchema, { content: f.content.toString("base64"), encoding: "base64" }));
      }
      tree.push({ path: f.path, mode: f.mode, type: "blob", sha: blob });
    }
    const { sha: treeSha } = await this.call("POST", `${at}/git/trees`, shaSchema, { base_tree: baseTree.sha, tree });
    const { sha: commit } = await this.call("POST", `${at}/git/commits`, shaSchema, { message: i.title, tree: treeSha, parents: [i.base] });
    await this.call("POST", `${at}/git/refs`, z.unknown(), { ref: `refs/heads/${i.branch}`, sha: commit });
    const pull = await this.call("POST", `${at}/pulls`, pullSchema, { title: i.title, body: i.body, head: i.branch, base: i.into });
    return { branch: i.branch, pullUrl: pull.html_url };
  }

  private authHeaders(): Record<string, string> {
    const t = this.deps.token();
    if (!t) throw new GitHubNotConnectedError("GitHub is not connected");
    return {
      Authorization: `Bearer ${t.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.deps.fetch(url, init);
    } catch {
      throw new GitHubUnavailableError("Could not reach GitHub");
    }
  }

  /** One JSON request to api.github.com, its answer read through a bounded body and cut down by `schema`. */
  private async call<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const headers = this.authHeaders();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.send(`${API}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => undefined);
      throw errorFor(res);
    }
    let raw: string | null;
    try {
      raw = await boundedText(res);
    } catch {
      throw new GitHubUnavailableError("Could not reach GitHub");
    }
    if (raw === null) throw new GitHubUnavailableError("GitHub sent an oversized answer");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new GitHubUnavailableError("GitHub sent a malformed answer");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new GitHubUnavailableError("GitHub sent an unexpected answer");
    return parsed.data;
  }

  /** The archive as a Node stream that fails past 200 MiB or when no data arrives for `idleTimeoutMs`. */
  private boundedDownload(body: ReadableStream<Uint8Array>, ctl: AbortController, detach: () => void): Readable {
    let size = 0;
    const fail = (err: Error) => {
      ctl.abort(err);
      out.destroy(err);
    };
    const idle = setTimeout(() => fail(new GitHubUnavailableError("The download stalled")), this.idleTimeoutMs);
    const out = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > MAX_ARCHIVE_BYTES) return done(new GitHubUnavailableError("The repository archive is larger than 200 MB"));
        idle.refresh();
        done(null, chunk);
      },
    });
    const source = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
    pipeline(source, out, (err) => {
      clearTimeout(idle);
      detach();
      if (err) ctl.abort(err);
    });
    return out;
  }
}

function checkRepo(repo: string): void {
  if (!REPO_NAME.test(repo)) throw new GitHubRepoNotFoundError("Repository not found");
}

/** The redirect target when it is an https URL on codeload.github.com with no credentials, else null. */
function codeloadUrl(location: string | null): string | null {
  if (!location) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.origin !== CODELOAD || url.username || url.password) return null;
  return url.href;
}

/** A fixed error for a status: nothing from the answer is echoed. */
function errorFor(res: Response): Error {
  const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  if (rateLimited) return new GitHubUnavailableError("GitHub is rate-limiting requests");
  if (res.status === 404) return new GitHubRepoNotFoundError("Repository not found");
  if (res.status === 401 || res.status === 403) return new GitHubRejectedError("GitHub rejected the token");
  return new GitHubUnavailableError("Could not reach GitHub");
}
