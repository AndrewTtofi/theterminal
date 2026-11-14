import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Board, LedgerEntry } from "@theterminal/shared";

const h = vi.hoisted(() => {
  const subs = new Set<{ after: number; cb: (e: LedgerEntry) => void }>();
  return {
    subs,
    /** Delivers an entry to every open ledger subscription. */
    onEntry: undefined as undefined | ((e: LedgerEntry) => void),
  };
});

vi.mock("../src/api", () => ({
  api: {
    health: vi.fn(),
    listProjects: vi.fn(),
    getBoard: vi.fn(),
    listLedger: vi.fn(),
    addCard: vi.fn(),
    moveCard: vi.fn(),
    createProject: vi.fn(),
    getAgents: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    listPendingActions: vi.fn(),
    listAllPendingActions: vi.fn(),
    decideAction: vi.fn(),
    startRun: vi.fn(),
    stopRun: vi.fn(),
    setClaudeAuth: vi.fn(),
  },
  errorMessage: () => "err",
  subscribeLedger: (after: number, cb: (e: LedgerEntry) => void) => {
    const sub = { after, cb };
    h.subs.add(sub);
    h.onEntry = (e) => {
      for (const s of [...h.subs]) s.cb(e);
    };
    return () => h.subs.delete(sub);
  },
}));

import { api } from "../src/api";
import { App } from "../src/App";

const mk = (id: string): Board => ({
  project: { id, name: `Project ${id}`, pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
});
const m = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
  h.onEntry = undefined;
  h.subs.clear();
  m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false, headSeq: 7 });
  m.listProjects.mockResolvedValue([mk("A").project, mk("B").project]);
  m.listLedger.mockResolvedValue([]);
  m.getAgents.mockResolvedValue({ adapters: ["fake"], claudeAuthMode: "api_key", subscriptionAck: "ack" });
  m.listRuns.mockResolvedValue([]);
  m.listPendingActions.mockResolvedValue([]);
  m.listAllPendingActions.mockResolvedValue([]);
});

describe("App board refresh", () => {
  it("never shows the old project's board after switching while a refresh is pending", async () => {
    let resolveStale!: (b: Board) => void;
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.addCard.mockResolvedValue({} as never);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });

    m.getBoard.mockImplementationOnce(() => new Promise<Board>((r) => (resolveStale = r)));
    await userEvent.type(screen.getByLabelText("Add card to Plan"), "x{Enter}");
    await waitFor(() => expect(m.getBoard).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Project B" }));
    await screen.findByRole("heading", { name: "Project B" });
    await act(async () => resolveStale(mk("A")));
    expect(screen.queryByRole("heading", { name: "Project A" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Project B" })).toBeTruthy();
  });

  it("coalesces a burst of entries into at most 2 board fetches", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await waitFor(() => expect(h.subs.size).toBe(2)); // the strip's and the project's
    m.getBoard.mockClear();
    await act(async () => {
      for (let seq = 1; seq <= 20; seq++) {
        h.onEntry!({
          seq, id: String(seq), ts: "2026-01-01T00:00:00Z", projectId: "A",
          actor: { kind: "human", id: "owner" }, type: "card.moved",
          payload: { from: "plan", to: "build" }, prevHash: "", hash: "",
        });
      }
    });
    await waitFor(() => expect(m.getBoard).toHaveBeenCalled());
    expect(m.getBoard.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("App initial load", () => {
  it("still renders the board when the ledger fails to load", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listLedger.mockRejectedValue(new Error("ledger down"));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    expect(await screen.findByRole("heading", { name: "Project A" })).toBeTruthy();
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});

describe("App needs-you strip", () => {
  const pendingAction = (id: string, projectId: string, summary: string) =>
    ({
      id, runId: `r-${id}`, kind: "shell", tool: "Bash", summary, input: {}, status: "pending", decidedBy: null,
      reason: "", output: null, requestedAt: "", decidedAt: null, projectId, projectName: `Project ${projectId}`,
    }) as const;
  const agentEntry = (seq: number, projectId: string) =>
    ({
      id: `e${seq}`, seq, ts: "", projectId, type: "agent.action.requested",
      actor: { kind: "agent", id: "r1" }, payload: {}, prevHash: "", hash: "",
    }) as LedgerEntry;

  it("shows pending actions from every project, with no project selected, each with its project name", async () => {
    m.listAllPendingActions.mockResolvedValue([pendingAction("a1", "A", "run ls"), pendingAction("b1", "B", "run make")]);
    render(<App />);
    const strip = await screen.findByRole("region", { name: "Needs you" });
    expect(screen.getByText("Select or create a project.")).toBeTruthy();
    const cards = strip.querySelectorAll("article");
    expect([...cards].map((c) => c.getAttribute("aria-label"))).toEqual(["Decision: run ls", "Decision: run make"]);
    expect(cards[0]!.textContent).toContain("Project A");
    expect(cards[1]!.textContent).toContain("Project B");
    expect(m.listPendingActions).not.toHaveBeenCalled();
  });

  it("subscribes from the ledger head and refreshes on any agent entry, whatever project is selected", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listAllPendingActions.mockResolvedValueOnce([]).mockResolvedValue([pendingAction("b1", "B", "run make")]);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await waitFor(() => expect([...h.subs].map((x) => x.after)).toContain(7));
    expect(screen.queryByText("Needs you")).toBeNull();
    act(() => h.onEntry?.(agentEntry(8, "B")));
    expect(await screen.findByText("Agent wants to: run make")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Needs you" }).textContent).toContain("Project B");
  });

  it("does not refresh the strip for non-agent entries", async () => {
    render(<App />);
    await waitFor(() => expect(h.subs.size).toBe(1));
    await waitFor(() => expect(m.listAllPendingActions).toHaveBeenCalledTimes(1));
    act(() => h.onEntry?.({ ...agentEntry(8, "B"), type: "card.moved" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.listAllPendingActions).toHaveBeenCalledTimes(1);
  });

  it("refreshes the strip after a decision", async () => {
    m.listAllPendingActions.mockResolvedValueOnce([pendingAction("a1", "A", "run ls")]).mockResolvedValue([]);
    m.decideAction.mockResolvedValue({} as never);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(m.decideAction.mock.calls[0]!.slice(0, 2)).toEqual(["a1", "allow"]);
    await waitFor(() => expect(screen.queryByText("Needs you")).toBeNull());
  });
});
