export const VIEWS = ["board", "agents", "needs_you", "ledger", "connections", "github", "capacity"] as const;
export type ViewId = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<ViewId, string> = {
  board: "Board",
  agents: "Agents",
  needs_you: "Needs you",
  ledger: "Ledger",
  connections: "Connections",
  github: "GitHub",
  capacity: "Capacity",
};
