/**
 * The Learn catalog: short plain-English explanations the workspace shows next to what they explain. Each topic
 * says what the thing is, why The Terminal does it that way and what the Owner should look at. Pure data.
 */
import { ACTION_KINDS, type ActionKind } from "./agents.js";
import type { Stage } from "./domain.js";
import { GATE_IDS, type GateId } from "./gates.js";

export const LEARN_SECTIONS = ["lifecycle", "agents", "deciding", "code", "connections"] as const;
export type LearnSection = (typeof LEARN_SECTIONS)[number];
export const LEARN_SECTION_LABELS: Record<LearnSection, string> = {
  lifecycle: "The lifecycle",
  agents: "Working with agents",
  deciding: "Deciding and gates",
  code: "Your code and changes",
  connections: "Connections and capacity",
};

export type LearnTopic = {
  id: string;
  section: LearnSection;
  title: string;
  body: string;
  appliesTo: { views?: string[]; stages?: Stage[]; actionKinds?: ActionKind[]; gateIds?: GateId[] };
};
export type LearnContext = { view?: string; stage?: Stage; actionKind?: ActionKind; gateId?: GateId };

const AGENT_VIEWS = ["agents", "board"];
const DECIDING_VIEWS = ["needs_you", "ledger"];
const CODE_VIEWS = ["changes"];
const CONNECTION_VIEWS = ["connections", "capacity", "github"];

export const LEARN_TOPICS: readonly LearnTopic[] = [
  {
    id: "stage_plan",
    section: "lifecycle",
    title: "Plan",
    body: "Plan is where an idea becomes a short list of cards you agree with. The intake asks a few questions and records your answers and decisions, so later work can point back to why it exists. Look at whether each card is something you would actually ask for, and approve the plan only when it says what you mean.",
    appliesTo: { stages: ["plan"] },
  },
  {
    id: "stage_design",
    section: "lifecycle",
    title: "Design",
    body: "Design is where a card is worked out before code is written: what it looks like, what it touches and what could go wrong. Doing this first keeps agents from guessing at choices that are yours to make. Look for open questions and decide them here, while changing your mind is still cheap.",
    appliesTo: { stages: ["design"] },
  },
  {
    id: "stage_build",
    section: "lifecycle",
    title: "Build",
    body: "Build is where agents write code, each in its own working copy, asking before every action that is not allowed automatically. Keeping the work separate means nothing reaches your project until you choose. Look at the changes each run made, and at anything waiting in Needs you.",
    appliesTo: { stages: ["build"] },
  },
  {
    id: "stage_ship",
    section: "lifecycle",
    title: "Ship",
    body: "Ship is where finished work is checked before it goes out. Readiness gates stand in the way of moving a card here until their conditions are met or you sign off, because shipping is hard to undo. Look at each gate's conditions and risks before you sign off or waive one.",
    appliesTo: { stages: ["ship"] },
  },
  {
    id: "stage_operate",
    section: "lifecycle",
    title: "Operate",
    body: "Operate is where the work is live and people depend on it. Going live has its own gate, since mistakes now reach real users. Look at what is running, what it costs and whether anything needs your attention, and keep the ledger as the record of how it got here.",
    appliesTo: { stages: ["operate"] },
  },
  {
    id: "agent_runs",
    section: "agents",
    title: "Agent runs",
    body: "A run is one agent working on one prompt, from start to finish. Every message, request and result is written to the ledger as it happens, so you can see what the agent did and why rather than trusting a summary. Look at the run's feed while it works, and at its changes when it stops.",
    appliesTo: { views: AGENT_VIEWS },
  },
  {
    id: "worktrees",
    section: "agents",
    title: "Working copies",
    body: "Each run works in its own git working copy of your project, a separate folder on a separate branch. Agents never edit your main checkout, so two runs cannot trip over each other and nothing lands until you take it. Look at a run's changes to see exactly what differs from where it started.",
    appliesTo: { views: AGENT_VIEWS },
  },
  {
    id: "approvals",
    section: "agents",
    title: "Approvals",
    body: "Before an agent acts, The Terminal checks the action. Some actions are allowed or stopped automatically by policy; the rest wait for you in Needs you. Asking first is the point: you decide what runs on your computer, not the agent. Look at the exact command or file before you allow it, and give a reason when you deny.",
    appliesTo: { views: AGENT_VIEWS },
  },
  {
    id: "action_kinds",
    section: "agents",
    title: "Kinds of action",
    body: "Every action an agent asks for has a kind: reading a file, creating or replacing one, changing part of one, running a program, fetching from the web, using an MCP tool, or something else. The kind tells you how much an action can do before you read the detail. Look hardest at running programs and web fetches, which can reach beyond the working copy.",
    appliesTo: { views: AGENT_VIEWS, actionKinds: [...ACTION_KINDS] },
  },
  {
    id: "asking_for_changes",
    section: "agents",
    title: "Asking for changes",
    body: "You never edit code yourself in The Terminal; you ask an agent. Start a run with a prompt that says what should change and why, or reply in its conversation. This keeps every change attributable and recorded. Look at the result as a diff, and ask again rather than fixing it by hand.",
    appliesTo: { views: AGENT_VIEWS },
  },
  {
    id: "readiness_gates",
    section: "deciding",
    title: "Readiness gates",
    body: "A readiness gate is a check that stands in the way of moving a card to a later stage, such as an approved plan before building or a review before shipping. Each gate lists its conditions and risks, and some need your sign-off even when every condition is met. Gates exist so that important steps are taken on purpose. Look at what is unmet before signing off.",
    appliesTo: { views: DECIDING_VIEWS, gateIds: GATE_IDS.filter((g) => g !== "over_budget") },
  },
  {
    id: "waivers",
    section: "deciding",
    title: "Waivers",
    body: "A waiver lets a card past a gate whose conditions are not met. It needs a reason of at least ten characters and is recorded as an exception that everyone reading the ledger will see. Waivers exist because rules sometimes do not fit, but they should stay rare. Look at the reasons you gave and whether the unmet condition was ever met later.",
    appliesTo: { views: DECIDING_VIEWS },
  },
  {
    id: "hash_chain",
    section: "deciding",
    title: "The hash chain",
    body: "Every ledger entry carries a hash of its contents together with the hash of the entry before it. Changing or removing an old entry breaks every hash after it, so tampering shows. The ledger is append-only for the same reason: the record of what happened should not change afterwards. Look for an integrity warning, which means the record can no longer be trusted as it stands.",
    appliesTo: { views: DECIDING_VIEWS },
  },
  {
    id: "audit_export",
    section: "deciding",
    title: "Exporting for audit",
    body: "The audit export downloads every ledger entry of a project as one line of JSON each, with its hash chain and a plain-language headline. Someone else can check the chain without running The Terminal. Use it when you need to show what happened, and look at whether the export covers the project and period you mean.",
    appliesTo: { views: DECIDING_VIEWS },
  },
  {
    id: "reading_a_diff",
    section: "code",
    title: "Reading a diff",
    body: "A diff shows what changed in a file. Lines starting with a plus were added and lines starting with a minus were removed; the rest is context. Each block starts with the line numbers it covers in the old and new file. Reading the diff is how you check an agent's work without editing anything. Look at removed lines as carefully as added ones.",
    appliesTo: { views: CODE_VIEWS },
  },
  {
    id: "tracked_and_untracked",
    section: "code",
    title: "Tracked and untracked files",
    body: "A tracked file is one git already knows about, so its changes show as a diff. An untracked file is new and not yet added to git, so it is shown whole, without line counts. Both are changes the agent made in its working copy. Look at untracked files in particular, since they are easy to miss and may hold generated output or secrets.",
    appliesTo: { views: CODE_VIEWS },
  },
  {
    id: "read_only_by_design",
    section: "code",
    title: "Read-only by design",
    body: "The Changes view and the file viewer only read. There is no editor, no save and no upload, because in The Terminal code is written by agents through recorded, approved actions, and never by hand in a side channel. Look, compare and then ask an agent for what you want changed.",
    appliesTo: { views: CODE_VIEWS },
  },
  {
    id: "emergency_override",
    section: "code",
    title: "Emergency override",
    body: "An emergency override is you acting directly on a run's working copy instead of asking an agent: running one program there, or discarding its uncommitted changes. It runs as you, outside the agent gate and the working copy's sandbox, and the program can change files; anything it starts, including scripts an agent wrote, is not checked. The program is started directly, not through a shell, with no connection keys in its environment, though files in your home folder are still readable. Discarding keeps commits the agent made. Each override needs a reason and is recorded in red. Look at the exact command before you confirm it.",
    appliesTo: { views: CODE_VIEWS },
  },
  {
    id: "api_keys_and_keychain",
    section: "connections",
    title: "API keys and the keychain",
    body: "API keys and other secrets you add are kept in your operating system's keychain, never in project files or the ledger. The ledger records that a connection was added or used, not its value, and known secrets are redacted from agent output. Look at which runs were given which connections, and remove keys you no longer need.",
    appliesTo: { views: CONNECTION_VIEWS },
  },
  {
    id: "estimates",
    section: "connections",
    title: "Estimates and budgets",
    body: "Costs shown in The Terminal are estimates built from what providers report, and runs that report nothing count as nothing, so the real spend may be higher. Every figure is labelled as an estimate for that reason. Your budget is the limit you chose; once spending is past it, moving a card on needs your sign-off. Look at the providers' own billing for the real numbers.",
    appliesTo: { views: CONNECTION_VIEWS, gateIds: ["over_budget"] },
  },
  {
    id: "cloud_session_tokens",
    section: "connections",
    title: "Cloud session tokens",
    body: "When a run needs a cloud account, The Terminal gives it a short-lived token where the provider offers one, such as a 12-hour AWS session token or a 1-hour Google Cloud token, rather than your long-lived keys. A short life limits the damage if a token leaks. Look at the ledger to see which run was given which credential.",
    appliesTo: { views: CONNECTION_VIEWS },
  },
  {
    id: "mcp_servers",
    section: "connections",
    title: "MCP servers",
    body: "An MCP server gives agents extra tools, such as a database or an issue tracker. A run only gets the servers you choose for it, and every tool call is recorded and asks first like any other action. Look at what each server can reach, and give runs only the servers their task needs.",
    appliesTo: { views: CONNECTION_VIEWS },
  },
  {
    id: "subscriptions_and_api_keys",
    section: "connections",
    title: "Subscriptions and API keys",
    body: "An agent can sign in with an API key, billed per use, or with your own subscription or account through the provider's command-line login. A subscription may be cheaper, but each provider has its own terms, and some may not allow use through other tools. Look at the acknowledgement before switching, and at which mode each provider uses.",
    appliesTo: { views: CONNECTION_VIEWS },
  },
];

/** Whether a topic applies to any field of the context. */
export function matchesContext(topic: LearnTopic, ctx: LearnContext): boolean {
  const a = topic.appliesTo;
  return (
    (ctx.view !== undefined && (a.views ?? []).includes(ctx.view)) ||
    (ctx.stage !== undefined && (a.stages ?? []).includes(ctx.stage)) ||
    (ctx.actionKind !== undefined && (a.actionKinds ?? []).includes(ctx.actionKind)) ||
    (ctx.gateId !== undefined && (a.gateIds ?? []).includes(ctx.gateId))
  );
}

/** The topics that apply to the context and the rest, each in catalog order. */
export function topicsFor(ctx: LearnContext): { matched: LearnTopic[]; rest: LearnTopic[] } {
  const matched: LearnTopic[] = [];
  const rest: LearnTopic[] = [];
  for (const t of LEARN_TOPICS) (matchesContext(t, ctx) ? matched : rest).push(t);
  return { matched, rest };
}

/** The topic explaining each action kind. */
export const ACTION_TOPIC: Record<ActionKind, string> = Object.fromEntries(
  ACTION_KINDS.map((k) => [k, "action_kinds"]),
) as Record<ActionKind, string>;

/** The topic explaining each gate. */
export const GATE_TOPIC: Record<GateId, string> = Object.fromEntries(
  GATE_IDS.map((g) => [g, g === "over_budget" ? "estimates" : "readiness_gates"]),
) as Record<GateId, string>;
