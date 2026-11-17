/**
 * Plain-language narration of ledger entries and agent actions, built from fixed templates.
 *
 * Pure: it reads only its arguments and adds nothing that is not in the entry or the context.
 *
 * Headlines are safe to show as they are: payload text in them is clipped, with hidden, bidi and control
 * characters shown as escapes, and quotes and backslashes in commands escaped. Each piece of free text gets the
 * room left after the fixed words, so the end of a line (a closing quote, "(and n more lines)", a cost) always
 * survives the 200-character cap.
 *
 * Details are NOT made safe: `detail` carries the raw recorded text (a message, a prompt, an output, an answer,
 * a rationale, an error or the input JSON). A UI must render it through `visibleControls` (or an equivalent)
 * before showing it.
 */
import type { ActionKind, AgentAction } from "./agents.js";
import { KIND_LABELS } from "./connections.js";
import type { Actor, LedgerEntry } from "./domain.js";
import { GATES, requirementLabel, type GateId, type GateRequirement } from "./gates.js";
import { INTAKE_DECISIONS, INTAKE_QUESTIONS, renderAnswer, type IntakeAnswer } from "./intake.js";
import { CHANGES_REFUSED_PHRASES, MIRRORABLE_TYPES } from "./link.js";
import { OWNER_ID, ROLE_LABELS, type Role } from "./people.js";
import { DEVICES, failureSentence, type PreviewFailure } from "./preview.js";
import { formatUsd, lowerFirst, plural, visibleControls } from "./text.js";

export type NarrationTopic =
  | "board" | "agent" | "decision" | "gate" | "intake" | "connection" | "settings" | "override" | "machine" | "share" | "people"
  | "preview" | "remote" | "other";
export type NarrationRefs = {
  cardId?: string;
  runId?: string;
  actionId?: string;
  connectionId?: string;
  intakeId?: string;
  gateId?: GateId;
  overrideId?: string;
  machineId?: string;
  shareId?: string;
  linkId?: string;
};
export type Narration = { headline: string; detail: string | null; topic: NarrationTopic; attention: boolean; refs: NarrationRefs };
/**
 * What the caller knows beyond the entry: a card's title, a run's adapter, a linked machine's name, a person's
 * name. Nothing else.
 */
export type NarrationContext = {
  cardTitle?: (cardId: string) => string | undefined;
  adapterName?: (runId: string) => string | undefined;
  machineName?: (machineId: string) => string | undefined;
  personName?: (personId: string) => string | undefined;
};
export type ActionLike = Pick<AgentAction, "kind" | "tool" | "summary" | "input">;

const HEADLINE_MAX = 200;
/** The longest a person's name is shown in a headline (a name is at most 60 characters; escapes count). */
const NAME_MAX = 60;
/**
 * The longest headline the templates build. The blind cap in `capHeadline` gives exactly HEADLINE_MAX
 * characters, so a headline that stays under it never had its fixed words cut.
 */
const FIT = HEADLINE_MAX - 1;

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

/**
 * Text for a headline, with hidden characters shown as escapes (and, when `quoted`, `"` and `\` escaped), clipped to
 * at most `max` characters AFTER escaping, plus `…` when cut. An escape is never cut in half.
 */
function clipVisible(s: string, max: number, quoted = false, oneLine = false): string {
  let out = "";
  for (const c of s) {
    const unit =
      quoted && (c === '"' || c === "\\") ? `\\${c}` : oneLine && (c === "\n" || c === "\t") ? ONE_LINE[c]! : visibleControls(c);
    if (out.length + unit.length > max) return `${out}…`;
    out += unit;
  }
  return out;
}

const ONE_LINE: Record<string, string> = { "\n": "\\n", "\t": "\\t" };

/** A payload value as headline text (see `clipVisible`). */
const show = (v: unknown, max: number, quoted = false): string => clipVisible(str(v), max, quoted);

/** A person's name as headline text: as `show`, and on one line, with line breaks and tabs shown as escapes too. */
const showName = (v: unknown, quoted = false): string => clipVisible(str(v), NAME_MAX, quoted, true);

/**
 * `before` + the free text + `after`, the free text clipped to `max` and to the room the fixed words leave under the
 * cap, so `after` always survives.
 */
function fit(before: string, v: unknown, after = "", max = HEADLINE_MAX): string {
  const room = Math.max(0, Math.min(max, FIT - before.length - after.length - 1));
  return `${before}${show(v, room)}${after}`;
}

const cap = (v: unknown): string => {
  const t = str(v);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** An adapter's display name (`Claude`, `Fake`), or the recorded id clipped and capitalised. */
export const adapterLabel = (v: unknown): string => own(ADAPTER_LABELS, v) ?? show(cap(v), 20);

function lookup<T>(fn: ((key: string) => T | undefined) | undefined, key: string | undefined): T | undefined {
  return fn && key !== undefined ? fn(key) : undefined;
}

/**
 * Who an actor is, in words: a person by the name the context knows (shown inert), else the Owner's fixed word for
 * the Owner and `Someone` for anyone else, never a raw id; `agent` for an agent; `Policy` or `The workspace` for the system.
 */
export function actorName(a: Actor, ctx: NarrationContext = {}, agent = "The agent"): string {
  if (a.kind === "system") return a.id === "policy" ? "Policy" : "The workspace";
  if (a.kind === "agent") return agent;
  let name: string | undefined;
  try {
    const found = lookup(ctx.personName, typeof a.id === "string" ? a.id : undefined);
    name = typeof found === "string" ? showName(found) : undefined;
  } catch {
    // A context that throws names nobody.
  }
  if (name) return name;
  return a.id === OWNER_ID ? "Owner" : "Someone";
}

/** A person named by id in a payload, as `actorName` names a human. */
const personRef = (personId: unknown, ctx: NarrationContext): string => actorName({ kind: "human", id: str(personId) }, ctx);

/** A role in lower case, as a headline says it (`a reviewer`). */
const roleWord = (v: unknown): string => {
  const label = own<string>(ROLE_LABELS as Record<Role, string>, v);
  return label ? label.toLowerCase() : show(v, 20);
};
const article = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

const TLS_LABELS: Record<string, string> = {
  self_signed: "self-signed",
  acme: "Let's Encrypt",
  provided: "own certificate files",
};

/** A recorded gate requirement, as narration can read it from a payload, or undefined. */
function requirementOf(v: unknown): GateRequirement | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.personId === "string") return { personId: v.personId };
  if (own(ROLE_LABELS as Record<Role, string>, v.role)) return { role: v.role as Role };
  return undefined;
}

function agentName(runId: string | undefined, ctx: NarrationContext): string {
  const name = lookup(ctx.adapterName, runId);
  return name ? `The ${own(ADAPTER_LABELS, name) ?? show(name, 20)} agent` : "The agent";
}

/** `"<title>"` when the context knows the card, else `a card`. */
function cardRef(cardId: string | undefined, ctx: NarrationContext): string {
  const title = lookup(ctx.cardTitle, cardId);
  return title ? `"${show(title, 80)}"` : "a card";
}

function lineCount(output: string): number {
  if (output.length === 0) return 0;
  return output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

const firstLine = (s: string): string => s.split(/\r?\n/)[0] ?? "";

const gateTitle = (id: unknown): string => GATES.find((g) => g.id === id)?.title ?? show(id, 30);

const FAILURE_KNOWN: Record<PreviewFailure, true> = {
  timed_out: true, exited: true, install_failed: true, build_failed: true,
  boot_failed: true, install_app_failed: true, launch_failed: true, start_failed: true,
};

function topicOf(type: string): NarrationTopic {
  if (type === "agent.action.decided") return "decision";
  const prefix = type.split(".")[0];
  switch (prefix) {
    case "card":
    case "project":
      return "board";
    case "agent":
    case "run":
      return "agent";
    case "preview":
      return "preview";
    case "gate":
      return "gate";
    case "intake":
      return "intake";
    case "connection":
      return "connection";
    case "settings":
      return "settings";
    case "override":
      return "override";
    case "machine":
    case "link":
      return "machine";
    case "share":
      return "share";
    case "person":
      return "people";
    case "remote":
      return "remote";
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
  const overrideId = idOf(p.overrideId);
  const machineId = idOf(p.machineId);
  const shareId = idOf(p.shareId);
  const linkId = idOf(p.linkId);
  const gates = Array.isArray(p.gates) ? p.gates : [];
  const gateId = idOf(p.gateId) ?? (isRecord(gates[0]) ? idOf(gates[0].gateId) : undefined);
  if (cardId) refs.cardId = cardId;
  if (runId) refs.runId = runId;
  if (actionId) refs.actionId = actionId;
  if (connectionId) refs.connectionId = connectionId;
  if (intakeId) refs.intakeId = intakeId;
  if (overrideId) refs.overrideId = overrideId;
  if (machineId) refs.machineId = machineId;
  if (shareId) refs.shareId = shareId;
  if (linkId) refs.linkId = linkId;
  if (gateId && GATES.some((g) => g.id === gateId)) refs.gateId = gateId as GateId;
  return refs;
}

const TARGET_KEYS = ["path", "file_path", "filePath", "command", "url"] as const;
/** A shell action names its command first, even when its input also carries a path. */
const SHELL_TARGET_KEYS = ["command", "path", "file_path", "filePath", "url"] as const;

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
    const size = typeof input.totalChars === "number" ? ` (${show(input.totalChars, 20)} characters)` : "";
    if (a.kind === "shell" && a.tool === "codex.stdin") {
      return `type something too long to show in full${size} into the running command`;
    }
    const what = a.kind === "shell" ? "a command" : "something";
    return `${own(VERBS, a.kind) ?? "use"} ${what} too long to show in full${size}`;
  }

  if (a.kind === "shell" && a.tool === "codex.stdin") {
    return `type "${show(input.reason, 80, true)}" into the running command`;
  }

  const keys = a.kind === "shell" ? SHELL_TARGET_KEYS : TARGET_KEYS;
  const raw = keys.map((k) => input[k]).find((v): v is string => typeof v === "string");
  if (a.kind === "shell") {
    if (raw === undefined) return `run the command "${show(a.summary, 100, true)}"`;
    const lines = raw.split(/\r?\n/);
    const more = lines.length > 1 ? ` (and ${plural(lines.length - 1, "more line")})` : "";
    return `run the command "${show(lines[0], 100, true)}"${more}`;
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

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const sizeText = (b: number): string =>
  b < 1024 ? plural(b, "byte") : b < 1_048_576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1_048_576).toFixed(1)} MB`;

type Told = { headline: string; detail?: string | null; attention?: boolean };

function tell(e: LedgerEntry, p: Payload, ctx: NarrationContext): Told {
  const runId = idOf(p.runId) ?? (e.actor.kind === "agent" ? e.actor.id : undefined);
  const agent = agentName(runId, ctx);
  const who = actorName(e.actor, ctx, agent);
  const cardId = idOf(p.cardId);
  const stage = (v: unknown) => show(cap(v), 20);
  /** The card's title in curly quotes, else `a card`. */
  const board = (id: string | undefined) => {
    const title = lookup(ctx.cardTitle, id);
    return title ? `\u201c${show(title, 80)}\u201d` : "a card";
  };
  /** The run's agent by adapter name, or undefined when the context does not know the run. */
  const knownAgent = (id: string | undefined): string | undefined => {
    const name = lookup(ctx.adapterName, id);
    return name ? (own(ADAPTER_LABELS, name) ?? show(name, 20)) : undefined;
  };
  const claude = (id: string | undefined) => knownAgent(id) ?? "The agent";
  /** The first eight characters of a run id, as 5B wrote them. */
  const run8 = () => `Agent ${show(str(p.runId).slice(0, 8), 16)}`;

  switch (e.type) {
    case "project.created":
      return { headline: fit(`${who} created the project "`, p.name, `"`, 120) };
    case "card.created":
      return { headline: `${who} added "${show(p.title, 120)}" to ${stage(p.stage)}` };
    case "card.moved":
      return { headline: `${who} moved ${cardRef(cardId, ctx)} from ${stage(p.from)} to ${stage(p.to)}` };
    case "card.status_changed":
      return { headline: `${who} marked ${cardRef(cardId, ctx)} ${show(p.to, 20)}` };

    case "card.run_linked":
      return { headline: `${claude(runId)} took on ${board(cardId)}` };
    case "card.comment":
      return { headline: `${who} left a note on ${board(cardId)}` };
    case "card.comments_given": {
      const count = Array.isArray(p.commentIds) ? p.commentIds.length : 0;
      // The run's own agent, as the other board lines say it; "the agent" when the run is not known.
      const to = knownAgent(runId) ?? "the agent";
      return {
        headline:
          count === 1
            ? `1 note on ${board(cardId)} was given to ${to}`
            : `${count} notes on ${board(cardId)} were given to ${to}`,
      };
    }
    case "card.comments_read":
      return { headline: `${claude(runId)} read the notes on ${board(cardId)}` };
    case "card.move_requested":
      return { headline: `${claude(runId)} wants to move ${board(cardId)} to ${stage(p.to)}` };
    case "card.move_declined":
      return { headline: `${who} said not yet to moving ${board(cardId)} to ${stage(p.to)}` };

    case "preview.offered": {
      const what = p.kind === "ios" ? "an iPhone app" : p.kind === "android" ? "an Android app" : "a website";
      return { headline: `${claude(runId)} offered ${what} preview` };
    }
    case "preview.requested": {
      const first = Array.isArray(p.commands) && Array.isArray(p.commands[0]) ? p.commands[0].map((x) => str(x)).join(" ") : "";
      const what = p.kind === "ios" ? "iPhone app" : p.kind === "android" ? "Android app" : "website";
      return { headline: `${who} confirmed starting the ${what} preview: ${show(first, 80)}` };
    }
    // A preview's later entries do not say its kind, so these lines fit a website and a phone app alike.
    case "preview.started":
      return { headline: "Started the preview" };
    case "preview.progress": {
      const steps = Array.isArray(p.steps) ? p.steps.length : 0;
      const done = Array.isArray(p.done) ? p.done.length : 0;
      return { headline: `Preview: step ${done} of ${steps} done` };
    }
    case "preview.ready":
      return { headline: "The preview is ready" };
    case "preview.failed":
      return { headline: own(FAILURE_KNOWN, p.reason) ? failureSentence(p.reason as PreviewFailure, null) : "The preview failed", attention: true };
    case "preview.stopped": {
      const note = p.reason === "idle" ? " (idle for 30 minutes)" : p.reason === "restarted" ? " (The Terminal restarted)" : "";
      return { headline: `The preview stopped${note}` };
    }
    case "preview.screenshot": {
      const dev = own(DEVICES as Record<string, { label: string }>, str(p.device));
      return { headline: `${who} took a screenshot on ${dev ? dev.label : show(p.device, 40)}` };
    }

    case "agent.started": {
      const adapter = adapterLabel(p.adapter);
      const title = lookup(ctx.cardTitle, cardId);
      const prompt = str(p.prompt);
      const headline = title
        ? `${who} started a ${adapter} agent on "${show(title, 80)}"`
        : fit(`${who} started a ${adapter} agent: "`, prompt, `"`, 80);
      return { headline, detail: prompt || null };
    }
    case "agent.message": {
      const text = str(p.text);
      return { headline: fit(`${agent} said: "`, text, `"`, 120), detail: text || null };
    }
    case "agent.progress": {
      const steps = Array.isArray(p.steps) ? p.steps : [];
      const done = Array.isArray(p.done) ? p.done.filter((d): d is number => typeof d === "number") : [];
      const current = typeof p.current === "number" ? p.current : null;
      const name = lookup(ctx.adapterName, runId);
      const label = name ? adapterLabel(name) : "The agent";
      const finished = current === null;
      const n = finished ? Math.max(0, ...done) : current;
      if (n < 1) return { headline: `${label} made a plan of ${plural(steps.length, "step")}` };
      return {
        headline: fit(`${label} ${finished ? "finished" : "started"} step ${n} of ${steps.length}: "`, steps[n - 1], `"`, 120),
      };
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
      const reason = str(p.reason);
      if (p.decision !== "allow" && p.decision !== "deny") {
        return { headline: reason ? fit(`${who} decided something: `, reason, "", 150) : `${who} decided something` };
      }
      const allowed = p.decision === "allow";
      const byPolicy = p.by === "policy" || (p.by !== "human" && e.actor.kind !== "human");
      if (byPolicy) {
        const lead = allowed ? "Allowed automatically" : "Stopped automatically";
        return { headline: reason ? fit(`${lead}: `, reason, "", 150) : lead };
      }
      if (allowed) return { headline: `${who} allowed it` };
      return { headline: reason ? fit(`${who} denied it: `, reason, "", 150) : `${who} denied it: no reason given` };
    }
    case "agent.action.completed": {
      const output = str(p.output);
      const detail = output || null;
      if (p.ok === true) return { headline: `Done (${plural(lineCount(output), "line")} of output)`, detail };
      if (p.ok !== false) return { headline: "Finished with an unknown result", detail };
      const first = firstLine(output);
      return { headline: first ? fit("It failed: ", first, "", 80) : "It failed", detail };
    }
    case "agent.finished": {
      const cost =
        typeof p.costUsd === "number" && Number.isFinite(p.costUsd) ? ` · cost ${show(formatUsd(p.costUsd), 30)} (estimate)` : "";
      if (p.status === "failed") {
        const error = str(p.error);
        return {
          headline: error ? fit(`${agent} failed: `, error, cost, 120) : `${agent} failed${cost}`,
          detail: error || null,
          attention: true,
        };
      }
      if (p.status === "stopped") return { headline: `${agent} was stopped${cost}` };
      if (p.status === "completed") return { headline: `${agent} finished${cost}` };
      return { headline: `${agent} finished with an unknown result${cost}` };
    }
    case "agent.rate_limited": {
      const retry = typeof p.retryAfterS === "number" ? `; retry after ${show(p.retryAfterS, 20)} s` : "";
      return { headline: `${run8()} was rate-limited by the provider${retry}` };
    }

    case "settings.claude_auth_changed":
      if (p.mode === "api_key") return { headline: `${who} set Claude to use API key` };
      if (p.mode === "subscription") return { headline: `${who} set Claude to use own subscription` };
      return { headline: `${who} changed how Claude signs in` };
    case "settings.provider_auth_changed": {
      const provider = stage(p.provider);
      const how = own<string>(
        { api_key: "API key", subscription: "own subscription", chatgpt: "own ChatGPT plan", google: "own Google account" },
        p.mode,
      );
      return { headline: how ? `${who} set ${provider} to use ${how}` : `${who} changed how ${provider} signs in` };
    }

    case "connection.added": {
      const kind = own<string>(KIND_LABELS, p.kind) ?? show(p.kind, 40);
      return { headline: `${who} connected "${show(p.name, 100)}" (${kind})` };
    }
    case "connection.updated": {
      const c = isRecord(p.changes) ? p.changes : {};
      const name = show(p.name, 100);
      if (c.enabled === true) return { headline: `${who} enabled "${name}"` };
      if (c.enabled === false) return { headline: `${who} disabled "${name}"` };
      const set = Array.isArray(c.secretsSet) ? c.secretsSet.map(str).filter((s) => s.length > 0) : [];
      if (set.length > 0) return { headline: `${who} replaced the ${show(set.join(", "), 40)} of "${name}"` };
      return { headline: `${who} updated "${name}"` };
    }
    case "connection.removed":
      return { headline: `${who} removed "${show(p.name, 100)}"` };
    case "connection.tested": {
      const name = show(p.name, 100);
      if (p.ok === true) return { headline: `"${name}" connected` };
      if (p.ok === false) return { headline: fit(`"${name}" failed to connect: `, p.message, "", 200) };
      return { headline: `Testing "${name}" finished with an unknown result` };
    }
    case "connection.signin": {
      const provider = stage(p.provider);
      if (p.ok === true) return { headline: `${who} signed in to ${provider}` };
      if (p.ok === false) return { headline: `Sign-in to ${provider} failed` };
      return { headline: `Sign-in to ${provider} finished with an unknown result` };
    }
    case "connection.used": {
      const name = show(p.name, 100);
      if (p.purpose === "mcp_server") return { headline: `${run8()} was given the MCP server "${name}"` };
      if (p.purpose === "cloud_credentials") {
        const label = own(CREDENTIAL_LABELS, p.credential) ?? "cloud credentials";
        return { headline: `${run8()} was given ${label} from "${name}"` };
      }
      if (p.purpose === "local_model") return { headline: `${run8()} was given the local model "${name}"` };
      return { headline: `${run8()} was given access to "${name}"` };
    }

    case "intake.started": {
      const idea = str(p.idea);
      return { headline: fit(`${who} described the idea: "`, idea, `"`, 80), detail: idea || null };
    }
    case "intake.answered": {
      const q = INTAKE_QUESTIONS.find((x) => x.id === p.questionId);
      const label = q ? q.label : show(p.questionId, 60);
      const a = p.answer;
      const valid = typeof a === "string" || typeof a === "number" || (Array.isArray(a) && a.every((x) => typeof x === "string"));
      const rendered = !valid ? "" : q ? renderAnswer(q, a as IntakeAnswer) : Array.isArray(a) ? a.join(", ") : str(a);
      return { headline: fit(`${who} answered "${label}": `, rendered, "", 120), detail: rendered || null };
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
      return { headline: fit(`${who} reopened the plan: `, p.reason) };

    case "gate.blocked": {
      const gates = Array.isArray(p.gates) ? p.gates : [];
      const titles = gates.map((g) => gateTitle(isRecord(g) ? g.gateId : undefined)).join(", ") || "a readiness gate";
      const card = lookup(ctx.cardTitle, cardId);
      const subject = card ? `"${show(card, 50)}"` : "a card";
      return { headline: fit(`Moving ${subject} to ${stage(p.to)} is blocked by `, titles), attention: true };
    }
    case "gate.signed_off":
      return { headline: `${who} signed off "${gateTitle(p.gateId)}" for ${cardRef(cardId, ctx)}` };
    case "gate.waived":
      return {
        headline: fit(`${who} waived "${gateTitle(p.gateId)}" for ${cardRef(cardId, ctx)}: `, p.reason),
        attention: true,
      };

    case "override.command": {
      const args = Array.isArray(p.args) ? p.args.map(str) : [];
      const shown = clipVisible([str(p.program), ...args].join(" "), 80, true);
      return {
        headline: fit(`OVERRIDE: ${who} ran "${shown}" in ${lowerFirst(agent)}'s working copy: `, p.reason),
        detail: json({ program: p.program, args: p.args, cwd: p.cwd }),
        attention: true,
      };
    }
    case "override.discard":
      return {
        headline: fit(`OVERRIDE: ${who} discarded ${show(p.files, 20)} changed file(s) of ${lowerFirst(agent)}'s run: `, p.reason),
        attention: true,
      };
    case "override.completed": {
      const output = str(p.output);
      const detail = output || null;
      if (p.timedOut === true) return { headline: "Override killed after 10 minutes", detail, attention: true };
      if (p.ok === true) return { headline: `Override finished (exit ${show(p.exitCode, 20)})`, detail, attention: true };
      const how =
        typeof p.exitCode === "number" ? `exit ${show(p.exitCode, 20)}` : typeof p.signal === "string" && p.signal !== "" ? `signal ${show(p.signal, 20)}` : "exit unknown";
      return { headline: `Override failed (${how})`, detail, attention: true };
    }

    case "machine.identity_created": {
      const groups = str(p.fingerprint).slice(0, 16).match(/.{1,4}/g);
      return { headline: groups ? `This computer got its identity (${show(groups.join(" "), 20)})` : "This computer got its identity" };
    }
    case "machine.named":
      return { headline: fit(`${who} named this computer "`, p.name, `"`, 40) };
    case "machine.linking_enabled": {
      const port = str(p.port) ? ` (port ${show(p.port, 10)})` : "";
      return { headline: `${who} allowed other computers on the local network to link with this one${port}`, attention: true };
    }
    case "machine.linking_disabled":
      return { headline: `${who} stopped linking` };
    case "machine.paired": {
      const fp = str(p.fingerprint).slice(0, 16);
      return { headline: `${who} linked "${show(p.name, 40)}"${fp ? ` (${show(fp, 16)})` : ""}` };
    }
    case "machine.unpaired":
      return { headline: `${who} unlinked "${show(p.name, 40)}"` };
    case "link.run_requested": {
      const prompt = str(p.prompt);
      return {
        headline: fit(`${who} asked ${machine(p, ctx)} to run a ${adapterLabel(p.adapter)} agent: "`, prompt, `"`, 80),
        detail: prompt || null,
      };
    }
    case "link.run_failed":
      // Fixed words only: the recorded error may have come from the other machine.
      return { headline: runFailed(str(p.error), machine(p, ctx)), attention: true };
    case "link.changes_refused": {
      const reason = str(p.reason);
      const why = Object.prototype.hasOwnProperty.call(CHANGES_REFUSED_PHRASES, reason)
        ? CHANGES_REFUSED_PHRASES[reason as keyof typeof CHANGES_REFUSED_PHRASES]
        : null;
      return { headline: `The changes from ${machine(p, ctx)} were refused${why ? `: ${why}` : ""}`, attention: true };
    }
    case "link.project_received":
      return { headline: `Received the project "${show(p.name, 120)}" from ${machine(p, ctx)}` };
    case "link.run_accepted":
      return { headline: `Accepted a run from ${machine(p, ctx)}` };
    case "link.decision_received": {
      // Recorded by the system: the decision is the other machine's Owner's, so this machine's names do not apply.
      const decider = e.actor.kind === "human" ? who : actorName({ kind: "human", id: OWNER_ID });
      const what = p.decision === "allow" ? "allowed" : p.decision === "deny" ? "denied" : "unknown";
      return { headline: `${decider}'s decision arrived from ${machine(p, ctx)}: ${what}` };
    }
    case "link.changes_imported":
      return { headline: `The run's changes arrived from ${machine(p, ctx)}` };
    case "project.files_imported": {
      const from = own<string>({ github: "from GitHub", folder: "from a folder", files: "to the project" }, p.from) ?? "to the project";
      const files = num(p.files);
      return { headline: `${who} added ${plural(files, "file")} (${sizeText(num(p.bytes))}) ${from}` };
    }
    case "project.source_set":
      return {
        headline:
          p.kind === "github"
            ? fit(`${who} linked the project to GitHub: `, p.repo, "", 120)
            : `${who} linked the project to a folder on this computer`,
      };
    case "run.accepted":
      return { headline: `${who} accepted the changes of ${agent}` };
    case "project.folder_applied": {
      const skipped = num(p.skipped);
      return {
        headline: `${who} applied ${plural(num(p.written) + num(p.deleted), "file")} to the folder${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
      };
    }
    case "project.published":
      return { headline: `${who} opened a pull request on GitHub` };
    case "share.confirmed": {
      const sections = Array.isArray(p.sections) ? p.sections.length : 0;
      return {
        headline: `${who} confirmed a share page (${plural(sections, "section")}, ${show(p.bytes, 20)} bytes)`,
        detail: isRecord(p.options) ? JSON.stringify(p.options) : null,
      };
    }
    case "share.link_created": {
      const where = own<string>({ this_computer: "this computer only", local_network: "the local network" }, p.scope);
      return {
        headline: `${who} created a share link for ${where ?? "an unknown scope"}, valid until ${show(p.expiresAt, 40)}`,
        attention: true,
      };
    }
    case "share.revoked":
      if (p.reason === "too_many_failures") {
        return { headline: "A share link was revoked after too many wrong attempts", attention: true };
      }
      if (p.reason === "owner") return { headline: `${who} revoked a share link` };
      return { headline: "A share link was revoked" };
    case "share.expired":
      return { headline: "A share link expired" };
    case "share.stopped": {
      const how = own<string>({ shutdown: "closed", restart: "restarted" }, p.reason);
      return { headline: how ? `A share link stopped: The Terminal ${how}` : "A share link stopped" };
    }

    case "person.invited":
      return { headline: `${who} invited ${article(roleWord(p.role))}` };
    case "person.invite_revoked":
      return { headline: `${who} revoked an invitation` };
    case "person.joined":
      return { headline: `${showName(p.name) || "Someone"} joined as ${roleWord(p.role)}` };
    case "person.credential_added": {
      const c = isRecord(p.credential) ? p.credential : {};
      const kind = c.kind === "passkey" ? "passkey" : c.kind === "key" ? "key" : "credential";
      return { headline: `${who} added a ${kind} ("${clipVisible(str(c.label), 60, true, true)}")` };
    }
    case "person.credential_removed":
      return { headline: `${who} removed a credential` };
    case "person.renamed":
      return { headline: `${who} is now called "${showName(p.name, true)}"` };
    case "person.role_changed":
      return { headline: `${who} made ${personRef(p.personId, ctx)} ${article(roleWord(p.to))}` };
    case "person.removed":
      return { headline: `${who} removed ${personRef(p.personId, ctx)}` };
    case "person.signed_in": {
      const where = p.listener === "remote" ? "remotely" : p.listener === "local" ? "locally" : "";
      return { headline: `${personRef(p.personId, ctx)} signed in${where ? ` ${where}` : ""}` };
    }
    case "person.locked":
      return {
        headline: `${personRef(p.personId, ctx)} was locked out after ${show(p.failures, 10)} failed sign-ins`,
        attention: true,
      };

    case "remote.enabled": {
      const where = typeof p.domain === "string" && p.domain ? show(p.domain, 80) : "this machine's addresses";
      return { headline: `${who} turned remote access on (${where}, port ${show(p.port, 10)})`, attention: true };
    }
    case "remote.disabled":
      return { headline: `${who} turned remote access off` };
    case "remote.certificate_changed": {
      const how = own(TLS_LABELS, p.tls) ?? show(p.tls, 20);
      return { headline: `The remote certificate changed (${how}, fingerprint ${show(str(p.fingerprint).slice(0, 8), 8)}…)` };
    }

    case "gate.requirement_set": {
      const before = `${who} set who may sign "${gateTitle(p.gateId)}"`;
      if (p.requirement === null) return { headline: `${before} back to the default` };
      const req = requirementOf(p.requirement);
      return { headline: req ? `${before}: ${requirementLabel(req, (id) => personRef(id, ctx))}` : before };
    }

    default:
      return { headline: `${who} recorded ${show(e.type, 80)}` };
  }
}

/** Codes recorded when a remote run never started: this computer's own, and the worker's start refusals. */
const START_CODES = new Set([
  "unreachable", "not_sent", "machine_bad_reply", "upload_refused", "invalid_input", "not_found", "no_repo", "bundle_invalid",
  "bundle_git_limit", "repo_too_large", "upload_limit", "connection_disabled", "connection_unsupported", "mcp_unsupported",
  "local_model_unsupported", "duplicate_mcp_server", "duplicate_cloud_provider", "cloud_credentials_failed", "keychain_unavailable",
  "identity_unavailable", "shutting_down", "read_only", "internal", "unknown",
]);
/** Refusals of a frame a correct machine never sends (the requester's FATAL_REFUSALS, and a frame of another run). */
const FRAME_REFUSALS = new Set([
  "bad_signature", "wrong_run", "wrong_project", "foreign_action", "invalid_payload", "not_mirrorable", "too_large", "invalid_frame",
  "wrong_worktree", "wrong_card",
]);

/** Why a remote run failed, in fixed words chosen by its recorded code; the code itself is never shown. */
function runFailed(error: string, where: string): string {
  if (START_CODES.has(error)) return `${cap(where)} could not start the run`;
  const on = `The run on ${where}`;
  if (FRAME_REFUSALS.has(error)) return `${on} stopped: signature check failed`;
  if (error === "machine_unpaired") return `${on} stopped: the machine was unlinked`;
  if (error === "conflict") return `${on} stopped: its entries clash with records here`;
  if (error === "machine_key_mismatch") return `${on} stopped: the machine's key changed`;
  if (error.startsWith("remote_")) return `${on} stopped: the machine refused`;
  return `${on} failed`;
}

/** The linked machine an entry names, as the context knows it, else `a linked machine`. */
function machine(p: Payload, ctx: NarrationContext): string {
  const name = lookup(ctx.machineName, idOf(p.machineId));
  return name ? show(name, 40) : "a linked machine";
}

const MIRRORED: readonly string[] = MIRRORABLE_TYPES;

/**
 * A `link.mirrored` entry, narrated as the worker's own entry it carries, prefixed with the machine it ran on: the
 * inner narration's detail, topic and attention, and its refs plus `machineId`.
 */
function narrateMirrored(p: Payload, ctx: NarrationContext): Narration {
  const machineId = idOf(p.machineId);
  const refs: NarrationRefs = machineId ? { machineId } : {};
  let where = "a linked machine";
  try {
    where = machine(p, ctx);
  } catch {
    // A context that throws names no machine.
  }
  const o = p.origin;
  if (!isRecord(o) || !MIRRORED.includes(str(o.type))) {
    return { headline: `${cap(where)} sent an entry that could not be read`, detail: null, topic: "machine", attention: false, refs };
  }
  const actor: Actor = isRecord(o.actor) ? { kind: o.actor.kind as Actor["kind"], id: str(o.actor.id) } : { kind: "system", id: "" };
  const inner = narrate(
    {
      seq: typeof o.seq === "number" ? o.seq : 0,
      id: str(o.id),
      ts: str(o.ts),
      projectId: typeof o.projectId === "string" ? o.projectId : null,
      actor,
      type: str(o.type) as LedgerEntry["type"],
      payload: o.payload,
      prevHash: str(o.prevHash),
      hash: str(o.hash),
    },
    ctx,
  );
  const before = `On ${where}: `;
  const room = Math.max(0, FIT - before.length - 1);
  const chars = [...inner.headline];
  const headline = chars.length > room ? `${before}${chars.slice(0, room).join("")}…` : `${before}${inner.headline}`;
  return { headline: capHeadline(headline), detail: inner.detail, topic: inner.topic, attention: inner.attention, refs: { ...inner.refs, ...refs } };
}

/** A plain-language account of one ledger entry. Pure: it reads only its arguments and never throws. */
export function narrate(e: LedgerEntry, ctx: NarrationContext = {}): Narration {
  const p = isRecord(e.payload) ? e.payload : {};
  const type = str(e.type);
  if (type === "link.mirrored") return narrateMirrored(p, ctx);
  const topic = topicOf(type);
  let refs: NarrationRefs = {};
  let told: Told;
  try {
    refs = refsOf(p);
    told = tell(e, p, ctx);
  } catch {
    const actor: Actor = isRecord(e.actor) ? { kind: e.actor.kind, id: str(e.actor.id) } : { kind: "system", id: "" };
    told = { headline: `${actorName(actor, ctx)} recorded ${show(type, 80)}` };
  }
  return {
    headline: capHeadline(told.headline),
    detail: told.detail ?? null,
    topic,
    attention: told.attention ?? false,
    refs,
  };
}
