import type { Board, Card, LedgerEntry, Project, Stage } from "@theterminal/shared";

export type Health = {
  ok: true;
  integrity: "ok" | "broken";
  brokenAtSeq?: number;
  readOnly: boolean;
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

async function request<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...(init && {
      method: init.method,
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
  return (await res.json()) as T;
}

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (i: { name: string; pitch?: string }) =>
    request<Project>("/api/projects", { method: "POST", body: i }),
  getBoard: (id: string) => request<Board>(`/api/projects/${encodeURIComponent(id)}/board`),
  addCard: (projectId: string, i: { title: string; stage: Stage }) =>
    request<Card>(`/api/projects/${encodeURIComponent(projectId)}/cards`, { method: "POST", body: i }),
  moveCard: (cardId: string, to: Stage) =>
    request<Card>(`/api/cards/${encodeURIComponent(cardId)}/move`, { method: "POST", body: { to } }),
  health: () => request<Health>("/api/health"),
  listLedger: (projectId: string, afterSeq = 0, limit = 500) =>
    request<LedgerEntry[]>(
      `/api/ledger?projectId=${encodeURIComponent(projectId)}&afterSeq=${afterSeq}&limit=${limit}`,
    ),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 423) return "Workspace is read-only";
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
