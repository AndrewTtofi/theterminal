import { createHash, randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ACTION_KINDS, type Actor, type AdapterId, type AgentAction, type AgentRun, type AuthMode, type Provider } from "@theterminal/shared";
import { CloudCredentialError, type CloudGrant } from "../connections/cloud/grant.js";
import { pairValueSecrets, type McpServerSpec } from "../connections/mcp.js";
import { UnsupportedConnectionError, type CloudSource, type Credentials, type RunSelection } from "../connections/service.js";
import type { Db } from "../db.js";
import { NotFoundError } from "../board/board-service.js";
import { commitEvent } from "../events/commit.js";
import { getRun, listActions, listRuns } from "../events/projections.js";
import { LedgerReadOnlyError, type Ledger } from "../ledger/ledger.js";
import type { AdapterEvent, AgentAdapter, GateResult, ProposedAction, RunCredentials } from "./adapter.js";
import { AlreadyDecidedError, type ApprovalBroker } from "./approvals.js";
import { classify } from "./policy.js";
import { redact, truncate } from "./redact.js";
import { ProviderSettings } from "./settings.js";
import { pathScrubber, usernameScrubber, type Scrub } from "./scrub-paths.js";
import type { WorktreeManager } from "./worktrees.js";

export class AdapterUnavailableError extends Error {
  constructor(adapter: string) {
    super(`agent adapter unavailable: ${adapter}`);
    this.name = "AdapterUnavailableError";
  }
}

export class ShuttingDownError extends Error {
  constructor() {
    super("workspace is shutting down");
    this.name = "ShuttingDownError";
  }
}

/** The agents that are never given MCP servers in this version, and why. */
const NO_MCP = {
  // Codex gives no approval step for MCP tool calls under its strict policy.
  codex: "Codex cannot use MCP servers in The Terminal yet",
  // gemini-cli 0.68.0 starts MCP servers only in a trusted folder, and a run's worktree is never trusted
  // (GEMINI_CLI_TRUST_WORKSPACE=false), since trust would also load repo-planted settings, .env and hooks.
  gemini: "Gemini cannot use MCP servers in The Terminal yet",
} as const;
export type NoMcpAdapter = keyof typeof NO_MCP;

/** A Codex or Gemini run was given an MCP server (see NO_MCP). */
export class McpUnsupportedError extends Error {
  constructor(readonly adapter: NoMcpAdapter) {
    super(NO_MCP[adapter]);
    this.name = "McpUnsupportedError";
  }
}

/** Two of a run's MCP connections would get the same server name: one would silently replace the other. */
export class DuplicateMcpServerError extends Error {
  constructor() {
    super("two of the selected MCP connections would get the same server name");
    this.name = "DuplicateMcpServerError";
  }
}

/**
 * A run was given two cloud connections of one provider, or grants that would set the same variable: one would
 * silently replace the other's credentials.
 */
export class DuplicateCloudProviderError extends Error {
  constructor(message = "a run can be given only one connection per cloud provider") {
    super(message);
    this.name = "DuplicateCloudProviderError";
  }
}

/** A run on a local model was asked of an agent other than Codex: only Codex has a custom model provider. */
export class LocalModelUnsupportedError extends Error {
  constructor() {
    super("Only Codex can run on a local model in The Terminal yet");
    this.name = "LocalModelUnsupportedError";
  }
}

/**
 * The run executes on a linked machine: it is stopped and decided there, through the remote-run service, never by
 * this machine's runner.
 */
export class RemoteRunError extends Error {
  constructor(readonly runId: string) {
    super("This run executes on a linked machine; stop it or decide for it there, through the link.");
    this.name = "RemoteRunError";
  }
}

/** How long all of a run's cloud grants together may take to mint, by default. */
export const DEFAULT_GRANT_TIMEOUT_MS = 10_000;
/** An MCP env or header value this long or longer is redacted from the run's output. */
const MIN_MCP_SECRET = 8;

/** How long the gate waits for a human by default: less than the Claude hook's 24h, so a timeout is recorded. */
export const DEFAULT_GATE_TIMEOUT_MS = 23 * 60 * 60 * 1000;

export type AgentRunnerDeps = {
  db: Db;
  ledger: Ledger;
  worktrees: WorktreeManager;
  broker: ApprovalBroker;
  adapters: Partial<Record<AdapterId, AgentAdapter>>;
  /**
   * The secrets to redact beyond the built-in patterns. Read on every clean, so a secret stored while a run is
   * live is redacted from that run's next event.
   */
  extraSecrets: () => string[];
  /** Recorded strings show this directory as `<data>`. */
  dataDir: string;
  newId?: () => string;
  /** How long shutdown() waits for adapters to return after aborting them. Default 5000. */
  shutdownTimeoutMs?: number;
  /** How long the gate waits for a human decision before denying with "timed out". Default 23h. */
  gateTimeoutMs?: number;
  /** Recorded strings show this name as `<user>`. Default: the OS username. */
  username?: string;
  /** The provider's connection credentials, looked up at each run start. Default: none. */
  credentials?: (provider: Provider) => Credentials | null;
  /**
   * What a run is given for the connection ids the Owner selected; throws for an unknown, disabled or wrong-kind id.
   * Default: no id is accepted (UnsupportedConnectionError), and none means nothing.
   */
  selectConnections?: (ids: string[]) => RunSelection;
  /** Mints one cloud grant; rejects with CloudCredentialError when it cannot. Default: none (cloud ids are refused). */
  mintCloud?: (source: CloudSource, signal: AbortSignal) => Promise<CloudGrant>;
  /** One deadline for minting all of a run's cloud grants. Default DEFAULT_GRANT_TIMEOUT_MS. */
  grantTimeoutMs?: number;
};

function defaultSelect(ids: string[]): RunSelection {
  if (ids.length > 0) throw new UnsupportedConnectionError();
  return { cloud: [], mcp: [], localModel: null };
}

/**
 * The MCP env and header values long enough to be secrets, and the credential after a scheme word such as `Bearer `:
 * redacted from everything the run reports.
 */
function mcpSecrets(specs: McpServerSpec[]): string[] {
  const values = specs.flatMap((m) => Object.values(m.transport === "stdio" ? m.env : m.headers));
  return values.flatMap((v) => pairValueSecrets(v, MIN_MCP_SECRET));
}

function osUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return ""; // no passwd entry: nothing to scrub
  }
}

type FinishStatus = "completed" | "failed" | "stopped";
type Session = {
  projectId: string;
  /** Replaces this run's absolute paths in recorded strings. */
  scrub: Scrub;
  abort: AbortController;
  done: Promise<void>;
  /** Per-run sums of what the adapter reported; null until something was reported. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Set when the runner itself failed during the run (e.g. a commit failed); fails the run. */
  failure: string | null;
  /** This run's own secrets (minted cloud values, MCP env and header values), redacted with the global ones. */
  secrets: string[];
};
type Payload = Record<string, unknown>;
type ActionRow = { run_id: string; project_id: string; status: AgentAction["status"]; reason: string; machine_id: string | null };
type GateOutcome = GateResult & { actionId: string };

const POLICY: Actor = { kind: "system", id: "policy" };
const RUNNER: Actor = { kind: "system", id: "runner" };
// Bounds from the agent payload schemas in @theterminal/shared; input has no schema bound, so we cap it.
const MAX = { tool: 200, summary: 200, reason: 500, text: 4000, output: 4000, prompt: 20000, error: 1000, input: 20000, preview: 4000 };
const promptSchema = z.string().min(1).max(MAX.prompt);
const INTERNAL_ERROR = "internal error";
const NOT_ALLOWED_RESULT = "adapter reported a result for an action that was not allowed";

function errorMessage(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
}

/**
 * Reads each field of a proposal exactly once, so a getter cannot show policy one thing and the
 * ledger another. Unknown kinds become "other"; a non-array `paths` is checked as a single path.
 */
function snapshot(a: ProposedAction): ProposedAction {
  const { kind, tool, summary, input, paths } = a;
  const list: unknown[] = Array.isArray(paths) ? [...paths] : paths === null || paths === undefined ? [] : [paths];
  return {
    kind: (ACTION_KINDS as readonly unknown[]).includes(kind) ? kind : "other",
    tool: asText(tool),
    summary: asText(summary),
    input,
    paths: list as string[],
  };
}

/** Adapter-reported text as a string; anything unprintable becomes "". */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return String(v);
  } catch {
    return "";
  }
}

/**
 * Adds a reported amount to a run's sum. Anything but a finite number >= 0 (an integer, for token counts) is
 * ignored; an unreported amount leaves the sum as it is, so "never reported" stays null.
 */
function addUsage(sum: number | null, v: unknown, integer = false): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) return sum;
  return (sum ?? 0) + v;
}

function scrubJson(v: unknown, scrub: Scrub): unknown {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map((x) => scrubJson(x, scrub));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrubJson(x, scrub)]));
  }
  return v;
}

/**
 * Runs agent adapters in the background behind the policy gate. Every proposed action is redacted and
 * committed to the ledger before it may run; anything that fails along the way is denied, and the denial
 * is recorded.
 */
export class AgentRunner {
  private readonly sessions = new Map<string, Session>();
  /** Runs whose adapter has not returned yet, even after a stop has closed their session. */
  private readonly unsettled = new Set<string>();
  private readonly newId: () => string;
  /** Scrubs dataDir, the home directory and the username, for strings recorded outside a live run. */
  private readonly scrub: Scrub;
  private readonly scrubUser: Scrub;
  /**
   * Every value minted for any run since this process started. Never shrinks: a minted token stays valid after its
   * run ends, so every later run (and anything else the server records) redacts it too.
   */
  private readonly minted = new Set<string>();
  /** Set once shutdown() begins; no run may start after that. */
  private closing = false;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.newId = deps.newId ?? (() => randomUUID());
    this.scrubUser = usernameScrubber(deps.username ?? osUsername());
    this.scrub = this.withUser(pathScrubber([[deps.dataDir, "<data>"], [homedir(), "~"]]));
  }

  private runScrubber(worktreeAbs: string): Scrub {
    return this.withUser(pathScrubber([[worktreeAbs, "."], [this.deps.dataDir, "<data>"], [homedir(), "~"]]));
  }

  /** Paths first, so a home directory becomes `~` rather than a path ending in `<user>`. */
  private withUser(paths: Scrub): Scrub {
    return (s) => this.scrubUser(paths(s));
  }

  async start(
    actor: Actor,
    input: { projectId: string; adapter: AdapterId; prompt: string; cardId?: string | null; connectionIds?: string[] },
  ): Promise<AgentRun> {
    const { db, ledger, worktrees } = this.deps;
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
      throw new NotFoundError("project", input.projectId);
    }
    if (ledger.readOnly) throw new LedgerReadOnlyError();
    if (this.closing) throw new ShuttingDownError();
    const adapter = this.deps.adapters[input.adapter];
    if (!adapter) throw new AdapterUnavailableError(input.adapter);
    const prompt = promptSchema.parse(input.prompt);
    const cardId = input.cardId ?? null;
    if (cardId !== null && !db.prepare("SELECT 1 FROM cards WHERE id = ? AND project_id = ?").get(cardId, input.projectId)) {
      throw new NotFoundError("card", cardId);
    }
    // Every selected connection is checked before anything is minted or created; errors propagate as they are.
    const selection = (this.deps.selectConnections ?? defaultSelect)(input.connectionIds ?? []);
    const localModel = selection.localModel ?? null;
    if (localModel !== null && input.adapter !== "codex") throw new LocalModelUnsupportedError();
    if ((input.adapter === "codex" || input.adapter === "gemini") && selection.mcp.length > 0) throw new McpUnsupportedError(input.adapter);
    const serverNames = selection.mcp.map((m) => m.serverName);
    if (new Set(serverNames).size !== serverNames.length) throw new DuplicateMcpServerError();
    const providers = selection.cloud.map((c) => c.provider);
    if (new Set(providers).size !== providers.length) throw new DuplicateCloudProviderError();
    const grants = await this.mintAll(selection.cloud);
    const names = grants.flatMap((g) => Object.keys(g.env));
    if (new Set(names).size !== names.length) throw new DuplicateCloudProviderError("two cloud grants would set the same variable");
    const runSecrets = [
      ...grants.flatMap((g) => g.secrets), ...mcpSecrets(selection.mcp), ...(localModel?.apiKey ? [localModel.apiKey] : []),
    ];

    // A local model needs no login: the provider's own mode and connection are not used.
    const authMode: AuthMode =
      input.adapter === "fake" || localModel !== null ? "none" : new ProviderSettings(db, ledger).getMode(input.adapter);
    const creds = input.adapter === "fake" || localModel !== null ? null : (this.deps.credentials?.(input.adapter) ?? null);
    // Only what the mode uses: the key in api_key mode, the CLI home in a login mode; the Gemini project in both.
    const env: Record<string, string> = Object.assign({}, ...grants.map((g) => g.env));
    const credentials: RunCredentials = { env, mcpServers: selection.mcp };
    if (authMode === "api_key" && creds?.apiKey) credentials.apiKey = creds.apiKey;
    if (authMode !== "api_key" && creds?.cliHome) credentials.cliHome = creds.cliHome;
    if (creds?.googleCloudProject) credentials.googleCloudProject = creds.googleCloudProject;
    // Its key stays in `localModel`, never in `env`: Codex lets every `env` name through to the agent's commands.
    if (localModel !== null) credentials.localModel = localModel;
    // What the run takes from the connection: its key in api_key mode, its CLI home in a login mode.
    const purpose = authMode === "api_key" ? (creds?.apiKey ? "api_key" : null) : creds?.cliHome ? "cli_home" : null;

    const runId = this.newId();
    const wt = await worktrees.createRunWorktree(input.projectId, runId);
    if (this.closing) throw new ShuttingDownError(); // shutdown began while the worktree was created
    const scrub = this.runScrubber(wt.absPath);
    const run = commitEvent(db, ledger, () => ({
      event: {
        projectId: input.projectId,
        actor,
        type: "agent.started",
        payload: {
          runId, adapter: input.adapter, authMode, prompt: this.clean(prompt, MAX.prompt, scrub, runSecrets),
          cardId, worktree: wt.relPath, base: wt.base,
        },
      },
      result: () => getRun(db, runId)!,
    }));
    // What the run was given: which connection, for what, which kind of credential and when it expires; never a value.
    const uses: Payload[] = [];
    if (creds && purpose) uses.push({ connectionId: creds.connectionId, name: creds.name, runId, purpose });
    selection.cloud.forEach((source, i) => {
      const { credential, expiresAt } = grants[i]!;
      uses.push({ connectionId: source.connectionId, name: source.name, runId, purpose: "cloud_credentials", credential, expiresAt });
    });
    for (const m of selection.mcp) uses.push({ connectionId: m.connectionId, name: m.name, runId, purpose: "mcp_server" });
    if (localModel !== null) uses.push({ connectionId: localModel.connectionId, name: localModel.name, runId, purpose: "local_model" });
    try {
      for (const payload of uses) {
        commitEvent(db, ledger, () => ({
          event: { projectId: null, actor: RUNNER, type: "connection.used", payload },
          result: () => undefined,
        }));
      }
    } catch (e) {
      this.close(runId, "failed", INTERNAL_ERROR, "run finished"); // never leave a run recorded as running
      throw e;
    }
    this.launch(run, adapter, wt.absPath, scrub, prompt, authMode, credentials, runSecrets);
    return run;
  }

  /**
   * Mints every grant in order against one shared deadline: when it passes, the signal is aborted and the start fails
   * with CloudCredentialError, even if a minter ignores its signal. The first failure ends the start.
   */
  private async mintAll(sources: CloudSource[]): Promise<CloudGrant[]> {
    if (sources.length === 0) return [];
    const mint = this.deps.mintCloud;
    if (!mint) throw new UnsupportedConnectionError();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.deps.grantTimeoutMs ?? DEFAULT_GRANT_TIMEOUT_MS);
    try {
      const grants: CloudGrant[] = [];
      for (const source of sources) {
        const timedOut = () =>
          new CloudCredentialError(source.name, `Could not get credentials for the connection "${source.name}": timed out`);
        if (deadline.signal.aborted) throw timedOut();
        let onAbort = () => {};
        const expired = new Promise<never>((_, reject) => {
          onAbort = () => reject(timedOut());
          deadline.signal.addEventListener("abort", onAbort, { once: true });
        });
        const minting = mint(source, deadline.signal);
        minting.catch(() => {}); // a late rejection after the deadline is not unhandled
        try {
          const grant = await Promise.race([minting, expired]);
          for (const v of grant.secrets) this.minted.add(v);
          grants.push(grant);
        } catch (e) {
          // A minter that rejects because its signal was aborted reports the deadline, not its own reason.
          throw deadline.signal.aborted && !(e instanceof CloudCredentialError) ? timedOut() : e;
        } finally {
          deadline.signal.removeEventListener("abort", onAbort);
        }
      }
      return grants;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A human decision on a pending action. The check and the commit share one transaction. */
  decide(actor: Actor, actionId: string, decision: "allow" | "deny", reason = ""): AgentAction {
    const { db, ledger, broker } = this.deps;
    let why = "";
    const runId = commitEvent(db, ledger, () => {
      const row = this.actionRow(actionId);
      if (!row) throw new NotFoundError("action", actionId);
      if (row.machine_id !== null) throw new RemoteRunError(row.run_id);
      if (row.status !== "pending" || !broker.pendingIds().includes(actionId)) throw new AlreadyDecidedError(actionId);
      const s = this.sessions.get(row.run_id);
      why = this.clean(reason, MAX.reason, s?.scrub ?? this.scrub, s?.secrets);
      return {
        event: {
          projectId: row.project_id, actor, type: "agent.action.decided",
          payload: { runId: row.run_id, actionId, decision, by: "human", reason: why },
        },
        result: () => row.run_id,
      };
    });
    broker.decide(actionId, decision, why);
    return listActions(db, runId).find((a) => a.id === actionId)!;
  }

  /**
   * True from a run's start until its adapter has returned. A stopped run is no longer `running` at once, but its
   * agent process may still be writing into the working copy until then.
   */
  settling(runId: string): boolean {
    return this.unsettled.has(runId);
  }

  stop(_actor: Actor, runId: string): void {
    const run = getRun(this.deps.db, runId);
    if (!run) throw new NotFoundError("run", runId);
    if (run.machineId !== null) throw new RemoteRunError(runId);
    this.close(runId, "stopped", null, "run stopped");
  }

  listRuns(projectId: string): AgentRun[] {
    return listRuns(this.deps.db, projectId);
  }

  getRun(runId: string): { run: AgentRun; actions: AgentAction[] } {
    const run = getRun(this.deps.db, runId);
    if (!run) throw new NotFoundError("run", runId);
    return { run, actions: listActions(this.deps.db, runId) };
  }

  /**
   * The cleaning this run's recorded text gets (redact, scrub paths, redact, then truncate to `max`), for text read
   * from its working copy: the live session's scrubber and secrets while it runs, else a scrubber for its worktree.
   */
  cleanFor(runId: string): (s: string, max: number) => string {
    const run = getRun(this.deps.db, runId);
    if (!run) throw new NotFoundError("run", runId);
    const s = this.sessions.get(runId);
    const scrub = s?.scrub ?? this.runScrubber(join(this.deps.dataDir, run.worktree));
    return (text, max) => this.clean(text, max, scrub, s?.secrets);
  }

  /**
   * After a restart nothing is waiting any more: deny every pending action and fail every running run of this
   * machine. A run on a linked machine (`machine_id` set) is left alone: it still runs there, its state arrives as
   * mirrored entries, and this machine records nothing about it itself.
   */
  recoverOnStartup(): void {
    const { db, ledger } = this.deps;
    if (ledger.readOnly) return;
    const pending = db
      .prepare(
        `SELECT a.id, a.run_id, r.project_id FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
         WHERE a.status = 'pending' AND r.machine_id IS NULL ORDER BY a.requested_at, a.rowid`,
      )
      .all() as { id: string; run_id: string; project_id: string }[];
    for (const a of pending) {
      if (!this.sessions.has(a.run_id)) this.settle(a.project_id, a.run_id, a.id, "deny", "workspace restarted");
    }
    const running = db
      .prepare("SELECT id FROM agent_runs WHERE status = 'running' AND machine_id IS NULL ORDER BY started_at, rowid")
      .all() as { id: string }[];
    for (const r of running) {
      if (!this.sessions.has(r.id)) this.close(r.id, "failed", "workspace restarted", "workspace restarted");
    }
  }

  /**
   * Stops every running run of this process and waits for the adapters to return. Only runs with a session here are
   * stopped: a run on a linked machine has none, so this machine never records it as stopped.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    const all = [...this.sessions.entries()];
    for (const [runId] of all) {
      try {
        this.close(runId, "stopped", null, "run stopped");
      } catch {
        // Keep stopping the others; the adapters are aborted either way.
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.shutdownTimeoutMs ?? 5000);
    });
    // An adapter that ignores the abort must not hang shutdown; its run is already recorded as stopped.
    await Promise.race([Promise.all(all.map(([, s]) => s.done)), timeout]);
    clearTimeout(timer);
  }

  private launch(
    run: AgentRun, adapter: AgentAdapter, cwd: string, scrub: Scrub, prompt: string, authMode: AuthMode, credentials: RunCredentials,
    secrets: string[],
  ): void {
    const abort = new AbortController();
    const session: Session = {
      projectId: run.projectId, scrub, abort, done: Promise.resolve(), costUsd: null, inputTokens: null, outputTokens: null, failure: null,
      secrets,
    };
    this.sessions.set(run.id, session);
    this.unsettled.add(run.id);
    session.done = (async () => {
      let status: FinishStatus;
      let error: string | null = null;
      try {
        const r = await adapter.start({
          cwd, projectId: run.projectId, prompt, authMode, signal: abort.signal,
          gate: (a) => this.gate(run.id, session, cwd, a),
          emit: (e) => this.onEmit(run.id, session, e),
          recordDenied: async (a, reason) => this.recordDenied(run.id, session, a, reason),
          clean: (s) => this.clean(asText(s), Infinity, scrub, secrets),
          credentials,
        });
        status = r.status;
        error = r.status === "failed" ? (r.error ?? "agent failed") : null;
      } catch (e) {
        status = "failed";
        error = errorMessage(e);
      }
      if (session.failure) {
        status = "failed";
        error = session.failure;
      }
      try {
        this.close(run.id, status, error, "run finished");
      } catch (e) {
        console.error(`agent run ${run.id} could not be finished: ${e instanceof Error ? e.name : "error"}`);
      } finally {
        this.sessions.delete(run.id);
      }
    })().finally(() => this.unsettled.delete(run.id));
  }

  /** Records a proposal through the same snapshot, redaction and scrub as every action; returns what was recorded. */
  private recordProposal(runId: string, s: Session, actionId: string, proposed: ProposedAction) {
    const a = snapshot(proposed); // recording and classify see only this copy
    const input = this.cleanInput(a.input, s.scrub, s.secrets);
    this.recordRequest(s, runId, {
      runId, actionId, kind: a.kind,
      tool: this.clean(a.tool, MAX.tool, s.scrub, s.secrets) || "unknown",
      summary: this.clean(a.summary, MAX.summary, s.scrub, s.secrets) || "(no summary)",
      input,
    });
    return { a, input };
  }

  /** An action the adapter refuses outright: recorded as requested and denied by policy, with no human wait. */
  private recordDenied(runId: string, s: Session, proposed: ProposedAction, reason: string): void {
    const actionId = this.newId();
    let recorded = false;
    try {
      this.recordProposal(runId, s, actionId, proposed);
      recorded = true;
      this.settle(s.projectId, runId, actionId, "deny", this.clean(reason, MAX.reason, s.scrub, s.secrets) || "denied");
    } catch {
      s.failure ??= INTERNAL_ERROR;
      try {
        if (!recorded) {
          this.recordRequest(s, runId, { runId, actionId, kind: "other", tool: "unknown", summary: "(unrecordable action)", input: null });
        }
        this.settle(s.projectId, runId, actionId, "deny", INTERNAL_ERROR);
      } catch {
        // Nothing more we can record.
      }
    }
  }

  private async gate(runId: string, s: Session, worktreeAbs: string, proposed: ProposedAction): Promise<GateOutcome> {
    const actionId = this.newId();
    let recorded = false;
    try {
      const { a, input } = this.recordProposal(runId, s, actionId, proposed);
      recorded = true;
      if (s.abort.signal.aborted) return this.settle(s.projectId, runId, actionId, "deny", "run stopped");
      const v = classify({ ...a, input }, worktreeAbs, this.deps.worktrees); // classify sees what was recorded
      if (v.verdict !== "ask") {
        return this.settle(s.projectId, runId, actionId, v.verdict === "auto_allow" ? "allow" : "deny", v.reason);
      }
      const r = await this.waitForHuman(actionId, s.abort.signal);
      // decide() has already committed a human decision; any other outcome (a stop or timeout) is recorded here.
      return this.settle(s.projectId, runId, actionId, r.decision, r.reason);
    } catch {
      s.failure ??= INTERNAL_ERROR; // the gate can no longer be trusted: the run fails
      try {
        if (!recorded) {
          // The proposal itself could not be recorded: record that an unrecordable action was denied.
          this.recordRequest(s, runId, {
            runId, actionId, kind: "other", tool: "unknown", summary: "(unrecordable action)", input: null,
          });
        }
        this.settle(s.projectId, runId, actionId, "deny", INTERNAL_ERROR);
      } catch {
        // Nothing more we can record; deny regardless.
      }
      return { actionId, decision: "deny", reason: INTERNAL_ERROR };
    }
  }

  /** The broker's wait, cut off after gateTimeoutMs with a "timed out" denial. */
  private async waitForHuman(actionId: string, runSignal: AbortSignal): Promise<GateResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
    try {
      const r = await this.deps.broker.wait(actionId, AbortSignal.any([runSignal, timeout.signal]));
      // A timeout ends the wait like a stop; say why. A decision already in the ledger wins in settle().
      return timeout.signal.aborted && !runSignal.aborted ? { decision: "deny", reason: "timed out" } : r;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordRequest(s: Session, runId: string, payload: Payload): void {
    commitEvent(this.deps.db, this.deps.ledger, () => ({
      event: { projectId: s.projectId, actor: { kind: "agent", id: runId }, type: "agent.action.requested", payload },
      result: () => undefined,
    }));
  }

  /**
   * Commits a policy decision unless the action is already decided, and returns what the ledger holds.
   * Only an action the ledger records as allowed is allowed.
   */
  private settle(projectId: string, runId: string, actionId: string, decision: "allow" | "deny", reason: string): GateOutcome {
    return commitEvent(this.deps.db, this.deps.ledger, () => {
      const row = this.actionRow(actionId);
      // Never record a decision for an action that was not recorded as requested.
      if (!row) return { result: (): GateOutcome => ({ actionId, decision: "deny", reason }) };
      if (row.status !== "pending") {
        const decided: GateOutcome = { actionId, decision: row.status === "allowed" ? "allow" : "deny", reason: row.reason };
        return { result: () => decided };
      }
      return {
        event: {
          projectId, actor: POLICY, type: "agent.action.decided",
          payload: { runId, actionId, decision, by: "policy", reason },
        },
        result: () => ({ actionId, decision, reason }),
      };
    });
  }

  private onEmit(runId: string, s: Session, e: AdapterEvent): void {
    if (s.abort.signal.aborted) return; // the run is over; late events are dropped
    const { db, ledger } = this.deps;
    const agent: Actor = { kind: "agent", id: runId };
    const fail = (why: string) => {
      s.failure ??= why;
      s.abort.abort();
    };
    try {
      if (e.type === "message") {
        const text = this.clean(asText(e.text), MAX.text, s.scrub, s.secrets);
        commitEvent(db, ledger, () => ({
          event: { projectId: s.projectId, actor: agent, type: "agent.message", payload: { runId, text } },
          result: () => undefined,
        }));
      } else if (e.type === "action_result") {
        const output = this.clean(asText(e.output), MAX.output, s.scrub, s.secrets);
        const committed = commitEvent(db, ledger, () => {
          const row = this.actionRow(e.actionId);
          if (!row || row.run_id !== runId || row.status !== "allowed") return { result: () => false };
          return {
            event: {
              projectId: s.projectId, actor: agent, type: "agent.action.completed",
              payload: { runId, actionId: e.actionId, ok: e.ok === true, output },
            },
            result: () => true,
          };
        });
        if (!committed) fail(NOT_ALLOWED_RESULT);
      } else if (e.type === "rate_limited") {
        const r = e.retryAfterS; // read once
        const retryAfterS = typeof r === "number" && Number.isSafeInteger(r) && r >= 0 ? r : null;
        commitEvent(db, ledger, () => ({
          event: { projectId: s.projectId, actor: agent, type: "agent.rate_limited", payload: { runId, retryAfterS } },
          result: () => undefined,
        }));
      } else if (e.type === "usage") {
        const { costUsd, inputTokens, outputTokens } = e; // each read once
        s.costUsd = addUsage(s.costUsd, costUsd);
        s.inputTokens = addUsage(s.inputTokens, inputTokens, true);
        s.outputTokens = addUsage(s.outputTokens, outputTokens, true);
      }
    } catch {
      fail(INTERNAL_ERROR);
    }
  }

  /** Aborts the run, denies its pending actions, then commits agent.finished once (guarded by run status). */
  private close(runId: string, status: FinishStatus, error: string | null, pendingReason: string): void {
    const { db, ledger } = this.deps;
    const s = this.sessions.get(runId);
    s?.abort.abort();
    this.sessions.delete(runId); // even if its adapter never returns
    const run = getRun(db, runId);
    // A run on a linked machine is never ended here: its end arrives mirrored (the last fail-safe behind stop/decide).
    if (!run || run.status !== "running" || run.machineId !== null) return;
    for (const a of listActions(db, runId)) {
      if (a.status === "pending") this.settle(run.projectId, runId, a.id, "deny", pendingReason);
    }
    commitEvent(db, ledger, () => {
      const cur = getRun(db, runId);
      if (!cur || cur.status !== "running") return { result: () => undefined };
      return {
        event: {
          projectId: cur.projectId, actor: RUNNER, type: "agent.finished",
          payload: {
            runId, status, costUsd: s?.costUsd ?? null, inputTokens: s?.inputTokens ?? null, outputTokens: s?.outputTokens ?? null,
            error: error === null ? null : this.clean(error, MAX.error, s?.scrub ?? this.scrub, s?.secrets),
          },
        },
        result: () => undefined,
      };
    });
  }

  private actionRow(actionId: string): ActionRow | undefined {
    return this.deps.db
      .prepare(
        `SELECT a.run_id, a.status, a.reason, r.project_id, r.machine_id FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
         WHERE a.id = ?`,
      )
      .get(actionId) as ActionRow | undefined;
  }

  /**
   * Redact the configured secrets and the run's own, scrub paths, redact again, then truncate (never truncate first). The first
   * pass runs before scrubbing so a secret that contains the username or a path is still matched whole.
   */
  private clean(s: string, max: number, scrub: Scrub, runSecrets: string[] = []): string {
    const secrets = [...this.secrets(), ...runSecrets];
    return truncate(redact(scrub(redact(s, secrets)), secrets), max);
  }

  /** Every value minted for a run so far, for redaction anywhere in the server. */
  mintedSecrets(): string[] {
    return [...this.minted];
  }

  /**
   * The extra secrets as of now, and every value minted so far; anything that is not a list of strings is a failure,
   * never "no secrets".
   */
  private secrets(): string[] {
    const list = this.deps.extraSecrets();
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new TypeError("extraSecrets must return strings");
    return [...list, ...this.minted];
  }

  /**
   * Normalises to plain JSON first (class instances and toJSON values become plain data that redact
   * can see into); a value that cannot be serialised throws and is denied by the gate. An input over
   * the cap is recorded as its hash, length and a preview, so what was approved can still be checked.
   */
  private cleanInput(input: unknown, scrub: Scrub, runSecrets: string[] = []): unknown {
    const json = JSON.stringify(input ?? null);
    const plain: unknown = json === undefined ? null : JSON.parse(json);
    const secrets = [...this.secrets(), ...runSecrets];
    const value = redact(scrubJson(redact(plain, secrets), scrub), secrets);
    const out = JSON.stringify(value);
    if (out.length <= MAX.input) return value;
    return {
      truncated: true,
      sha256: createHash("sha256").update(out).digest("hex"),
      totalChars: out.length,
      preview: truncate(out, MAX.preview),
    };
  }
}
