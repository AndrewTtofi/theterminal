import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRun, Board, LedgerEntry } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { ConversationPanel, conversationThread } from "../src/views/ConversationPanel";
import { fakeDock, shellNav } from "./connections-harness";
import { decided, ev, feedRun, message, requested } from "./feed-fixtures";

const login = { id: "c1", projectId: "p1", title: "Login", stage: "build", status: "todo", createdAt: "", updatedAt: "" } as const;
const board: Board = {
  project: { id: "p1", name: "Demo", pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [{ ...login }], ship: [], operate: [] },
};

// Listed newest first, as the server sends them.
const runs: AgentRun[] = [
  feedRun("run2", { prompt: "Write the docs", startedAt: "2026-11-15T11:00:00.000Z", status: "running" }),
  feedRun("run1", { prompt: "Add a login form", cardId: "c1", costUsd: 0.1, startedAt: "2026-11-15T10:00:00.000Z" }),
];
const entries: LedgerEntry[] = [
  message(1, "run1", "Looking at the form"),
  requested(2, "run1", "a1", "npm test"),
  decided(3, "run1", "a1", "allow"),
  requested(4, "run1", "a2", "rm -rf build"),
  decided(5, "run1", "a2", "deny", "not now"),
  message(6, "run1", "Done"),
  message(7, "run2", "Reading the README"),
  ev(8, "card.created", { cardId: "c2", title: "Docs", stage: "plan" }),
];

function renderPanel(over: Partial<WorkbenchModel> = {}) {
  const dock = fakeDock();
  const nav = shellNav();
  const model = {
    selectedId: "p1",
    board,
    runs,
    projectEntries: entries,
    agentsInfo: { adapters: ["fake"], providers: {} },
    connections: { list: [] },
    onStartRun: vi.fn().mockResolvedValue(true),
    onSelectChangesRun: vi.fn(),
    projectOlder: { hasOlder: false, loading: false, error: null },
    onLoadOlderProject: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as WorkbenchModel;
  const wrap = (m: WorkbenchModel) => (
    <ShellContext.Provider value={{ model: m, dock: () => dock, ...nav } satisfies ShellContextValue}>
      <ConversationPanel />
    </ShellContext.Provider>
  );
  const r = render(wrap(model));
  return { model, nav, dock, rerender: (o: Partial<WorkbenchModel>) => r.rerender(wrap({ ...model, ...o })) };
}

const panel = () => screen.getByRole("region", { name: "Conversation" });
const articles = () => within(panel()).getAllByRole("article");

describe("conversationThread", () => {
  it("lists runs oldest first with their card, messages and action counts", () => {
    const thread = conversationThread(runs, entries, [{ ...login }]);
    expect(thread.map((t) => t.run.id)).toEqual(["run1", "run2"]);
    expect(thread[0]).toMatchObject({
      cardTitle: "Login",
      messages: ["Looking at the form", "Done"],
      actions: { total: 2, allowed: 1, denied: 1 },
    });
    expect(thread[1]).toMatchObject({ cardTitle: null, messages: ["Reading the README"], actions: { total: 0, allowed: 0, denied: 0 } });
  });

  it("marks a run partial while older entries are not loaded and its start is not among the loaded ones", () => {
    const started = ev(0, "agent.started", { runId: "run2", adapter: "fake", authMode: "none", prompt: "Write the docs", cardId: null, worktree: "w/run2" });
    const thread = conversationThread(runs, [started, ...entries], [{ ...login }], true);
    expect(thread.map((t) => [t.run.id, t.partial])).toEqual([["run1", true], ["run2", false]]);
    expect(conversationThread(runs, entries, [{ ...login }]).every((t) => !t.partial)).toBe(true);
  });

  it("gives a run whose card left the project no card title", () => {
    expect(conversationThread([runs[1]!], [], [])[0]!.cardTitle).toBeNull();
  });
});

describe("ConversationPanel", () => {
  it("asks for a project without one", () => {
    renderPanel({ selectedId: null, board: null });
    expect(panel().textContent).toBe("Select or create a project.");
  });

  it("shows each ask with its prompt, what the agent said and the result", () => {
    renderPanel();
    const [first, second] = articles();
    expect(within(first!).getByRole("heading").textContent).toBe('You asked Fake on "Login"');
    expect(first!.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-15T10:00:00.000Z");
    expect(first!.querySelector("blockquote")?.textContent).toBe("Add a login form");
    expect([...first!.querySelectorAll("p.agent-says")].map((p) => p.textContent)).toEqual(["Looking at the form", "Done"]);
    expect(first!.querySelector(".result")?.textContent).toBe("completed · 2 actions, 1 allowed, 1 denied · $0.10 (estimate)");
    expect(within(second!).getByRole("heading").textContent).toBe("You asked Fake");
    expect(second!.querySelector(".result")?.textContent).toBe("running · 0 actions, 0 allowed, 0 denied");
    expect(within(second!).queryByRole("button", { name: "Story" })).toBeNull();
  });

  it("says when a finished run reported no cost, and never shows it as $0.00", () => {
    renderPanel({ runs: [feedRun("run1", { costUsd: null })], projectEntries: [] });
    expect(articles()[0]!.querySelector(".result")?.textContent).toBe("completed · 0 actions, 0 allowed, 0 denied · cost not reported");
  });

  it("shows prompts and messages as text, with terminal codes dropped and hidden characters made visible", () => {
    renderPanel({
      runs: [feedRun("run1", { prompt: "<b>bold</b> \u202eevil" })],
      projectEntries: [message(1, "run1", "\u001b[32mOK\u001b[0m <img src=x>")],
    });
    const [a] = articles();
    expect(a!.querySelector("blockquote")?.textContent).toBe("<b>bold</b> \\u202eevil");
    expect(a!.querySelector("p.agent-says")?.textContent).toBe("OK <img src=x>");
    expect(a!.querySelector("b, img")).toBeNull();
  });

  it("opens the run's changes and the card's story", async () => {
    const { model, nav, dock } = renderPanel();
    const [first] = articles();
    await userEvent.click(within(first!).getByRole("button", { name: "Changes" }));
    expect(model.onSelectChangesRun).toHaveBeenCalledWith("run1");
    expect(nav.showView).toHaveBeenCalledWith("changes");
    await userEvent.click(within(first!).getByRole("button", { name: "Story" }));
    expect(dock.open).toHaveBeenCalledWith("story:c1", "Login", "main");
  });

  it("asks an agent for a change", async () => {
    const { model } = renderPanel();
    const ask = within(panel()).getByRole("region", { name: "Ask an agent" });
    expect(ask.textContent).toContain(
      "Agents do the work. Describe what should change; the agent will ask before anything that affects your files or accounts.",
    );
    await userEvent.selectOptions(within(ask).getByLabelText("Card (optional)"), "c1");
    await userEvent.type(within(ask).getByLabelText("Prompt"), "Add a logout button");
    await userEvent.click(within(ask).getByRole("button", { name: "Ask" }));
    expect(model.onStartRun).toHaveBeenCalledWith("fake", "Add a logout button", [], "c1");
  });

  it("invites a first ask when nothing has been asked", () => {
    renderPanel({ runs: [], projectEntries: [] });
    expect(within(panel()).queryAllByRole("article")).toHaveLength(0);
    expect(panel().textContent).toContain("Nothing asked yet.");
  });

  it("keeps the newest answer in view as it arrives, unless the Owner has scrolled up", () => {
    const { rerender } = renderPanel();
    const list = within(panel()).getByRole("list", { name: "Asks and answers" });
    expect(list.tabIndex).toBe(0);
    const g = { scrollHeight: 1000, clientHeight: 200 };
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => g.clientHeight });
    // A new message in the newest run, with no new run: still followed.
    rerender({ projectEntries: [...entries, message(9, "run2", "Found it")] });
    expect(list.scrollTop).toBe(1000);

    act(() => {
      list.scrollTop = 500;
      fireEvent.scroll(list);
    });
    g.scrollHeight = 1200;
    rerender({ projectEntries: [...entries, message(9, "run2", "Found it"), message(10, "run2", "Writing")] });
    expect(list.scrollTop).toBe(500);
    fireEvent.click(within(panel()).getByRole("button", { name: /Jump to latest/ }));
    expect(list.scrollTop).toBe(1200);
  });

  describe("with older entries not loaded", () => {
    const older = { hasOlder: true, loading: false, error: null };

    it("says earlier asks may be incomplete and loads older entries", async () => {
      const { model } = renderPanel({ projectOlder: older });
      expect(panel().textContent).toContain("Older entries are not loaded, so earlier asks may be missing answers or action counts.");
      await userEvent.click(within(panel()).getByRole("button", { name: "Load older" }));
      expect(model.onLoadOlderProject).toHaveBeenCalledTimes(1);
    });

    it("never shows 0 actions for a run whose start is not loaded", () => {
      renderPanel({ projectOlder: older, projectEntries: [], runs: [feedRun("run1", { costUsd: 0.1 })] });
      expect(articles()[0]!.querySelector(".result")?.textContent).toBe("completed · action counts unavailable · $0.10 (estimate)");
    });

    it("disables Load older while it loads and shows why it failed", () => {
      renderPanel({ projectOlder: { hasOlder: true, loading: true, error: "offline" } });
      expect((within(panel()).getByRole("button", { name: "Load older" }) as HTMLButtonElement).disabled).toBe(true);
      expect(within(panel()).getByRole("alert").textContent).toBe("Older entries could not be loaded: offline");
    });

    it("shows no note once everything is loaded", () => {
      renderPanel();
      expect(within(panel()).queryByRole("button", { name: "Load older" })).toBeNull();
    });
  });

  it("labels each ask by its heading", () => {
    renderPanel();
    for (const a of articles()) {
      const id = a.getAttribute("aria-labelledby");
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)).toBe(within(a).getByRole("heading"));
    }
    expect(screen.getByRole("article", { name: 'You asked Fake on "Login"' })).toBeTruthy();
  });

  it("puts focus back in the prompt after an ask and announces it", async () => {
    renderPanel();
    const ask = within(panel()).getByRole("region", { name: "Ask an agent" });
    const box = within(ask).getByLabelText("Prompt");
    await userEvent.type(box, "Add a logout button");
    await userEvent.click(within(ask).getByRole("button", { name: "Ask" }));
    expect(document.activeElement).toBe(box);
    const status = within(ask).getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Asked Fake.");
  });
  it("passes the inferred offline state to the ask form", () => {
    const network = { state: "offline", basis: "inferred", since: null, lastError: "ENOTFOUND" };
    renderPanel({ agentsInfo: { adapters: ["claude"], providers: {} }, status: { network } } as unknown as Partial<WorkbenchModel>);
    const ask = within(panel()).getByRole("region", { name: "Ask an agent" });
    expect(within(ask).getByText("You seem to be offline. Cloud models will not answer; a local model will.")).toBeTruthy();
  });
});
