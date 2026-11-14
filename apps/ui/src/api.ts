import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  Card,
  CatalogEntry,
  Connection,
  ConnectionKind,
  ConnectionProvider,
  LedgerEntry,
  PendingAgentAction,
  Project,
  Provider,
  Stage,
} from "@theterminal/shared";

export type Health = {
  ok: true;
  integrity: "ok" | "broken";
  brokenAtSeq?: number;
  readOnly: boolean;
  /** The last ledger seq when health was read; stream from here to see only new entries. */
  headSeq: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init?: { method: "POST" | "PATCH"; body: unknown } | { method: "DELETE" },
): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...(init && { method: init.method }),
    ...(init && "body" in init && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(init.body),
    }),
  });
  if (!res.ok) {
    let code = "internal";
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      // non-JSON error body: keep the default code
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type AgentsInfo = {
  adapters: AdapterId[];
  /** apiKey: where a run's API key comes from; "environment" is the server's own variable (development fallback). */
  providers: Record<Provider, { mode: AuthMode; installed: boolean; apiKey?: "connection" | "environment" | "none" }>;
  acks: Record<Provider, string>;
};

export type NewConnection = {
  kind: ConnectionKind;
  provider: ConnectionProvider;
  name: string;
  config?: Record<string, string>;
  secrets?: Record<string, string>;
  private?: Record<string, string>;
};

/** `null` removes a secret or private value. */
export type ConnectionPatch = {
  name?: string;
  config?: Record<string, string>;
  enabled?: boolean;
  secrets?: Record<string, string | null>;
  private?: Record<string, string | null>;
};

export type Status = {
  runningAgents: number;
  pendingDecisions: number;
  todayCostUsd: number;
  connections: { enabled: number; failed: number; keychain: "ok" | "unavailable" };
  ci: null;
};

const enc = encodeURIComponent;

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (i: { name: string; pitch?: string }) =>
    request<Project>("/api/projects", { method: "POST", body: i }),
  getBoard: (id: string) => request<Board>(`/api/projects/${encodeURIComponent(id)}/board`),
  addCard: (projectId: string, i: { title: string; stage: Stage }) =>
    request<Card>(`/api/projects/${encodeURIComponent(projectId)}/cards`, { method: "POST", body: i }),
  moveCard: (cardId: string, to: Stage) =>
    request<Card>(`/api/cards/${encodeURIComponent(cardId)}/move`, { method: "POST", body: { to } }),
  getAgents: () => request<AgentsInfo>("/api/agents"),
  setProviderAuth: (i: { provider: Provider; mode: AuthMode; acknowledgement?: string }) =>
    request<{ provider: Provider; mode: AuthMode }>("/api/settings/provider-auth", { method: "POST", body: i }),
  startRun: (projectId: string, i: { adapter: AdapterId; prompt: string; cardId?: string }) =>
    request<AgentRun>(`/api/projects/${enc(projectId)}/runs`, { method: "POST", body: i }),
  listRuns: (projectId: string) => request<AgentRun[]>(`/api/projects/${enc(projectId)}/runs`),
  getRun: (runId: string) => request<{ run: AgentRun; actions: AgentAction[] }>(`/api/runs/${enc(runId)}`),
  stopRun: (runId: string) => request<AgentRun>(`/api/runs/${enc(runId)}/stop`, { method: "POST", body: {} }),
  listPendingActions: (projectId: string) =>
    request<AgentAction[]>(`/api/projects/${enc(projectId)}/pending-actions`),
  listAllPendingActions: () => request<PendingAgentAction[]>("/api/pending-actions"),
  decideAction: (actionId: string, decision: "allow" | "deny", reason?: string) =>
    request<AgentAction>(`/api/actions/${enc(actionId)}/decision`, {
      method: "POST",
      body: reason ? { decision, reason } : { decision },
    }),
  health: () => request<Health>("/api/health"),
  /** A project's entries, or every project's when `projectId` is null. */
  listLedger: (projectId: string | null, afterSeq = 0, limit = 500) =>
    request<LedgerEntry[]>(
      `/api/ledger?${projectId === null ? "" : `projectId=${encodeURIComponent(projectId)}&`}afterSeq=${afterSeq}&limit=${limit}`,
    ),
  listConnections: () => request<Connection[]>("/api/connections"),
  getConnectionCatalog: () => request<CatalogEntry[]>("/api/connections/catalog"),
  addConnection: (i: NewConnection) => request<Connection>("/api/connections", { method: "POST", body: i }),
  updateConnection: (id: string, patch: ConnectionPatch) =>
    request<Connection>(`/api/connections/${enc(id)}`, { method: "PATCH", body: patch }),
  removeConnection: (id: string) => request<void>(`/api/connections/${enc(id)}`, { method: "DELETE" }),
  testConnection: (id: string) =>
    request<{ ok: boolean; message: string }>(`/api/connections/${enc(id)}/test`, { method: "POST", body: {} }),
  getStatus: () => request<Status>("/api/status"),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 423) return "Workspace is read-only";
    if (e.status === 409 && e.code === "conflict") return "Already connected";
    if (e.code === "secret_in_config") return "That field must not contain a key or token";
    if (e.status === 503 && e.code === "keychain_unavailable") return "Your keychain is unavailable. Nothing was saved.";
    if (e.status === 401 || e.status === 403) return "Not authorised";
    if (e.status === 400) return "That input was not accepted";
    if (e.status === 404) return "Not found";
  }
  return "Something went wrong";
}

/** Streams ledger entries with seq > afterSeq; reconnects with backoff 1s→10s, resuming from the last seq. */
export function subscribeLedger(
  afterSeq: number,
  onEntry: (e: LedgerEntry) => void,
  WS: typeof WebSocket = WebSocket,
): () => void {
  let last = afterSeq;
  let delay = 1000;
  let closed = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WS(`${proto}://${location.host}/api/events?afterSeq=${last}`);
    socket.onopen = () => {
      delay = 1000;
    };
    socket.onmessage = (m) => {
      const entry = JSON.parse(String(m.data)) as LedgerEntry;
      if (entry.seq <= last) return;
      last = entry.seq;
      onEntry(entry);
    };
    socket.onclose = () => {
      if (closed) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10000);
    };
  };
  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
