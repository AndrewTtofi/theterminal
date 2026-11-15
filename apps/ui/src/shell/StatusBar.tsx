import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { visibleControls } from "@theterminal/shared";
import type { CiStatus } from "@theterminal/shared";
import type { Status } from "../api";
import { PRESET_LABELS } from "./dock-layout";
import type { PresetId } from "./dock-layout";
import type { ViewId } from "./views";

/** The Layout select's data and actions. `saveAs` throws a RangeError, whose message is shown, when the save is refused. */
export type LayoutControls = {
  /** "Guided", "Operator", a saved name, or "Custom". */
  current: string;
  saved: string[];
  applyPreset(preset: PresetId): void;
  applySaved(name: string): void;
  saveAs(name: string): void;
};

const MONTH_TITLE = "Includes estimates: Claude's cost is computed by its SDK, not billed by the provider.";

type Props = {
  /** The server's latest status; null until the first answer arrives. */
  status: Status | null;
  /** Local counts, shown until the server has answered. */
  running: number;
  pending: number;
  onSelectView: (view: ViewId) => void;
  onResetLayout: () => void;
  layout: LayoutControls;
};

export function StatusBar({ status, running, pending, onSelectView, onResetLayout, layout }: Props) {
  const runningCount = status?.runningAgents ?? running;
  const needsYou = status ? status.pendingDecisions + status.intakeDecisions : pending;
  const cost = (status?.todayCostUsd ?? 0).toFixed(2);
  const month = status?.monthCostUsd ?? 0;
  const budget = status?.monthlyBudgetUsd ?? null;
  const conn = status?.connections;
  const connections = conn
    ? `Connections: ${conn.enabled} connected${conn.failed > 0 ? `, ${conn.failed} failed` : ""}`
    : "Connections: 0 connected";
  const linked = status?.machines?.linked ?? 0;
  const machines = `Machines: ${linked} linked${linked > 0 ? `, ${status?.machines?.online ?? 0} online` : ""}`;
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
        <button type="button" className="status-item" onClick={() => onSelectView("machines")}>
          {machines}
        </button>
        <CiItem ci={status?.ci ?? null} />
        <LayoutItem layout={layout} />
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

const PRESETS = Object.keys(PRESET_LABELS) as PresetId[];
const presetValue = (p: PresetId) => `preset:${p}`;
const savedValue = (name: string) => `saved:${name}`;

/** The Layout select and Save layout, which reveals a name input and a Save button. */
function LayoutItem({ layout }: { layout: LayoutControls }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Set when the name form closes, so focus goes back to Save layout instead of falling to the page. */
  const [closed, setClosed] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!closed) return;
    setClosed(false);
    saveButton.current?.focus();
  }, [closed]);
  const close = () => {
    setNaming(false);
    setClosed(true);
  };

  const preset = PRESETS.find((p) => PRESET_LABELS[p] === layout.current);
  const value = preset ? presetValue(preset) : layout.saved.includes(layout.current) ? savedValue(layout.current) : "custom";

  const choose = (v: string) => {
    const p = PRESETS.find((x) => presetValue(x) === v);
    if (p) layout.applyPreset(p);
    else if (v.startsWith("saved:")) layout.applySaved(v.slice("saved:".length));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === "") return;
    try {
      layout.saveAs(name.trim());
    } catch (err) {
      if (err instanceof RangeError) {
        setError(err.message);
        return;
      }
      throw err;
    }
    close();
    setName("");
    setError(null);
  };

  return (
    <span className="status-item layout-item">
      <select aria-label="Layout" value={value} onChange={(e) => choose(e.target.value)}>
        {value === "custom" && (
          <option value="custom" disabled>
            Custom
          </option>
        )}
        {PRESETS.map((p) => (
          <option key={p} value={presetValue(p)}>
            {PRESET_LABELS[p]}
          </option>
        ))}
        {layout.saved.map((n) => (
          <option key={n} value={savedValue(n)}>
            {visibleControls(n)}
          </option>
        ))}
      </select>
      {naming ? (
        <form className="layout-save" onSubmit={save}>
          <input
            aria-label="Layout name"
            value={name}
            maxLength={40}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
          />
          <button type="submit" disabled={name.trim() === ""}>
            Save
          </button>
          {error !== null && (
            <span className="attention" role="alert">
              {error}
            </span>
          )}
        </form>
      ) : (
        <button type="button" ref={saveButton} onClick={() => setNaming(true)}>
          Save layout
        </button>
      )}
    </span>
  );
}
