import { useEffect, useRef } from "react";
import type { CapacitySource, Figure } from "@theterminal/shared";
import { OWN_LABEL, PROVIDER_NAMES } from "../components/ProviderAuthSettings";
import { useShell } from "../shell/model";

const REFRESH_MS = 60_000;
const ESTIMATE_TITLE = "Not a figure from the provider. Computed by The Terminal from observed usage.";
const FOOTER =
  "Figures marked estimate are computed by The Terminal, not published by the provider. Providers that publish no quota have none shown.";

/** The word `estimate`, explained on hover: shown next to every figure The Terminal computed itself. */
export function Estimate() {
  return <abbr title={ESTIMATE_TITLE}>estimate</abbr>;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString("en-US");

export const providerName = (s: CapacitySource) => PROVIDER_NAMES[s.provider];
export const planText = (s: CapacitySource) => s.plan ?? "no plan set";
const modeText = (s: CapacitySource) => (s.mode === "api_key" ? "API key" : (OWN_LABEL[s.mode] ?? s.mode));

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
                <FigureText figure={{ value: s.rateLimits.last24h, basis: s.rateLimits.basis }} format={count} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="capacity-footer">{FOOTER}</p>
    </div>
  );
}
