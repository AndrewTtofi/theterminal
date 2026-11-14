import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Board, LedgerEntry } from "@theterminal/shared";

const h = vi.hoisted(() => ({
  onEntry: undefined as undefined | ((e: LedgerEntry) => void),
}));

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
    decideAction: vi.fn(),
    startRun: vi.fn(),
    stopRun: vi.fn(),
    setClaudeAuth: vi.fn(),
  },
  errorMessage: () => "err",
  subscribeLedger: (_after: number, cb: (e: LedgerEntry) => void) => {
    h.onEntry = cb;
    return () => {};
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
  m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false });
  m.listProjects.mockResolvedValue([mk("A").project, mk("B").project]);
  m.listLedger.mockResolvedValue([]);
  m.getAgents.mockResolvedValue({ adapters: ["fake"], claudeAuthMode: "api_key", subscriptionAck: "ack" });
  m.listRuns.mockResolvedValue([]);
  m.listPendingActions.mockResolvedValue([]);
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
    await waitFor(() => expect(h.onEntry).toBeDefined());
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
  it("shows pending actions above the board and refreshes on agent ledger entries", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    const pendingAction = {
      id: "act1", runId: "r1", kind: "shell", tool: "Bash", summary: "run ls", input: {},
      status: "pending", decidedBy: null, reason: "", output: null, requestedAt: "", decidedAt: null,
    } as const;
    m.listPendingActions.mockResolvedValueOnce([]).mockResolvedValue([pendingAction]);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    expect(screen.queryByText("Needs you")).toBeNull();
    act(() => {
      h.onEntry?.({
        id: "e", seq: 1, ts: "", projectId: "A", type: "agent.action.requested",
        actor: { kind: "agent", id: "r1" }, payload: {}, prevHash: "", hash: "",
      } as LedgerEntry);
    });
    expect(await screen.findByText("Agent wants to: run ls")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });
});
