import type { LocalEngine, LocalModel } from "@theterminal/shared";
import type { ConnectionTester } from "../connections/service.js";

/** Where Ollama and llama.cpp server listen by default. Detection never looks anywhere else. */
export const OLLAMA_URL = "http://127.0.0.1:11434";
export const LLAMACPP_URL = "http://127.0.0.1:8080";

/**
 * The one variable a local-model run may add to the Codex process: the server's key, named by the provider's
 * `env_key`. It reaches Codex itself only, never the commands Codex runs (see the Codex adapter).
 */
export const LOCAL_MODEL_ENV_ALLOWLIST: readonly string[] = ["LOCAL_MODEL_API_KEY"];

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 2000;
const NOT_LOOPBACK = "Only this computer's own address is allowed";

/** Whether `url` is plain http to this computer's own address (127.0.0.1, localhost or [::1]), with no user name or password. */
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && u.username === "" && u.password === "";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

type Probe = { fetch: typeof fetch; timeoutMs: number };

/** GET `url` as JSON, or null on any failure (no answer, a non-2xx status, a body that is not JSON). */
async function getJson(p: Probe, url: string): Promise<unknown> {
  try {
    const res = await p.fetch(url, { method: "GET", signal: AbortSignal.timeout(p.timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

async function ollama(p: Probe, detectedAt: string): Promise<LocalEngine | null> {
  const version = await getJson(p, `${OLLAMA_URL}/api/version`);
  if (!isRecord(version) || typeof version.version !== "string") return null;
  const tags = await getJson(p, `${OLLAMA_URL}/api/tags`);
  if (!isRecord(tags) || !Array.isArray(tags.models)) return null;
  const models: LocalModel[] = tags.models.filter(isRecord).flatMap((m) => {
    const id = strOrNull(m.name);
    if (id === null) return [];
    const details = isRecord(m.details) ? m.details : {};
    const size = typeof m.size === "number" && Number.isFinite(m.size) && m.size >= 0 ? m.size : null;
    return [{ id, sizeBytes: size, parameters: strOrNull(details.parameter_size), quantization: strOrNull(details.quantization_level) }];
  });
  return { engine: "ollama", baseUrl: `${OLLAMA_URL}/v1`, version: version.version, models, detectedAt };
}

async function llamacpp(p: Probe, detectedAt: string): Promise<LocalEngine | null> {
  // /health answers 200 only once the model is loaded.
  try {
    const health = await p.fetch(`${LLAMACPP_URL}/health`, { method: "GET", signal: AbortSignal.timeout(p.timeoutMs) });
    if (!health.ok) return null;
  } catch {
    return null;
  }
  const list = await getJson(p, `${LLAMACPP_URL}/v1/models`);
  if (!isRecord(list) || !Array.isArray(list.data)) return null;
  const models: LocalModel[] = list.data.filter(isRecord).flatMap((m) => {
    const id = strOrNull(m.id);
    return id === null ? [] : [{ id, sizeBytes: null, parameters: null, quantization: null }];
  });
  return { engine: "llamacpp", baseUrl: `${LLAMACPP_URL}/v1`, version: null, models, detectedAt };
}

/**
 * The model servers answering on this computer's default ports: Ollama (`/api/version`, `/api/tags`) and llama.cpp
 * server (`/health`, `/v1/models`). An engine whose probe fails is left out. Never throws, never installs anything.
 */
export async function detectLocalEngines(deps: { fetch: typeof fetch; now?: () => Date; timeoutMs?: number }): Promise<LocalEngine[]> {
  const p: Probe = { fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  const detectedAt = (deps.now ?? (() => new Date()))().toISOString();
  const found = await Promise.all([ollama(p, detectedAt).catch(() => null), llamacpp(p, detectedAt).catch(() => null)]);
  return found.filter((e): e is LocalEngine => e !== null);
}

/**
 * Tests a `local_model` connection: lists the server's models (with the stored key, if any, in the Authorization
 * header only) and checks the configured model is among them. Never sends anything beyond this computer.
 */
export const localModelTester: ConnectionTester = async (input, deps) => {
  const baseUrl = input.config.baseUrl ?? "";
  const model = input.config.model ?? "";
  if (!isLoopbackUrl(baseUrl)) return { ok: false, message: NOT_LOOPBACK };
  const key = input.secrets.apiKey;
  let res: Response;
  try {
    res = await deps.fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET", headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: deps.signal,
    });
  } catch {
    return { ok: false, message: "Could not reach the local model server" };
  }
  if (!res.ok) return { ok: false, message: `Unexpected response (HTTP ${res.status})` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const ids = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord).map((m) => m.id) : [];
  return ids.includes(model)
    ? { ok: true, message: "Connected (model available)" }
    : { ok: false, message: `Model ${model} is not installed on this server` };
};
