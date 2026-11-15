import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  Card,
  CatalogEntry,
  CapacityReport,
  CiStatus,
  Connection,
  ConnectionKind,
  ConnectionProvider,
  GitHubOverview,
  HardwareInfo,
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
    /** The rest of the error body (everything but `error`), when the server sent more; callers narrow it. */
    readonly detail?: unknown,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init?: { method: "POST" | "PATCH"; body: unknown } | { method: "POST" | "DELETE" },
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
    let detail: unknown;
    try {
      const body: unknown = await res.json();
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        const { error, ...rest } = body as Record<string, unknown>;
        if (typeof error === "string") code = error;
        if (Object.keys(rest).length > 0) detail = rest;
      }
    } catch {
      // non-JSON error body: keep the default code
    }
    throw new ApiError(res.status, code, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type AgentsInfo = {
  adapters: AdapterId[];
  /** apiKey: where a run's API key comes from; "environment" is the server's own variable (development fallback). */
  providers: Record<Provider, { mode: AuthMode; available: boolean; apiKey?: "connection" | "environment" | "none" }>;
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
  /** Over runs started this calendar month (the server's local time). */
  monthCostUsd: number;
  /** The summed monthly budgets of the enabled model connections; null when none has one. */
  monthlyBudgetUsd: number | null;
  connections: { enabled: number; failed: number; keychain: "ok" | "unavailable" };
  /** null when GitHub is not connected. */
  ci: CiStatus | null;
};

/** A sign-in through the provider's own login command; `lines` are the safe lines it printed (links, codes). */
export type SignInView = { state: "running" | "succeeded" | "failed"; lines: string[] };
export type SignInStatus = "signed_in" | "signed_out" | "unknown" | "not_installed";

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
  startRun: (projectId: string, i: { adapter: AdapterId; prompt: string; cardId?: string; connectionIds?: string[] }) =>
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
    request<{ ok: boolean; message: string }>(`/api/connections/${enc(id)}/test`, { method: "POST" }),
  getStatus: () => request<Status>("/api/status"),
  getGitHubOverview: () => request<GitHubOverview>("/api/github/overview"),
  getCapacity: () => request<CapacityReport>("/api/capacity"),
  detectHardware: () => request<HardwareInfo>("/api/capacity/detect", { method: "POST" }),
  startSignIn: (provider: Provider) =>
    request<{ id: string }>(`/api/connections/signin/${enc(provider)}`, { method: "POST" }),
  getSignIn: (id: string) => request<SignInView>(`/api/connections/signin/${enc(id)}`),
  cancelSignIn: (id: string) => request<void>(`/api/connections/signin/${enc(id)}`, { method: "DELETE" }),
  getSignInStatus: () => request<Record<Provider, SignInStatus>>("/api/connections/signin-status"),
};

/** Why a Codex run cannot be given an MCP server; the picker and the MCP editors show it too. */
export const CODEX_MCP_NOTE =
  "Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.";
/** Why a Gemini run cannot be given an MCP server; the picker and the MCP editors show it too. */
export const GEMINI_MCP_NOTE =
  "Gemini cannot use MCP servers in The Terminal yet: Gemini only starts MCP servers in a trusted folder, and The Terminal never trusts agent worktrees.";

/** A string field of an error's detail, or undefined. */
function detailString(e: ApiError, key: string): string | undefined {
  const d = e.detail;
  if (typeof d !== "object" || d === null) return undefined;
  const v = (d as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** Where the audit export downloads from: every project's entries, or one project's. */
export function exportLedgerUrl(projectId: string | null): string {
  return projectId === null ? "/api/ledger/export" : `/api/ledger/export?projectId=${encodeURIComponent(projectId)}`;
}

/** The message for a failed request. `context: "run"` words the connection refusals for starting a run. */
export function errorMessage(e: unknown, context?: "run"): string {
  if (e instanceof ApiError) {
    if (e.status === 423) return "Workspace is read-only";
    if (context === "run" && e.status === 400 && e.code === "connection_unsupported") return "That connection cannot be given to a run";
    if (e.status === 400 && e.code === "connection_disabled") return "That connection is disabled";
    if (e.status === 400 && e.code === "mcp_unsupported") return detailString(e, "adapter") === "gemini" ? GEMINI_MCP_NOTE : CODEX_MCP_NOTE;
    if (e.status === 400 && e.code === "duplicate_mcp_server") {
      return "Two of the selected MCP servers would get the same name in this run. Untick one of them.";
    }
    if (e.status === 400 && e.code === "duplicate_cloud_provider") {
      return "A run can be given only one connection per cloud provider. Untick the extra one.";
    }
    if (e.status === 502 && e.code === "cloud_credentials_failed") {
      return `Could not get credentials from "${detailString(e, "name") ?? "a cloud connection"}". The run did not start.`;
    }
    if (e.status === 409 && e.code === "conflict") return "Already connected";
    if (e.code === "secret_in_config") return "That field must not contain a key or token";
    if (e.status === 400 && e.code === "connection_unsupported") return "This connection cannot be used that way";
    if (e.status === 503 && e.code === "keychain_unavailable") return "Your keychain is unavailable. Nothing was saved.";
    if (e.status === 422 && e.code === "terminal_required") return "This provider signs in inside its own terminal. Run the command shown, then check again.";
    if (e.status === 422 && e.code === "invalid_cli_home") return "The CLI home folder must be an absolute path";
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
