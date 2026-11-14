import type { Status } from "../api";
import type { ViewId } from "./views";

type Props = {
  /** The server's latest status; null until the first answer arrives. */
  status: Status | null;
  /** Local counts, shown until the server has answered. */
  running: number;
  pending: number;
  onSelectView: (view: ViewId) => void;
  onResetLayout: () => void;
};

export function StatusBar({ status, running, pending, onSelectView, onResetLayout }: Props) {
  const runningCount = status?.runningAgents ?? running;
  const needsYou = status?.pendingDecisions ?? pending;
  const cost = (status?.todayCostUsd ?? 0).toFixed(2);
  const conn = status?.connections;
  const connections = conn
    ? `Connections: ${conn.enabled} connected${conn.failed > 0 ? `, ${conn.failed} failed` : ""}`
    : "Connections: 0 connected";
  return (
    <footer className="status-bar" aria-label="Status bar">
      <div className="status-left">
        <span className="status-item">Agents running: {runningCount}</span>
        <span className="status-item">Today: ${cost}</span>
        <button
          type="button"
          className={`status-item${needsYou > 0 ? " attention" : ""}`}
          onClick={() => onSelectView("needs_you")}
        >
          Needs you: {needsYou}
        </button>
      </div>
      <div className="status-right">
        {conn?.keychain === "unavailable" ? (
          <button type="button" className="status-item attention" onClick={() => onSelectView("connections")}>
            Keychain unavailable
          </button>
        ) : (
          <button
            type="button"
            className={`status-item${conn && conn.failed > 0 ? " attention" : ""}`}
            onClick={() => onSelectView("connections")}
          >
            {connections}
          </button>
        )}
        <span className="status-item">CI: not connected</span>
        <button type="button" className="status-item" onClick={onResetLayout}>
          Reset layout
        </button>
      </div>
    </footer>
  );
}
