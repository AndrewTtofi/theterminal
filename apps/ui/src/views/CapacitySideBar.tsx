import { useId, useState } from "react";
import type { CapacitySource, HardwareInfo } from "@theterminal/shared";
import { api, errorMessage } from "../api";
import { useShell } from "../shell/model";
import { Estimate, planText, providerName, usd, useCapacityRefresh } from "./CapacityPanel";

/** The month's spend: against the budget when both exist, else alone, else `not reported` (never $0). */
function Spend({ s }: { s: CapacitySource }) {
  const cost = s.month.costUsd;
  if (cost.value === null) return <p className="capacity-spend">not reported</p>;
  const budget = s.monthlyBudgetUsd;
  return (
    <>
      {budget !== null && budget > 0 && (
        <div
          className="capacity-bar"
          role="progressbar"
          aria-label={`${providerName(s)} spend this month`}
          aria-valuemin={0}
          aria-valuemax={budget}
          aria-valuenow={cost.value}
          aria-valuetext={`${usd(cost.value)} of ${usd(budget)}`}
        >
          <div className={`capacity-bar-fill${cost.value >= budget ? " attention" : ""}`} style={{ width: `${Math.min(100, (cost.value / budget) * 100)}%` }} />
        </div>
      )}
      <p className="capacity-spend">
        {budget !== null ? `${usd(cost.value)} of ${usd(budget)} this month` : `${usd(cost.value)} this month`}
        {cost.basis === "estimate" && (
          <>
            {" "}
            <Estimate />
          </>
        )}
      </p>
    </>
  );
}

function HardwareLines({ hw }: { hw: HardwareInfo }) {
  const gb = (n: number) => `${n} GB`;
  const cpu = hw.cpu === null ? "not detected" : hw.cores === null ? hw.cpu : `${hw.cpu} (${hw.cores} cores)`;
  let gpu = hw.gpu ?? "not detected";
  if (hw.gpu !== null && hw.gpuMemoryGb !== null) {
    // On a Mac the detected GPU memory is the unified memory it shares with the CPU.
    gpu += hw.platform === "darwin" ? `, ${gb(hw.gpuMemoryGb)} shared with the CPU` : `, ${gb(hw.gpuMemoryGb)}`;
  }
  return (
    <ul>
      <li>{`CPU: ${cpu}`}</li>
      <li>{`Memory: ${hw.memoryGb === null ? "not detected" : gb(hw.memoryGb)}`}</li>
      <li>{`GPU: ${gpu}`}</li>
      {hw.wsl && <li>Running inside WSL: the GPU is the Windows machine's.</li>}
    </ul>
  );
}

/** Capacity at a glance: each provider's plan and month's spend, and what this computer can run. */
export function CapacitySideBar() {
  const { model, dock } = useShell();
  const { report, error, refresh } = model.capacity;
  const uid = useId();
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  useCapacityRefresh(refresh);

  const detect = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      await api.detectHardware();
      refresh();
    } catch (e) {
      setDetectError(errorMessage(e));
    } finally {
      setDetecting(false);
    }
  };

  if (error) return <p className="empty">Could not load capacity</p>;
  if (!report) return <p className="empty">Loading…</p>;

  return (
    <div className="capacity-side">
      <ul className="capacity-sources">
        {report.sources.map((s) => (
          <li key={s.provider} aria-labelledby={`${uid}-${s.provider}`}>
            <h3 id={`${uid}-${s.provider}`}>{`${providerName(s)} · ${planText(s)}`}</h3>
            <Spend s={s} />
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => dock()?.focus("capacity")}>
        Open capacity
      </button>
      <section aria-labelledby={`${uid}-hw`}>
        <h3 id={`${uid}-hw`}>This computer</h3>
        {report.hardware === null ? (
          <p className="empty">Not detected yet</p>
        ) : report.hardware.enabled ? (
          <HardwareLines hw={report.hardware} />
        ) : (
          <p className="empty">Turned off in Connections</p>
        )}
        <button type="button" onClick={() => void detect()} disabled={detecting}>
          Detect this computer
        </button>
        {detectError && <p className="capacity-error">{detectError}</p>}
      </section>
    </div>
  );
}
