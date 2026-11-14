type Props = {
  running: number;
  pending: number;
  onResetLayout: () => void;
};

/** Skeleton: spend, connections and CI are placeholders until the status API exists. */
export function StatusBar({ running, pending, onResetLayout }: Props) {
  return (
    <footer className="status-bar" aria-label="Status bar">
      <div className="status-left">
        <span className="status-item">Agents running: {running}</span>
        <span className="status-item">Today: $0.00</span>
        <span className={`status-item${pending > 0 ? " attention" : ""}`}>Needs you: {pending}</span>
      </div>
      <div className="status-right">
        <span className="status-item">Connections: 0 connected</span>
        <span className="status-item">CI: not connected</span>
        <button type="button" className="status-item" onClick={onResetLayout}>
          Reset layout
        </button>
      </div>
    </footer>
  );
}
