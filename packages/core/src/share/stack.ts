import {
  ADAPTERS, DECISION_IDS, INTAKE_DECISIONS, INTAKE_QUESTIONS, STACK_KIND_LAYERS, STACK_LAYERS, STACK_LICENCES, catalogEntry,
  plural, renderAnswer, type AdapterId, type AgentRun, type Connection, type Evidence, type LedgerEntry, type StackRow,
} from "@theterminal/shared";
import type { getIntake } from "../events/projections.js";

export type StackDeps = { intake: ReturnType<typeof getIntake>; connections: Connection[]; runs: AgentRun[]; entries: LedgerEntry[] };

/** What each agent program is called on a share page. */
export const PROGRAM_LABELS: Record<AdapterId, string> = {
  claude: "Claude Code (Claude Agent SDK)",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  fake: "Fake agent",
};

/** A reference to one ledger entry. */
export function evidenceOf(e: LedgerEntry): Evidence {
  return { seq: e.seq, hash12: e.hash.slice(0, 12), at: e.ts };
}

type Payload = Record<string, unknown>;
const payloadOf = (e: LedgerEntry): Payload =>
  typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload) ? (e.payload as Payload) : {};

const first = (entries: LedgerEntry[], match: (e: LedgerEntry, p: Payload) => boolean): LedgerEntry | undefined =>
  entries.find((e) => match(e, payloadOf(e)));
const last = (entries: LedgerEntry[], match: (e: LedgerEntry, p: Payload) => boolean): LedgerEntry | undefined =>
  entries.findLast((e) => match(e, payloadOf(e)));
const evidence = (e: LedgerEntry | undefined): Evidence | null => (e ? evidenceOf(e) : null);

const STACK_KINDS = Object.keys(STACK_KIND_LAYERS) as (keyof typeof STACK_KIND_LAYERS)[];

/**
 * The project's tech stack, derived from the ledger's projections: the decided intake decisions, the platform
 * answer, the enabled connections (kind and catalog label only: never a name or a config value) and the agent
 * programs that ran. Each row names the entry that decided it, when the entries hold it.
 */
export function techStack(deps: StackDeps): StackRow[] {
  const rows: StackRow[] = [];
  const intake = deps.intake;
  const intakeId = intake?.intake.id;

  if (intake) {
    for (const id of DECISION_IDS) {
      const decided = intake.decisions[id];
      if (!decided) continue;
      const option = INTAKE_DECISIONS.find((d) => d.id === id)?.options.find((o) => o.id === decided.chosen);
      const entry = last(deps.entries, (e, p) => e.type === "intake.decided" && p.intakeId === intakeId && p.decisionId === id);
      rows.push({
        layer: STACK_LAYERS[id],
        choice: option?.label ?? decided.chosen,
        why: decided.rationale.trim() !== "" ? decided.rationale : (option?.tradeoffs ?? ""),
        licence: null,
        evidence: evidence(entry),
      });
    }
    const platform = intake.answers.platform;
    if (platform) {
      const q = INTAKE_QUESTIONS.find((x) => x.id === "platform")!;
      const entry = last(deps.entries, (e, p) => e.type === "intake.answered" && p.intakeId === intakeId && p.questionId === "platform");
      rows.push({ layer: "Platforms", choice: renderAnswer(q, platform.answer), why: "From the plan", licence: null, evidence: evidence(entry) });
    }
  }

  for (const kind of STACK_KINDS) {
    const seen = new Set<string>();
    for (const c of deps.connections) {
      if (c.kind !== kind || !c.enabled || seen.has(c.provider)) continue;
      seen.add(c.provider);
      const entry = first(deps.entries, (e, p) => e.type === "connection.added" && p.connectionId === c.id);
      rows.push({
        layer: STACK_KIND_LAYERS[kind],
        choice: catalogEntry(c.provider).label,
        why: "Connected by the Owner",
        licence: STACK_LICENCES[c.provider] ?? null,
        evidence: evidence(entry),
      });
    }
  }

  for (const adapter of ADAPTERS) {
    const runs = deps.runs.filter((r) => r.adapter === adapter);
    if (runs.length === 0) continue;
    const entry = first(deps.entries, (e, p) => e.type === "agent.started" && p.adapter === adapter);
    rows.push({
      layer: "Agent programs",
      choice: PROGRAM_LABELS[adapter],
      why: plural(runs.length, "run"),
      licence: STACK_LICENCES[adapter] ?? null,
      evidence: evidence(entry),
    });
  }
  return rows;
}
