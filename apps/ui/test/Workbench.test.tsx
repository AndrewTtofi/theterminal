import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONNECTION_CATALOG } from "@theterminal/shared";
import type { AgentAction, AgentRun, Board, Connection, LedgerEntry, PendingAgentAction } from "@theterminal/shared";

vi.mock("../src/shell/Dock", () => import("./test-dock"));

import { Workbench } from "../src/shell/Workbench";
import type { WorkbenchModel } from "../src/shell/model";
import { testDock } from "./test-dock";
import type { ConnectionsModel } from "../src/use-connections";

function connectionsModel(over: Partial<ConnectionsModel> = {}): ConnectionsModel {
  return {
    catalog: [...CONNECTION_CATALOG],
    list: [],
    loaded: true,
    loadError: false,
    refresh: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    ...over,
  };
}

const board: Board = {
  project: { id: "p1", name: "Local Model Hub", pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
};
const run: AgentRun = {
  id: "run1", projectId: "p1", cardId: null, adapter: "fake", authMode: "none", prompt: "Detect GPU",
  status: "running", worktree: "w/run1", costUsd: null, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null,
};
const action: AgentAction = {
  id: "a1", runId: "run1", kind: "file_read", tool: "Read", summary: "read README.md", input: {},
  status: "allowed", decidedBy: "policy", reason: "", output: null, requestedAt: "", decidedAt: null,
};
const pendingAction: PendingAgentAction = {
  id: "p1a", runId: "run1", kind: "shell", tool: "Bash", summary: "Run: nvidia-smi", input: {}, status: "pending",
  decidedBy: null, reason: "", output: null, requestedAt: "", decidedAt: null, projectId: "p1", projectName: "Local Model Hub",
};
const entry: LedgerEntry = {
  seq: 1, id: "e1", ts: "2026-01-01T00:00:00Z", projectId: "p1", actor: { kind: "human", id: "owner" },
  type: "project.created", payload: { name: "Local Model Hub" }, prevHash: "", hash: "",
};

function model(over: Partial<WorkbenchModel> = {}): WorkbenchModel {
  return {
    projects: [board.project],
    selectedId: "p1",
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    board,
    onAddCard: vi.fn(),
    onMoveCard: vi.fn(),
    agentsInfo: {
      adapters: ["fake"],
      providers: {
        claude: { mode: "api_key", installed: true },
        codex: { mode: "api_key", installed: false },
        gemini: { mode: "api_key", installed: false },
      },
      acks: { claude: "a", codex: "b", gemini: "c" },
    },
    runs: [run],
    selectedRunId: null,
    runActions: [],
    onStartRun: vi.fn().mockResolvedValue(true),
    onSelectRun: vi.fn(),
    onStopRun: vi.fn(),
    pending: [],
    onDecide: vi.fn(),
    entries: [entry],
    ledgerScope: "project",
    onLedgerScopeChange: vi.fn(),
    onProviderAuthChange: vi.fn(),
    connections: connectionsModel(),
    ...over,
  };
}

const views = () => screen.getByRole("navigation", { name: "Views" });
const view = (name: string) => within(views()).getByRole("button", { name });

beforeEach(() => localStorage.clear());

describe("Workbench", () => {
  it("lays out the activity bar, side bar, dock and status bar, with the Board view first", () => {
    render(<Workbench model={model()} />);
    expect(view("Board").getAttribute("aria-pressed")).toBe("true");
    const side = screen.getByRole("complementary", { name: "Side bar" });
    expect(within(side).getByRole("navigation", { name: "Projects" })).toBeTruthy();
    expect(within(side).getByLabelText("New project name")).toBeTruthy();
    expect(screen.getByRole("contentinfo", { name: "Status bar" })).toBeTruthy();
    expect(screen.getByText("Agents running: 1")).toBeTruthy();
  });

  it("shows the five stage columns in the Board panel", () => {
    const { container } = render(<Workbench model={model()} />);
    const panel = container.querySelector<HTMLElement>('[data-panel="board"]')!;
    for (const stage of ["Plan", "Design", "Build", "Ship", "Operate"]) {
      expect(within(panel).getByRole("region", { name: stage })).toBeTruthy();
    }
    expect(within(panel).getByRole("heading", { name: "Local Model Hub" })).toBeTruthy();
  });

  it("switches side bars from the activity bar", async () => {
    render(<Workbench model={model()} />);
    await userEvent.click(view("Agents"));
    expect(view("Agents").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeTruthy();
    expect(screen.getByLabelText("Prompt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start agent" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();

    await userEvent.click(view("Board"));
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeTruthy();
  });

  it("collapses the side bar when the active view is clicked again", async () => {
    render(<Workbench model={model()} />);
    await userEvent.click(view("Board"));
    expect(screen.queryByRole("complementary", { name: "Side bar" })).toBeNull();
    expect(view("Board").getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(view("Board"));
    expect(screen.getByRole("complementary", { name: "Side bar" })).toBeTruthy();
  });

  it("starts a run from the Agents side bar", async () => {
    const m = model();
    render(<Workbench model={m} />);
    await userEvent.click(view("Agents"));
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(m.onStartRun).toHaveBeenCalledWith("fake", "hello");
  });

  it("shows the selected run's actions in the Agent feed panel", () => {
    const { container } = render(<Workbench model={model({ selectedRunId: "run1", runActions: [action] })} />);
    const feed = container.querySelector<HTMLElement>('[data-panel="agent_feed"]')!;
    expect(within(feed).getByText(/Detect GPU/)).toBeTruthy();
    expect(within(feed).getByText(/read README\.md · allowed · decided by policy/)).toBeTruthy();
  });

  it("keeps the ledger in an aside labelled Ledger in the bottom panel", () => {
    const { container } = render(<Workbench model={model()} />);
    const panel = container.querySelector<HTMLElement>('[data-panel="ledger"]')!;
    const aside = within(panel).getByRole("complementary", { name: "Ledger" });
    expect(within(aside).getAllByRole("listitem")[0]!.textContent).toContain('Owner created project "Local Model Hub"');
  });

  it("switches the ledger scope from the Ledger side bar", async () => {
    const m = model();
    render(<Workbench model={m} />);
    await userEvent.click(view("Ledger"));
    await userEvent.click(screen.getByRole("radio", { name: "All projects" }));
    expect(m.onLedgerScopeChange).toHaveBeenCalledWith("all");
    await userEvent.click(screen.getByRole("button", { name: "Open ledger panel" }));
  });

  it("shows pending decisions in the Needs you side bar and badges the activity bar", async () => {
    render(<Workbench model={model({ pending: [pendingAction] })} />);
    expect(within(view("Needs you")).getByText("1")).toBeTruthy();
    await userEvent.click(view("Needs you"));
    const side = screen.getByRole("complementary", { name: "Side bar" });
    expect(within(side).getByRole("article", { name: "Decision: Run: nvidia-smi" })).toBeTruthy();
  });

  it("lists the connection catalog, with Plan 5B entries disabled, and opens an editor tab from a row", async () => {
    const { container } = render(<Workbench model={model()} />);
    await userEvent.click(view("Connections"));
    const side = screen.getByRole("complementary", { name: "Side bar" });
    for (const label of ["Claude (Anthropic)", "Codex (OpenAI)", "Gemini (Google)", "GitHub"]) {
      expect(within(side).getByText(label)).toBeTruthy();
    }
    const aws = within(side).getByText("AWS").closest("li")!;
    expect(aws.getAttribute("aria-disabled")).toBe("true");
    expect(aws.textContent).toContain("Arrives with Plan 5B");

    await userEvent.click(within(side).getByRole("button", { name: "GitHub" }));
    const tab = container.querySelector('[data-panel="connection:new:github"]')!;
    expect(within(tab as HTMLElement).getByLabelText("Personal access token")).toBeTruthy();
  });

  it("closes restored tabs for connections that no longer exist, once the list is loaded", async () => {
    const conn: Connection = {
      id: "c1", kind: "llm", provider: "claude", name: "Claude", enabled: true, config: {}, private: {}, secretFields: [],
      status: { state: "untested", message: "", testedAt: null }, createdAt: "", updatedAt: "",
    };
    const { container, rerender } = render(<Workbench model={model({ connections: connectionsModel({ loaded: false }) })} />);
    act(() => {
      testDock.api!.open("connection:gone", "Claude (Anthropic)", "main");
      testDock.api!.open("connection:c1", "Claude (Anthropic)", "main");
    });
    expect(container.querySelector('[data-panel="connection:gone"]')).toBeTruthy();
    rerender(<Workbench model={model({ connections: connectionsModel({ loaded: true, list: [conn] }) })} />);
    expect(container.querySelector('[data-panel="connection:gone"]')).toBeNull();
    expect(container.querySelector('[data-panel="connection:c1"]')).toBeTruthy();

    // Only the first load prunes: a later list without c1 leaves its tab to say it no longer exists.
    rerender(<Workbench model={model({ connections: connectionsModel({ loaded: true, list: [] }) })} />);
    expect(container.querySelector('[data-panel="connection:c1"]')?.textContent).toBe("This connection no longer exists.");
  });

  it("keeps connection tabs open when the list fails to load", () => {
    const failed = () => connectionsModel({ loaded: false, loadError: true });
    const { container, rerender } = render(<Workbench model={model({ connections: failed() })} />);
    act(() => testDock.api!.open("connection:c1", "Claude (Anthropic)", "main"));
    rerender(<Workbench model={model({ connections: failed() })} />);
    expect(container.querySelector('[data-panel="connection:c1"]')).toBeTruthy();
  });

  it("prunes a restored new-connection tab for a provider that is not available", () => {
    const { container, rerender } = render(<Workbench model={model({ connections: connectionsModel({ loaded: false }) })} />);
    act(() => {
      testDock.api!.open("connection:new:aws", "AWS", "main");
      testDock.api!.open("connection:new:github", "GitHub", "main");
    });
    rerender(<Workbench model={model({ connections: connectionsModel({ loaded: true }) })} />);
    expect(container.querySelector('[data-panel="connection:new:aws"]')).toBeNull();
    expect(container.querySelector('[data-panel="connection:new:github"]')).toBeTruthy();
  });

  it("shows the Plan 5B placeholder for GitHub and Capacity", async () => {
    render(<Workbench model={model()} />);
    await userEvent.click(view("GitHub"));
    expect(screen.getByText("Arrives with Plan 5B.")).toBeTruthy();
    await userEvent.click(view("Capacity"));
    expect(screen.getByText("Arrives with Plan 5B.")).toBeTruthy();
  });

  it("keeps the Needs-you strip above the dock in every view, even with the bottom panel closed", async () => {
    const { container } = render(<Workbench model={model({ pending: [pendingAction] })} />);
    await userEvent.click(view("Connections"));
    await userEvent.keyboard("{Control>}j{/Control}");
    expect(container.querySelector('[data-panel="ledger"]')).toBeNull();
    expect(container.querySelector('[data-panel="agent_feed"]')).toBeNull();
    const strip = screen.getByRole("region", { name: "Needs you" });
    expect(strip.querySelector('article[aria-label="Decision: Run: nvidia-smi"]')).toBeTruthy();
  });

  it("reopens and focuses the Board tab when the Board view is selected", async () => {
    const { container } = render(<Workbench model={model()} />);
    act(() => testDock.api!.close("board"));
    expect(container.querySelector('[data-panel="board"]')).toBeNull();
    await userEvent.click(view("Agents"));
    await userEvent.click(view("Board"));
    const board = container.querySelector('[data-panel="board"]');
    expect(board).toBeTruthy();
    expect(board!.getAttribute("data-active")).toBe("true");
  });

  it("toggles the bottom panel with Ctrl+J and Cmd+J, but not while typing", async () => {
    const { container } = render(<Workbench model={model()} />);
    const ledgerShown = () => container.querySelector('[data-panel="ledger"]') !== null;

    await userEvent.click(screen.getByLabelText("New project name"));
    await userEvent.keyboard("{Control>}j{/Control}");
    expect(ledgerShown()).toBe(true);

    await userEvent.click(view("Agents"));
    await userEvent.click(screen.getByLabelText("Prompt"));
    await userEvent.keyboard("{Meta>}j{/Meta}");
    expect(ledgerShown()).toBe(true);

    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(editable);
    editable.focus();
    await userEvent.keyboard("{Control>}j{/Control}");
    expect(ledgerShown()).toBe(true);
    editable.remove();

    await userEvent.click(view("Agents"));
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Meta>}j{/Meta}");
    expect(ledgerShown()).toBe(false);
    await userEvent.keyboard("{Control>}j{/Control}");
    expect(ledgerShown()).toBe(true);
  });

  it("does not show the strip when nothing is pending", () => {
    render(<Workbench model={model()} />);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("resizes the side bar with the keyboard within 200 to 480 px", async () => {
    render(<Workbench model={model()} />);
    const handle = screen.getByRole("separator", { name: "Resize side bar" });
    const side = screen.getByRole("complementary", { name: "Side bar" });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(260);
    for (let i = 0; i < 40; i++) await userEvent.keyboard("{ArrowRight}");
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    expect(side.style.width).toBe("480px");
    for (let i = 0; i < 40; i++) await userEvent.keyboard("{ArrowLeft}");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
  });
});
