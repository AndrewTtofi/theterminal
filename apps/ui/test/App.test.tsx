import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONNECTION_CATALOG } from "@theterminal/shared";
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
    getStatus: vi.fn(),
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
    setProviderAuth: vi.fn(),
    listConnections: vi.fn(),
    getConnectionCatalog: vi.fn(),
    addConnection: vi.fn(),
    updateConnection: vi.fn(),
    removeConnection: vi.fn(),
    testConnection: vi.fn(),
    getGitHubOverview: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, readonly code: string) {
      super(code);
    }
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

vi.mock("../src/shell/Dock", () => import("./test-dock"));

import { ApiError, api } from "../src/api";
import type { AgentsInfo } from "../src/api";
import { App } from "../src/App";

const mk = (id: string): Board => ({
  project: { id, name: `Project ${id}`, pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
});
const m = vi.mocked(api);
const AGENTS: AgentsInfo = {
  adapters: ["claude", "fake"],
  providers: {
    claude: { mode: "api_key", available: true },
    codex: { mode: "api_key", available: false },
    gemini: { mode: "api_key", available: false },
  },
  acks: { claude: "claude ack", codex: "codex ack", gemini: "gemini ack" },
};

beforeEach(() => {
  vi.resetAllMocks();
  h.onEntry = undefined;
  h.subs.clear();
  m.getStatus.mockResolvedValue({
    runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0,
    connections: { enabled: 0, failed: 0, keychain: "ok" }, ci: null,
  });
  m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false, headSeq: 7 });
  m.listProjects.mockResolvedValue([mk("A").project, mk("B").project]);
  m.listLedger.mockResolvedValue([]);
  m.getAgents.mockResolvedValue(AGENTS);
  m.listRuns.mockResolvedValue([]);
  m.listPendingActions.mockResolvedValue([]);
  m.listAllPendingActions.mockResolvedValue([]);
  m.listConnections.mockResolvedValue([]);
  m.getConnectionCatalog.mockResolvedValue([...CONNECTION_CATALOG]);
});

describe("App status polling", () => {
  it("refetches status every 30 s and on a ledger entry, and stops after unmount", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<App />);
      const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await flush();
      expect(m.getStatus).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(m.getStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        h.onEntry!({
          seq: 8, id: "8", ts: "2026-01-01T00:00:00Z", projectId: "A",
          actor: { kind: "human", id: "owner" }, type: "card.moved",
          payload: { from: "plan", to: "build" }, prevHash: "", hash: "",
        });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(m.getStatus).toHaveBeenCalledTimes(3);

      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(m.getStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
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

describe("App provider settings", () => {
  const openCodex = async () => {
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Connections" }));
    await userEvent.click(screen.getByRole("button", { name: "Codex (OpenAI)" }));
  };

  it("shows the provider sign-in settings in a connection's editor tab with no project selected", async () => {
    render(<App />);
    await openCodex();
    expect(await screen.findByRole("group", { name: "Codex sign-in" })).toBeTruthy();
    expect(screen.getByText("Select or create a project.")).toBeTruthy();
  });

  it("re-fetches and keeps the radio on the server's mode when a change fails", async () => {
    m.setProviderAuth.mockRejectedValue(new Error("nope"));
    render(<App />);
    await openCodex();
    const codex = within(await screen.findByRole("group", { name: "Codex sign-in" }));
    await userEvent.click(codex.getByLabelText("My own ChatGPT plan"));
    await userEvent.click(codex.getByLabelText("I understand and accept this risk"));
    await userEvent.click(codex.getByRole("button", { name: "Confirm" }));
    expect(m.setProviderAuth).toHaveBeenCalledWith({ provider: "codex", mode: "chatgpt", acknowledgement: "codex ack" });
    await waitFor(() => expect(m.getAgents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((codex.getByLabelText("API key (recommended)") as HTMLInputElement).checked).toBe(true),
    );
  });
});

describe("App connections", () => {
  it("rereads the connections when a connection entry arrives on the ledger", async () => {
    render(<App />);
    await waitFor(() => expect(h.subs.size).toBe(1));
    await waitFor(() => expect(m.listConnections).toHaveBeenCalledTimes(1));
    await act(async () => {
      h.onEntry!({
        seq: 8, id: "8", ts: "2026-01-01T00:00:00Z", projectId: null, actor: { kind: "human", id: "owner" },
        type: "connection.tested", payload: { connectionId: "c1", name: "Claude", ok: true, message: "ok" }, prevHash: "", hash: "",
      } as unknown as LedgerEntry);
    });
    expect(m.listConnections).toHaveBeenCalledTimes(2);
  });

  it("a stale list response that resolves after a new connection is saved leaves its tab open", async () => {
    const saved = {
      id: "c1", kind: "llm", provider: "claude", name: "Claude", enabled: true, config: {}, private: {}, secretFields: ["apiKey"],
      status: { state: "untested", message: "", testedAt: null }, createdAt: "", updatedAt: "",
    } as const;
    render(<App />);
    await waitFor(() => expect(h.subs.size).toBe(1));
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Connections" }));
    const row = screen.getByRole("button", { name: "Claude (Anthropic)" }) as HTMLButtonElement;
    await waitFor(() => expect(row.disabled).toBe(false));
    await userEvent.click(row);

    // A refresh is issued (a ledger entry) and answers only after the save.
    let answerStale!: (l: never[]) => void;
    m.listConnections.mockImplementationOnce(() => new Promise((r) => (answerStale = r)));
    await act(async () => {
      h.onEntry!({
        seq: 8, id: "8", ts: "2026-01-01T00:00:00Z", projectId: null, actor: { kind: "system", id: "runner" },
        type: "connection.used", payload: {}, prevHash: "", hash: "",
      } as unknown as LedgerEntry);
    });
    m.addConnection.mockResolvedValue({ ...saved, secretFields: [...saved.secretFields] });
    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-TESTKEY-0000000000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.querySelector('[data-panel="connection:c1"]')).toBeTruthy());

    await act(async () => answerStale([]));
    const tab = document.querySelector('[data-panel="connection:c1"]') as HTMLElement;
    expect(tab).toBeTruthy();
    expect((within(tab).getByLabelText("API key") as HTMLInputElement).placeholder).toBe("Stored in your keychain");
  });
});

describe("App ledger scope", () => {
  const entry = (seq: number, projectId: string, name: string): LedgerEntry => ({
    seq, id: `e${seq}`, ts: "2026-01-01T00:00:00Z", projectId, actor: { kind: "human", id: "owner" },
    type: "project.created", payload: { name }, prevHash: "", hash: "",
  });

  it("shows every project's entries when All projects is chosen, and the project's again after", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listLedger.mockImplementation((projectId) =>
      Promise.resolve(projectId === null ? [entry(1, "A", "Project A"), entry(2, "B", "Project B")] : [entry(1, "A", "Project A")]),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1));

    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    expect(m.listLedger).toHaveBeenCalledWith(null);
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(2));

    await userEvent.click(screen.getByRole("radio", { name: "This project" }));
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1));
  });
});

describe("App GitHub view", () => {
  const views = () => screen.getByRole("navigation", { name: "Views" });

  it("loads the overview when the view opens and shows the error copy for a failed load", async () => {
    m.getGitHubOverview.mockRejectedValueOnce(new ApiError(404, "github_not_connected"));
    render(<App />);
    await userEvent.click(within(views()).getByRole("button", { name: "GitHub" }));
    expect(await screen.findByText("Connect GitHub and set a repository in Connections.")).toBeTruthy();
    expect(m.getGitHubOverview).toHaveBeenCalledTimes(1);
  });

  it("shows the overview it loaded", async () => {
    m.getGitHubOverview.mockResolvedValue({
      repo: { fullName: "octo-org/example", defaultBranch: "main", htmlUrl: "https://github.com/octo-org/example", private: false },
      branches: [{ name: "main", isDefault: true }], pulls: [], ciRuns: [],
      ci: { state: "unknown", url: null, branch: null, updatedAt: null }, fetchedAt: "2026-11-15T12:00:00Z", stale: false,
    });
    render(<App />);
    await userEvent.click(within(views()).getByRole("button", { name: "GitHub" }));
    expect(await screen.findByRole("link", { name: "octo-org/example" })).toBeTruthy();
  });
});
