import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { ProjectFiles } from "@theterminal/shared";
import { api } from "../src/api";
import userEvent from "@testing-library/user-event";
import { HOME_KEY } from "../src/home/home-store";
import { HomeView } from "../src/views/HomeView";
import { RunTimelinePanel } from "../src/home/RunTimelinePanel";
import { asRole, homeModel, homeRun, renderInShell } from "./home-fixtures";
import { ev, message } from "./feed-fixtures";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const running = homeRun("r1", { progress: { steps: ["Fix the contact form", "Check it"], done: [], current: 1 } }, { title: "Fix the contact form", percent: 33 });
const finished = homeRun("r2", { status: "completed", finishedAt: new Date().toISOString() }, { title: "Write the notes", summary: "Notes are in NOTES.md" });

describe("HomeView", () => {
  it("shows a running card with the agent's percentage and a finished line, and no code", () => {
    const { container } = renderInShell(<HomeView />, homeModel({}, { working: [running], finishedToday: [finished] }));
    const card = screen.getByRole("article", { name: "Fix the contact form" });
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("33");
    expect(within(card).getByText("Claude · 6 min · $0.42")).toBeTruthy();
    expect(screen.getByText("Write the notes — Notes are in NOTES.md — done")).toBeTruthy();
    expect(container.querySelector("pre, .diff")).toBeNull();
  });

  it("shows Working… and no number for a run without a plan", () => {
    const { container } = renderInShell(<HomeView />, homeModel({}, { working: [homeRun("r1", { costUsd: null })], finishedToday: [] }));
    const card = screen.getByRole("article", { name: "Fix the contact form" });
    expect(within(card).getByText("Working…")).toBeTruthy();
    expect(within(card).getByText(/cost so far unknown/)).toBeTruthy();
    expect(container.querySelector(".home-working [aria-valuenow]")).toBeNull();
  });

  it("marks a waiting card and says why", () => {
    renderInShell(<HomeView />, homeModel({}, { working: [homeRun("r1", {}, { waiting: true, reason: "Change the form" })], finishedToday: [] }));
    const card = screen.getByRole("article", { name: "Fix the contact form" });
    expect(card.className).toContain("waiting");
    expect(within(card).getByText("Waiting for you: Change the form")).toBeTruthy();
  });

  it("shows the plan's steps with the current one marked", () => {
    const r = homeRun("r1", { progress: { steps: ["Read", "Change", "Check"], done: [1], current: 2 } }, { percent: 33 });
    renderInShell(<HomeView />, homeModel({}, { working: [r], finishedToday: [] }));
    expect(screen.getByText("Change").closest("li")?.getAttribute("aria-current")).toBe("step");
  });

  it("opens the run's timeline from its card", async () => {
    const { dock } = renderInShell(<HomeView />, homeModel({}, { working: [running], finishedToday: [] }));
    await userEvent.click(screen.getByRole("button", { name: "Fix the contact form" }));
    expect(dock.open).toHaveBeenCalledWith("timeline:r1", "Fix the contact form", "main");
  });

  it("clicking working in the strip switches to every project, and back", async () => {
    const model = homeModel({ status: { runningAgents: 2, todayCostUsd: 1.9, doneToday: 3 } as never });
    renderInShell(<HomeView />, model);
    const strip = screen.getByRole("region", { name: "Totals" });
    expect(within(strip).getByText("today")).toBeTruthy();
    expect(within(strip).getByText("$1.90")).toBeTruthy();
    await userEvent.click(within(strip).getByRole("button", { name: /2\s*working/ }));
    expect(model.home.setScope).toHaveBeenCalledWith("all");
    expect(within(strip).getByRole("button", { name: /2\s*working/ }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(within(strip).getByRole("button", { name: /2\s*working/ }));
    expect(model.home.setScope).toHaveBeenLastCalledWith("project");
  });

  it("need you moves focus to the approvals heading", async () => {
    renderInShell(<HomeView />, homeModel());
    const strip = screen.getByRole("region", { name: "Totals" });
    await userEvent.click(within(strip).getByRole("button", { name: /need you/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Needs your approval" }));
  });

  it("filters Working now to the selected project unless the filter is on", () => {
    const other = homeRun("r9", { projectId: "p2" }, { title: "Sort the photos", projectName: "Photos" });
    renderInShell(<HomeView />, homeModel({ home: { data: { working: [running, other], finishedToday: [] }, error: null, scope: "all", setScope: vi.fn(), refresh: vi.fn() } }));
    expect(screen.queryByRole("article", { name: "Sort the photos" })).toBeNull();
  });

  it("shows overall progress and how many work without a plan", () => {
    const a = homeRun("r1", { progress: { steps: ["a", "b"], done: [1], current: 2 } }, { title: "A", percent: 50 });
    const b = homeRun("r2", {}, { title: "B" });
    renderInShell(<HomeView />, homeModel({}, { working: [a, b], finishedToday: [] }));
    const block = screen.getByRole("region", { name: "Overall progress" });
    expect(within(block).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(within(block).getByText("1 working without a plan")).toBeTruthy();
  });

  it("names where the files came from and lists folders first", () => {
    renderInShell(<HomeView />, homeModel({
      projectFiles: {
        data: { source: { kind: "github", repo: "you/website", branch: "main" }, added: false, head: "h", truncated: false,
          entries: [{ name: "README.md", kind: "file", size: 3 }, { name: "src", kind: "dir", size: null }] },
        error: null, refresh: vi.fn(),
      },
    }));
    const block = screen.getByRole("region", { name: "Project files" });
    expect(within(block).getByText("from GitHub: you/website")).toBeTruthy();
    expect(within(block).getAllByRole("listitem").map((li) => li.textContent?.trim())).toEqual(["src", "README.md"].map((n) => expect.stringContaining(n)));
  });

  it("tells a viewer files are for reviewers", () => {
    renderInShell(<HomeView />, homeModel({ me: asRole("viewer") }));
    expect(screen.getByText("Files are shown to reviewers and above.")).toBeTruthy();
  });

  it("renders the default Home from a corrupt layout", () => {
    localStorage.setItem(HOME_KEY, "{not json");
    renderInShell(<HomeView />, homeModel());
    expect(screen.getByPlaceholderText("Tell an agent what you want…")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Project files" })).toBeTruthy();
  });

  it("shows the ask box to a maintainer and not to a reviewer", () => {
    renderInShell(<HomeView />, homeModel({ me: asRole("maintainer") }));
    expect(screen.getByPlaceholderText("Tell an agent what you want…")).toBeTruthy();
  });

  it("hides the ask box from a reviewer", () => {
    renderInShell(<HomeView />, homeModel({ me: asRole("reviewer") }));
    expect(screen.queryByPlaceholderText("Tell an agent what you want…")).toBeNull();
  });

  it("Go starts a run and keeps the prompt when starting failed", async () => {
    const onStartRun = vi.fn().mockResolvedValue(false);
    renderInShell(<HomeView />, homeModel({ onStartRun }));
    const box = screen.getByPlaceholderText("Tell an agent what you want…");
    await userEvent.type(box, "Fix the form");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onStartRun).toHaveBeenCalledWith("claude", "Fix the form", [], null, undefined, { autoCard: true });
    expect((box as HTMLTextAreaElement).value).toBe("Fix the form");
  });

  it("Go clears the prompt once the run started", async () => {
    renderInShell(<HomeView />, homeModel());
    const box = screen.getByPlaceholderText("Tell an agent what you want…");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Ask with" }), "codex");
    await userEvent.type(box, "Sort photos");
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
});

describe("RunTimelinePanel", () => {
  it("narrates the run's entries and links to the raw work", async () => {
    const model = homeModel({
      runs: [running.run],
      projectEntries: [ev(1, "agent.started", { runId: "r1", adapter: "claude", prompt: "Fix the contact form" }), message(2, "r1", "Looking at the form"), message(3, "r2", "Other run")],
    });
    const { nav, dock } = renderInShell(<RunTimelinePanel id="timeline:r1" />, model);
    expect(screen.getByText(/Looking at the form/)).toBeTruthy();
    expect(screen.queryByText(/Other run/)).toBeNull();
    expect(screen.queryByText("Open the Agents view for older steps")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(model.onSelectRun).toHaveBeenCalledWith("r1");
    expect(nav.showView).toHaveBeenCalledWith("changes");
    await userEvent.click(screen.getByRole("button", { name: "Agent feed" }));
    expect(dock.focus).toHaveBeenCalledWith("agent_feed");
    await userEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(dock.focus).toHaveBeenCalledWith("terminal");
  });

  it("says where older steps are when the start was not loaded", () => {
    renderInShell(<RunTimelinePanel id="timeline:r1" />, homeModel({ runs: [running.run], projectEntries: [message(2, "r1", "Later step")] }));
    expect(screen.getByText("Open the Agents view for older steps")).toBeTruthy();
  });
});

describe("Home sources", () => {
  const files = (source: ProjectFiles["source"]) => ({
    data: { source, added: false, head: "h", truncated: false, entries: [{ name: "readme.md", kind: "file" as const, size: 3 }] },
    error: null,
    refresh: vi.fn(),
  });
  const result = { commit: "c".repeat(40), files: 2, bytes: 2, skipped: [], skippedCount: 0 };

  it("adds chosen files to the project, showing how far it got, and cancels on request", async () => {
    vi.spyOn(api, "openUpload").mockResolvedValue({ uploadId: "u1" });
    let release: () => void = () => {};
    const put = vi.spyOn(api, "putUploadFile").mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>((ok) => (release = ok)));
    const cancel = vi.spyOn(api, "cancelUpload").mockResolvedValue(undefined);
    const commit = vi.spyOn(api, "commitUpload").mockResolvedValue(result);
    renderInShell(<HomeView />, homeModel({ me: asRole("maintainer"), projectFiles: files(null) }));
    const block = screen.getByRole("region", { name: "Project files" });
    await userEvent.upload(within(block).getByLabelText("Choose files"), [new File(["a"], "a.txt"), new File(["b"], "b.txt")]);
    expect(await within(block).findByText("Sending 1 of 2 files")).toBeTruthy();
    expect(within(block).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    await userEvent.click(within(block).getByRole("button", { name: "Cancel" }));
    release();
    expect(await within(block).findByText("Cancelled. Nothing was added.")).toBeTruthy();
    expect(put).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith("u1");
    expect(commit).not.toHaveBeenCalled();
  });

  it("says what was added", async () => {
    vi.spyOn(api, "openUpload").mockResolvedValue({ uploadId: "u1" });
    vi.spyOn(api, "putUploadFile").mockResolvedValue(undefined);
    vi.spyOn(api, "commitUpload").mockResolvedValue({ ...result, skippedCount: 1, skipped: [{ path: "CON.txt", reason: "unstorable" }] });
    const model = homeModel({ me: asRole("maintainer"), projectFiles: files(null) });
    renderInShell(<HomeView />, model);
    const block = screen.getByRole("region", { name: "Project files" });
    await userEvent.upload(within(block).getByLabelText("Choose files"), [new File(["a"], "a.txt"), new File(["b"], "b.txt")]);
    expect(await within(block).findByText(/Added 2 files/)).toBeTruthy();
    expect(within(block).getByText(/CON\.txt/)).toBeTruthy();
    expect(model.projectFiles.refresh).toHaveBeenCalled();
  });

  it("names possible secrets before sending anything, and sends them once ticked", async () => {
    const open = vi.spyOn(api, "openUpload").mockResolvedValue({ uploadId: "u1" });
    vi.spyOn(api, "putUploadFile").mockResolvedValue(undefined);
    vi.spyOn(api, "commitUpload").mockResolvedValue(result);
    renderInShell(<HomeView />, homeModel({ me: asRole("maintainer"), projectFiles: files(null) }));
    const block = screen.getByRole("region", { name: "Project files" });
    await userEvent.upload(within(block).getByLabelText("Choose files"), [new File(["a"], "a.txt"), new File(["K=TESTKEY"], ".env")]);
    expect(within(block).getByText(/These files may contain secrets: \.env/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    await userEvent.click(within(block).getByRole("checkbox", { name: "include files that may contain secrets" }));
    await userEvent.click(within(block).getByRole("button", { name: "Add them" }));
    expect(open).toHaveBeenCalledWith("p1", { files: 2, bytes: 10, includeSecrets: true });
  });

  it("offers no drop zone below maintainer", () => {
    renderInShell(<HomeView />, homeModel({ me: asRole("reviewer"), projectFiles: files(null) }));
    const block = screen.getByRole("region", { name: "Project files" });
    expect(within(block).queryByLabelText("Choose files")).toBeNull();
  });

  it("offers the Owner Apply to my folder for a folder project, and Publish to GitHub for a GitHub one", async () => {
    vi.spyOn(api, "writebackPreview").mockResolvedValue({ kind: "folder", head: "1".repeat(40), files: [{ path: "a.txt", change: "modify" }] });
    const { unmount } = renderInShell(<HomeView />, homeModel({ projectFiles: files({ kind: "folder" }) }));
    expect(screen.queryByRole("button", { name: "Publish to GitHub" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Apply to my folder…" }));
    expect(await screen.findByText("Write this 1 file to your folder?")).toBeTruthy();
    unmount();
    renderInShell(<HomeView />, homeModel({ projectFiles: files({ kind: "github", repo: "you/site", branch: "main" }) }));
    expect(screen.getByRole("button", { name: "Publish to GitHub…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply to my folder…" })).toBeNull();
  });

  it("offers write-back to nobody but the Owner", () => {
    renderInShell(<HomeView />, homeModel({ me: asRole("maintainer"), projectFiles: files({ kind: "github", repo: "you/site", branch: "main" }) }));
    expect(screen.queryByRole("button", { name: "Publish to GitHub…" })).toBeNull();
  });

  it("offers Accept these changes on a finished run, and Accepted once accepted", async () => {
    const done = homeRun("r2", { status: "completed", finishedAt: new Date().toISOString() }, { title: "Write the notes", summary: "Notes are in NOTES.md" });
    const accepted = homeRun("r3", { status: "completed", finishedAt: new Date().toISOString(), acceptedCommit: "a".repeat(40) }, { title: "Tidy up" });
    const onAcceptRun = vi.fn().mockResolvedValue(true);
    const runChanges = vi.fn().mockResolvedValue({ runId: "r2", base: "b", head: "h", files: [{ path: "NOTES.md", status: "added", added: 3, deleted: 0, binary: false }], truncated: false });
    renderInShell(<HomeView />, homeModel({ onAcceptRun, runChanges }, { working: [], finishedToday: [done, accepted] }));
    const block = screen.getByRole("region", { name: "Finished today" });
    await userEvent.click(within(block).getByRole("button", { name: "Accept these changes" }));
    expect(await within(block).findByText("NOTES.md")).toBeTruthy();
    await userEvent.click(within(block).getByRole("button", { name: "Accept" }));
    expect(onAcceptRun).toHaveBeenCalledWith("r2");
    await waitFor(() => expect(within(block).getAllByText("Accepted")).toHaveLength(2));
  });
});

describe("Home previews and screenshots", () => {
  const shots = (runId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sha256: String(i).repeat(64), runId, previewId: "pv1", device: "iphone16", width: 393, height: 852, bytes: 10, at: `2026-11-16T0${i}:00:00.000Z`,
    }));

  it("a Working now card of a run that offered a site has Preview, which opens its tab, and up to 3 thumbnails", async () => {
    const openPreview = vi.fn();
    const r = homeRun("r1", {}, { offers: ["web"], screenshots: shots("r1", 5) });
    renderInShell(<HomeView />, homeModel({ openPreview }, { working: [r], finishedToday: [] }));
    const card = screen.getByRole("article", { name: "Fix the contact form" });
    expect(within(card).getAllByRole("img")).toHaveLength(3);
    await userEvent.click(within(card).getByRole("button", { name: "Preview" }));
    expect(openPreview).toHaveBeenCalledWith("r1", "Fix the contact form");
  });

  it("a run that offered nothing has no Preview", () => {
    renderInShell(<HomeView />, homeModel({}, { working: [homeRun("r1", {}, { offers: [] })], finishedToday: [] }));
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("a Finished today line shows at most 3 thumbnails from 5", () => {
    const done = homeRun("r2", { status: "completed", finishedAt: new Date().toISOString() }, { title: "Write the notes", screenshots: shots("r2", 5), offers: ["ios"] });
    renderInShell(<HomeView />, homeModel({ openPreview: vi.fn() }, { working: [], finishedToday: [done] }));
    const block = screen.getByRole("region", { name: "Finished today" });
    const imgs = within(block).getAllByRole("img");
    expect(imgs).toHaveLength(3);
    expect(imgs[0]!.getAttribute("alt")).toBe("Screenshot on iPhone 16");
    expect(within(block).getByRole("button", { name: "Preview" })).toBeTruthy();
  });

  it("shows the Previews block after Finished today", () => {
    renderInShell(<HomeView />, homeModel());
    const order = [...document.querySelectorAll("[data-block]")].map((e) => e.getAttribute("data-block"));
    expect(order.indexOf("previews")).toBe(order.indexOf("finished") + 1);
    expect(screen.getByRole("region", { name: "Previews" })).toBeTruthy();
  });
});
