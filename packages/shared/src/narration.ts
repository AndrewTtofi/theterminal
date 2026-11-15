import type { ActionKind, AgentAction } from "./agents.js";
import { KIND_LABELS } from "./connections.js";
import type { Actor, LedgerEntry } from "./domain.js";
import { GATES, type GateId } from "./gates.js";
import { INTAKE_DECISIONS, INTAKE_QUESTIONS, renderAnswer, type IntakeAnswer } from "./intake.js";
import { formatUsd, plural, visibleControls } from "./text.js";

export type NarrationTopic = "board" | "agent" | "decision" | "gate" | "intake" | "connection" | "settings" | "other";
export type NarrationRefs = {
  cardId?: string;
  runId?: string;
  actionId?: string;
  connectionId?: string;
  intakeId?: string;
  gateId?: GateId;
};
export type Narration = { headline: string; detail: string | null; topic: NarrationTopic; attention: boolean; refs: NarrationRefs };
/** What the caller knows beyond the entry: a card's title and a run's adapter. Narration adds nothing else. */
export type NarrationContext = {
  cardTitle?: (cardId: string) => string | undefined;
  adapterName?: (runId: string) => string | undefined;
};
export type ActionLike = Pick<AgentAction, "kind" | "tool" | "summary" | "input">;

const HEADLINE_MAX = 200;

const ADAPTER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", fake: "Fake" };

/** What a run was given for a cloud connection, by credential kind (never its value). */
const CREDENTIAL_LABELS: Record<string, string> = {
  aws_session_token: "a 12-hour AWS session token",
  aws_static_keys: "the AWS access keys (no session token available)",
  gcp_access_token: "a 1-hour Google Cloud token",
  azure_client_secret: "the Azure client secret",
};

export const ACTION_KIND_MEANS: Record<ActionKind, string> = {
  file_read: "Reads a file inside the agent's working copy of the project. Nothing changes.",
  file_write:
    "Creates or replaces a file inside the agent's working copy. The previous contents are gone unless git kept them.",
  file_edit: "Changes part of a file inside the agent's working copy.",
  shell:
    "Runs a program on this computer, inside the agent's working copy. It can read and change files there and reach the network.",
  web: "Fetches something from the internet. What is sent and received is recorded.",
  mcp: "Uses a tool from a connected MCP server. Every call is recorded and asks first.",
  other: "Something the agent's program asked for that fits no other kind. Read the raw detail before deciding.",
};

type Payload = Record<string, unknown>;

const isRecord = (v: unknown): v is Payload => typeof v === "object" && v !== null && !Array.isArray(v);

/** A payload value as text: strings as written, numbers and booleans spelled out, anything else empty. */
const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

/** A string id from the payload, or undefined. */
const idOf = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** A record's own value for a key, never an inherited one such as `constructor`. */
function own<T>(rec: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Payload text for a headline: clipped, then with hidden and bidi characters shown as escapes. */
const show = (v: unknown, max = HEADLINE_MAX): string => visibleControls(clip(str(v), max));

const cap = (v: unknown): string => {
  const t = str(v);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const adapterLabel = (v: unknown): string => own(ADAPTER_LABELS, v) ?? show(cap(v), 40);

function lookup<T>(fn: ((key: string) => T | undefined) | undefined, key: string | undefined): T | undefined {
  return fn && key !== undefined ? fn(key) : undefined;
}

function actorName(a: Actor, agent: string): string {
  if (a.kind === "system") return a.id === "policy" ? "Policy" : "The workspace";
  if (a.kind === "agent") return agent;
  return a.id === "owner" ? "Owner" : show(a.id, 60);
}

function agentName(runId: string | undefined, ctx: NarrationContext): string {
  const name = lookup(ctx.adapterName, runId);
  return name ? `The ${own(ADAPTER_LABELS, name) ?? show(name, 40)} agent` : "The agent";
}

/** `"<title>"` when the context knows the card, else `a card`. */
function cardRef(cardId: string | undefined, ctx: NarrationContext): string {
  const title = lookup(ctx.cardTitle, cardId);
  return title ? `"${show(title, 120)}"` : "a card";
}

function lineCount(output: string): number {
  if (output.length === 0) return 0;
  return output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

const firstLine = (s: string): string => s.split(/\r?\n/)[0] ?? "";

const gateTitle = (id: unknown): string => GATES.find((g) => g.id === id)?.title ?? show(id, 60);

function topicOf(type: string): NarrationTopic {
  if (type === "agent.action.decided") return "decision";
  const prefix = type.split(".")[0];
  switch (prefix) {
    case "card":
    case "project":
      return "board";
    case "agent":
      return "agent";
    case "gate":
      return "gate";
    case "intake":
      return "intake";
    case "connection":
      return "connection";
    case "settings":
      return "settings";
    default:
      return "other";
  }
}

function refsOf(p: Payload): NarrationRefs {
  const refs: NarrationRefs = {};
  const cardId = idOf(p.cardId);
  const runId = idOf(p.runId);
  const actionId = idOf(p.actionId);
  const connectionId = idOf(p.connectionId);
  const intakeId = idOf(p.intakeId);
  const gates = Array.isArray(p.gates) ? p.gates : [];
  const gateId = idOf(p.gateId) ?? (isRecord(gates[0]) ? idOf(gates[0].gateId) : undefined);
  if (cardId) refs.cardId = cardId;
  if (runId) refs.runId = runId;
  if (actionId) refs.actionId = actionId;
  if (connectionId) refs.connectionId = connectionId;
  if (intakeId) refs.intakeId = intakeId;
  if (gateId && GATES.some((g) => g.id === gateId)) refs.gateId = gateId as GateId;
  return refs;
}

const TARGET_KEYS = ["path", "file_path", "filePath", "command", "url"] as const;

const VERBS: Record<ActionKind, string> = {
  file_read: "read",
  file_write: "create or replace",
  file_edit: "change",
  shell: "run",
  web: "fetch",
  mcp: "use",
  other: "",
};

/** A verb phrase for what the action does, from its recorded input, else its recorded summary. */
export function actionPhrase(a: ActionLike): string {
  const input = isRecord(a.input) ? a.input : {};
  const summary = show(a.summary, 120);
  if (a.kind === "mcp") return `use ${summary}`;
  if (a.kind === "other") return summary;

  if (input.truncated === true) {
    const size = typeof input.totalChars === "number" ? ` (${input.totalChars} characters)` : "";
    if (a.kind === "shell" && a.tool === "codex.stdin") {
      return `type something too long to show in full${size} into the running command`;
    }
    const what = a.kind === "shell" ? "a command" : "something";
    return `${own(VERBS, a.kind) ?? "use"} ${what} too long to show in full${size}`;
  }

  if (a.kind === "shell" && a.tool === "codex.stdin") {
    return `type "${show(input.reason, 80)}" into the running command`;
  }

  const raw = TARGET_KEYS.map((k) => input[k]).find((v): v is string => typeof v === "string");
  if (a.kind === "shell") {
    if (raw === undefined) return `run the command "${summary}"`;
    const lines = raw.split(/\r?\n/);
    const more = lines.length > 1 ? ` (and ${plural(lines.length - 1, "more line")})` : "";
    return `run the command "${show(lines[0], 100)}"${more}`;
  }
  const target = raw === undefined ? summary : show(raw, 120);
  return `${own(VERBS, a.kind) ?? "use"} ${target}`;
}

const STATUS_PREFIX: Record<AgentAction["status"], string> = {
  pending: "Wants to",
  allowed: "Allowed to",
  denied: "Denied:",
  completed: "Did",
  failed: "Failed to",
};

const json = (v: unknown): string | null => {
  try {
    return JSON.stringify(v, null, 2) ?? null;
  } catch {
    return null;
  }
};

const capHeadline = (s: string): string => (s.length > HEADLINE_MAX ? `${s.slice(0, HEADLINE_MAX - 1)}…` : s);

export function narrateAction(a: AgentAction): { headline: string; detail: string | null; means: string } {
  const headline = capHeadline(`${own(STATUS_PREFIX, a.status) ?? "Wants to"} ${actionPhrase(a)}`);
  const detail = typeof a.output === "string" && a.output.length > 0 ? a.output : json(a.input);
  return { headline, detail, means: own(ACTION_KIND_MEANS, a.kind) ?? ACTION_KIND_MEANS.other };
}

type Told = { headline: string; detail?: string | null; attention?: boolean };

function tell(e: LedgerEntry, p: Payload, ctx: NarrationContext): Told {
  const runId = idOf(p.runId) ?? (e.actor.kind === "agent" ? e.actor.id : undefined);
  const agent = agentName(runId, ctx);
  const who = actorName(e.actor, agent);
  const cardId = idOf(p.cardId);

  switch (e.type) {
    case "project.created":
      return { headline: `${who} created the project "${show(p.name, 120)}"` };
    case "card.created":
      return { headline: `${who} added "${show(p.title, 120)}" to ${show(cap(p.stage), 20)}` };
    case "card.moved":
      return { headline: `${who} moved ${cardRef(cardId, ctx)} from ${show(cap(p.from), 20)} to ${show(cap(p.to), 20)}` };
    case "card.status_changed":
      return { headline: `${who} marked ${cardRef(cardId, ctx)} ${show(p.to, 20)}` };

    case "agent.started": {
      const adapter = adapterLabel(p.adapter);
      const title = lookup(ctx.cardTitle, cardId);
      const prompt = str(p.prompt);
      const headline = title
        ? `${who} started a ${adapter} agent on "${show(title, 120)}"`
        : `${who} started a ${adapter} agent: "${show(prompt, 80)}"`;
      return { headline, detail: prompt || null };
    }
    case "agent.message": {
      const text = str(p.text);
      return { headline: `${agent} said: "${show(text, 120)}"`, detail: text || null };
    }
    case "agent.action.requested": {
      const phrase = actionPhrase({
        kind: (str(p.kind) || "other") as ActionKind,
        tool: str(p.tool),
        summary: str(p.summary),
        input: p.input,
      });
      return { headline: `${agent} wants to ${phrase}`, detail: json(p.input), attention: true };
    }
    case "agent.action.decided": {
      const allowed = p.decision === "allow";
      const reason = show(p.reason, 160);
      const byPolicy = p.by === "policy" || (p.by !== "human" && e.actor.kind !== "human");
      if (byPolicy) {
        const lead = allowed ? "Allowed automatically" : "Stopped automatically";
        return { headline: reason ? `${lead}: ${reason}` : lead };
      }
      return { headline: allowed ? `${who} allowed it` : `${who} denied it: ${reason || "no reason given"}` };
    }
    case "agent.action.completed": {
      const output = str(p.output);
      if (p.ok === true) return { headline: `Done (${plural(lineCount(output), "line")} of output)`, detail: output || null };
      const first = show(firstLine(output), 80);
      return { headline: first ? `It failed: ${first}` : "It failed", detail: output || null };
    }
    case "agent.finished": {
      if (p.status === "failed") {
        const error = str(p.error);
        return { headline: error ? `${agent} failed: ${show(error, 120)}` : `${agent} failed`, detail: error || null, attention: true };
      }
      if (p.status === "stopped") return { headline: `${agent} was stopped` };
      const cost = typeof p.costUsd === "number" && Number.isFinite(p.costUsd) ? ` · cost ${formatUsd(p.costUsd)} (estimate)` : "";
      return { headline: `${agent} finished${cost}` };
    }
    case "agent.rate_limited": {
      const retry = typeof p.retryAfterS === "number" ? `; retry after ${p.retryAfterS} s` : "";
      return { headline: `Agent ${show(str(p.runId).slice(0, 8))} was rate-limited by the provider${retry}` };
    }

    case "settings.claude_auth_changed":
      return { headline: `${who} set Claude to use ${p.mode === "subscription" ? "own subscription" : "API key"}` };
    case "settings.provider_auth_changed": {
      const how =
        p.mode === "api_key"
          ? "API key"
          : p.mode === "chatgpt"
            ? "own ChatGPT plan"
            : p.mode === "google"
              ? "own Google account"
              : "own subscription";
      return { headline: `${who} set ${show(cap(p.provider), 20)} to use ${how}` };
    }

    case "connection.added": {
      const kind = own<string>(KIND_LABELS, p.kind) ?? show(p.kind, 40);
      return { headline: `${who} connected "${show(p.name, 120)}" (${kind})` };
    }
    case "connection.updated": {
      const c = isRecord(p.changes) ? p.changes : {};
      const name = show(p.name, 120);
      if (c.enabled === true) return { headline: `${who} enabled "${name}"` };
      if (c.enabled === false) return { headline: `${who} disabled "${name}"` };
      const set = Array.isArray(c.secretsSet) ? c.secretsSet.map((s) => show(s, 40)) : [];
      if (set.length > 0) return { headline: `${who} replaced the ${set.join(", ")} of "${name}"` };
      return { headline: `${who} updated "${name}"` };
    }
    case "connection.removed":
      return { headline: `${who} removed "${show(p.name, 120)}"` };
    case "connection.tested":
      return {
        headline: p.ok === true ? `"${show(p.name, 120)}" connected` : `"${show(p.name, 120)}" failed to connect: ${show(p.message, 200)}`,
      };
    case "connection.signin":
      return {
        headline: p.ok === true ? `${who} signed in to ${show(cap(p.provider), 20)}` : `Sign-in to ${show(cap(p.provider), 20)} failed`,
      };
    case "connection.used": {
      const used = `Agent ${show(str(p.runId).slice(0, 8))}`;
      const name = show(p.name, 120);
      if (p.purpose === "mcp_server") return { headline: `${used} was given the MCP server "${name}"` };
      if (p.purpose === "cloud_credentials") {
        const label = own(CREDENTIAL_LABELS, p.credential) ?? "cloud credentials";
        return { headline: `${used} was given ${label} from "${name}"` };
      }
      return { headline: `${used} was given access to "${name}"` };
    }

    case "intake.started": {
      const idea = str(p.idea);
      return { headline: `${who} described the idea: "${show(idea, 80)}"`, detail: idea || null };
    }
    case "intake.answered": {
      const q = INTAKE_QUESTIONS.find((x) => x.id === p.questionId);
      const label = q ? q.label : show(p.questionId, 60);
      const a = p.answer;
      const valid = typeof a === "string" || typeof a === "number" || (Array.isArray(a) && a.every((x) => typeof x === "string"));
      const rendered = !valid ? "" : q ? renderAnswer(q, a as IntakeAnswer) : Array.isArray(a) ? a.join(", ") : str(a);
      return { headline: `${who} answered "${label}": ${show(rendered, 120)}`, detail: rendered || null };
    }
    case "intake.decided": {
      const d = INTAKE_DECISIONS.find((x) => x.id === p.decisionId);
      const question = d ? d.question : show(p.decisionId, 60);
      const option = d?.options.find((o) => o.id === p.chosen)?.label ?? show(p.chosen, 60);
      const rationale = str(p.rationale);
      return { headline: `${who} decided "${question}": ${option}`, detail: rationale || null };
    }
    case "intake.completed": {
      const cards = Array.isArray(p.cards) ? p.cards : [];
      const created = cards.filter((c) => isRecord(c) && c.outcome === "created").length;
      const summary = str(p.summary);
      return { headline: `${who} approved the plan (${plural(created, "card")} added)`, detail: summary || null };
    }
    case "intake.reopened":
      return { headline: `${who} reopened the plan: ${show(p.reason)}` };

    case "gate.blocked": {
      const gates = Array.isArray(p.gates) ? p.gates : [];
      const titles = gates.map((g) => gateTitle(isRecord(g) ? g.gateId : undefined));
      const card = lookup(ctx.cardTitle, cardId);
      const subject = card ? `"${show(card, 120)}"` : "a card";
      return {
        headline: `Moving ${subject} to ${show(cap(p.to), 20)} is blocked by ${titles.join(", ") || "a readiness gate"}`,
        attention: true,
      };
    }
    case "gate.signed_off":
      return { headline: `${who} signed off "${gateTitle(p.gateId)}" for ${cardRef(cardId, ctx)}` };
    case "gate.waived":
      return {
        headline: `${who} waived "${gateTitle(p.gateId)}" for ${cardRef(cardId, ctx)}: ${show(p.reason)}`,
        attention: true,
      };

    default:
      return { headline: `${who} recorded ${show(e.type, 80)}` };
  }
}

/** A plain-language account of one ledger entry. Pure: it reads only its arguments and never throws. */
export function narrate(e: LedgerEntry, ctx: NarrationContext = {}): Narration {
  const p = isRecord(e.payload) ? e.payload : {};
  const type = str(e.type);
  const topic = topicOf(type);
  let refs: NarrationRefs = {};
  let told: Told;
  try {
    refs = refsOf(p);
    told = tell(e, p, ctx);
  } catch {
    const actor: Actor = isRecord(e.actor) ? { kind: e.actor.kind, id: str(e.actor.id) } : { kind: "system", id: "" };
    told = { headline: `${actorName(actor, "The agent")} recorded ${show(type, 80)}` };
  }
  return {
    headline: capHeadline(told.headline),
    detail: told.detail ?? null,
    topic,
    attention: told.attention ?? false,
    refs,
  };
}
