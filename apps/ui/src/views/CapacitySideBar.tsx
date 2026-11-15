import { useId, useState } from "react";
import type { CapacitySource, HardwareInfo, MachineCapacity } from "@theterminal/shared";
import { api, errorMessage } from "../api";
import { useShell } from "../shell/model";
import {
  CheckedAt, Estimate, cpuText, engineText, gpuText, hardwareSummary, memoryText, modelCount, planText, providerName, usd, useCapacityRefresh,
} from "./CapacityPanel";
import { shownName } from "./MachinesSideBar";

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
  return (
    <ul>
      <li>{`CPU: ${cpuText(hw)}`}</li>
      <li>{`Memory: ${memoryText(hw)}`}</li>
      <li>{`GPU: ${gpuText(hw)}`}</li>
      {hw.wsl && <li>Running inside WSL: the GPU is the Windows machine's.</li>}
    </ul>
  );
}

/** A linked machine at a glance: its state, a one-line hardware summary and how many local models it serves. */
function MachineSection({ machine, id }: { machine: MachineCapacity; id: string }) {
  const n = modelCount(machine);
  return (
    <section aria-labelledby={id} className={machine.online ? undefined : "offline"}>
      <h3 id={id}>{`${shownName(machine.name)} · ${machine.online ? "online" : "offline"}`}</h3>
      <ul>
        <li>{machine.hardware === null ? "Hardware not reported" : shownName(hardwareSummary(machine.hardware))}</li>
        <li>{`${n} ${n === 1 ? "local model" : "local models"}`}</li>
        {!machine.online && (
          <li>
            <CheckedAt machine={machine} />
          </li>
        )}
      </ul>
    </section>
  );
}

/** Capacity at a glance: each provider's plan and month's spend, what this computer can run, and each linked machine. */
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
      <section aria-labelledby={`${uid}-local`}>
        <h3 id={`${uid}-local`}>Local models</h3>
        {report.localModels.length === 0 ? (
          <p className="empty">No local model server detected. Install Ollama or llama.cpp server and detect again.</p>
        ) : (
          <ul>
            {report.localModels.map((e) => (
              <li key={e.engine}>{`${engineText(e)} · ${e.models.length} ${e.models.length === 1 ? "model" : "models"}`}</li>
            ))}
          </ul>
        )}
      </section>
      {report.machines.map((m) => (
        <MachineSection key={m.machineId} machine={m} id={`${uid}-machine-${m.machineId}`} />
      ))}
    </div>
  );
}
