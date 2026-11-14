import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { Connection } from "@theterminal/shared";
import type { AgentsInfo } from "../src/api";
import type { DockApi } from "../src/shell/Dock";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { useConnections } from "../src/use-connections";

export const AGENTS: AgentsInfo = {
  adapters: ["fake"],
  providers: {
    claude: { mode: "api_key", installed: true, apiKey: "none" },
    codex: { mode: "api_key", installed: false, apiKey: "none" },
    gemini: { mode: "api_key", installed: false, apiKey: "none" },
  },
  acks: { claude: "Example claude warning.", codex: "Example codex warning.", gemini: "Example gemini warning." },
};

export function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: "c1",
    kind: "llm",
    provider: "claude",
    name: "Claude",
    enabled: true,
    config: {},
    private: {},
    secretFields: ["apiKey"],
    status: { state: "untested", message: "", testedAt: null },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function fakeDock(): DockApi & { [K in keyof DockApi]: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    reset: vi.fn(),
    toggleBottom: vi.fn(),
    panelIds: vi.fn(() => []),
  } as never;
}

/** Renders `children` inside the shell context, with the live connections model (backed by the mocked api). */
export function renderWithConnections(
  children: ReactNode,
  opts: { agentsInfo?: AgentsInfo | null; dock?: DockApi; onProviderAuthChange?: WorkbenchModel["onProviderAuthChange"] } = {},
): { container: HTMLElement; dock: ReturnType<typeof fakeDock> } {
  const dock = (opts.dock ?? fakeDock()) as ReturnType<typeof fakeDock>;
  function Harness() {
    const connections = useConnections();
    const model = {
      agentsInfo: opts.agentsInfo === undefined ? AGENTS : opts.agentsInfo,
      onProviderAuthChange: opts.onProviderAuthChange ?? vi.fn().mockResolvedValue(true),
      connections,
    } as unknown as WorkbenchModel;
    return <ShellContext.Provider value={{ model, dock: () => dock }}>{children}</ShellContext.Provider>;
  }
  const { container } = render(<Harness />);
  return { container, dock };
}
