import { PROVIDERS, type AuthMode, type Basis, type CapacityReport, type CapacitySource, type Figure, type HardwareInfo, type Provider, type UsageWindow } from "@theterminal/shared";
import type { Budget } from "../connections/service.js";
import type { Db } from "../db.js";

export type CapacityDeps = {
  budgets: () => Budget[];
  modes: (p: Provider) => AuthMode;
  hardware: () => HardwareInfo | null;
  now?: () => Date;
};

const NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A figure's basis. A null value is always not_reported, never 0. Claude's cost is the Agent SDK's own estimate;
 * any other figure an adapter passed on is the provider's.
 */
function figure(value: number | null, estimate: boolean): Figure {
  const basis: Basis = value === null ? "not_reported" : estimate ? "estimate" : "reported";
  return { value, basis };
}

function usage(db: Db, adapter: Provider, from: Date, to: Date): UsageWindow {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output
       FROM agent_runs WHERE adapter = ? AND started_at >= ? AND started_at < ?`,
    )
    .get(adapter, from.toISOString(), to.toISOString()) as { runs: number; cost: number | null; input: number | null; output: number | null };
  return {
    runs: row.runs,
    costUsd: figure(row.cost, adapter === "claude"),
    inputTokens: figure(row.input, false),
    outputTokens: figure(row.output, false),
  };
}

function rateLimits(db: Db, adapter: Provider, now: Date): CapacitySource["rateLimits"] {
  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE adapter = ? AND at > ?")
    .get(adapter, new Date(now.getTime() - DAY_MS).toISOString()) as { n: number };
  const last = db.prepare("SELECT MAX(at) AS at FROM rate_limits WHERE adapter = ?").get(adapter) as { at: string | null };
  // What the adapters inferred from errors, not a quota the provider published.
  return { last24h: recent.n, lastAt: last.at, basis: "estimate" };
}

/**
 * Usage per provider today and this month (the server's local calendar), the plan and budget the Owner set, the
 * rate limits observed in the last 24 hours, and this computer's hardware.
 */
export function capacityReport(db: Db, deps: CapacityDeps): CapacityReport {
  const now = (deps.now ?? (() => new Date()))();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const budgets = deps.budgets();
  const sources = PROVIDERS.map((provider): CapacitySource => {
    const budget = budgets.find((b) => b.provider === provider);
    return {
      provider,
      connectionId: budget?.connectionId ?? null,
      name: budget?.name ?? NAMES[provider],
      mode: deps.modes(provider),
      plan: budget?.plan ?? null,
      monthlyBudgetUsd: budget?.monthlyBudgetUsd ?? null,
      today: usage(db, provider, dayStart, nextDay),
      month: usage(db, provider, monthStart, nextMonth),
      rateLimits: rateLimits(db, provider, now),
    };
  });
  return { sources, hardware: deps.hardware(), generatedAt: now.toISOString() };
}
