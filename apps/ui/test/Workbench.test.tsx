import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONNECTION_CATALOG } from "@theterminal/shared";
import type { AgentRun, Board, Connection, LedgerEntry, PendingAgentAction } from "@theterminal/shared";

vi.mock("../src/shell/Dock", () => import("./test-dock"));

import { Workbench } from "../src/shell/Workbench";
import type { DockPanelId } from "../src/shell/Dock";
import type { AppModel } from "../src/shell/model";
import { testDock } from "./test-dock";
import { ALL_ANSWERS, intakeView } from "./intake-fixtures";
import { planPassed, shipBlocked } from "./gate-fixtures";
import type { Status } from "../src/api";
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

/** Every provider is available since 5B; this catalog keeps one unavailable to cover that path. */
const withoutAws = CONNECTION_CATALOG.map((e) => (e.provider === "aws" ? { ...e, available: false } : e));

const board: Board = {
  project: { id: "p1", name: "Local Model Hub", pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
};
const run: AgentRun = {
  id: "run1", projectId: "p1", cardId: null, adapter: "fake", authMode: "none", prompt: "Detect GPU",
  status: "running", worktree: "w/run1", costUsd: null, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null,
};
const pendingAction: PendingAgentAction = {
  id: "p1a", runId: "run1", kind: "shell", tool: "Bash", summary: "Run: nvidia-smi", input: {}, status: "pending",
  decidedBy: null, reason: "", output: null, requestedAt: "", decidedAt: null, projectId: "p1", projectName: "Local Model Hub",
};
const entry: LedgerEntry = {
  seq: 1, id: "e1", ts: "2026-01-01T00:00:00Z", projectId: "p1", actor: { kind: "human", id: "owner" },
  type: "project.created", payload: { name: "Local Model Hub" }, prevHash: "", hash: "",
};

function model(over: Partial<AppModel> = {}): AppModel {
  return {
    projects: [board.project],
    selectedId: "p1",
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    board,
    onAddCard: vi.fn(),
    onMoveCard: vi.fn(),
    status: null,
    agentsInfo: {
      adapters: ["fake"],
      providers: {
        claude: { mode: "api_key", available: true },
        codex: { mode: "api_key", available: false },
        gemini: { mode: "api_key", available: false },
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
    projectEntries: [entry],
    feedRunId: null,
    onFollowRun: vi.fn(),
    ledgerHasOlder: false,
    onLoadOlderLedger: vi.fn(async () => {}),
    ledgerScope: "project",
    onLedgerScopeChange: vi.fn(),
    ledgerTopics: ["board", "agent", "decision", "gate", "intake", "connection", "settings", "other"],
    onLedgerTopicsChange: vi.fn(),
    narration: {},
    onProviderAuthChange: vi.fn(),
    connections: connectionsModel(),
    github: { overview: null, error: null, refresh: vi.fn() },
    capacity: { report: null, error: null, refresh: vi.fn() },
    intake: null,
    onStartIntake: vi.fn().mockResolvedValue(true),
    onAnswerIntake: vi.fn().mockResolvedValue(true),
    onDecideIntake: vi.fn().mockResolvedValue(true),
    onCompleteIntake: vi.fn().mockResolvedValue(true),
    onReopenIntake: vi.fn().mockResolvedValue(true),
    gate: null,
    onResolveGate: vi.fn().mockResolvedValue(true),
    onCancelGate: vi.fn(),
    story: vi.fn().mockReturnValue(new Promise(() => {})),
    subscribeEntries: () => () => {},
    runExists: vi.fn().mockResolvedValue(true),
    changesRunId: null,
    onSelectChangesRun: vi.fn(),
    changes: null,
    changesError: null,
    runChanges: vi.fn().mockReturnValue(new Promise(() => {})),
    dir: vi.fn().mockReturnValue(new Promise(() => {})),
    file: vi.fn().mockReturnValue(new Promise(() => {})),
    diff: vi.fn().mockReturnValue(new Promise(() => {})),
    onOverrideCommand: vi.fn(async () => ({ ok: true as const })),
    onOverrideDiscard: vi.fn(async () => ({ ok: true as const, files: 0 })),
    ...over,
  };
}

const views = () => screen.getByRole("navigation", { name: "Views" });
const view = (name: string) => within(views()).getByRole("button", { name });

/** Switches the TestDock to the Operator preset, which shows the Agent feed and the Ledger in the bottom panel. */
const operator = () => act(() => testDock.api!.applyPreset("operator"));

beforeEach(() => {
  localStorage.clear();
  testDock.restore = null;
});

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
    expect(m.onStartRun).toHaveBeenCalledWith("fake", "hello", []);
  });

  it("shows the project's agent entries in the Agent feed panel and its commands in the Terminal panel", () => {
    const requested: LedgerEntry = {
      ...entry, seq: 2, id: "e2", actor: { kind: "agent", id: "run1" }, type: "agent.action.requested",
      payload: { runId: "run1", actionId: "a1", kind: "shell", tool: "Bash", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" } },
    };
    const { container } = render(<Workbench model={model({ projectEntries: [entry, requested] })} />);
    operator();
    const feed = container.querySelector<HTMLElement>('[data-panel="agent_feed"]')!;
    expect(within(feed).getByRole("listitem").textContent).toContain('wants to run the command "nvidia-smi"');
    const terminal = container.querySelector<HTMLElement>('[data-panel="terminal"]')!;
    expect(within(terminal).getByRole("listitem").textContent).toBe("$ nvidia-smi");
  });

  it("keeps the ledger in an aside labelled Ledger in the bottom panel", () => {
    const { container } = render(<Workbench model={model()} />);
    operator();
    const panel = container.querySelector<HTMLElement>('[data-panel="ledger"]')!;
    const aside = within(panel).getByRole("complementary", { name: "Ledger" });
    expect(within(aside).getAllByRole("listitem")[0]!.textContent).toContain('Owner created the project "Local Model Hub"');
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

  it("lists the connection catalog, with unavailable entries disabled, and opens an editor tab from a row", async () => {
    const { container } = render(<Workbench model={model({ connections: connectionsModel({ catalog: withoutAws }) })} />);
    await userEvent.click(view("Connections"));
    const side = screen.getByRole("complementary", { name: "Side bar" });
    for (const label of ["Claude (Anthropic)", "Codex (OpenAI)", "Gemini (Google)", "GitHub"]) {
      expect(within(side).getByText(label)).toBeTruthy();
    }
    const aws = within(side).getByText("AWS").closest("li")!;
    expect(aws.getAttribute("aria-disabled")).toBe("true");
    expect(aws.textContent).toContain("Arrives in a later release");

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
    act(() => testDock.api!.applyPreset("operator"));
    act(() => {
      testDock.api!.open("connection:gone", "Claude (Anthropic)", "main");
      testDock.api!.open("connection:c1", "Claude (Anthropic)", "main");
    });
    act(() => testDock.api!.saveAs("Mine"));
    rerender(<Workbench model={model({ connections: connectionsModel({ loaded: true, list: [conn] }) })} />);
    expect(container.querySelector('[data-panel="connection:gone"]')).toBeNull();
    // Closing a stale tab on load is not the Owner changing the layout: the name stays.
    expect(testDock.api!.currentName()).toBe("Mine");
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
    const { container, rerender } = render(<Workbench model={model({ connections: connectionsModel({ loaded: false, catalog: withoutAws }) })} />);
    act(() => {
      testDock.api!.open("connection:new:aws", "AWS", "main");
      testDock.api!.open("connection:new:github", "GitHub", "main");
    });
    rerender(<Workbench model={model({ connections: connectionsModel({ loaded: true, catalog: withoutAws }) })} />);
    expect(container.querySelector('[data-panel="connection:new:aws"]')).toBeNull();
    expect(container.querySelector('[data-panel="connection:new:github"]')).toBeTruthy();
  });

  it("loads the GitHub view when it is selected", async () => {
    const github = { overview: null, error: null, refresh: vi.fn() };
    render(<Workbench model={model({ github })} />);
    await userEvent.click(view("GitHub"));
    expect(github.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("loads the Capacity view when it is selected, and opens the Capacity tab from it", async () => {
    const capacity = { report: { sources: [], hardware: null, generatedAt: "2026-11-15T12:00:00.000Z" }, error: null, refresh: vi.fn() };
    const { container } = render(<Workbench model={model({ capacity })} />);
    expect(container.querySelector('[data-panel="capacity"]')).toBeNull();
    await userEvent.click(view("Capacity"));
    expect(capacity.refresh).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open capacity" }));
    const tab = container.querySelector('[data-panel="capacity"]');
    expect(tab?.getAttribute("data-active")).toBe("true");
    expect(within(tab as HTMLElement).getByRole("table")).toBeTruthy();
  });

  it("opens the Connections view from the GitHub view when GitHub is not connected", async () => {
    render(<Workbench model={model({ github: { overview: null, error: "github_not_connected", refresh: vi.fn() } })} />);
    await userEvent.click(view("GitHub"));
    await userEvent.click(screen.getByRole("button", { name: "Open Connections" }));
    expect(view("Connections").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the Needs-you strip above the dock in every view, even with the bottom panel closed", async () => {
    const { container } = render(<Workbench model={model({ pending: [pendingAction] })} />);
    operator();
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
    operator();
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

  it("keeps a gate card in the strip in the Connections view with the bottom panel closed, and badges it", async () => {
    const m = model({ gate: { cardId: "c1", cardTitle: "Login", to: "ship", evaluations: [planPassed(), shipBlocked()], note: null, revision: 0, refreshing: false } });
    const { container } = render(<Workbench model={m} />);
    await userEvent.click(view("Connections"));
    await userEvent.keyboard("{Control>}j{/Control}");
    expect(container.querySelector('[data-panel="ledger"]')).toBeNull();
    const strip = screen.getByRole("region", { name: "Needs you" });
    expect(within(strip).getByRole("article", { name: "Gate: Ready to ship" })).toBeTruthy();
    expect(within(strip).getByText("Passed: Plan approved")).toBeTruthy();
    expect(within(view("Needs you")).getByText("1")).toBeTruthy();
    await userEvent.click(within(strip).getByRole("button", { name: "Cancel" }));
    expect(m.onCancelGate).toHaveBeenCalled();
  });

  it("opens a card's story tab from its title on the board", async () => {
    const login = { id: "c1", projectId: "p1", title: "Login", stage: "build", status: "todo", createdAt: "", updatedAt: "" } as const;
    const m = model({ board: { ...board, columns: { ...board.columns, build: [login] } } });
    const { container } = render(<Workbench model={m} />);
    await userEvent.click(screen.getByRole("button", { name: "Open the story of Login" }));
    expect(container.querySelector('[data-panel="story:c1"]')?.getAttribute("data-active")).toBe("true");
    expect(m.story).toHaveBeenCalledWith("c1");
  });

  it("offers the board's cards when starting a run and passes the chosen one", async () => {
    const login = { id: "c1", projectId: "p1", title: "Login", stage: "build", status: "todo", createdAt: "", updatedAt: "" } as const;
    const m = model({ board: { ...board, columns: { ...board.columns, build: [login] } } });
    render(<Workbench model={m} />);
    await userEvent.click(view("Agents"));
    await userEvent.selectOptions(screen.getByLabelText("Card (optional)"), "Login");
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(m.onStartRun).toHaveBeenCalledWith("fake", "hello", [], "c1");
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

  describe("layouts and new views", () => {
    const panels = (container: HTMLElement) => [...container.querySelectorAll("[data-panel]")].map((p) => p.getAttribute("data-panel"));
    const layoutSelect = () => screen.getByRole("combobox", { name: "Layout" }) as HTMLSelectElement;

    it("opens on the Guided layout: the Board and the Conversation, no Ledger", () => {
      const { container } = render(<Workbench model={model()} />);
      expect(panels(container)).toEqual(["board", "conversation"]);
      expect(container.querySelector('[data-panel="ledger"]')).toBeNull();
      expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Guided");
    });

    it("keeps a decision in the strip with the Guided layout in the Connections view, and badges it", async () => {
      const { container } = render(<Workbench model={model({ pending: [pendingAction] })} />);
      await userEvent.click(view("Connections"));
      expect(panels(container)).toEqual(["board", "conversation"]);
      const strip = screen.getByRole("region", { name: "Needs you" });
      expect(strip.querySelector('article[aria-label="Decision: Run: nvidia-smi"]')).toBeTruthy();
      expect(within(view("Needs you")).getByText("1")).toBeTruthy();
    });

    it("switches presets from the status bar, saves a layout under a name, and resets to Guided", async () => {
      const { container } = render(<Workbench model={model()} />);
      await userEvent.selectOptions(layoutSelect(), "Operator");
      expect(panels(container)).toEqual(["board", "capacity", "terminal", "agent_feed", "ledger"]);
      expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Operator");

      act(() => testDock.api!.close("ledger"));
      expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Custom");
      await userEvent.click(screen.getByRole("button", { name: "Save layout" }));
      await userEvent.type(screen.getByLabelText("Layout name"), "Mine");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Mine");
      expect([...layoutSelect().options].map((o) => o.textContent)).toEqual(["Guided", "Operator", "Mine"]);

      await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
      expect(panels(container)).toEqual(["board", "conversation"]);
      expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Guided");
      await userEvent.selectOptions(layoutSelect(), "Mine");
      expect(panels(container)).toEqual(["board", "capacity", "terminal", "agent_feed"]);
    });

    it("keeps the selected name and says so when browser storage refuses the save", async () => {
      render(<Workbench model={model()} />);
      await userEvent.selectOptions(layoutSelect(), "Operator");
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
      try {
        await userEvent.click(screen.getByRole("button", { name: "Save layout" }));
        await userEvent.type(screen.getByLabelText("Layout name"), "Mine{Enter}");
        expect(screen.getByRole("alert").textContent).toBe("The layout could not be saved: browser storage is full or blocked");
        expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Operator");
        expect([...layoutSelect().options].map((o) => o.textContent)).toEqual(["Guided", "Operator"]);
      } finally {
        setItem.mockRestore();
      }
    });

    it("lists the Changes and Learn views, with a side bar for each", async () => {
      render(<Workbench model={model()} />);
      await userEvent.click(view("Changes"));
      expect(screen.getByRole("complementary", { name: "Side bar" }).querySelector(".side-bar-title")?.textContent).toBe("Changes");
      await userEvent.click(view("Learn"));
      expect(screen.getByRole("complementary", { name: "Side bar" }).querySelector(".side-bar-title")?.textContent).toBe("Learn");
    });

    it("openLearn selects the Learn view on the topic, and never hides the side bar", () => {
      render(<Workbench model={model()} />);
      expect(testDock.shell!.learnTopic).toBeNull();
      act(() => testDock.shell!.openLearn("reading_a_diff"));
      expect(view("Learn").getAttribute("aria-pressed")).toBe("true");
      expect(testDock.shell!.learnTopic).toBe("reading_a_diff");
      expect(testDock.shell!.contextView).toBe("board");
      act(() => testDock.shell!.openLearn("estimates"));
      expect(screen.getByRole("complementary", { name: "Side bar" })).toBeTruthy();
      expect(testDock.shell!.learnTopic).toBe("estimates");
    });

    it("showView keeps the side bar open on the active view, and the status bar uses it", async () => {
      render(<Workbench model={model()} />);
      act(() => testDock.shell!.showView("changes"));
      act(() => testDock.shell!.showView("changes"));
      expect(view("Changes").getAttribute("aria-pressed")).toBe("true");
      expect(testDock.shell!.contextView).toBe("changes");
      await userEvent.click(screen.getByRole("button", { name: "Needs you: 0" }));
      await userEvent.click(screen.getByRole("button", { name: "Needs you: 0" }));
      expect(view("Needs you").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("complementary", { name: "Side bar" })).toBeTruthy();
    });

    it("opens a run's diff and file tabs in the main area, named after the file", () => {
      const { container } = render(<Workbench model={model()} />);
      act(() => testDock.shell!.model.onOpenDiff("run1", "src/a.ts"));
      act(() => testDock.shell!.model.onOpenFile("run1", "src/a.ts"));
      expect(panels(container)).toEqual(["board", "conversation", "diff:run1:src%2Fa.ts", "file:run1:src%2Fa.ts"]);
      expect(container.querySelector('[data-panel="file:run1:src%2Fa.ts"]')?.getAttribute("data-active")).toBe("true");
    });

    it("closes restored diff and file tabs whose run the server no longer knows, keeping the rest", async () => {
      testDock.restore = [
        { id: "board", where: "main" },
        { id: "diff:run1:src%2Fa.ts", where: "main" },
        { id: "file:gone:notes.txt", where: "main" },
        { id: "diff:gone:b.ts", where: "main" },
        // Malformed: no path. A real dock could restore one from an edited layout.
        { id: "diff:broken" as DockPanelId, where: "main" },
      ];
      const runExists = vi.fn(async (id: string) => id === "run1");
      const { container } = render(<Workbench model={model({ runExists })} />);
      await waitFor(() => expect(panels(container)).toEqual(["board", "diff:run1:src%2Fa.ts"]));
      // The prune is not the Owner changing the layout: it keeps its name.
      expect(layoutSelect().selectedOptions[0]!.textContent).toBe("Guided");
      expect(runExists.mock.calls.map(([id]) => id).sort()).toEqual(["gone", "run1"]);
    });
  });

  describe("plan intake", () => {
    const statusWith = (intakeProjects: Status["intakeProjects"]): Status => ({
      runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, monthCostUsd: 0, monthlyBudgetUsd: null,
      connections: { enabled: 0, failed: 0, keychain: "ok" }, ci: null,
      intakeDecisions: intakeProjects.reduce((a, p) => a + p.decisions, 0), intakeProjects,
    });

    it("opens the Plan intake tab from the Projects side bar", async () => {
      const { container } = render(<Workbench model={model()} />);
      expect(screen.getByText("Plan: not started")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Plan intake" }));
      const tab = container.querySelector('[data-panel="intake"]');
      expect(tab?.getAttribute("data-active")).toBe("true");
      expect(within(tab as HTMLElement).getByRole("region", { name: "Plan intake" })).toBeTruthy();
    });

    it("keeps the plan notice in the strip in the Connections view with the bottom panel closed, and opens the tab", async () => {
      const { container } = render(
        <Workbench model={model({ intake: intakeView(ALL_ANSWERS), status: statusWith([{ projectId: "p1", name: "Local Model Hub", decisions: 2 }]) })} />,
      );
      await userEvent.click(view("Connections"));
      await userEvent.keyboard("{Control>}j{/Control}");
      expect(container.querySelector('[data-panel="ledger"]')).toBeNull();
      const strip = screen.getByRole("region", { name: "Needs you" });
      const item = strip.querySelector<HTMLElement>("div.needs-you-item")!;
      expect(item.textContent).toContain("Your plan needs 2 decisions");
      expect(strip.querySelectorAll("div.needs-you-item")).toHaveLength(1);
      await userEvent.click(within(item).getByRole("button", { name: "Open intake" }));
      expect(container.querySelector('[data-panel="intake"]')?.getAttribute("data-active")).toBe("true");
    });

    it("shows other projects' open plan decisions in the strip and the Needs you side bar, selecting the project", async () => {
      const onSelectProject = vi.fn();
      const { container } = render(
        <Workbench
          model={model({ onSelectProject, status: statusWith([{ projectId: "p2", name: "Book Club", decisions: 1 }]) })}
        />,
      );
      const strip = screen.getByRole("region", { name: "Needs you" });
      expect(strip.textContent).toContain("The plan for Book Club needs 1 decision");
      expect(within(view("Needs you")).getByText("1")).toBeTruthy();
      await userEvent.click(within(strip).getByRole("button", { name: "Open intake" }));
      expect(onSelectProject).toHaveBeenCalledWith("p2");
      expect(container.querySelector('[data-panel="intake"]')?.getAttribute("data-active")).toBe("true");

      await userEvent.click(view("Needs you"));
      const side = screen.getByRole("complementary", { name: "Side bar" });
      expect(side.textContent).toContain("The plan for Book Club needs 1 decision");
      expect(within(side).getByRole("button", { name: "Open intake" })).toBeTruthy();
    });

    it("shows the selected project's open decisions while questions are still unanswered", () => {
      const { budget_usd: _b, ...answers } = ALL_ANSWERS;
      const intake = intakeView({ ...answers, exposure: "internet" }, { hosting: "own_cloud", exposure_protection: "login" });
      expect(intake.step).toBe("answer");
      expect(intake.decisions.filter((d) => d.chosen === null)).toHaveLength(1);
      render(<Workbench model={model({ intake, status: statusWith([{ projectId: "p1", name: "Local Model Hub", decisions: 1 }]) })} />);
      const strip = screen.getByRole("region", { name: "Needs you" });
      expect(strip.querySelector("div.needs-you-item")?.textContent).toContain("Your plan needs 1 decision");
      expect(screen.getByText("Needs you: 1")).toBeTruthy();
    });

    it("shows no plan notice for an approved plan", () => {
      const intake = { ...intakeView(ALL_ANSWERS, { first_version: "smallest", hosting: "local" }, { completed: true }) };
      intake.decisions = intake.decisions.map((d) => ({ ...d, chosen: null }));
      render(<Workbench model={model({ intake })} />);
      expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    });

    it("does not show the strip once the plan's decisions are made", () => {
      render(<Workbench model={model({ intake: intakeView(ALL_ANSWERS, { first_version: "smallest", hosting: "local" }) })} />);
      expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    });
  });
});
