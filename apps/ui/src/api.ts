import type {
  AdapterId,
  AgentAction,
  AgentRun,
  AuthMode,
  Board,
  Card,
  CardStory,
  CatalogEntry,
  CapacityReport,
  CiStatus,
  Connection,
  DailyDigest,
  DigestDays,
  ConnectionKind,
  ConnectionProvider,
  GitHubOverview,
  DecisionId,
  DirListing,
  FileContent,
  FileDiff,
  GateDecisionInput,
  GateEvaluation,
  HardwareInfo,
  IntakeAnswer,
  IntakeView,
  LedgerEntry,
  MachineCapacity,
  Machine,
  MachinePresence,
  PendingAgentAction,
  Project,
  Provider,
  QuestionId,
  RunChanges,
  ShareLink,
  ShareOptions,
  ShareScope,
  ShareSnapshot,
  ShareSnapshotRecord,
  Stage,
} from "@theterminal/shared";
import { CHANGES_REFUSED_PHRASES, visibleControls } from "@theterminal/shared";

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
  /** Undecided plan decisions over every open intake. */
  intakeDecisions: number;
  /** The projects whose open intake has undecided plan decisions; `name` is the project's name as recorded. */
  intakeProjects: { projectId: string; name: string; decisions: number }[];
  /** Linked machines, how many answered the last presence check, and how many met another key at their address. */
  machines: { linked: number; online: number; keyChanged: number };
  /** Inferred from the Owner's own calls to the internet; `lastError` is a fixed system code such as `ENOTFOUND`. */
  network: NetworkState;
  /** Share links being served right now. */
  shareLinks: number;
};

/** `/api/status.network`: never a probe, only what the last outgoing call showed. */
export type NetworkState = {
  state: "online" | "offline" | "unknown";
  basis: "inferred";
  since: string | null;
  lastError: string | null;
};

/** This computer as linking sees it; `linking.port` is the listener's port while linking is on. */
export type LinkSelf = { machineId: string; fingerprint: string; name: string; linking: { enabled: boolean; port: number | null } };
/** A machine another computer announced on the local network; `name` and `address` are its own words, untrusted. */
export type DiscoveredMachine = { machineId: string; name: string; address: string; seenAt: string };
/** `GET /api/link`: `self` is null when the keychain is unavailable (`identity: "unavailable"`). */
export type LinkOverview = {
  identity: "ok" | "unavailable";
  self: LinkSelf | null;
  machines: MachinePresence[];
  discovered: DiscoveredMachine[];
};
/** A one-time pairing code this computer shows, until `expiresAt`, and the addresses it can be reached at. */
export type PairingCode = { code: string; expiresAt: string; addresses: string[] };

/**
 * A share page generated for the Owner to read before confirming: the exact HTML, its sha256 and size, the
 * snapshot it was rendered from (for the hidden list), and when the preview stops being confirmable.
 */
export type SharePreview = {
  previewId: string;
  contentHash: string;
  bytes: number;
  expiresAt: string;
  html: string;
  snapshot: ShareSnapshot;
};

/** An address a share link may listen on, as the server offers it; `label` is what the Owner picks by. */
export type ShareAddress = { address: string; scope: ShareScope; label: string };

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
  /** Every gate a move to `to` would raise, evaluated now; nothing is recorded. */
  getCardGates: (cardId: string, to: Stage) =>
    request<GateEvaluation[]>(`/api/cards/${enc(cardId)}/gates?to=${enc(to)}`),
  /** Moves through the gates; a gate left without a decision answers 409 `gate_blocked` with `{ gates }` (see blockedGates). */
  moveCard: (cardId: string, to: Stage, gates?: GateDecisionInput[]) =>
    request<Card>(`/api/cards/${enc(cardId)}/move`, { method: "POST", body: gates ? { to, gates } : { to } }),
  getCardStory: (cardId: string) => request<CardStory>(`/api/cards/${enc(cardId)}/story`),
  getAgents: () => request<AgentsInfo>("/api/agents"),
  setProviderAuth: (i: { provider: Provider; mode: AuthMode; acknowledgement?: string }) =>
    request<{ provider: Provider; mode: AuthMode }>("/api/settings/provider-auth", { method: "POST", body: i }),
  /** With `machineId`, the run goes to that linked machine (its connections are the ones given). */
  startRun: (projectId: string, i: { adapter: AdapterId; prompt: string; cardId?: string; connectionIds?: string[]; machineId?: string }) =>
    request<AgentRun>(`/api/projects/${enc(projectId)}/runs`, { method: "POST", body: i }),
  listRuns: (projectId: string) => request<AgentRun[]>(`/api/projects/${enc(projectId)}/runs`),
  getRun: (runId: string) => request<{ run: AgentRun; actions: AgentAction[] }>(`/api/runs/${enc(runId)}`),
  /** False only when the server answers 404 for the run; true when it exists or the check failed for another reason. */
  runExists: async (runId: string): Promise<boolean> => {
    try {
      await request<unknown>(`/api/runs/${enc(runId)}`);
      return true;
    } catch (e) {
      return !(e instanceof ApiError && e.status === 404);
    }
  },
  /** What the run changed against its starting point; 404 `worktree_missing`, 409 `no_base`. */
  getRunChanges: (runId: string) => request<RunChanges>(`/api/runs/${enc(runId)}/changes`),
  /** One file's diff, relative to the run's working copy. */
  getRunDiff: (runId: string, path: string) => request<FileDiff>(`/api/runs/${enc(runId)}/diff?path=${enc(path)}`),
  /** One directory of the run's working copy; `""` is its top. */
  listRunDir: (runId: string, path: string) => request<DirListing>(`/api/runs/${enc(runId)}/files?path=${enc(path)}`),
  /** One file's text from the run's working copy. */
  getRunFile: (runId: string, path: string) => request<FileContent>(`/api/runs/${enc(runId)}/file?path=${enc(path)}`),
  /**
   * Runs a program as the Owner in the run's working copy (emergency override); resolves once it has started and
   * been recorded. 409 `run_active` / `override_busy`, 400 `program_not_found` / `program_not_allowed` / `secret_in_text`.
   */
  overrideCommand: (runId: string, i: { program: string; args: string[]; cwd?: string; reason: string }) =>
    request<{ overrideId: string }>(`/api/runs/${enc(runId)}/override/command`, { method: "POST", body: i }),
  /** Drops the run's uncommitted changes (emergency override); `files` is how many uncommitted files there were. */
  overrideDiscard: (runId: string, reason: string) =>
    request<{ overrideId: string; files: number }>(`/api/runs/${enc(runId)}/override/discard`, { method: "POST", body: { reason } }),
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
  /**
   * A page of a project's entries, or every project's when `projectId` is null, in ascending seq order: those after
   * `afterSeq`, or the newest `limit` before `beforeSeq`.
   */
  listLedger: (projectId: string | null, q: { afterSeq?: number; beforeSeq?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (projectId !== null) params.set("projectId", projectId);
    if (q.afterSeq !== undefined) params.set("afterSeq", String(q.afterSeq));
    if (q.beforeSeq !== undefined) params.set("beforeSeq", String(q.beforeSeq));
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    const query = params.toString().replace(/\+/g, "%20");
    return request<LedgerEntry[]>(query === "" ? "/api/ledger" : `/api/ledger?${query}`);
  },
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
  getLink: () => request<LinkOverview>("/api/link"),
  /** The paired machines as last seen: no machine is asked and the network is not browsed (names, the Run on picker). */
  getMachines: () => request<MachinePresence[]>("/api/link/machines"),
  renameMachine: (name: string) => request<LinkSelf>("/api/link/name", { method: "POST", body: { name } }),
  /** `acknowledgement` must be LINKING_ACK verbatim; 409 `linking_disabled` never applies here, 503 `identity_unavailable` does. */
  enableLinking: (acknowledgement: string) => request<LinkSelf>("/api/link/enable", { method: "POST", body: { acknowledgement } }),
  disableLinking: () => request<LinkSelf>("/api/link/disable", { method: "POST" }),
  /** Opens a pairing window (replacing any earlier one); 409 `linking_disabled` while linking is off. */
  showPairingCode: () => request<PairingCode>("/api/link/code", { method: "POST" }),
  cancelPairingCode: () => request<void>("/api/link/code", { method: "DELETE" }),
  /** Pairs with the machine showing `code` at `address`; see errorMessage(e, "pair") for its refusals. */
  pairMachine: (address: string, code: string) => request<Machine>("/api/link/pair", { method: "POST", body: { address, code } }),
  unpairMachine: (machineId: string) => request<void>(`/api/link/machines/${enc(machineId)}`, { method: "DELETE" }),
  /**
   * Asks the machine again now, or (`cached`) answers from the server's 30 s cache. One that does not answer is
   * `online: false` with the values it last sent; 409 `machine_key_mismatch` when its address presented another key.
   */
  getMachineCapacity: (machineId: string, cached = false) =>
    request<MachineCapacity>(`/api/link/machines/${enc(machineId)}/capacity${cached ? "?cached=1" : ""}`),
  startSignIn: (provider: Provider) =>
    request<{ id: string }>(`/api/connections/signin/${enc(provider)}`, { method: "POST" }),
  getSignIn: (id: string) => request<SignInView>(`/api/connections/signin/${enc(id)}`),
  cancelSignIn: (id: string) => request<void>(`/api/connections/signin/${enc(id)}`, { method: "DELETE" }),
  getSignInStatus: () => request<Record<Provider, SignInStatus>>("/api/connections/signin-status"),
  /**
   * The project's guided intake, or null when it has none yet. A project that no longer exists throws its 404
   * `not_found`, which `errorMessage(e, "intake")` words as "This project no longer exists".
   */
  getIntake: async (projectId: string): Promise<IntakeView | null> => {
    try {
      return await request<IntakeView>(`/api/projects/${enc(projectId)}/intake`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && e.code === "no_intake") return null;
      throw e;
    }
  },
  startIntake: (projectId: string, idea: string) =>
    request<IntakeView>(`/api/projects/${enc(projectId)}/intake`, { method: "POST", body: { idea } }),
  answerIntake: (projectId: string, questionId: QuestionId, answer: IntakeAnswer) =>
    request<IntakeView>(`/api/projects/${enc(projectId)}/intake/answers`, { method: "POST", body: { questionId, answer } }),
  decideIntake: (projectId: string, decisionId: DecisionId, chosen: string, rationale?: string) =>
    request<IntakeView>(`/api/projects/${enc(projectId)}/intake/decisions`, {
      method: "POST",
      body: rationale === undefined ? { decisionId, chosen } : { decisionId, chosen, rationale },
    }),
  /** Sent with no body: the route takes none. */
  completeIntake: (projectId: string) => request<IntakeView>(`/api/projects/${enc(projectId)}/intake/complete`, { method: "POST" }),
  reopenIntake: (projectId: string, reason: string) =>
    request<IntakeView>(`/api/projects/${enc(projectId)}/intake/reopen`, { method: "POST", body: { reason } }),
  /** Generates the share page for the Owner to read; nothing is recorded or kept until it is confirmed. */
  previewShare: (projectId: string, options: ShareOptions) =>
    request<SharePreview>(`/api/projects/${enc(projectId)}/share/preview`, { method: "POST", body: options }),
  /** Saves the previewed page and records it; 409 `preview_stale` when the page changed or the preview expired. */
  confirmShare: (projectId: string, previewId: string, contentHash: string) =>
    request<ShareSnapshotRecord>(`/api/projects/${enc(projectId)}/share/confirm`, { method: "POST", body: { previewId, contentHash } }),
  listShareSnapshots: (projectId: string) => request<ShareSnapshotRecord[]>(`/api/projects/${enc(projectId)}/share/snapshots`),
  listShareAddresses: () => request<ShareAddress[]>("/api/share/addresses"),
  /** The url carries the link's one-time token: it is returned once, here, and never again. */
  createShareLink: (shareId: string, address: string, ttlMinutes: number) =>
    request<{ link: ShareLink; url: string }>(`/api/share/snapshots/${enc(shareId)}/links`, { method: "POST", body: { address, ttlMinutes } }),
  listShareLinks: (projectId?: string) =>
    request<ShareLink[]>(projectId === undefined ? "/api/share/links" : `/api/share/links?projectId=${enc(projectId)}`),
  revokeShareLink: (id: string) => request<void>(`/api/share/links/${enc(id)}`, { method: "DELETE" }),
  /** One plain-language account per UTC day of the project's ledger, newest first. */
  getDigests: (projectId: string, days: DigestDays) => request<DailyDigest[]>(`/api/projects/${enc(projectId)}/digests?days=${days}`),
};

/** A saved share page, served inline: opened in a new tab to read, present or print. */
export function shareSnapshotUrl(id: string): string {
  return `/api/share/snapshots/${encodeURIComponent(id)}`;
}

/** The same page as a download. */
export function shareDownloadUrl(id: string): string {
  return `/api/share/snapshots/${encodeURIComponent(id)}/download`;
}

/** Why a Codex run cannot be given an MCP server; the picker and the MCP editors show it too. */
export const CODEX_MCP_NOTE =
  "Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.";
/** Why a Gemini run cannot be given an MCP server; the picker and the MCP editors show it too. */
export const GEMINI_MCP_NOTE =
  "Gemini cannot use MCP servers in The Terminal yet: Gemini only starts MCP servers in a trusted folder, and The Terminal never trusts agent worktrees.";

/** Why a run on a local model needs Codex; the run picker shows it too. */
export const LOCAL_MODEL_NOTE = "Only Codex can run on a local model in The Terminal yet.";

/** A string field of an error's detail, or undefined. */
function detailString(e: ApiError, key: string): string | undefined {
  const d = e.detail;
  if (typeof d !== "object" || d === null) return undefined;
  const v = (d as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** The gate evaluations a refused move (409 `gate_blocked`) sent back, or null for any other error. */
export function blockedGates(e: unknown): GateEvaluation[] | null {
  if (!(e instanceof ApiError) || e.code !== "gate_blocked") return null;
  const d = e.detail;
  if (typeof d !== "object" || d === null) return null;
  const gates = (d as Record<string, unknown>).gates;
  return Array.isArray(gates) ? (gates as GateEvaluation[]) : null;
}

/** Where the audit export downloads from: every project's entries, or one project's. */
export function exportLedgerUrl(projectId: string | null): string {
  return projectId === null ? "/api/ledger/export" : `/api/ledger/export?projectId=${encodeURIComponent(projectId)}`;
}

/**
 * Said in place of a run's changes, files or diffs while it runs. The server refuses to read a live run's working
 * copy (the agent can still change its files and its git settings), so they show once the run is stopped or finished.
 */
export const LIVE_RUN_CHANGES = "Changes show when the run is stopped or finished.";

/** What the Changes view says of a run on a linked machine before its changes have arrived. */
export const remoteChangesNote = (machine: string): string => `The changes arrive when the run finishes on ${visibleControls(machine)}.`;

/** What the Changes view says when this computer refused a linked machine's changes (`link.changes_refused`). */
export function refusedChangesNote(machine: string, reason: string): string {
  const why = Object.prototype.hasOwnProperty.call(CHANGES_REFUSED_PHRASES, reason)
    ? CHANGES_REFUSED_PHRASES[reason as keyof typeof CHANGES_REFUSED_PHRASES]
    : null;
  return `The changes from ${visibleControls(machine)} were refused${why === null ? "" : `: ${why}`}.`;
}

/**
 * What a linked machine's refusal codes mean, in fixed words: the code is the machine's say, so only a code listed here
 * is worded; anything else reads as a plain refusal. The machine's own message is never shown.
 */
const REMOTE_REFUSALS: Record<string, string> = {
  connection_disabled: "that connection is disabled there",
  connection_unsupported: "that connection cannot be given to a run there",
  not_found: "it does not have something the run needs (a connection, or the run itself)",
  conflict: "it already has a project or run with that id",
  upload_refused: "it did not accept the project's files",
  upload_limit: "too many projects are waiting to start there",
  repo_too_large: "the project is too large to send",
  too_large: "the project is too large to send",
  bundle_invalid: "the project's files could not be read there",
  bundle_git_limit: "it could not read the project's files in time",
  no_repo: "the project's files did not arrive",
  invalid_input: "the request was not accepted",
  mcp_unsupported: "that agent cannot use MCP servers there",
  local_model_unsupported: "only Codex can run on a local model",
  duplicate_mcp_server: "two of the selected MCP servers would get the same name",
  duplicate_cloud_provider: "a run can be given only one connection per cloud provider",
  cloud_credentials_failed: "it could not get credentials from a cloud connection",
  keychain_unavailable: "its keychain is unavailable",
  already_decided: "that action was already decided",
  run_active: "the run is still working",
  shutting_down: "it is shutting down",
  identity_unavailable: "its keychain is unavailable",
};

/** A linked machine's refusal (`remote_refused`), in fixed words with the name this computer gave it. */
function remoteRefusal(e: ApiError): string {
  const name = detailString(e, "machine");
  const who = name === undefined ? "A linked machine" : `"${visibleControls(name)}"`;
  const code = detailString(e, "code");
  const why = code !== undefined && Object.prototype.hasOwnProperty.call(REMOTE_REFUSALS, code) ? REMOTE_REFUSALS[code] : undefined;
  return why === undefined ? `${who} refused the request.` : `${who} refused: ${why}.`;
}

/**
 * The message for a failed request. `context: "run"` words the connection refusals for starting a run;
 * `"intake"` words a conflict as the project already having an intake and a missing project as gone, `"reopen"` a
 * conflict as the plan being open already, `"changes"` a live run as the reason a run's changes, files or diffs
 * cannot be read yet, `"pair"` an unreachable machine as the address the Owner typed.
 */
export function errorMessage(e: unknown, context?: "run" | "intake" | "reopen" | "changes" | "pair"): string {
  if (e instanceof ApiError) {
    if (e.code === "remote_refused") return remoteRefusal(e);
    if (context === "run" && e.code === "machine_unreachable") return "Could not reach that machine. Nothing was started.";
    if (e.code === "identity_unavailable") return "Your keychain is unavailable, so this computer has no identity for linking.";
    if (e.code === "linking_disabled") return "Turn on linking first (Machines view)";
    if (e.code === "pairing_code_mismatch") return "That code was not shown by the machine at this address";
    if (e.code === "pairing_rejected") return "The other machine rejected the code";
    if (e.code === "no_pairing") return "That machine is not showing a code right now";
    if (e.code === "self_pairing") return "That address is this computer";
    if (context === "pair" && e.code === "machine_unreachable") return "Could not reach that address";
    if (e.status === 423) return "Workspace is read-only";
    // The share view's refusals, before the generic 400, 404 and 409 wordings below.
    if (e.code === "preview_stale" || e.code === "preview_not_found") {
      return "The preview has changed or expired. Preview again before confirming.";
    }
    if (e.code === "share_not_clean") return "The page could not be cleaned of sensitive text and was not generated.";
    if (e.code === "share_too_large") return "The page is too large to share. Choose fewer digest days.";
    if (e.code === "share_link_active") return "A link is already live for this project. Revoke it first.";
    if (e.code === "snapshot_tampered") return "This snapshot's file no longer matches the ledger. It will not be shared.";
    if (e.code === "snapshot_missing") return "This snapshot's file is missing.";
    if (e.code === "link_not_active") return "That link is no longer live.";
    if (e.code === "intake_incomplete") return "Answer every question and make every decision first";
    if (e.code === "secret_in_text") return "That text looks like it contains a key or password. It was not saved.";
    if (e.code === "intake_completed") return "This plan is approved. Reopen it to change answers.";
    if (e.code === "stage_gated") {
      return detailString(e, "message") ?? "Add the card to an earlier stage, then move it, so its readiness checks run.";
    }
    if (e.code === "decision_not_applicable") return "That decision no longer applies to your answers";
    if (context === "intake" && e.status === 409 && e.code === "conflict") return "This project already has a plan intake";
    if (context === "intake" && e.status === 404 && e.code === "not_found") return "This project no longer exists";
    if (context === "reopen" && e.status === 409 && e.code === "conflict") return "This plan is already open for changes.";
    if (context === "run" && e.status === 400 && e.code === "connection_unsupported") return "That connection cannot be given to a run";
    if (e.status === 400 && e.code === "connection_disabled") return "That connection is disabled";
    if (e.status === 400 && e.code === "mcp_unsupported") return detailString(e, "adapter") === "gemini" ? GEMINI_MCP_NOTE : CODEX_MCP_NOTE;
    if (e.status === 400 && e.code === "local_model_unsupported") return LOCAL_MODEL_NOTE;
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
    if (context === "changes" && e.code === "run_active") return LIVE_RUN_CHANGES;
    if (e.code === "run_active") return "Stop the agent first: it is still working in this run";
    if (e.code === "unsafe_repository") {
      return "This repository's git setup includes settings The Terminal does not allow, so its changes cannot be shown.";
    }
    if (e.code === "override_busy") return "An override is already running for this run";
    if (e.code === "program_not_found") return "That program was not found on this computer's PATH";
    if (e.code === "program_not_allowed") return "Programs inside the project folder, and Windows batch files, cannot be run as an override";
    if (e.code === "worktree_missing") return "This run's working copy no longer exists on this computer";
    // A run recorded before its starting commit was kept (or whose starting commit is gone): nothing is guessed.
    if (e.code === "no_base") {
      return "What this run changed cannot be shown: it was recorded before The Terminal kept the commit it started from, or that commit is gone. Its files can still be browsed under Files in the Changes view.";
    }
    // The workspace's own git pins were tampered with, so the server ran no git at all.
    if (e.code === "gitconfig_modified") {
      return "The Terminal's shared git configuration was modified, so git was not run. Restart The Terminal to repair it.";
    }
    if (e.code === "hooks_modified") return "The Terminal's empty hooks folder was modified, so git was not run. Empty it and try again.";
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
