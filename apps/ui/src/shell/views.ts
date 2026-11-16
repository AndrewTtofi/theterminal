/** The activity bar's views, in their fixed order: Home first, then twelve (the Board only while "Show the Board" is on). */
export const VIEWS = [
  "home", "board", "agents", "changes", "needs_you", "ledger", "connections", "github", "capacity", "machines", "people", "share", "learn",
] as const;
export type ActivityViewId = (typeof VIEWS)[number];
/** Every side bar view: the ones above, and Settings, which opens from the gear pinned below them. */
export type ViewId = ActivityViewId | "settings";
export const VIEW_LABELS: Record<ViewId, string> = {
  home: "Home",
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
