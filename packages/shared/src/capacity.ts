import type { AuthMode, Provider } from "./agents.js";

/** Where a figure comes from: the provider's own number, our estimate, or nothing reported. */
export type Basis = "reported" | "estimate" | "not_reported";

export type Figure = { value: number | null; basis: Basis };

export type UsageWindow = { runs: number; costUsd: Figure; inputTokens: Figure; outputTokens: Figure };

export type CapacitySource = {
  provider: Provider;
  connectionId: string | null;
  name: string;
  mode: AuthMode;
  plan: string | null;
  monthlyBudgetUsd: number | null;
  today: UsageWindow;
  month: UsageWindow;
  rateLimits: { last24h: number; lastAt: string | null; basis: "estimate" };
};

export type HardwareInfo = {
  cpu: string | null;
  cores: number | null;
  memoryGb: number | null;
  gpu: string | null;
  gpuMemoryGb: number | null;
  platform: "darwin" | "win32" | "linux";
  wsl: boolean;
  detectedAt: string;
};

export type CapacityReport = { sources: CapacitySource[]; hardware: HardwareInfo | null; generatedAt: string };
