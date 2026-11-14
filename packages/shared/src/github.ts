export type CiState = "passing" | "failing" | "running" | "unknown";

export type CiStatus = { state: CiState; url: string | null; branch: string | null; updatedAt: string | null };

/** What the GitHub view shows for the connection's repository. */
export type GitHubOverview = {
  repo: { fullName: string; defaultBranch: string; htmlUrl: string; private: boolean };
  branches: { name: string; isDefault: boolean }[];
  pulls: { number: number; title: string; headRef: string; baseRef: string; draft: boolean; htmlUrl: string; updatedAt: string }[];
  ciRuns: { id: number; name: string; status: string; conclusion: string | null; headBranch: string; htmlUrl: string; updatedAt: string }[];
  ci: CiStatus;
  fetchedAt: string;
  /** Served from the cache after a failed refresh. */
  stale: boolean;
};
