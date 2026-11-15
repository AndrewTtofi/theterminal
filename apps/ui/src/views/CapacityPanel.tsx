import { useEffect, useRef } from "react";
import type { CapacitySource, Figure, LocalEngine } from "@theterminal/shared";
import { OWN_LABEL, PROVIDER_NAMES } from "../components/ProviderAuthSettings";
import { useShell } from "../shell/model";

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

/** The Capacity tab: each provider's mode, plan, spend, budget, tokens and observed rate limits. */
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
      <p className="capacity-footer">{FOOTER}</p>
    </div>
  );
}
