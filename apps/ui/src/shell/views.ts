/** The activity bar's views, in their fixed order (Plans 6, 7 and 8 together): twelve. */
export const VIEWS = [
  "board", "agents", "changes", "needs_you", "ledger", "connections", "github", "capacity", "machines", "people", "share", "learn",
] as const;
export type ActivityViewId = (typeof VIEWS)[number];
/** Every side bar view: the twelve above, and Settings, which opens from the gear pinned below them. */
export type ViewId = ActivityViewId | "settings";
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
  people: "People",
  share: "Share",
  learn: "Learn",
  settings: "Settings",
};
