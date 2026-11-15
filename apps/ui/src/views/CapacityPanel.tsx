import { useEffect, useRef } from "react";
import type { CapacitySource, Figure, HardwareInfo, LocalEngine, MachineCapacity } from "@theterminal/shared";
import { OWN_LABEL, PROVIDER_NAMES } from "../components/ProviderAuthSettings";
import { useShell } from "../shell/model";
import { shownName } from "./MachinesSideBar";

const REFRESH_MS = 60_000;
const ESTIMATE_TITLE = "Not a figure from the provider. Computed by The Terminal from observed usage.";
const FOOTER =
  "Rate-limit counts are what The Terminal observed in errors, not a quota the provider published. Figures from the providers themselves are not shown yet.";

/** The word `estimate`, explained on hover: shown next to every figure The Terminal computed itself. */
export function Estimate() {
  return <abbr title={ESTIMATE_TITLE}>estimate</abbr>;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString("en-US");

export const providerName = (s: CapacitySource) => PROVIDER_NAMES[s.provider];
export const planText = (s: CapacitySource) => s.plan ?? "no plan set";
const modeText = (s: CapacitySource) => (s.mode === "api_key" ? "API key" : (OWN_LABEL[s.mode] ?? s.mode));

/** An engine as the Owner knows it, with its version when it reports one. */
export const engineText = (e: LocalEngine) => `${e.engine === "ollama" ? "Ollama" : "llama.cpp"}${e.version === null ? "" : ` ${e.version}`}`;
/** Decimal gigabytes, as Ollama lists model sizes. */
const sizeText = (bytes: number | null) => (bytes === null ? "not reported" : `${(bytes / 1e9).toFixed(1)} GB`);

const gb = (n: number) => `${n} GB`;
/** The CPU with its core count when known. */
export const cpuText = (hw: HardwareInfo) => (hw.cpu === null ? "not detected" : hw.cores === null ? hw.cpu : `${hw.cpu} (${hw.cores} cores)`);
export const memoryText = (hw: HardwareInfo) => (hw.memoryGb === null ? "not detected" : gb(hw.memoryGb));
/** The GPU with its memory; on a Mac the detected GPU memory is the unified memory it shares with the CPU. */
export function gpuText(hw: HardwareInfo): string {
  if (hw.gpu === null) return "not detected";
  if (hw.gpuMemoryGb === null) return hw.gpu;
  return hw.platform === "darwin" ? `${hw.gpu}, ${gb(hw.gpuMemoryGb)} shared with the CPU` : `${hw.gpu}, ${gb(hw.gpuMemoryGb)}`;
}
/** A machine's hardware on one line: `cpu · memory · gpu`. */
export const hardwareSummary = (hw: HardwareInfo) =>
  `${hw.cpu ?? "CPU not detected"} · ${hw.memoryGb === null ? "memory not detected" : gb(hw.memoryGb)} · ${hw.gpu ?? "GPU not detected"}`;
/** How many models a machine's servers list in all. */
export const modelCount = (m: MachineCapacity) => m.localModels.reduce((n, e) => n + e.models.length, 0);

const at = (iso: string) => <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>;

/**
 * When a machine was checked. An offline machine's figures are the last it sent, so it says when it last answered
 * (`lastSeenAt`), or that it never has.
 */
export function CheckedAt({ machine }: { machine: MachineCapacity }) {
  if (machine.online) return at(machine.checkedAt);
  return machine.lastSeenAt === null ? <>never seen</> : <>last seen {at(machine.lastSeenAt)}</>;
}

/**
 * One row per linked machine as it last answered; an offline row keeps the last known values, greyed. Everything a
 * machine sent is shown as text with hidden characters made visible.
 */
function MachinesTable({ machines }: { machines: MachineCapacity[] }) {
  return (
    <table className="capacity-machines-table" aria-label="Machines">
      <thead>
        <tr>
          {["Machine", "State", "CPU", "Memory", "GPU", "Local models", "Checked"].map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {machines.map((m) => (
          <tr key={m.machineId} className={m.online ? undefined : "offline"}>
            <td>{shownName(m.name)}</td>
            <td>{m.online ? "online" : "offline"}</td>
            <td>{m.hardware === null ? "not reported" : shownName(cpuText(m.hardware))}</td>
            <td>{m.hardware === null ? "not reported" : memoryText(m.hardware)}</td>
            <td>{m.hardware === null ? "not reported" : shownName(gpuText(m.hardware))}</td>
            <td>{modelCount(m)}</td>
            <td>
              <CheckedAt machine={m} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every model of every detected server, one row each. */
function LocalModelsTable({ engines }: { engines: LocalEngine[] }) {
  return (
    <table className="local-models-table" aria-label="Local models">
      <thead>
        <tr>
          {["Engine", "Model", "Size", "Parameters", "Quantization"].map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {engines.flatMap((e) =>
          e.models.map((m) => (
            <tr key={`${e.engine}/${m.id}`}>
              <td>{engineText(e)}</td>
              <td>{m.id}</td>
              <td>{sizeText(m.sizeBytes)}</td>
              <td>{m.parameters ?? "not reported"}</td>
              <td>{m.quantization ?? "not reported"}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}

/** Loads the report while mounted: on open, then every 60 s. */
export function useCapacityRefresh(refresh: () => void): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    ref.current();
    const timer = setInterval(() => ref.current(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
}

/** A figure as text: a null value is `not reported`, never 0; an estimate carries the word. */
function FigureText({ figure, format }: { figure: Figure; format: (n: number) => string }) {
  if (figure.value === null) return <>not reported</>;
  return (
    <>
      {format(figure.value)}
      {figure.basis === "estimate" && (
        <>
          {" "}
          <Estimate />
        </>
      )}
    </>
  );
}

function Tokens({ s }: { s: CapacitySource }) {
  const { inputTokens: i, outputTokens: o } = s.month;
  if (i.value === null && o.value === null) return <>not reported</>;
  return (
    <>
      <FigureText figure={i} format={count} />
      {" / "}
      <FigureText figure={o} format={count} />
    </>
  );
}

/** Runs that hit a rate limit in 24 h; `none observed` when nothing ran this month and so nothing could be observed. */
function RateLimits({ s }: { s: CapacitySource }) {
  if (s.rateLimits.last24h === 0 && s.month.runs === 0) return <>none observed</>;
  return <FigureText figure={{ value: s.rateLimits.last24h, basis: s.rateLimits.basis }} format={count} />;
}

/**
 * The Capacity tab: each provider's mode, plan, spend, budget, tokens and observed rate limits, the local models and the
 * linked machines.
 */
export function CapacityPanel(_props: { id: string }) {
  const { model } = useShell();
  const { report, error, refresh } = model.capacity;
  useCapacityRefresh(refresh);

  if (error) return <p className="empty">Could not load capacity</p>;
  if (!report) return <p className="empty">Loading…</p>;

  return (
    <div className="capacity-panel">
      <table className="capacity-table">
        <thead>
          <tr>
            {["Source", "Mode", "Plan", "Today", "This month", "Budget", "Tokens (in / out)", "Rate limits (24 h)"].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.sources.map((s) => (
            <tr key={s.provider}>
              <td>{s.name}</td>
              <td>{modeText(s)}</td>
              <td>{planText(s)}</td>
              <td>
                <FigureText figure={s.today.costUsd} format={usd} />
              </td>
              <td>
                <FigureText figure={s.month.costUsd} format={usd} />
              </td>
              <td>{s.monthlyBudgetUsd === null ? "none" : usd(s.monthlyBudgetUsd)}</td>
              <td>
                <Tokens s={s} />
              </td>
              <td>
                <RateLimits s={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.localModels.some((e) => e.models.length > 0) && (
        <>
          <h3>Local models</h3>
          <LocalModelsTable engines={report.localModels} />
        </>
      )}
      {report.machines.length > 0 && (
        <>
          <h3>Machines</h3>
          <MachinesTable machines={report.machines} />
        </>
      )}
      <p className="capacity-footer">{FOOTER}</p>
    </div>
  );
}
