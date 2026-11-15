export const VIEWS = ["board", "agents", "changes", "needs_you", "ledger", "connections", "github", "capacity", "machines", "share", "learn"] as const;
export type ViewId = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<ViewId, string> = {
  board: "Board",
  agents: "Agents",
  changes: "Changes",
  needs_you: "Needs you",
  ledger: "Ledger",
  connections: "Connections",
  github: "GitHub",
  capacity: "Capacity",
  machines: "Machines",
  share: "Share",
  learn: "Learn",
};
