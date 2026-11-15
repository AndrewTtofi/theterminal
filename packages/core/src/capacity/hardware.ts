import { win32 } from "node:path";
import type { HardwareInfo } from "@theterminal/shared";

/** `execFile` with fixed options: never a shell, a timeout, bounded output and no console window on Windows. */
export type ExecFile = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: true; maxBuffer: number },
) => Promise<{ stdout: string }>;

export type HardwareDeps = {
  execFile: ExecFile;
  platform: NodeJS.Platform;
  arch: string;
  totalmem: () => number;
  cpus: () => { model: string }[];
  release: () => string;
  /** Locates a program on PATH (absolute path or null); see agents/which.ts. */
  which: (cmd: string) => string | null;
  /** For `SystemRoot` on Windows. */
  env: NodeJS.ProcessEnv;
  now?: () => Date;
};

const TIMEOUT_MS = 10_000;
/** Enough for system_profiler's display listing; a larger answer fails that probe. */
const MAX_OUTPUT_BYTES = 512 * 1024;
/** A model name longer than this is cut: it is shown and stored, never parsed further. */
const MAX_NAME = 120;
const EXEC_OPTS = { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES } as const;

const SYSTEM_PROFILER = "/usr/sbin/system_profiler";
const NVIDIA_SMI_ARGS = ["--query-gpu=name,memory.total", "--format=csv,noheader"];
const NVIDIA_LINE = /^([^,]+),\s*(\d{1,9}(?:\.\d+)?)\s*MiB\s*$/;

const round1 = (n: number) => Math.round(n * 10) / 10;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The platform as HardwareInfo names it: any other Unix is reported as linux. */
export const hardwarePlatform = (p: NodeJS.Platform): HardwareInfo["platform"] => (p === "darwin" || p === "win32" ? p : "linux");

/** A model name fit to store: control characters removed, whitespace collapsed, capped; null when empty. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return t === "" ? null : t;
}

/** `fn()`, or null when it throws. */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** The program's stdout, or null when it fails, times out or says too much. */
async function run(deps: HardwareDeps, file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await deps.execFile(file, args, { ...EXEC_OPTS });
    return typeof stdout === "string" ? stdout : null;
  } catch {
    return null;
  }
}

/** The first display adapter's model name in `system_profiler SPDisplaysDataType -json`. */
function parseSystemProfiler(stdout: string): string | null {
  const parsed = attempt(() => JSON.parse(stdout) as unknown);
  if (!isRecord(parsed) || !Array.isArray(parsed.SPDisplaysDataType)) return null;
  const first: unknown = parsed.SPDisplaysDataType[0];
  return isRecord(first) ? cleanName(first.sppci_model) : null;
}

/** The first line of `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`: `<name>, <n> MiB`. */
function parseNvidiaSmi(stdout: string): { gpu: string; gpuMemoryGb: number } | null {
  const m = NVIDIA_LINE.exec(stdout.split(/\r?\n/)[0]?.trim() ?? "");
  const gpu = m ? cleanName(m[1]) : null;
  return m && gpu ? { gpu, gpuMemoryGb: round1(Number(m[2]) / 1024) } : null;
}

/** nvidia-smi on PATH, then (Windows) where the NVIDIA driver installs it under SystemRoot. */
function nvidiaSmiCandidates(deps: HardwareDeps): string[] {
  const out: string[] = [];
  const onPath = attempt(() => deps.which("nvidia-smi"));
  if (onPath) out.push(onPath);
  if (deps.platform === "win32") {
    const key = Object.keys(deps.env).find((k) => k.toUpperCase() === "SYSTEMROOT");
    const root = key === undefined ? undefined : deps.env[key];
    if (root && win32.isAbsolute(root)) out.push(win32.join(root, "System32", "nvidia-smi.exe"));
  }
  return [...new Set(out)];
}

/**
 * What this computer can run: the CPU model and core count, memory, the first GPU and its memory. Only model names
 * and amounts are recorded, never a serial number, host name or user name. Each program runs from a fixed path with
 * fixed arguments; one that fails or is missing leaves its fields null. Never throws.
 */
export async function detectHardware(deps: HardwareDeps): Promise<HardwareInfo> {
  const cpus = attempt(() => deps.cpus()) ?? [];
  const total = attempt(() => deps.totalmem());
  const memoryGb = typeof total === "number" && Number.isFinite(total) && total > 0 ? round1(total / 2 ** 30) : null;
  const platform = hardwarePlatform(deps.platform);
  let gpu: string | null = null;
  let gpuMemoryGb: number | null = null;

  if (deps.platform === "darwin") {
    const stdout = await run(deps, SYSTEM_PROFILER, ["SPDisplaysDataType", "-json"]);
    gpu = stdout === null ? null : parseSystemProfiler(stdout);
    // Apple Silicon: the GPU shares the CPU's (unified) memory.
    if (gpu !== null && deps.arch === "arm64") gpuMemoryGb = memoryGb;
  } else if (deps.platform === "win32" || deps.platform === "linux") {
    for (const file of nvidiaSmiCandidates(deps)) {
      const stdout = await run(deps, file, NVIDIA_SMI_ARGS);
      const found = stdout === null ? null : parseNvidiaSmi(stdout);
      if (found) {
        ({ gpu, gpuMemoryGb } = found);
        break;
      }
    }
  }

  const release = attempt(() => deps.release());
  return {
    cpu: cleanName(cpus[0]?.model),
    cores: cpus.length > 0 ? cpus.length : null,
    memoryGb,
    gpu,
    gpuMemoryGb,
    platform,
    wsl: deps.platform === "linux" && typeof release === "string" && /microsoft/i.test(release),
    detectedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

/** Tests and demos only (THETERMINAL_FAKE_AGENT=1 with THETERMINAL_FAKE_HARDWARE=1): a fixed machine. */
export const fakeHardware: HardwareInfo = {
  cpu: "Fake CPU",
  cores: 8,
  memoryGb: 32,
  gpu: "Fake GPU",
  gpuMemoryGb: 24,
  platform: hardwarePlatform(process.platform),
  wsl: false,
  detectedAt: "2026-01-01T00:00:00.000Z",
};

/** HardwareInfo as the local_hardware connection stores it: strings, a null field left out. */
export function hardwareConfig(info: HardwareInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(info)) if (v !== null) out[k] = String(v);
  return out;
}

/** HardwareInfo from a stored local_hardware config; null when it holds no detection. */
export function hardwareFromConfig(config: Record<string, string>): HardwareInfo | null {
  if (!config.detectedAt) return null;
  const num = (v: string | undefined) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const platform = config.platform === "darwin" || config.platform === "win32" || config.platform === "linux" ? config.platform : "linux";
  return {
    cpu: config.cpu ?? null,
    cores: num(config.cores),
    memoryGb: num(config.memoryGb),
    gpu: config.gpu ?? null,
    gpuMemoryGb: num(config.gpuMemoryGb),
    platform,
    wsl: config.wsl === "true",
    detectedAt: config.detectedAt,
  };
}
