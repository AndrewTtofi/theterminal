import type { CiStatus } from "@theterminal/shared";
import type { Status } from "../api";
import type { ViewId } from "./views";

const MONTH_TITLE = "Includes estimates: Claude's cost is computed by its SDK, not billed by the provider.";

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
  const needsYou = status ? status.pendingDecisions + status.intakeDecisions : pending;
  const cost = (status?.todayCostUsd ?? 0).toFixed(2);
  const month = status?.monthCostUsd ?? 0;
  const budget = status?.monthlyBudgetUsd ?? null;
  const conn = status?.connections;
  const connections = conn
    ? `Connections: ${conn.enabled} connected${conn.failed > 0 ? `, ${conn.failed} failed` : ""}`
    : "Connections: 0 connected";
  return (
    <footer className="status-bar" aria-label="Status bar">
      <div className="status-left">
        <span className="status-item">Agents running: {runningCount}</span>
        <span className="status-item">
          Today: ${cost}
          {budget !== null && (
            <span className={month >= budget ? "attention" : undefined} title={MONTH_TITLE}>
              {` · Month: $${month.toFixed(2)} of $${budget.toFixed(2)}`}
            </span>
          )}
        </span>
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
        <CiItem ci={status?.ci ?? null} />
        <button type="button" className="status-item" onClick={onResetLayout}>
          Reset layout
        </button>
      </div>
    </footer>
  );
}

function CiItem({ ci }: { ci: CiStatus | null }) {
  if (!ci) return <span className="status-item">CI: not connected</span>;
  const className = `status-item${ci.state === "failing" ? " attention" : ""}`;
  return ci.url ? (
    <a className={className} href={ci.url} target="_blank" rel="noopener noreferrer">
      {`CI: ${ci.state}`}
    </a>
  ) : (
    <span className={className}>{`CI: ${ci.state}`}</span>
  );
}
