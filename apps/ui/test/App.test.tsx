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
