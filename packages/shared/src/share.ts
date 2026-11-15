import { z } from "zod";
import type { AdapterId } from "./agents.js";
import type { Figure, HardwareInfo } from "./capacity.js";
import type { ConnectionKind } from "./connections.js";
import type { DailyDigest } from "./digest.js";
import type { Stage } from "./domain.js";
import type { GateId } from "./gates.js";
import type { CiState } from "./github.js";
import type { DecisionId } from "./intake.js";

/**
 * The share view: a self-contained page about one project, generated locally from the ledger, previewed and
 * confirmed by the Owner, and optionally served read-only behind a one-time link. These are its types, its
 * fixed copy and its ledger entries.
 */

export const SHARE_VERSION = 1;

export const DIGEST_DAYS = [7, 14, 30] as const;
export type DigestDays = (typeof DIGEST_DAYS)[number];

export type ShareOptions = { includePrompts: boolean; includeHardware: boolean; digestDays: DigestDays };
export const DEFAULT_SHARE_OPTIONS: ShareOptions = { includePrompts: false, includeHardware: false, digestDays: 7 };

export const shareOptionsSchema = z
  .object({
    includePrompts: z.boolean(),
    includeHardware: z.boolean(),
    digestDays: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  })
  .strict();

export const SHARE_SECTIONS = [
  "overview",
  "progress",
  "numbers",
  "what_and_why",
  "stack",
  "workforce",
  "waiting",
  "decisions",
  "readiness",
  "digests",
  "history",
  "audit",
] as const;
export type ShareSection = (typeof SHARE_SECTIONS)[number];

export const SHARE_SECTION_TITLES: Record<ShareSection, string> = {
  overview: "Overview",
  progress: "Progress",
  numbers: "Headline numbers",
  what_and_why: "What it does and why",
  stack: "Tech stack",
  workforce: "Agent workforce",
  waiting: "Waiting on a human",
  decisions: "Decisions made",
  readiness: "Readiness",
  digests: "Daily digests",
  history: "Earlier history",
  audit: "Audit status",
};

/** The hidden line that `includePrompts` removes. */
export const HIDDEN_PROMPTS_LINE = "Your prompts to agents (shown only when you tick Include my prompts to agents)";
/** The hidden line that `includeHardware` removes. */
export const HIDDEN_HARDWARE_LINE = "This computer's hardware (shown only when you tick Include this computer's hardware)";

/** What a share page never carries by default, shown to the Owner before confirming and on the page itself. */
export const HIDDEN_BY_DEFAULT: readonly string[] = [
  "Credentials, API keys and tokens (they live only in your keychain and are never in the ledger)",
  "File contents and diffs",
  "Raw agent output and the raw input of every action",
  "What agents said (their messages)",
  HIDDEN_PROMPTS_LINE,
  HIDDEN_HARDWARE_LINE,
  "Connection names and account details: regions, project ids, repository names",
  "Paths under your home folder and The Terminal's data folder, your username and email addresses",
  "Anything from other projects",
];

/** A reference to one ledger entry: its sequence number, the first twelve characters of its hash, and its time. */
export type Evidence = { seq: number; hash12: string; at: string };

export type ShareNumbers = {
  cardsTotal: number;
  cardsDone: number;
  runsTotal: number;
  runsCompleted: number;
  overrides: number;
  spendUsd: Figure;
  budgetUsd: number | null;
  costPerDayUsd: Figure;
  decisionsMade: number;
  decisionsWaiting: number;
  ci: CiState | null;
};
export type StackRow = { layer: string; choice: string; why: string; licence: string | null; evidence: Evidence | null };
export type WorkforceRow = {
  adapter: AdapterId;
  label: string;
  runs: number;
  completed: number;
  failed: number;
  stopped: number;
  costUsd: Figure;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type WaitingItem = { kind: "action" | "intake"; headline: string; since: string | null; cardTitle: string | null; assignee: string };
export type DecisionItem = {
  kind: "intake" | "gate_sign_off" | "gate_waiver" | "action";
  headline: string;
  /** The signer's display name. */
  by: string;
  at: string;
  reason: string | null;
  evidence: Evidence;
};
export type ReadinessRow = {
  gateId: GateId;
  title: string;
  state: "signed_off" | "waived" | "open" | "not_reached";
  detail: string | null;
  cardTitle: string | null;
  at: string | null;
  evidence: Evidence | null;
};
export type HistoryDay = { day: string; entries: number; actions: number; decisions: number; cardsMoved: number };
export type Ask = { day: string; time: string; adapterLabel: string; cardTitle: string | null; prompt: string };

export type ShareSnapshot = {
  version: 1;
  generatedAt: string;
  options: ShareOptions;
  hidden: string[];
  project: { name: string; pitch: string; createdAt: string };
  /** The Owner's display name. */
  owner: string;
  progress: Record<Stage, { total: number; done: number }>;
  currentStage: Stage | null;
  numbers: ShareNumbers;
  summary: string | null;
  idea: string | null;
  stack: StackRow[];
  workforce: WorkforceRow[];
  waiting: WaitingItem[];
  decisions: DecisionItem[];
  decisionsOmitted: number;
  readiness: ReadinessRow[];
  digests: DailyDigest[];
  asks: Ask[];
  history: HistoryDay[];
  hardware: HardwareInfo | null;
  audit: { ok: boolean; entries: number; brokenAtSeq: number | null; headSeq: number; headHash12: string | null };
};

/** Licence or terms per adapter or connection provider, for the tech stack table. */
export const STACK_LICENCES: Record<string, string> = {
  claude: "Claude Agent SDK, under Anthropic's legal agreements",
  codex: "Apache-2.0 (Codex CLI)",
  gemini: "Apache-2.0 (Gemini CLI)",
  github: "GitHub terms of service",
  aws: "AWS customer agreement",
  gcp: "Google Cloud terms",
  azure: "Microsoft Azure terms",
  mcp_stdio: "Per server",
  mcp_http: "Per server",
};

/** The tech stack layer each intake decision fills. */
export const STACK_LAYERS = {
  first_version: "Scope",
  hosting: "Hosting",
  exposure_protection: "Access",
  payments_scope: "Payments",
  data_handling: "Personal data",
} as const satisfies Record<DecisionId, string>;

/** The tech stack layer each kind of connection fills. This computer's hardware is its own opt-in line. */
export const STACK_KIND_LAYERS: Record<Exclude<ConnectionKind, "hardware">, string> = {
  llm: "AI agents",
  cloud: "Cloud",
  github: "Code hosting",
  mcp: "Tools (MCP)",
};

export type ShareSnapshotRecord = {
  id: string;
  projectId: string;
  contentHash: string;
  bytes: number;
  sections: ShareSection[];
  options: ShareOptions;
  headSeq: number;
  confirmedAt: string;
};
export type ShareLinkState = "active" | "revoked" | "expired" | "stopped";
export type ShareScope = "this_computer" | "local_network";
export type ShareLink = {
  id: string;
  shareId: string;
  projectId: string;
  scope: ShareScope;
  port: number;
  state: ShareLinkState;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
};

/** How long a share link lives, in minutes: one hour, eight hours, one day, one week. */
export const TTL_MINUTES = [60, 480, 1440, 10080] as const;

const id = z.string().min(1).max(200);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** The share view's ledger entries. A link records its scope and port, never its address or its token. */
export const sharePayloadSchemas = {
  "share.confirmed": z
    .object({
      shareId: id,
      contentHash: sha256Hex,
      bytes: z.number().int().nonnegative(),
      sections: z.array(z.enum(SHARE_SECTIONS)).min(1),
      options: shareOptionsSchema,
      headSeq: z.number().int().nonnegative(),
    })
    .strict(),
  "share.link_created": z
    .object({
      linkId: id,
      shareId: id,
      tokenDigest: sha256Hex,
      expiresAt: z.iso.datetime(),
      port: z.number().int().min(1).max(65535),
      scope: z.enum(["this_computer", "local_network"]),
    })
    .strict(),
  "share.revoked": z.object({ linkId: id, reason: z.enum(["owner", "too_many_failures"]) }).strict(),
  "share.expired": z.object({ linkId: id }).strict(),
  "share.stopped": z.object({ linkId: id, reason: z.enum(["shutdown", "restart"]) }).strict(),
} satisfies Record<string, z.ZodType>;

export type ShareEventType = keyof typeof sharePayloadSchemas;
