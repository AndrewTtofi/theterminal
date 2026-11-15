import { useEffect, useId, useRef } from "react";
import type { GitHubOverview } from "@theterminal/shared";
import { useShell } from "../shell/model";

const REFRESH_MS = 60_000;

const ERROR_COPY: Record<string, string> = {
  repo_not_found: "Repository not found, or the token has no access to it",
  github_rejected: "GitHub rejected the token",
  github_unavailable: "Could not reach GitHub",
};

/** Added to a stale or failed overview's note when the server inferred that the internet is unreachable. */
const OFFLINE_SUFFIX = " You seem to be offline.";

const RUNNING = new Set(["queued", "in_progress", "waiting", "pending"]);
const FAILING = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** The word shown for a run: passing, failing or running, else GitHub's own conclusion or status. */
function runWord(run: GitHubOverview["ciRuns"][number]): string {
  if (RUNNING.has(run.status)) return "running";
  if (run.conclusion === "success") return "passing";
  if (run.conclusion !== null && FAILING.has(run.conclusion)) return "failing";
  return run.conclusion ?? run.status;
}

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Read-only view of the connected repository: branches, open pull requests and recent CI runs. */
export function GitHubSideBar() {
  const { model, showView } = useShell();
  const { overview, error, refresh } = model.github;
  const offline = model.status?.network.state === "offline" ? OFFLINE_SUFFIX : "";
  const uid = useId();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Mounted while the GitHub view is open: load on open, then every 60 s.
  useEffect(() => {
    refreshRef.current();
    const timer = setInterval(() => refreshRef.current(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  if (error === "github_not_connected") {
    return (
      <div className="github-side">
        <p className="empty">Connect GitHub and set a repository in Connections.</p>
        <button type="button" onClick={() => showView("connections")}>
          Open Connections
        </button>
      </div>
    );
  }
  if (error) {
    const copy = ERROR_COPY[error] ?? ERROR_COPY.github_unavailable;
    return <p className="empty">{offline ? `${copy}.${offline}` : copy}</p>;
  }
  if (!overview) return <p className="empty">Loading…</p>;

  return (
    <div className="github-side">
      <header className="github-repo">
        <a href={overview.repo.htmlUrl} {...external}>
          {overview.repo.fullName}
        </a>
        <p>{`Default branch: ${overview.repo.defaultBranch}`}</p>
      </header>
      {overview.stale && <p className="github-stale">{`Showing the last loaded data; GitHub is rate-limiting requests.${offline}`}</p>}
      <section aria-labelledby={`${uid}-branches`}>
        <h3 id={`${uid}-branches`}>Branches</h3>
        <ul>
          {overview.branches.map((b) => (
            <li key={b.name}>{b.name}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby={`${uid}-pulls`}>
        <h3 id={`${uid}-pulls`}>Pull requests</h3>
        {overview.pulls.length === 0 ? (
          <p className="empty">No open pull requests</p>
        ) : (
          <ul>
            {overview.pulls.map((p) => (
              <li key={p.number}>
                <a href={p.htmlUrl} {...external}>{`#${p.number} ${p.title}`}</a>
                {p.draft && <span className="github-draft">draft</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={`${uid}-runs`}>
        <h3 id={`${uid}-runs`}>CI runs</h3>
        {overview.ciRuns.length === 0 ? (
          <p className="empty">No runs</p>
        ) : (
          <ul>
            {overview.ciRuns.map((r) => (
              <li key={r.id}>
                <a href={r.htmlUrl} {...external}>
                  {r.name || "Run"}
                </a>{" "}
                <span className="github-branch">{r.headBranch}</span>{" "}
                <span className={`github-run-${runWord(r)}`}>{runWord(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
