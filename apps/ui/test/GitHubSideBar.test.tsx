import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitHubOverview } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { GitHubSideBar } from "../src/views/GitHubSideBar";
import { fakeDock } from "./connections-harness";

const html = "https://github.com/octo-org/example";
const overview = (over: Partial<GitHubOverview> = {}): GitHubOverview => ({
  repo: { fullName: "octo-org/example", defaultBranch: "main", htmlUrl: html, private: false },
  branches: [{ name: "main", isDefault: true }, { name: "feature/x", isDefault: false }],
  pulls: [
    { number: 7, title: "Add the thing", headRef: "feature/x", baseRef: "main", draft: true, htmlUrl: `${html}/pull/7`, updatedAt: "2026-11-01T00:00:00Z" },
    { number: 8, title: "Fix the other thing", headRef: "fix", baseRef: "main", draft: false, htmlUrl: `${html}/pull/8`, updatedAt: "2026-11-01T00:00:00Z" },
  ],
  ciRuns: [
    { id: 1, name: "CI", status: "completed", conclusion: "success", headBranch: "main", htmlUrl: `${html}/actions/runs/1`, updatedAt: "2026-11-01T00:00:00Z" },
    { id: 2, name: "Lint", status: "completed", conclusion: "failure", headBranch: "feature/x", htmlUrl: `${html}/actions/runs/2`, updatedAt: "2026-11-01T00:00:00Z" },
    { id: 3, name: "E2E", status: "in_progress", conclusion: null, headBranch: "fix", htmlUrl: `${html}/actions/runs/3`, updatedAt: "2026-11-01T00:00:00Z" },
  ],
  ci: { state: "passing", url: `${html}/actions/runs/1`, branch: "main", updatedAt: "2026-11-01T00:00:00Z" },
  fetchedAt: "2026-11-15T12:00:00Z",
  stale: false,
  ...over,
});

function renderSideBar(github: Partial<WorkbenchModel["github"]>) {
  const refresh = vi.fn();
  const selectView = vi.fn();
  const model = { github: { overview: null, error: null, refresh, ...github } } as unknown as WorkbenchModel;
  render(
    <ShellContext.Provider value={{ model, dock: () => fakeDock(), selectView }}>
      <GitHubSideBar />
    </ShellContext.Provider>,
  );
  return { refresh, selectView };
}

afterEach(() => vi.useRealTimers());

describe("GitHubSideBar", () => {
  it("shows the repository, its branches, pull requests and CI runs", () => {
    renderSideBar({ overview: overview() });
    expect(screen.getByRole("link", { name: "octo-org/example" }).getAttribute("href")).toBe(html);
    expect(screen.getByText("Default branch: main")).toBeTruthy();

    const branches = screen.getByRole("region", { name: "Branches" });
    expect(within(branches).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["main", "feature/x"]);

    const pulls = screen.getByRole("region", { name: "Pull requests" });
    expect(within(pulls).getByRole("link", { name: "#7 Add the thing" }).getAttribute("href")).toBe(`${html}/pull/7`);
    expect(within(pulls).getByRole("link", { name: "#8 Fix the other thing" })).toBeTruthy();
    expect(within(pulls).getAllByText("draft")).toHaveLength(1);

    const runs = within(screen.getByRole("region", { name: "CI runs" })).getAllByRole("listitem");
    expect(runs[0]!.textContent).toContain("CI");
    expect(runs[0]!.textContent).toContain("main");
    expect(runs[0]!.textContent).toContain("passing");
    expect(within(runs[0]!).getByRole("link").getAttribute("href")).toBe(`${html}/actions/runs/1`);
    expect(runs[1]!.textContent).toContain("failing");
    expect(runs[2]!.textContent).toContain("running");
    expect(screen.queryByText(/rate-limiting/)).toBeNull();
  });

  it("notes stale data", () => {
    renderSideBar({ overview: overview({ stale: true }) });
    expect(screen.getByText("Showing the last loaded data; GitHub is rate-limiting requests.")).toBeTruthy();
  });

  it("asks to connect GitHub and opens Connections", async () => {
    const { selectView } = renderSideBar({ error: "github_not_connected" });
    expect(screen.getByText("Connect GitHub and set a repository in Connections.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Connections" }));
    expect(selectView).toHaveBeenCalledWith("connections");
  });

  it.each([
    ["repo_not_found", "Repository not found, or the token has no access to it"],
    ["github_rejected", "GitHub rejected the token"],
    ["github_unavailable", "Could not reach GitHub"],
  ])("shows the copy for %s", (error, copy) => {
    renderSideBar({ error, overview: overview() });
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByText("Default branch: main")).toBeNull();
  });

  it("refreshes when opened and every 60 s while open", () => {
    vi.useFakeTimers();
    const { refresh } = renderSideBar({});
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
