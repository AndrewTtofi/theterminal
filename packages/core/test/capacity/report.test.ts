import { describe, expect, it } from "vitest";
import type { AuthMode, HardwareInfo, LocalEngine, Provider } from "@theterminal/shared";
import { capacityReport } from "../../src/capacity/report.js";
import type { Budget } from "../../src/connections/service.js";
import { openDatabase, type Db } from "../../src/db.js";

const NOW = new Date(2026, 10, 15, 14, 0, 0);
const at = (d: Date) => d.toISOString();

function seed() {
  const db = openDatabase(":memory:");
  let n = 0;
  const run = (adapter: string, started: Date, cost: number | null, tokens: [number | null, number | null] = [null, null]) =>
    db
      .prepare(
        `INSERT INTO agent_runs (id, project_id, adapter, auth_mode, prompt, status, worktree, cost_usd, input_tokens, output_tokens, started_at)
         VALUES (?, 'p1', ?, 'api_key', 'p', 'completed', 'wt', ?, ?, ?, ?)`,
      )
      .run(`r${++n}`, adapter, cost, tokens[0], tokens[1], at(started));
  const limit = (adapter: string, when: Date, retry: number | null = null, runId = "r") =>
    db.prepare("INSERT INTO rate_limits (run_id, adapter, at, retry_after_s) VALUES (?, ?, ?, ?)").run(runId, adapter, at(when), retry);
  return { db, run, limit };
}

const MODES: Record<Provider, AuthMode> = { claude: "api_key", codex: "chatgpt", gemini: "google" };
const report = (db: Db, budgets: Budget[] = [], hardware: (HardwareInfo & { enabled: boolean }) | null = null) =>
  capacityReport(db, { budgets: () => budgets, modes: (p) => MODES[p], hardware: () => hardware, now: () => NOW });
const source = (r: ReturnType<typeof report>, p: Provider) => r.sources.find((s) => s.provider === p)!;

describe("capacityReport", () => {
  it("has one source per provider, with the mode and no plan or budget when none is set", () => {
    const { db } = seed();
    const r = report(db);
    expect(r.sources.map((s) => s.provider)).toEqual(["claude", "codex", "gemini"]);
    expect(source(r, "codex")).toMatchObject({ connectionId: null, name: "Codex", mode: "chatgpt", plan: null, monthlyBudgetUsd: null });
    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r.hardware).toBeNull();
  });

  it("lists the local model servers it is given, and none without them", () => {
    const { db } = seed();
    expect(report(db).localModels).toEqual([]);
    const engines: LocalEngine[] = [{
      engine: "ollama", baseUrl: "http://127.0.0.1:11434/v1", version: "0.12.3", detectedAt: NOW.toISOString(),
      models: [{ id: "qwen2.5-coder:14b", sizeBytes: 9_000_000_000, parameters: "14.8B", quantization: "Q4_K_M" }],
    }];
    const r = capacityReport(db, { budgets: () => [], modes: (p) => MODES[p], hardware: () => null, localModels: () => engines, now: () => NOW });
    expect(r.localModels).toEqual(engines);
  });

  it("sums Claude's cost as an estimate over today and this month, excluding last month", () => {
    const { db, run } = seed();
    run("claude", new Date(2026, 10, 15, 9, 0), 0.1);
    run("claude", new Date(2026, 10, 15, 0, 0), 0.2);
    run("claude", new Date(2026, 10, 3, 12, 0), 1);
    run("claude", new Date(2026, 9, 31, 23, 59), 5);
    const claude = source(report(db), "claude");
    expect(claude.today.runs).toBe(2);
    expect(claude.today.costUsd.basis).toBe("estimate");
    expect(claude.today.costUsd.value).toBeCloseTo(0.3);
    expect(claude.month.runs).toBe(3);
    expect(claude.month.costUsd.value).toBeCloseTo(1.3);
  });

  it("says not_reported, never 0, for a null figure from any provider", () => {
    const { db, run } = seed();
    run("codex", new Date(2026, 10, 15, 9, 0), null, [100, 20]);
    run("codex", new Date(2026, 10, 15, 10, 0), null, [50, null]);
    const r = report(db);
    const codex = source(r, "codex");
    expect(codex.today.costUsd).toEqual({ value: null, basis: "not_reported" });
    expect(codex.today.inputTokens).toEqual({ value: 150, basis: "reported" });
    expect(codex.today.outputTokens).toEqual({ value: 20, basis: "reported" });
    // No runs at all: nothing reported, not zero, Claude included.
    for (const p of ["claude", "gemini"] as const) {
      expect(source(r, p).month.costUsd).toEqual({ value: null, basis: "not_reported" });
      expect(source(r, p).month.inputTokens).toEqual({ value: null, basis: "not_reported" });
    }
  });

  it("marks a reported Gemini cost as reported", () => {
    const { db, run } = seed();
    run("gemini", new Date(2026, 10, 15, 9, 0), 0.05);
    expect(source(report(db), "gemini").today.costUsd).toEqual({ value: 0.05, basis: "reported" });
  });

  it("counts each run once however many rate limits it hit, per adapter", () => {
    const { db, limit } = seed();
    const hourAgo = new Date(NOW.getTime() - 3600_000);
    limit("claude", new Date(NOW.getTime() - 3 * 3600_000), null, "r1");
    limit("claude", new Date(NOW.getTime() - 2 * 3600_000), 30, "r1");
    limit("claude", hourAgo, null, "r1");
    limit("claude", hourAgo, null, "r2");
    limit("codex", hourAgo, null, "r1");
    const r = report(db);
    expect(source(r, "claude").rateLimits).toEqual({ last24h: 2, lastAt: hourAgo.toISOString(), basis: "estimate" });
    expect(source(r, "codex").rateLimits.last24h).toBe(1);
  });

  it("counts observed rate limits within the last 24 hours per adapter, as an estimate", () => {
    const { db, limit } = seed();
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000);
    limit("codex", twoHoursAgo, 12);
    limit("codex", new Date(NOW.getTime() - 25 * 3600_000));
    limit("claude", new Date(NOW.getTime() - 30 * 3600_000));
    const r = report(db);
    expect(source(r, "codex").rateLimits).toEqual({ last24h: 1, lastAt: twoHoursAgo.toISOString(), basis: "estimate" });
    expect(source(r, "claude").rateLimits.last24h).toBe(0);
    expect(source(r, "gemini").rateLimits).toEqual({ last24h: 0, lastAt: null, basis: "estimate" });
  });

  it("takes the connection, plan and budget from budgets() and the hardware from its source", () => {
    const { db } = seed();
    const hw: HardwareInfo & { enabled: boolean } = { enabled: true, cpu: "Fake CPU", cores: 8, memoryGb: 32, gpu: null, gpuMemoryGb: null, platform: "linux", wsl: false, detectedAt: NOW.toISOString() };
    const r = report(db, [{ connectionId: "c1", provider: "claude", name: "Work Claude", plan: "Max 5x", monthlyBudgetUsd: 50 }], hw);
    expect(source(r, "claude")).toMatchObject({ connectionId: "c1", name: "Work Claude", plan: "Max 5x", monthlyBudgetUsd: 50 });
    expect(source(r, "gemini").monthlyBudgetUsd).toBeNull();
    expect(r.hardware).toEqual(hw);
    const off = report(db, [], { ...hw, enabled: false });
    expect(off.hardware).toEqual({ ...hw, enabled: false });
  });
});
