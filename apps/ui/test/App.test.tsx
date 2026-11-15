import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONNECTION_CATALOG } from "@theterminal/shared";
import type { Board, LedgerEntry, Me } from "@theterminal/shared";

const h = vi.hoisted(() => {
  const subs = new Set<{ after: number; cb: (e: LedgerEntry) => void }>();
  return {
    subs,
    /** Delivers an entry to every open ledger subscription. */
    onEntry: undefined as undefined | ((e: LedgerEntry) => void),
    /** The options the latest subscription was opened with (presence). */
    opts: [] as { onPresence?: (people: unknown[]) => void; presence?: () => { projectId: string | null; view: string | null } }[],
    unauthorized: null as null | (() => void),
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
    runExists: vi.fn(),
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
    getLink: vi.fn(),
    getMachines: vi.fn(),
    getMachineCapacity: vi.fn(),
    getIntake: vi.fn(),
    startIntake: vi.fn(),
    answerIntake: vi.fn(),
    decideIntake: vi.fn(),
    completeIntake: vi.fn(),
    reopenIntake: vi.fn(),
    getCardGates: vi.fn(),
    getCardStory: vi.fn(),
    getRunChanges: vi.fn(),
    getRunDiff: vi.fn(),
    listRunDir: vi.fn(),
    getRunFile: vi.fn(),
    overrideCommand: vi.fn(),
    overrideDiscard: vi.fn(),
    previewShare: vi.fn(),
    confirmShare: vi.fn(),
    listShareSnapshots: vi.fn(),
    listShareAddresses: vi.fn(),
    createShareLink: vi.fn(),
    listShareLinks: vi.fn(),
    revokeShareLink: vi.fn(),
    getDigests: vi.fn(),
    getMe: vi.fn(),
    listPeople: vi.fn(),
    listInvites: vi.fn(),
    getRemote: vi.fn(),
  },
  setUnauthorizedHandler: (fn: (() => void) | null) => {
    h.unauthorized = fn;
  },
  shareSnapshotUrl: (id: string) => `/api/share/snapshots/${id}`,
  shareDownloadUrl: (id: string) => `/api/share/snapshots/${id}/download`,
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, readonly detail?: unknown) {
      super(code);
    }
  },
  errorMessage: vi.fn(() => "err"),
  LIVE_RUN_CHANGES: "Changes show when the run is stopped or finished.",
  remoteChangesNote: (machine: string) => `The changes arrive when the run finishes on ${machine}.`,
  refusedChangesNote: (machine: string, reason: string) => `The changes from ${machine} were refused: ${reason}.`,
  blockedGates: (e: { code?: string; detail?: { gates?: unknown } }) =>
    e?.code === "gate_blocked" && Array.isArray(e.detail?.gates) ? e.detail.gates : null,
  exportLedgerUrl: (projectId: string | null) => (projectId === null ? "/export" : `/export?projectId=${projectId}`),
  subscribeLedger: (after: number, cb: (e: LedgerEntry) => void, opts: (typeof h.opts)[number] = {}) => {
    h.opts.push(opts);
    const sub = { after, cb };
    h.subs.add(sub);
    h.onEntry = (e) => {
      for (const s of [...h.subs]) s.cb(e);
    };
    return () => h.subs.delete(sub);
  },
}));

vi.mock("../src/shell/Dock", () => import("./test-dock"));

import { ApiError, api, errorMessage } from "../src/api";
import type { AgentsInfo } from "../src/api";
import { App } from "../src/App";
import { testDock } from "./test-dock";
import { intakeView } from "./intake-fixtures";
import { planPassed, shipBlocked, shipMet } from "./gate-fixtures";
import { changes, fileDiff, listing, run1, runEntry } from "./changes-fixtures";
import { ADDRESSES, SHARE_ID, digest, link, preview, snapshotRecord } from "./share-fixtures";

const mk = (id: string): Board => ({
  project: { id, name: `Project ${id}`, pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
});
const m = vi.mocked(api);
const OWNER_ME: Me = { personId: "owner", name: "Owner", role: "owner", listener: "local", method: "token", credentials: [], sessions: [] };
const AGENTS: AgentsInfo = {
  adapters: ["claude", "fake"],
  providers: {
    claude: { mode: "api_key", available: true },
    codex: { mode: "api_key", available: false },
    gemini: { mode: "api_key", available: false },
  },
  acks: { claude: "claude ack", codex: "codex ack", gemini: "gemini ack" },
};

/** Switches to the Operator layout, whose bottom panel holds the Ledger (Guided, the default, has none). */
async function operatorLayout() {
  await waitFor(() => expect(testDock.api).not.toBeNull());
  act(() => testDock.api!.applyPreset("operator"));
}

beforeEach(() => {
  vi.resetAllMocks();
  testDock.api = null;
  h.onEntry = undefined;
  h.subs.clear();
  m.getStatus.mockResolvedValue({
    runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, monthCostUsd: 0, monthlyBudgetUsd: null,
    connections: { enabled: 0, failed: 0, keychain: "ok" }, ci: null, intakeDecisions: 0, intakeProjects: [], machines: { linked: 0, online: 0, keyChanged: 0 }, network: { state: "unknown", basis: "inferred", since: null, lastError: null }, shareLinks: 0,
  });
  m.getIntake.mockResolvedValue(null);
  m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false, headSeq: 7 });
  m.listProjects.mockResolvedValue([mk("A").project, mk("B").project]);
  m.listLedger.mockResolvedValue([]);
  m.getAgents.mockResolvedValue(AGENTS);
  m.listRuns.mockResolvedValue([]);
  m.listPendingActions.mockResolvedValue([]);
  m.listAllPendingActions.mockResolvedValue([]);
  m.listConnections.mockResolvedValue([]);
  m.getConnectionCatalog.mockResolvedValue([...CONNECTION_CATALOG]);
  m.listShareSnapshots.mockResolvedValue([]);
  m.listShareLinks.mockResolvedValue([]);
  m.listShareAddresses.mockResolvedValue([]);
  m.getDigests.mockResolvedValue([]);
  h.opts = [];
  m.getMe.mockResolvedValue(OWNER_ME);
  m.listPeople.mockResolvedValue([]);
  m.listInvites.mockResolvedValue([]);
  m.getRemote.mockResolvedValue({ enabled: false, listening: false });
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

describe("App plan intake", () => {
  const entry = (seq: number, type: LedgerEntry["type"], projectId = "A"): LedgerEntry => ({
    seq, id: String(seq), ts: "2026-01-01T00:00:00Z", projectId, actor: { kind: "human", id: "owner" },
    type, payload: {}, prevHash: "", hash: "",
  });

  it("says so when the selected project no longer exists, instead of loading forever", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    const gone = new ApiError(404, "not_found");
    m.getIntake.mockRejectedValue(gone);
    vi.mocked(errorMessage).mockImplementation((e, context) =>
      e === gone && context === "intake" ? "This project no longer exists" : "err");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan intake" }));
    expect(await screen.findByText("This project no longer exists")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("loads the selected project's intake, reloads it on its intake and card entries, and shows a saved answer", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    expect(await screen.findByText("Plan: not started")).toBeTruthy();
    expect(m.getIntake).toHaveBeenCalledWith("A");
    await waitFor(() => expect(h.subs.size).toBe(2));

    m.getIntake.mockResolvedValue(intakeView({ audience: "book club members" }));
    await act(async () => h.onEntry!(entry(8, "intake.answered")));
    expect(await screen.findByText("Plan: 1 of 9 questions answered")).toBeTruthy();
    const calls = m.getIntake.mock.calls.length;
    await act(async () => h.onEntry!(entry(9, "card.created")));
    await waitFor(() => expect(m.getIntake.mock.calls.length).toBe(calls + 1));
    await act(async () => h.onEntry!(entry(10, "intake.answered", "B")));
    await act(async () => h.onEntry!(entry(11, "agent.started")));
    expect(m.getIntake.mock.calls.length).toBe(calls + 1);

    m.answerIntake.mockResolvedValue(intakeView({ audience: "book club members", payments: "yes" }));
    await userEvent.click(screen.getByRole("button", { name: "Plan intake" }));
    const payments = await screen.findByRole("group", { name: "Will it take payments?" });
    await userEvent.click(within(payments).getByRole("radio", { name: "Yes" }));
    expect(m.answerIntake).toHaveBeenCalledWith("A", "payments", "yes");
    expect(await screen.findByText("Plan: 2 of 9 questions answered")).toBeTruthy();
  });

  it("shows the refusal and keeps the view when a change is refused", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.startIntake.mockRejectedValue(new ApiError(400, "secret_in_text"));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await userEvent.click(await screen.findByRole("button", { name: "Plan intake" }));
    const panel = await screen.findByRole("region", { name: "Plan intake" });
    await userEvent.type(within(panel).getByLabelText("Describe your idea"), "key sk-123");
    await userEvent.click(within(panel).getByRole("button", { name: "Begin" }));
    expect(m.startIntake).toHaveBeenCalledWith("A", "key sk-123");
    expect(await screen.findByText("err")).toBeTruthy();
    expect((within(panel).getByLabelText("Describe your idea") as HTMLTextAreaElement).value).toBe("key sk-123");
  });
});

describe("App initial load", () => {
  it("still renders the board when the ledger fails to load", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listLedger.mockRejectedValue(new Error("ledger down"));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    expect(await screen.findByRole("heading", { name: "Project A" })).toBeTruthy();
    expect((await screen.findAllByRole("status")).some((s) => s.classList.contains("error"))).toBe(true);
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
    // The Board shows the welcome, and the Conversation asks for a project.
    expect(screen.getByText("Start by opening a project.")).toBeTruthy();
    expect(screen.getAllByText("Select or create a project.")).toHaveLength(1);
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
    expect(await screen.findByText('Agent wants to run the command "run make"')).toBeTruthy();
    expect(screen.getByRole("region", { name: "Needs you" }).textContent).toContain("Project B");
  });

  it("refreshes the strip on an agent entry a linked machine sent, and when a run on one ends", async () => {
    m.listAllPendingActions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingAction("b1", "B", "run make")])
      .mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(h.subs.size).toBe(1));
    await waitFor(() => expect(m.listAllPendingActions).toHaveBeenCalledTimes(1));
    const inner = { ...agentEntry(3, "B"), actor: { kind: "agent", id: "r1" }, payload: { runId: "r1", actionId: "b1" } } as LedgerEntry;
    act(() =>
      h.onEntry?.({
        ...agentEntry(8, "B"), type: "link.mirrored", actor: { kind: "system", id: "link" },
        payload: { machineId: "b".repeat(32), origin: inner, signature: "c".repeat(128) },
      } as LedgerEntry),
    );
    expect(await screen.findByText('Agent wants to run the command "run make"')).toBeTruthy();
    act(() =>
      h.onEntry?.({
        ...agentEntry(9, "B"), type: "link.run_failed", actor: { kind: "system", id: "link" },
        payload: { runId: "r1", machineId: "b".repeat(32), error: "machine_unpaired" },
      } as LedgerEntry),
    );
    await waitFor(() => expect(screen.queryByText('Agent wants to run the command "run make"')).toBeNull());
    expect(m.listAllPendingActions).toHaveBeenCalledTimes(3);
  });

  it("rereads the project's runs on an agent entry a linked machine sent, and when a run on one ends", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await waitFor(() => expect(m.listRuns).toHaveBeenCalledWith("A"));
    await waitFor(() => expect(h.subs.size).toBe(2));
    const before = m.listRuns.mock.calls.length;
    const inner = { ...agentEntry(3, "A"), type: "agent.finished", payload: { runId: "r1", status: "completed" } } as LedgerEntry;
    act(() =>
      h.onEntry?.({
        ...agentEntry(8, "A"), type: "link.mirrored", actor: { kind: "system", id: "link" },
        payload: { machineId: "b".repeat(32), origin: inner, signature: "c".repeat(128) },
      } as LedgerEntry),
    );
    await waitFor(() => expect(m.listRuns.mock.calls.length).toBeGreaterThan(before));
    const after = m.listRuns.mock.calls.length;
    act(() =>
      h.onEntry?.({
        ...agentEntry(9, "A"), type: "link.run_failed", actor: { kind: "system", id: "link" },
        payload: { runId: "r1", machineId: "b".repeat(32), error: "machine_unpaired" },
      } as LedgerEntry),
    );
    await waitFor(() => expect(m.listRuns.mock.calls.length).toBeGreaterThan(after));
  });

  it("does not refresh the strip for non-agent entries", async () => {
    render(<App />);
    await waitFor(() => expect(h.subs.size).toBe(1));
    await waitFor(() => expect(m.listAllPendingActions).toHaveBeenCalledTimes(1));
    act(() => h.onEntry?.({ ...agentEntry(8, "B"), type: "card.moved" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.listAllPendingActions).toHaveBeenCalledTimes(1);
  });

  it("sends one decision when the same action is decided twice at once", async () => {
    let resolve!: () => void;
    m.decideAction.mockReturnValue(new Promise<never>((r) => (resolve = r as () => void)));
    render(<App />);
    await waitFor(() => expect(testDock.shell).not.toBeNull());
    const { onDecide } = testDock.shell!.model;
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = onDecide("a1", "allow");
      second = onDecide("a1", "allow");
    });
    expect(await second).toBe(false);
    expect(m.decideAction).toHaveBeenCalledTimes(1);
    resolve();
    await act(async () => void (await first));
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
    // The workspace shows once it knows who is signed in.
    await screen.findByRole("navigation", { name: "Views" });
    await openCodex();
    expect(await screen.findByRole("group", { name: "Codex sign-in" })).toBeTruthy();
    // The Board shows the welcome, and the Conversation asks for a project.
    expect(screen.getByText("Start by opening a project.")).toBeTruthy();
    expect(screen.getAllByText("Select or create a project.")).toHaveLength(1);
  });

  it("re-fetches and keeps the radio on the server's mode when a change fails", async () => {
    m.setProviderAuth.mockRejectedValue(new Error("nope"));
    render(<App />);
    // The workspace shows once it knows who is signed in.
    await screen.findByRole("navigation", { name: "Views" });
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

// The paging tests paint 500 to 1,001 ledger rows several times over, which takes the Windows runner past the default
// 5 s (it was at about 2.5 s with React 18). A test that times out keeps running and interferes with the tests after
// it, so the block gets the same cap as the other heavy painting tests. The paging is what is tested, not the speed.
describe("App ledger scope", { timeout: 30_000 }, () => {
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
    await operatorLayout();
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1));

    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    expect(m.listLedger).toHaveBeenCalledWith(null, { beforeSeq: 8, limit: 500 });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(2));

    await userEvent.click(screen.getByRole("radio", { name: "This project" }));
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1));
  });

  it("loads the newest page before the head, then pages older entries in with beforeSeq", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => entry(from + i, "A", `P${from + i}`));
    m.listLedger.mockImplementation(async (_projectId, q) => (q.beforeSeq === 8 ? page(601, 500) : page(501, 100)));
    m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false, headSeq: 7 });
    render(<App />);
    await operatorLayout();
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(200));
    expect(m.listLedger).toHaveBeenCalledWith("A", { beforeSeq: 8, limit: 500 });
    const older = () => within(ledger()).getByRole("button", { name: "Show older entries" });
    await userEvent.click(older());
    await userEvent.click(older());
    expect(within(ledger()).getAllByRole("listitem")).toHaveLength(500);
    await userEvent.click(older());
    expect(m.listLedger).toHaveBeenLastCalledWith("A", { beforeSeq: 601, limit: 500 });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(600));
    // A short page means the start of the ledger: nothing older to ask for.
    expect(within(ledger()).queryByRole("button", { name: "Show older entries" })).toBeNull();
  });

  it("loads the project's older entries from the Conversation, even under the All-projects ledger scope", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    const page = (from: number, n: number, projectId: string | null) =>
      Array.from({ length: n }, (_, i) => entry(from + i, projectId ?? "A", `P${from + i}`));
    m.listLedger.mockImplementation(async (projectId, q) => (q.beforeSeq === 1101 ? page(601, 500, projectId) : page(501, 100, projectId)));
    m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false, headSeq: 1100 });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    const conversation = () => screen.getByRole("region", { name: "Conversation" });
    await within(conversation()).findByRole("button", { name: "Load older" });
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    await waitFor(() => expect(m.listLedger).toHaveBeenCalledWith(null, { beforeSeq: 1101, limit: 500 }));
    await userEvent.click(within(conversation()).getByRole("button", { name: "Load older" }));
    expect(m.listLedger).toHaveBeenLastCalledWith("A", { beforeSeq: 601, limit: 500 });
    await waitFor(() => expect(within(conversation()).queryByRole("button", { name: "Load older" })).toBeNull());
  });

  const page = (from: number, n: number, projectId = "A") => Array.from({ length: n }, (_, i) => entry(from + i, projectId, `P${from + i}`));
  const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
  const older = () => within(ledger()).getByRole("button", { name: "Show older entries" }) as HTMLButtonElement;
  async function openLedger(health = 1100) {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.health.mockResolvedValue({ ok: true, integrity: "ok", readOnly: false, headSeq: health });
    render(<App />);
    await operatorLayout();
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
  }

  it("applies streamed entries together, a moment after they arrive", async () => {
    m.listLedger.mockResolvedValue([entry(1, "A", "P1")]);
    await openLedger(1);
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1));
    act(() => {
      for (const seq of [2, 3, 4]) h.onEntry!(entry(seq, "A", `P${seq}`));
    });
    expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1);
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(4));
  });

  it("keeps the entries that streamed in when an older page is put in front", async () => {
    m.listLedger.mockImplementation(async (_p, q) => (q.beforeSeq === 1101 ? page(601, 500) : page(101, 500)));
    await openLedger();
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(200));
    act(() => h.onEntry!(entry(1101, "A", "P1101")));
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")[0]!.textContent).toContain("P1101"));
    for (let i = 0; i < 3; i++) await userEvent.click(older());
    await waitFor(() => expect(m.listLedger).toHaveBeenLastCalledWith("A", { beforeSeq: 601, limit: 500 }));
    for (let i = 0; i < 3; i++) await userEvent.click(older());
    const lines = within(ledger()).getAllByRole("listitem");
    expect(lines).toHaveLength(1001);
    expect(lines[0]!.textContent).toContain("P1101");
    expect(lines[1000]!.textContent).toContain("P101");
  });

  it("disables Show older entries while a page loads, and a stale load does not end a newer one", async () => {
    const pending: Array<(v: LedgerEntry[]) => void> = [];
    m.listLedger.mockImplementation((projectId, q) =>
      q.beforeSeq === 1101 ? Promise.resolve(page(601, 500, projectId ?? "A")) : new Promise((resolve) => pending.push(resolve)),
    );
    await openLedger();
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(200));
    for (let i = 0; i < 3; i++) await userEvent.click(older());
    await waitFor(() => expect(older().disabled).toBe(true));
    // Another scope, and its own older page, while the first is still out.
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(200));
    expect(older().disabled).toBe(false);
    for (let i = 0; i < 3; i++) await userEvent.click(older());
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[0]!(page(101, 500)));
    expect(older().disabled).toBe(true);
    await act(async () => pending[1]!(page(101, 10)));
    await waitFor(() => expect(within(ledger()).queryByRole("button", { name: "Show older entries" })).toBeNull());
  });

  it("says inline when an older page could not be loaded, and lets the Owner try again", async () => {
    m.listLedger.mockImplementation(async (_p, q) => {
      if (q.beforeSeq === 1101) return page(601, 500);
      throw new ApiError(500, "internal");
    });
    await openLedger();
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(200));
    for (let i = 0; i < 3; i++) await userEvent.click(older());
    expect((await within(ledger()).findByRole("alert")).textContent).toBe("Older entries could not be loaded: err");
    expect(older().disabled).toBe(false);
  });

  it("feeds the Agent feed from the project's stream whatever the ledger scope, following the chosen run", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listRuns.mockResolvedValue([
      { id: "r1", projectId: "A", cardId: null, adapter: "fake", authMode: "none", prompt: "p", status: "completed", worktree: "w", base: null,
        costUsd: null, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null, machineId: null },
    ]);
    const said = (seq: number, runId: string, text: string): LedgerEntry => ({
      ...entry(seq, "A", "x"), type: "agent.message", actor: { kind: "agent", id: runId }, payload: { runId, text },
    });
    m.listLedger.mockImplementation(async (projectId) => (projectId === null ? [] : [said(1, "r1", "one"), said(2, "r2", "two")]));
    render(<App />);
    await operatorLayout();
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    act(() => testDock.api!.focus("agent_feed"));
    const feed = () => screen.getByRole("region", { name: "Agent feed" });
    await waitFor(() => expect(within(feed()).getAllByRole("listitem")).toHaveLength(2));
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    await userEvent.selectOptions(within(feed()).getByRole("combobox", { name: "Follow" }), "r1");
    expect(within(feed()).getAllByRole("listitem").map((li) => li.querySelector(".headline")?.textContent)).toEqual([
      'The Fake agent said: "one"',
    ]);
  });

  it("narrates with the card titles on the board and the adapters of the runs", async () => {
    const card = { id: "c9", projectId: "A", title: "Login", stage: "build", status: "todo", createdAt: "" };
    m.getBoard.mockResolvedValue({ ...mk("A"), columns: { ...mk("A").columns, build: [card] } } as Board);
    m.listRuns.mockResolvedValue([
      { id: "r1", projectId: "A", cardId: null, adapter: "claude", authMode: "none", prompt: "p", status: "running", worktree: "w", base: null,
        costUsd: null, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null, machineId: null },
    ]);
    m.listLedger.mockResolvedValue([
      { ...entry(1, "A", "x"), type: "card.moved", payload: { cardId: "c9", from: "build", to: "ship" } },
      { ...entry(2, "A", "x"), type: "agent.message", actor: { kind: "agent", id: "r1" }, payload: { runId: "r1", text: "hi" } },
    ]);
    render(<App />);
    await operatorLayout();
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
    await waitFor(() => expect(ledger().textContent).toContain('Owner moved "Login" from Build to Ship'));
    await waitFor(() => expect(ledger().textContent).toContain('The Claude agent said: "hi"'));
  });

  it("filters the ledger by topic and exports the scope it shows", async () => {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listLedger.mockImplementation((projectId) =>
      Promise.resolve(projectId === null ? [entry(1, "A", "Project A"), entry(2, "B", "Project B")] : [entry(1, "A", "Project A")]),
    );
    render(<App />);
    await operatorLayout();
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1));
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    expect(screen.getByRole("link", { name: "Export for audit" }).getAttribute("href")).toBe("/export?projectId=A");

    await userEvent.click(screen.getByRole("checkbox", { name: "Board" }));
    expect(within(ledger()).queryAllByRole("listitem")).toHaveLength(0);
    await userEvent.click(screen.getByRole("checkbox", { name: "Board" }));
    expect(within(ledger()).getAllByRole("listitem")).toHaveLength(1);

    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    expect(screen.getByRole("link", { name: "Export for audit" }).getAttribute("href")).toBe("/export");
  });
});

describe("App GitHub view", () => {
  const views = () => screen.getByRole("navigation", { name: "Views" });

  it("loads the overview when the view opens and shows the error copy for a failed load", async () => {
    m.getGitHubOverview.mockRejectedValueOnce(new ApiError(404, "github_not_connected"));
    render(<App />);
    // The workspace shows once it knows who is signed in.
    await screen.findByRole("navigation", { name: "Views" });
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
    // The workspace shows once it knows who is signed in.
    await screen.findByRole("navigation", { name: "Views" });
    await userEvent.click(within(views()).getByRole("button", { name: "GitHub" }));
    expect(await screen.findByRole("link", { name: "octo-org/example" })).toBeTruthy();
  });
});

describe("App Machines view", () => {
  const views = () => screen.getByRole("navigation", { name: "Views" });
  const entry = (seq: number, type: LedgerEntry["type"]): LedgerEntry => ({
    seq, id: `m${seq}`, ts: "", projectId: null, actor: { kind: "human", id: "owner" }, type, payload: {}, prevHash: "", hash: "",
  });
  const overview = {
    identity: "ok" as const,
    self: { machineId: "11".repeat(16), fingerprint: "ab".repeat(32), name: "Mac", linking: { enabled: false, port: null } },
    machines: [],
    discovered: [],
  };

  it("asks for nothing until the view opens, then reloads on machine entries only", async () => {
    m.getLink.mockResolvedValue(overview);
    render(<App />);
    await waitFor(() => expect(h.subs.size).toBeGreaterThan(0));
    await act(async () => h.onEntry!(entry(5, "machine.named")));
    expect(m.getLink).not.toHaveBeenCalled();
    await userEvent.click(within(views()).getByRole("button", { name: "Machines" }));
    expect(await screen.findByRole("switch", { name: "Allow linking" })).toBeTruthy();
    const calls = m.getLink.mock.calls.length;
    await act(async () => h.onEntry!(entry(6, "card.created")));
    expect(m.getLink.mock.calls.length).toBe(calls);
    await act(async () => h.onEntry!(entry(7, "machine.paired")));
    await waitFor(() => expect(m.getLink.mock.calls.length).toBe(calls + 1));
  });

  it("with a machine paired, names come from the paired list: no machine is asked and the network is not browsed", async () => {
    m.getStatus.mockResolvedValue({
      runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, monthCostUsd: 0, monthlyBudgetUsd: null,
      connections: { enabled: 0, failed: 0, keychain: "ok" }, ci: null, intakeDecisions: 0, intakeProjects: [], machines: { linked: 1, online: 0, keyChanged: 0 }, shareLinks: 0,
      network: { state: "unknown", basis: "inferred", since: null, lastError: null },
    });
    m.getMachines.mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(m.getMachines).toHaveBeenCalled());
    await userEvent.click(within(views()).getByRole("button", { name: "Agents" }));
    await act(async () => h.onEntry?.(entry(8, "machine.paired")));
    await waitFor(() => expect(m.getMachines.mock.calls.length).toBeGreaterThan(1));
    expect(m.getLink).not.toHaveBeenCalled();
  });

  it("says it could not load", async () => {
    m.getLink.mockRejectedValue(new ApiError(500, "internal"));
    render(<App />);
    // The workspace shows once it knows who is signed in.
    await screen.findByRole("navigation", { name: "Views" });
    await userEvent.click(within(views()).getByRole("button", { name: "Machines" }));
    expect(await screen.findByText("Could not load machines")).toBeTruthy();
  });
});

describe("App readiness gates", () => {
  const login = { id: "c1", projectId: "A", title: "Login", stage: "build", status: "todo", createdAt: "", updatedAt: "" } as const;
  const withLogin = (): Board => ({ ...mk("A"), columns: { ...mk("A").columns, build: [login] } });
  const views = () => screen.getByRole("navigation", { name: "Views" });
  const NOTE = "Something changed: a condition is no longer met. The checklist was refreshed.";
  const gateEntry = (seq: number, type: LedgerEntry["type"], projectId = "A"): LedgerEntry => ({
    seq, id: `g${seq}`, ts: "", projectId, actor: { kind: "human", id: "owner" }, type, payload: {}, prevHash: "", hash: "",
  });

  const openA = async () => {
    m.getBoard.mockResolvedValue(withLogin());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("button", { name: "Open the story of Login" });
  };

  it("moves at once when every gate passes", async () => {
    m.getCardGates.mockResolvedValue([planPassed()]);
    m.moveCard.mockResolvedValue({ ...login, stage: "ship" });
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    await waitFor(() => expect(m.moveCard).toHaveBeenCalledWith("c1", "ship"));
    expect(m.getCardGates).toHaveBeenCalledWith("c1", "ship");
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("puts a blocked move in the strip in any view with the bottom panel closed, and moves with the decision", async () => {
    m.getCardGates.mockResolvedValue([shipMet()]);
    m.moveCard.mockResolvedValue({ ...login, stage: "ship" });
    await openA();
    await userEvent.click(within(views()).getByRole("button", { name: "Connections" }));
    await userEvent.keyboard("{Control>}j{/Control}");
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    const card = within(strip).getByRole("article", { name: "Gate: Ready to ship" });
    expect(m.moveCard).not.toHaveBeenCalled();

    // A project entry while the gate is open re-checks it.
    const calls = m.getCardGates.mock.calls.length;
    await act(async () => h.onEntry!(gateEntry(20, "agent.finished")));
    await waitFor(() => expect(m.getCardGates.mock.calls.length).toBe(calls + 1));
    await act(async () => h.onEntry!(gateEntry(21, "agent.finished", "B")));
    await act(async () => h.onEntry!(gateEntry(22, "connection.added")));
    expect(m.getCardGates.mock.calls.length).toBe(calls + 1);

    await userEvent.click(within(card).getByRole("checkbox"));
    await userEvent.click(within(card).getByRole("button", { name: "Sign off" }));
    await userEvent.click(within(strip).getByRole("button", { name: 'Move "Login" to Ship' }));
    expect(m.moveCard).toHaveBeenCalledWith("c1", "ship", [
      expect.objectContaining({ gateId: "ready_to_ship", decision: "sign_off" }),
    ]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull());
  });

  it("sends one move when the gated move is resolved twice at once", async () => {
    m.getCardGates.mockResolvedValue([shipMet()]);
    let resolve!: (v: unknown) => void;
    m.moveCard.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    await screen.findByRole("article", { name: "Gate: Ready to ship" });
    const { onResolveGate } = testDock.shell!.model;
    const decisions = [{ gateId: "ready_to_ship" as const, decision: "sign_off" as const, acknowledgement: "x" }];
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = onResolveGate(decisions);
      second = onResolveGate(decisions);
    });
    expect(await second).toBe(false);
    expect(m.moveCard).toHaveBeenCalledTimes(1);
    resolve({ ...login, stage: "ship" });
    expect(await act(async () => await first)).toBe(true);
  });

  it("refreshes the checklist and keeps the card when a condition stopped holding", async () => {
    m.getCardGates.mockResolvedValueOnce([shipMet()]).mockResolvedValue([shipBlocked()]);
    m.moveCard.mockRejectedValue(new ApiError(409, "gate_not_met", { gateId: "ready_to_ship", unmet: ["The plan has been approved"] }));
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    const card = within(strip).getByRole("article", { name: "Gate: Ready to ship" });
    await userEvent.click(within(card).getByRole("checkbox"));
    await userEvent.click(within(card).getByRole("button", { name: "Sign off" }));
    await userEvent.click(within(strip).getByRole("button", { name: 'Move "Login" to Ship' }));
    expect(await within(strip).findByText(NOTE)).toBeTruthy();
    const refreshed = within(strip).getByRole("article", { name: "Gate: Ready to ship" });
    expect(within(refreshed).getByRole("button", { name: "Waive" })).toBeTruthy();
    expect(within(refreshed).queryByRole("button", { name: "Sign off" })).toBeNull();
  });

  it("takes the gates a refused move sends back and keeps the card", async () => {
    m.getCardGates.mockResolvedValue([shipMet()]);
    m.moveCard.mockRejectedValue(new ApiError(409, "gate_blocked", { gates: [shipBlocked()] }));
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    const card = within(strip).getByRole("article", { name: "Gate: Ready to ship" });
    await userEvent.click(within(card).getByRole("checkbox"));
    await userEvent.click(within(card).getByRole("button", { name: "Sign off" }));
    await userEvent.click(within(strip).getByRole("button", { name: 'Move "Login" to Ship' }));
    expect(await within(strip).findByText(NOTE)).toBeTruthy();
    expect(within(strip).getByRole("button", { name: "Waive" })).toBeTruthy();
  });

  it("opens a gate from a move the server blocked although the check passed", async () => {
    m.getCardGates.mockResolvedValue([]);
    m.moveCard.mockRejectedValue(new ApiError(409, "gate_blocked", { gates: [shipBlocked()] }));
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    expect(within(strip).getByRole("article", { name: "Gate: Ready to ship" })).toBeTruthy();
  });

  it("cancels the gate", async () => {
    m.getCardGates.mockResolvedValue([shipMet()]);
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    await userEvent.click(within(strip).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(m.moveCard).not.toHaveBeenCalled();
  });

  it("opens the story tab from a card title and loads its story", async () => {
    m.getCardStory.mockResolvedValue({
      card: login, runs: [], actions: [], gateDecisions: [], costUsd: null, integrity: { ok: true }, unreadable: [],
      entries: [{ ...gateEntry(1, "card.created"), payload: { cardId: "c1", title: "Login", stage: "build" } }],
    });
    await openA();
    await userEvent.click(screen.getByRole("button", { name: "Open the story of Login" }));
    const story = await screen.findByRole("region", { name: "Story: Login" });
    expect(m.getCardStory).toHaveBeenCalledWith("c1");
    expect(story.textContent).toContain("Nothing has happened on this card yet.");
    const calls = m.getCardStory.mock.calls.length;
    await act(async () => h.onEntry!({ ...gateEntry(30, "card.status_changed"), payload: { cardId: "c1", to: "active" } }));
    await waitFor(() => expect(m.getCardStory.mock.calls.length).toBe(calls + 1));
  });

  it("starts a run on the chosen card", async () => {
    m.startRun.mockResolvedValue({ id: "r1" } as never);
    await openA();
    await userEvent.click(within(views()).getByRole("button", { name: "Agents" }));
    const agents = within(await screen.findByRole("region", { name: "Agents" }));
    await userEvent.selectOptions(await agents.findByLabelText("Card (optional)"), "Login");
    await userEvent.type(agents.getByLabelText("Prompt"), "add sign-in");
    await userEvent.click(agents.getByRole("button", { name: "Start agent" }));
    expect(m.startRun).toHaveBeenCalledWith("A", { adapter: "claude", prompt: "add sign-in", cardId: "c1" });
  });

  it("keeps the gate and shows the error when a refused move sends no usable gates", async () => {
    m.getCardGates.mockResolvedValue([shipMet()]);
    m.moveCard.mockRejectedValue(new ApiError(409, "gate_blocked", { gates: "x" }));
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    await userEvent.click(within(strip).getByRole("checkbox"));
    await userEvent.click(within(strip).getByRole("button", { name: "Sign off" }));
    await userEvent.click(within(strip).getByRole("button", { name: 'Move "Login" to Ship' }));
    expect(await screen.findByText("err")).toBeTruthy();
    expect(within(strip).getByRole("article", { name: "Gate: Ready to ship" })).toBeTruthy();
  });

  it("keeps Move disabled until the refresh after gate_not_met resolves", async () => {
    let resolveRefresh: (v: unknown) => void = () => {};
    m.getCardGates
      .mockResolvedValueOnce([shipMet()])
      .mockImplementationOnce(() => new Promise((r) => { resolveRefresh = r; }) as never);
    m.moveCard.mockRejectedValue(new ApiError(409, "gate_not_met", { gateId: "ready_to_ship", unmet: [] }));
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    const strip = await screen.findByRole("region", { name: "Needs you" });
    await userEvent.click(within(strip).getByRole("checkbox"));
    await userEvent.click(within(strip).getByRole("button", { name: "Sign off" }));
    const move = () => within(strip).getByRole("button", { name: 'Move "Login" to Ship' }) as HTMLButtonElement;
    await userEvent.click(move());
    await within(strip).findByText(NOTE);
    expect(move().disabled).toBe(true);
    await act(async () => resolveRefresh([shipBlocked()]));
    expect(within(strip).getByRole("button", { name: "Waive" })).toBeTruthy();
    expect(move().disabled).toBe(true);
  });

  it("clears an open gate when another project is selected", async () => {
    m.getCardGates.mockResolvedValue([shipMet()]);
    await openA();
    await userEvent.selectOptions(screen.getByLabelText("Move Login to"), "Ship");
    await screen.findByRole("region", { name: "Needs you" });
    m.getBoard.mockResolvedValue(mk("B"));
    await userEvent.click(screen.getByRole("button", { name: "Project B" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull());
  });
});

describe("App Changes view", () => {
  const run2 = { ...run1, id: "run2", startedAt: "2026-11-15T11:00:00.000Z", prompt: "Newer" };

  async function openChanges() {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listRuns.mockResolvedValue([run1, run2]);
    m.getRunChanges.mockImplementation(async (runId) => changes({ runId }));
    m.listRunDir.mockImplementation(async (_runId, path) => listing(path, []));
    m.getRunDiff.mockImplementation(async () => fileDiff({ status: "added", added: 1, deleted: 0 }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Changes" }));
  }

  it("shows the newest run's changes until a run is picked, then the picked one's", async () => {
    await openChanges();
    expect(await screen.findByText("1 file changed · +1 −0")).toBeTruthy();
    expect(m.getRunChanges).toHaveBeenCalledWith("run2");
    expect(m.listRunDir).toHaveBeenCalledWith("run2", "");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Run" }), "run1");
    await waitFor(() => expect(m.getRunChanges).toHaveBeenCalledWith("run1"));
  });

  it("opens a changed file's diff in a tab, reusing the run's changes it already has", async () => {
    await openChanges();
    const list = await screen.findByRole("list", { name: "Changed files" });
    await userEvent.click(within(list).getByRole("button", { name: /notes\.txt/ }));
    expect(await screen.findByRole("region", { name: "Diff: notes.txt" })).toBeTruthy();
    expect(m.getRunDiff).toHaveBeenCalledWith("run2", "notes.txt");
    expect(testDock.api!.panelIds()).toContain("diff:run2:notes.txt");
    expect(m.getRunChanges).toHaveBeenCalledTimes(1);
  });

  it("reloads the changes on an agent or override entry naming the run, and not for another run", async () => {
    await openChanges();
    await screen.findByText("1 file changed · +1 −0");
    expect(m.getRunChanges).toHaveBeenCalledTimes(1);
    act(() => h.onEntry!(runEntry("agent.finished", "run1")));
    act(() => h.onEntry!(runEntry("card.created", "run2")));
    await act(async () => {});
    expect(m.getRunChanges).toHaveBeenCalledTimes(1);
    m.getRunChanges.mockResolvedValueOnce(changes({ runId: "run2", files: [] }));
    act(() => h.onEntry!(runEntry("override.completed", "run2")));
    expect(await screen.findByText("0 files changed · +0 −0")).toBeTruthy();
  });

  it("asks nothing about a live run's changes, however many of its entries arrive, and reads them once it finishes", async () => {
    const live = { ...run2, status: "running" as const };
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listRuns.mockResolvedValue([run1, live]);
    m.getRunChanges.mockImplementation(async (runId) => changes({ runId }));
    m.listRunDir.mockImplementation(async (_runId, path) => listing(path, []));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Changes" }));
    expect(await screen.findByText("Changes show when the run is stopped or finished.")).toBeTruthy();
    for (let seq = 8; seq < 13; seq++) act(() => h.onEntry!({ ...runEntry("agent.message", "run2"), seq, projectId: "A" }));
    await act(async () => {});
    expect(m.getRunChanges).not.toHaveBeenCalled();
    expect(m.listRunDir).not.toHaveBeenCalled();

    m.listRuns.mockResolvedValue([run1, { ...run2, status: "completed" as const }]);
    act(() => h.onEntry!({ ...runEntry("agent.finished", "run2"), seq: 13, projectId: "A" }));
    expect(await screen.findByText("1 file changed · +1 −0")).toBeTruthy();
    expect(m.getRunChanges).toHaveBeenCalledWith("run2");
    expect(m.listRunDir).toHaveBeenCalledWith("run2", "");
  });

  it("a run on a linked machine: its changes are awaited, then refused changes say why in fixed words", async () => {
    const remote = { ...run2, machineId: "m1", status: "completed" as const };
    m.getStatus.mockResolvedValue({
      runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, monthCostUsd: 0, monthlyBudgetUsd: null,
      connections: { enabled: 0, failed: 0, keychain: "ok" }, ci: null, intakeDecisions: 0, intakeProjects: [], machines: { linked: 1, online: 1, keyChanged: 0 }, shareLinks: 0,
      network: { state: "unknown", basis: "inferred", since: null, lastError: null },
    });
    m.getMachines.mockResolvedValue([{ id: "m1", name: "GPU box" } as never]);
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listRuns.mockResolvedValue([run1, remote]);
    m.getRunChanges.mockRejectedValue(new ApiError(404, "worktree_missing"));
    m.listRunDir.mockRejectedValue(new ApiError(404, "worktree_missing"));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await waitFor(() => expect(m.getMachines).toHaveBeenCalled());
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Changes" }));
    expect(await screen.findByText("The changes arrive when the run finishes on GPU box.")).toBeTruthy();
    act(() => h.onEntry!({ ...runEntry("link.changes_refused", "run2"), seq: 20, projectId: "A", payload: { runId: "run2", machineId: "m1", reason: "bad_bundle" } }));
    expect(await screen.findByText("The changes from GPU box were refused: bad_bundle.")).toBeTruthy();
  });

  it("discards through the override route, shows a refusal inside the form and the server's count after", async () => {
    vi.mocked(errorMessage).mockImplementation(() => "Stop the agent first: it is still working in this run");
    const refusal = new ApiError(409, "run_active");
    m.overrideDiscard.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ overrideId: "o1", files: 2 });
    await openChanges();
    await screen.findByText("1 file changed · +1 −0");
    await userEvent.click(screen.getByText("Emergency override"));
    const form = screen.getByRole("group", { name: "Discard this run's changes" });
    await userEvent.click(within(form).getByRole("button", { name: "Discard…" }));
    await userEvent.type(within(form).getByLabelText("Why? (required, at least 10 characters)"), "The agent broke the build");
    await userEvent.click(within(form).getByRole("button", { name: /^Discard (\d|uncommitted)/ }));
    await userEvent.click(within(form).getByRole("button", { name: "Confirm discard" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Stop the agent first: it is still working in this run");
    expect(m.overrideDiscard).toHaveBeenCalledWith("run2", "The agent broke the build");
    expect(errorMessage).toHaveBeenCalledWith(refusal);
    await userEvent.click(within(form).getByRole("button", { name: "Confirm discard" }));
    await waitFor(() =>
      expect(within(form).getByRole("status").textContent).toBe(
        "Recorded: 2 uncommitted files discarded. Watch the Ledger or the Terminal for the result.",
      ),
    );
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("sends one override of a run at a time: a second request meanwhile is refused without reaching the server", async () => {
    let finish!: () => void;
    m.overrideCommand.mockReturnValue(new Promise((r) => (finish = () => r({ overrideId: "o1" }))));
    m.overrideDiscard.mockResolvedValue({ overrideId: "o2", files: 0 });
    render(<App />);
    await waitFor(() => expect(testDock.shell).not.toBeNull());
    const { onOverrideCommand, onOverrideDiscard } = testDock.shell!.model;
    const input = { program: "git", args: ["status"], reason: "The agent broke the build" };
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    let third!: Promise<unknown>;
    act(() => {
      first = onOverrideCommand("run1", input);
      second = onOverrideCommand("run1", input);
      third = onOverrideDiscard("run1", "The agent broke the build");
    });
    expect(await second).toEqual({ ok: false, error: "An override of this run is already being sent" });
    expect(await third).toEqual({ ok: false, error: "An override of this run is already being sent" });
    expect(m.overrideCommand).toHaveBeenCalledTimes(1);
    expect(m.overrideDiscard).not.toHaveBeenCalled();
    finish();
    await act(async () => void (await first));
    expect(await first).toEqual({ ok: true, overrideId: "o1" });
    // Once the first is answered, the next one is sent.
    await act(async () => void (await testDock.shell!.model.onOverrideDiscard("run1", "The agent broke the build")));
    expect(m.overrideDiscard).toHaveBeenCalledTimes(1);
  });

  it("runs a command through the override route", async () => {
    m.overrideCommand.mockResolvedValue({ overrideId: "o1" });
    await openChanges();
    await userEvent.click(screen.getByText("Emergency override"));
    const form = screen.getByRole("group", { name: "Run a command in this run's working copy" });
    await userEvent.type(within(form).getByLabelText("Program"), "git");
    await userEvent.type(within(form).getByLabelText("Arguments (one per line)"), "status");
    await userEvent.type(within(form).getByLabelText("Why? (required, at least 10 characters)"), "The agent broke the build");
    await userEvent.click(within(form).getByRole("button", { name: "Run as override" }));
    await userEvent.click(within(form).getByRole("button", { name: "Confirm and run" }));
    await waitFor(() =>
      expect(m.overrideCommand).toHaveBeenCalledWith("run2", { program: "git", args: ["status"], reason: "The agent broke the build" }),
    );
  });

  it("words a failed load", async () => {
    vi.mocked(errorMessage).mockImplementation(() => "This run's working copy no longer exists on this computer");
    m.getRunChanges.mockRejectedValue(new ApiError(404, "worktree_missing"));
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    m.listRuns.mockResolvedValue([run1]);
    m.listRunDir.mockImplementation(async (_runId, path) => listing(path, []));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Changes" }));
    expect(await screen.findByText("This run's working copy no longer exists on this computer")).toBeTruthy();
    expect(errorMessage).toHaveBeenCalledWith(expect.any(ApiError), "changes");
  });
});

describe("App Share view", () => {
  const views = () => screen.getByRole("navigation", { name: "Views" });
  const shareEntry = (seq: number, type: LedgerEntry["type"], projectId = "A"): LedgerEntry => ({
    seq, id: String(seq), ts: "2026-11-15T12:00:00Z", projectId, actor: { kind: "human", id: "owner" },
    type, payload: {}, prevHash: "", hash: "",
  });
  const ACK = "I have read this page and I am happy to share everything on it.";

  async function openShare() {
    m.getBoard.mockImplementation((id) => Promise.resolve(mk(id)));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Project A" }));
    await screen.findByRole("heading", { name: "Project A" });
    await waitFor(() => expect(h.subs.size).toBe(2));
    await userEvent.click(within(views()).getByRole("button", { name: "Share" }));
  }

  it("loads the project's snapshots and links, and again on a share entry of the project only", async () => {
    m.listShareSnapshots.mockResolvedValue([snapshotRecord()]);
    m.listShareLinks.mockResolvedValue([link()]);
    await openShare();
    expect(m.listShareSnapshots).toHaveBeenCalledWith("A");
    expect(m.listShareLinks).toHaveBeenCalledWith("A");
    expect(await screen.findByText(new RegExp(`#${SHARE_ID.slice(0, 8)}`))).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Live links" })).getAllByRole("listitem")).toHaveLength(1);
    m.listShareSnapshots.mockClear();
    m.listShareLinks.mockClear();
    await act(async () => h.onEntry!(shareEntry(20, "card.created")));
    await act(async () => h.onEntry!(shareEntry(21, "share.confirmed", "B")));
    expect(m.listShareSnapshots).not.toHaveBeenCalled();
    await act(async () => h.onEntry!(shareEntry(22, "share.revoked")));
    await waitFor(() => expect(m.listShareLinks).toHaveBeenCalledWith("A"));
    expect(m.listShareSnapshots).toHaveBeenCalledWith("A");
  });

  it("loads the addresses when the Share view opens", async () => {
    m.listShareAddresses.mockResolvedValue(ADDRESSES);
    await openShare();
    await waitFor(() => expect(m.listShareAddresses).toHaveBeenCalled());
  });

  it("says why no address is offered when the addresses could not be loaded", async () => {
    m.listShareAddresses.mockRejectedValue(new ApiError(500, "internal"));
    m.listShareSnapshots.mockResolvedValue([snapshotRecord()]);
    await openShare();
    await userEvent.click(await screen.findByRole("button", { name: "Share on your network…" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The addresses this computer can share on could not be loaded. Close and open the Share view to try again.",
    );
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews with the chosen options, shows the page, and clears a stale preview on confirm", async () => {
    m.previewShare.mockResolvedValue(preview());
    m.confirmShare.mockRejectedValue(new ApiError(409, "preview_stale"));
    await openShare();
    await userEvent.click(screen.getByRole("checkbox", { name: "Include my prompts to agents" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview share page" }));
    expect(m.previewShare).toHaveBeenCalledWith("A", { includePrompts: true, includeHardware: false, digestDays: 7 });
    const frame = (await screen.findByTitle("Share page preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toContain("Book Club");
    await userEvent.click(screen.getByRole("checkbox", { name: ACK }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm and save snapshot" }));
    expect(m.confirmShare).toHaveBeenCalledWith("A", "pv1", preview().contentHash);
    await waitFor(() => expect(screen.queryByTitle("Share page preview")).toBeNull());
  });

  it("drops the preview when the options change, so what is confirmed matches what is chosen", async () => {
    m.previewShare.mockResolvedValue(preview());
    await openShare();
    await userEvent.click(screen.getByRole("button", { name: "Preview share page" }));
    expect(await screen.findByTitle("Share page preview")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Include this computer's hardware" }));
    expect(screen.queryByTitle("Share page preview")).toBeNull();
  });

  it("confirms a preview, drops it, and reloads the snapshots", async () => {
    m.previewShare.mockResolvedValue(preview());
    m.confirmShare.mockResolvedValue(snapshotRecord());
    await openShare();
    await userEvent.click(screen.getByRole("button", { name: "Preview share page" }));
    await screen.findByTitle("Share page preview");
    m.listShareSnapshots.mockClear();
    await userEvent.click(screen.getByRole("checkbox", { name: ACK }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm and save snapshot" }));
    expect(await screen.findByText("Saved. Open, download or share it from the Share view.")).toBeTruthy();
    await waitFor(() => expect(m.listShareSnapshots).toHaveBeenCalledWith("A"));
    // The confirmed preview is gone: saving again needs a new preview, and its previewId is never sent twice.
    expect(screen.queryByTitle("Share page preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm and save snapshot" })).toBeNull();
    expect(m.confirmShare).toHaveBeenCalledTimes(1);
  });

  it("creates a link for a snapshot and revokes it", async () => {
    m.listShareSnapshots.mockResolvedValue([snapshotRecord()]);
    m.listShareAddresses.mockResolvedValue(ADDRESSES);
    m.createShareLink.mockResolvedValue({ link: link(), url: "http://127.0.0.1:47400/tok" });
    m.revokeShareLink.mockResolvedValue(undefined);
    await openShare();
    await userEvent.click(await screen.findByRole("button", { name: "Share on your network…" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Address" }).querySelectorAll("option")).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(m.createShareLink).toHaveBeenCalledWith(SHARE_ID, "127.0.0.1", 1440);
    expect(((await screen.findByRole("textbox", { name: "Share link" })) as HTMLInputElement).value).toBe("http://127.0.0.1:47400/tok");
    m.listShareLinks.mockResolvedValue([link()]);
    await act(async () => h.onEntry!(shareEntry(30, "share.link_created")));
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(m.revokeShareLink).toHaveBeenCalledWith("l1");
  });

  it("loads the digests once the Daily digest tab opens, again on its entries, and for the chosen window", async () => {
    m.getDigests.mockResolvedValue([digest()]);
    await openShare();
    // Nothing asks for digests while the tab is closed: not on opening the view, not on an entry.
    await act(async () => h.onEntry!(shareEntry(39, "card.created")));
    expect(m.getDigests).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open daily digest" }));
    await waitFor(() => expect(m.getDigests).toHaveBeenCalledWith("A", 7));
    expect(await screen.findByRole("article", { name: "2026-11-15 (UTC)" })).toBeTruthy();
    m.getDigests.mockClear();
    await act(async () => h.onEntry!(shareEntry(40, "card.created")));
    await waitFor(() => expect(m.getDigests).toHaveBeenCalledWith("A", 7));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Days" }), "30");
    await waitFor(() => expect(m.getDigests).toHaveBeenCalledWith("A", 30));
  });
});

describe("App: who is signed in, and who is here", () => {
  const views = () => screen.getByRole("navigation", { name: "Views" });
  it("goes to /sign-in when nobody is signed in, and on any later 401 from the auth hook", async () => {
    m.getMe.mockRejectedValue(new ApiError(401, "unauthorized"));
    const navigate = vi.fn();
    render(<App navigate={navigate} />);
    // The real api calls the handler on the 401; this mock stands in for it.
    await waitFor(() => expect(h.unauthorized).not.toBeNull());
    act(() => h.unauthorized!());
    expect(navigate).toHaveBeenCalledWith("/sign-in");
    expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull();
  });

  it("shows the person in the status bar, and a viewer's controls disabled", async () => {
    m.getMe.mockResolvedValue({ ...OWNER_ME, personId: "v1", name: "Viewer One", role: "viewer" });
    render(<App />);
    expect(await screen.findByRole("button", { name: "You: Viewer One (Viewer)" })).toBeTruthy();
    expect((screen.getByLabelText("New project name") as HTMLInputElement).disabled).toBe(true);
    // A viewer is not the Owner: no invitations are asked for.
    expect(m.listInvites).not.toHaveBeenCalled();
  });

  it("reports the project and view for presence on every stream, and lists who is here", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Views" });
    await waitFor(() => expect(h.opts.some((o) => o.onPresence)).toBe(true));
    await userEvent.click(within(views()).getByRole("button", { name: "People" }));
    const opts = h.opts.find((o) => o.onPresence)!;
    expect(opts.presence!()).toEqual({ projectId: null, view: "people" });
    act(() =>
      opts.onPresence!([{ personId: "r1", name: "Reviewer One", role: "reviewer", projectId: null, view: null, since: "2026-11-15T00:00:00Z" }]),
    );
    expect(await screen.findByText("Reviewer One · Reviewer · not in a project")).toBeTruthy();
    expect(m.listInvites).toHaveBeenCalled();
  });

  it("names the person who made each ledger entry, a removed person included, and anyone unknown as Someone", async () => {
    m.listPeople.mockResolvedValue([
      { id: "owner", name: "Owner", role: "owner", joinedAt: null, lastSeenAt: null, removedAt: null, credentials: 1 },
      { id: "r1", name: "Reviewer One", role: "reviewer", joinedAt: null, lastSeenAt: null, removedAt: null, credentials: 1 },
      { id: "x1", name: "Former Person", role: "viewer", joinedAt: null, lastSeenAt: null, removedAt: "2026-11-15T00:00:00Z", credentials: 0 },
    ]);
    const decided = (seq: number, who: string): LedgerEntry => ({
      seq, id: `e${seq}`, ts: "2026-01-01T00:00:00Z", projectId: null, actor: { kind: "human", id: who },
      type: "card.created", payload: { cardId: `c${seq}`, title: `Card ${seq}`, stage: "plan" }, prevHash: "", hash: "",
    });
    m.listLedger.mockResolvedValue([decided(1, "r1"), decided(2, "x1"), decided(3, "nobody")]);
    render(<App />);
    await operatorLayout();
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Views" })).getByRole("button", { name: "Ledger" }));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    const ledger = () => screen.getByRole("complementary", { name: "Ledger" });
    await waitFor(() => expect(within(ledger()).getAllByRole("listitem")).toHaveLength(3));
    await waitFor(() => expect(within(ledger()).getByText(/^Reviewer One added/)).toBeTruthy());
    expect(within(ledger()).getByText(/^Former Person added/)).toBeTruthy();
    expect(within(ledger()).getByText(/^Someone added/)).toBeTruthy();
    // A removed person is still named in the ledger, but not listed among the people.
    await userEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "People" }));
    expect(screen.queryByText("Former Person")).toBeNull();
  });

  it("reads people again on a person.* entry", async () => {
    render(<App />);
    await screen.findByRole("navigation", { name: "Views" });
    await waitFor(() => expect(h.onEntry).toBeDefined());
    const before = m.listPeople.mock.calls.length;
    await act(async () => {
      h.onEntry!({
        seq: 9, id: "9", ts: "2026-01-01T00:00:00Z", projectId: null, actor: { kind: "human", id: "owner" },
        type: "person.role_changed", payload: { personId: "r1", from: "reviewer", to: "maintainer" }, prevHash: "", hash: "",
      });
    });
    await waitFor(() => expect(m.listPeople.mock.calls.length).toBeGreaterThan(before));
  });
});
