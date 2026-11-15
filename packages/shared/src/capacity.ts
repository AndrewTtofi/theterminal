import type { AdapterId, AuthMode, Provider } from "./agents.js";
import type { ConnectionKind, ConnectionProvider } from "./connections.js";

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
  /** `last24h`: runs that hit at least one rate limit in the last 24 hours (each run counted once). */
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

/** The last detection, and whether the Owner left This computer on (`enabled`) in Connections. */
export type CapacityHardware = HardwareInfo & { enabled: boolean };

/** One model an engine on loopback lists; the figures are what the engine reported, null when it did not say. */
export type LocalModel = { id: string; sizeBytes: number | null; parameters: string | null; quantization: string | null };

/** An open-weight model server found on this computer's loopback (Ollama or llama.cpp server), when it was found. */
export type LocalEngine = {
  engine: "ollama" | "llamacpp";
  baseUrl: string;
  version: string | null;
  models: LocalModel[];
  detectedAt: string;
};

/**
 * A linked machine's inventory as it last answered: `online` and `checkedAt` are what the last check said and when;
 * `lastSeenAt` is when it last answered (null when it never has). An offline machine keeps the values it last sent.
 * `hardware` is the worker's detection without its own `enabled` switch; `connections` names only ids, kinds,
 * providers and names, never a value.
 */
export type MachineCapacity = {
  machineId: string;
  name: string;
  online: boolean;
  checkedAt: string;
  lastSeenAt: string | null;
  hardware: HardwareInfo | null;
  localModels: LocalEngine[];
  sources: CapacitySource[];
  adapters: AdapterId[];
  connections: { id: string; kind: ConnectionKind; provider: ConnectionProvider; name: string }[];
};

export type CapacityReport = {
  sources: CapacitySource[];
  hardware: CapacityHardware | null;
  localModels: LocalEngine[];
  machines: MachineCapacity[];
  generatedAt: string;
};
