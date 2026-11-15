import type { CapacityReport, CapacitySource, HardwareInfo, LocalEngine, Provider, UsageWindow } from "@theterminal/shared";

const none: UsageWindow = {
  runs: 0,
  costUsd: { value: null, basis: "not_reported" },
  inputTokens: { value: null, basis: "not_reported" },
  outputTokens: { value: null, basis: "not_reported" },
};

export function source(provider: Provider, over: Partial<CapacitySource> = {}): CapacitySource {
  return {
    provider,
    connectionId: null,
    name: provider.charAt(0).toUpperCase() + provider.slice(1),
    mode: "api_key",
    plan: null,
    monthlyBudgetUsd: null,
    today: none,
    month: none,
    rateLimits: { last24h: 0, lastAt: null, basis: "estimate" },
    ...over,
  };
}

export const hardware: HardwareInfo & { enabled: boolean } = {
  enabled: true, cpu: "Apple M2 Max", cores: 12, memoryGb: 32, gpu: "Apple M2 Max", gpuMemoryGb: 32, platform: "darwin", wsl: false,
  detectedAt: "2026-11-15T12:00:00.000Z",
};

/** Ollama with two models (one without details), llama.cpp server with one and no version. */
export const localEngines: LocalEngine[] = [
  {
    engine: "ollama", baseUrl: "http://127.0.0.1:11434/v1", version: "0.12.3", detectedAt: "2026-11-15T12:00:00.000Z",
    models: [
      { id: "qwen2.5-coder:14b", sizeBytes: 9_000_000_000, parameters: "14.8B", quantization: "Q4_K_M" },
      { id: "llama3.2:3b", sizeBytes: null, parameters: null, quantization: null },
    ],
  },
  {
    engine: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1", version: null, detectedAt: "2026-11-15T12:00:00.000Z",
    models: [{ id: "gpt-oss-20b", sizeBytes: null, parameters: null, quantization: null }],
  },
];

/** Claude with a plan, a budget and estimated cost; Codex with tokens but no cost; Gemini with nothing. */
export function report(over: Partial<CapacityReport> = {}): CapacityReport {
  return {
    sources: [
      source("claude", {
        connectionId: "c1", plan: "Max 5x", monthlyBudgetUsd: 50,
        today: { runs: 2, costUsd: { value: 0.4, basis: "estimate" }, inputTokens: { value: 1200, basis: "reported" }, outputTokens: { value: 300, basis: "reported" } },
        month: { runs: 9, costUsd: { value: 12, basis: "estimate" }, inputTokens: { value: 45000, basis: "reported" }, outputTokens: { value: 9000, basis: "reported" } },
        rateLimits: { last24h: 2, lastAt: "2026-11-15T10:00:00.000Z", basis: "estimate" },
      }),
      source("codex", {
        mode: "chatgpt",
        month: { runs: 1, costUsd: { value: null, basis: "not_reported" }, inputTokens: { value: 500, basis: "reported" }, outputTokens: { value: 50, basis: "reported" } },
      }),
      source("gemini"),
    ],
    hardware: null,
    localModels: [],
    machines: [],
    generatedAt: "2026-11-15T12:00:00.000Z",
    ...over,
  };
}
