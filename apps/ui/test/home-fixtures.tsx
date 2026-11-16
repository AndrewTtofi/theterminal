import { vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { AgentRun, HomeRun, HomeRuns, Me, PendingAgentAction, Role } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { fakeDock, shellNav } from "./connections-harness";
import { OWNER_ME } from "./as-owner";

type Rendered = ReturnType<typeof render> & { dock: ReturnType<typeof fakeDock>; nav: ReturnType<typeof shellNav>; model: WorkbenchModel };

export const homeRun = (id: string, over: Partial<AgentRun> = {}, extra: Partial<HomeRun> = {}): HomeRun => {
  const run: AgentRun = {
    id, projectId: "p1", cardId: null, adapter: "claude", authMode: "none", prompt: "Fix the contact form", status: "running",
    worktree: `w/${id}`, base: null, costUsd: 0.42, inputTokens: null, outputTokens: null, error: null,
    startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), finishedAt: null, machineId: null, ...over,
  };
  return { run, projectName: "Website", title: "Fix the contact form", percent: null, now: null, summary: null, waiting: false, reason: null, ...extra };
};

export const pendingAction = (over: Partial<PendingAgentAction> = {}): PendingAgentAction => ({
  id: "a1", runId: "r1", kind: "file_edit", tool: "Edit", summary: "Edit src/a.ts",
  input: { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }, status: "pending", decidedBy: null, reason: "",
  output: null, requestedAt: "", decidedAt: null, projectId: "p1", projectName: "Website", ...over,
});

export const asRole = (role: Role): Me => ({ ...OWNER_ME, personId: role === "owner" ? "owner" : `p-${role}`, role });

export function homeModel(over: Partial<WorkbenchModel> = {}, data: HomeRuns | null = { working: [], finishedToday: [] }): WorkbenchModel {
  return {
    projects: [{ id: "p1", name: "Website", createdAt: "" }],
    selectedId: "p1",
    runs: [],
    pending: [],
    gate: null,
    intake: null,
    status: { runningAgents: 0, pendingDecisions: 0, todayCostUsd: 0, doneToday: 0 },
    agentsInfo: { adapters: ["claude", "codex"], providers: {} },
    projectEntries: [],
    projectOlder: { hasOlder: false, loading: false, error: null },
    narration: {},
    home: { data, error: null, scope: "project", setScope: vi.fn(), refresh: vi.fn() },
    projectFiles: { data: null, error: null, refresh: vi.fn() },
    onStartRun: vi.fn().mockResolvedValue(true),
    onDecide: vi.fn().mockResolvedValue(undefined),
    onSelectRun: vi.fn(),
    onFollowRun: vi.fn(),
    onSelectProject: vi.fn(),
    me: OWNER_ME,
    ...over,
  } as unknown as WorkbenchModel;
}

export function renderInShell(ui: ReactElement, model: WorkbenchModel): Rendered {
  const dock = fakeDock();
  const nav = shellNav();
  const utils = render(
    <ShellContext.Provider value={{ model, dock: () => dock, ...nav } satisfies ShellContextValue}>{ui}</ShellContext.Provider>,
  );
  return { ...utils, dock, nav, model };
}
