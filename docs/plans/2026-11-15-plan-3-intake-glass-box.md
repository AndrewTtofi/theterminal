# Plan 3: Intake and the Glass Box Implementation Plan

**Goal:** A person describes an idea and is guided, question by question and decision by decision, to a plan written in plain language, which they approve before any work starts; moving work through the lifecycle stops at readiness gates that explain in plain words what the step means, show a checklist derived from the ledger, and require the Owner to sign off or to waive with a reason; and everything agents and humans do is narrated in plain language, deterministically from the ledger, with the raw record underneath, on the agent feed, in the ledger, on a decision card and in every card's story.

**Architecture:**
- **Narration is a pure function of the ledger.** `packages/shared/src/narration.ts` exports `narrate(entry, ctx?)`: template per event type and, for agent actions, per action kind. No clock, no randomness, no network, no model. The UI narrates the entries it already streams; the core narrates for the audit export. Nothing narrated is ever written to the ledger: the ledger stays the only source of truth and the narration can be regenerated on any machine.
- **Intake is a sequence of ledger events** on one intake session per project: `intake.started` (the idea), `intake.answered` (one per question, latest wins), `intake.decided` (a decision with a named human owner), `intake.completed` (the approved plan summary plus the cards it creates, in one transaction), `intake.reopened`. The question set, the decisions it can raise, the recommendation rules, the proposed cards and the plan summary are a fixed, versioned catalog in `packages/shared/src/intake.ts`, so the same answers always produce the same plan.
- **Readiness gates are checklists computed from projections** at the moment a card is moved: `packages/core/src/gates/` evaluates the applicable gates for a `(card, from, to)` transition from intake answers, pending actions, running runs and spend. A gate with every condition met either passes (checklist-only gates) or needs the Owner's sign-off with a fixed acknowledgement sentence; a gate with an unmet condition blocks until the Owner waives it with a reason. Gate decisions and the `card.moved` they unlock commit in one transaction through a new `commitEvents`. A blocked attempt is recorded (`gate.blocked`).
- **Card story:** `GET /api/cards/:id/story` returns the card, its runs and every ledger entry that refers to the card or to its runs; the UI narrates them into "what happened", "decisions and why" and the raw detail underneath (spec §4.3). The ledger gains an NDJSON audit export with a narrated headline per line.
- UI: a `Plan intake` dock tab, a `GateCard` in the Needs-you strip (which no layout can hide), a `story:<cardId>` dock tab opened by clicking a card, and narrated lines in the agent feed, the ledger panel and the decision card, each with the raw record underneath.

**Tech Stack:** existing stack only (TypeScript strict ESM, zod, better-sqlite3 with its `json_extract`, Fastify 5, React 18 + dockview-react, Vitest, Playwright). No new dependencies.

**Spec:** `docs/specs/2026-11-13-agent-workspace-design.md` §1 (success: "describes an idea, is guided through the decisions"; "can explain what was built, why, what it costs, and what risks they've accepted"), §2 goal 3 (glass box: plain language by default, raw detail underneath) and goal 5 (gates and ledger), §3 (decision cards; every decision names a human), §4.3 (needs-you; clicking a card opens its story; decisions and gates can't be hidden), §5 (readiness gates, decision ledger filterable and exportable, learn on the way), §7 core items 1 (intake), 3 (glass-box activity) and 4 (gates), §11 ("how intake questions are generated" is left to the builder), §12 calls 1 and 2. Plan 1 named this slice "intake and glass box"; Plan 2 left "plain-language narration" to it. Builds on Plans 1, 2, 2B, 5A and 5B (`docs/plans/`); 5B's interfaces (`agent.rate_limited`, migration 6 `rate_limits`, `monthCostUsd` in `/api/status`, the `connection.used` wording) are assumed to exist, and this branch is cut from `main` after 5B merges.

## Decisions

- **Decision (controller default): narration is produced locally and deterministically from ledger events, by templates per event type and per action kind; an LLM summariser is not built, and if one is added later it is opt-in, runs through the Owner's own connection, is labelled as a model's summary under the template line, and is never written to the ledger or used as the source of truth.** Why: the narration *is* the glass box, so it must say exactly what the ledger says, with no room for a model to misstate an action; the same ledger must read the same on every machine (an Auditor's view equals the Owner's); it must work offline (spec §2 goal 9) and cost nothing (anti-goal: waste); and a template is testable to the character. The spec's note that "feed narration" may go to local models (§6) is honoured as a future opt-in enrichment, not as the narration itself.
- **Decision (controller default): intake is modelled as ledger events (a session, answers, decisions with a named owner, completion), not as free chat state.** Why: the spec requires every decision to have a named human owner and to be auditable with its evidence (§3, §5); a transcript cannot answer "which decisions are still open" or feed a gate condition, while projections rebuilt from events can; the share view (Plan 7) needs each stack choice linked to the ledger entry that decided it; and events survive restarts and work offline.
- **Decision (controller default): the intake questions, the decisions they raise, the recommendations and the proposed cards are a fixed catalog in `@theterminal/shared`, versioned by `INTAKE_VERSION`; an agent-assisted intake (an agent proposing extra questions or decision cards) is left to a later plan, once agents can propose decision cards through the gate.** Why: spec §11 leaves question generation to the builder; a fixed catalog is deterministic, testable and needs no connection or internet; and there is no protocol yet by which a Claude, Codex or Gemini run can hand the workspace a decision card (§3) rather than a tool call.
- **Decision (controller default): readiness gates are checklists derived from ledger state at the moment of a lifecycle move; they block the move until every condition is met (and, for consequential gates, the Owner signs off with a fixed acknowledgement) or until the Owner explicitly waives the unmet conditions with a reason; sign-offs, waivers and blocked attempts are recorded; evaluations are not.** Why: a checklist computed from the ledger can never disagree with it, where a stored gate state would need its own invalidation; the Owner is accountable (anti-goal: unaccountable shipping) and must be able to proceed knowingly, so a waiver is allowed but records what was unmet and why; recording every evaluation would flood the ledger with derived data.
- **Decision (controller default): gates attach to stage moves on the board (and the over-budget gate to any move); pausing agent runs on budget is left to the capacity router.** Why: the spec names consequential steps (payments, network exposure, personal data, production, spend) but not what they attach to; the board is the one place every piece of work passes through, and 5B already records spend per run for a router to act on later.
- **Decision (controller default): a gate whose conditions are all met still requires the Owner's sign-off, except `plan_approved`, whose only condition (the plan is approved) is itself a recorded human approval.** Why: spec §5 requires a named human to review and sign off a consequential step; asking twice for the plan would be ceremony.

## Out of scope (later plans)

- Agents proposing decision cards (§3) through the CLIs; an agent-assisted intake. Plan 3 reserves nothing in the schema for it.
- Roles other than Owner, gates that "require a specific person or role" (§4.5), presence: Plan 8. Every Plan 3 actor is `{ kind: "human", id: "owner" }`; the schemas record the actor, not a role.
- The share view, PDF export, daily digests, the tech-stack table (§4.4): Plan 7, which reads `intake.decided` entries and this plan's narration.
- The Learn panel, Guided/Operator layout presets, drag-and-drop on the board, Monaco and xterm inspection views, the emergency override "in red" (§3): Plan 4.
- Pausing or refusing runs over budget; the router and scheduler (§6).
- Lifecycle packs' own gates and learning content (§7): Plan 3 ships the gate engine and the core gates of §5; packs add definitions to the same catalog shape.
- Translation: narration and intake copy are English only.

## Global Constraints

- **Open source: never leak sensitive data.** No personal names, emails, absolute local paths, tokens or keys in code, tests, fixtures, docs, commit messages or ledger payloads. Intake fixtures describe made-up products ("a reading list for a book club").
- **Intake text is permanent and checked.** The idea, every text answer, every rationale and every waiver reason pass through `redact()`; a value `redact()` would change is refused (`secret_in_text`) and nothing is committed. The intake panel says, above the first field: `What you write here is recorded permanently in this project's ledger. Do not paste passwords, keys or other people's personal details.`
- **Every new route sits behind the default-deny auth** (`registerAuth`): `/api/projects/:id/intake*`, `/api/cards/:id/gates`, `/api/cards/:id/story` and `/api/ledger/export` answer 401 without the cookie or bearer token.
- **Narration is pure.** `narrate` reads only its arguments; no `Date`, `Math.random`, `fetch`, `process`, or imports from core or the UI. It never appends information that is not in the entry or the context it was given.
- **Gate decisions are human.** `gate.signed_off`, `gate.waived` and `intake.decided` are refused for a non-human actor at the service (`HumanRequiredError`). A waiver needs a reason of 10 to 500 characters and the gate's exact acknowledgement sentence; a sign-off needs the exact sentence.
- **Fail closed.** A gate that cannot be evaluated blocks the move (the error propagates; nothing is moved or recorded). Conditions are evaluated inside the move's transaction, so a sign-off whose conditions stopped holding is refused (`gate_not_met`). A completed intake refuses further answers (`intake_completed`); an incomplete one refuses completion (`intake_incomplete`).
- **One transaction for a gate decision and the move it unlocks** (`commitEvents`); neither is recorded without the other. Projections must rebuild exactly from the ledger, including the new tables.
- **Decisions and gates surface in every layout.** Gate cards and the intake notice render in the Needs-you strip outside the dock; the status bar count includes open intake decisions.
- **Test doubles only under `THETERMINAL_FAKE_AGENT=1`** (unchanged); no new switches.
- **Branch and PR.** `main` is protected: the work lands on branch `plan-3-intake-glass-box`, one commit per task, pushed when it lands, and merges through a pull request once CI is green on macOS and Windows. Commits and the PR are authored by the repository owner only, with no AI attribution or co-author trailers.
- Plan 1/2/2B/5A/5B constraints still hold (Node ≥ 22, strict TS ESM, append-only ledger, 127.0.0.1 bind, every agent action gated before it runs, allowlisted child env via `buildChildEnv`, no `shell: true`, keychain-only secrets, redact before truncate, live redaction, estimates labelled `estimate`).

## Review Focus

1. **A move that slips past a gate.** A card in Build with no intake is moved to Ship with a plain `{ to: "ship" }`; then with `gates: [{ gateId: "ready_to_ship", decision: "sign_off", … }]` although a condition is unmet; then with a waiver whose reason is 3 characters; then with a system actor. Expected: 409 `gate_blocked` with the evaluation and a `gate.blocked` entry; 409 `gate_not_met`; 400 `invalid_input`; `HumanRequiredError`; in every case no `card.moved` and the card still in Build. (Tests in Task 5.)
2. **A sign-off that went stale.** The Owner fetches the gates for a move to Operate and every condition is met; before the move is posted, an agent on that card asks for approval. Expected: the posted sign-off answers 409 `gate_not_met` naming `no_pending_actions`, nothing is recorded, and after the action is decided the same request succeeds. (Tests in Task 5.)
3. **Narration that says more, or less, than the ledger.** An action whose input the runner truncated, a shell input containing `[REDACTED]`, an action with an unknown input shape, an entry of an unknown type, and a payload with an unexpected field type. Expected: `a command too long to show in full (<n> characters)`; the headline shows the recorded `[REDACTED]` text as is; the headline falls back to the recorded summary; `Owner recorded <type>`; never a throw, never `undefined` or `[object Object]` in a headline. (Tests in Task 2.)
4. **A key pasted into the idea.** `POST /api/projects/:id/intake` with an idea containing `sk-ant-TESTKEY-0000000000`, then an answer and a waiver reason containing it. Expected: 400 `secret_in_text`, no ledger entry, no projection row, and the error body does not echo the value. (Tests in Tasks 4 and 5.)
5. **Re-planning after work exists.** An approved plan created five cards; the Owner reopens the intake, changes `payments` from `no` to `yes` and approves again. Expected: exactly one new card (`Payments readiness review`), no duplicate of the five, `intake.completed.cards` lists the new card as `created` and the others as `existing`, and a move to Ship now raises the `payments` gate. (Tests in Task 4.)

---

## File Structure

```
packages/shared/src/intake.ts            # INTAKE_VERSION, questions, decisions, derivations, intake.* schemas, IntakeView types (Task 1)
packages/shared/src/gates.ts             # gate and condition catalogs, GateEvaluation, gate.* schemas (Task 1)
packages/shared/src/narration.ts         # narrate, narrateAction, actionPhrase, ACTION_KIND_MEANS (Task 2)
packages/shared/src/events.ts            # (modify) EventType gains intake.* and gate.* (Task 1)
packages/shared/src/index.ts             # (modify) (Tasks 1, 2)

packages/core/src/events/commit.ts       # (modify) commitEvents; commitEvent delegates to it (Task 3)
packages/core/src/events/projections.ts  # (modify) intake and gate reducers, queries, intake/gate tables in PROJECTION_TABLES (Task 3)
packages/core/src/db.ts                  # (modify) the migration after 5B's rate_limits: intakes, intake_answers, intake_decisions, gate_decisions (Task 3)
packages/core/src/ledger/ledger.ts       # (modify) list() filters cardId / runIds (Task 6)
packages/core/src/intake/service.ts      # IntakeService (Task 4)
packages/core/src/gates/conditions.ts    # evaluateConditions over the projections (Task 5)
packages/core/src/gates/service.ts       # GateService: evaluate, move (Task 5)
packages/core/src/story/story.ts         # cardStory, narrationContext (Task 6)
packages/core/src/server/intake-routes.ts    # /api/projects/:id/intake* (Task 4)
packages/core/src/server/routes.ts           # (modify) move through gates, GET gates, error map (Tasks 4, 5, 6)
packages/core/src/server/story-routes.ts     # GET /api/cards/:id/story, GET /api/ledger/export (Task 6)
packages/core/src/server/connection-routes.ts # (modify) /api/status intakeDecisions (Task 4)
packages/core/src/server/server.ts           # (modify) wire services and routes (Tasks 4, 5, 6)
packages/core/src/index.ts                   # (modify)

apps/ui/src/api.ts                        # (modify) intake, gates, story, export url (Tasks 7, 8, 9)
apps/ui/src/shell/model.ts                # (modify) intake, gate, story, ledger topics (Tasks 7, 8, 9)
apps/ui/src/App.tsx                       # (modify) data and handlers (Tasks 7, 8, 9)
apps/ui/src/shell/{Dock,dock-layout,Workbench,StatusBar}.tsx  # (modify) panel ids, strip, counts (Tasks 8, 9)
apps/ui/src/components/LedgerPanel.tsx    # (modify) narrate; topic filter (Task 7)
apps/ui/src/views/LedgerSideBar.tsx       # (modify) topics, Export for audit (Task 7)
apps/ui/src/views/AgentFeedPanel.tsx      # (modify) narrated items with raw detail (Task 7)
apps/ui/src/components/DecisionCard.tsx   # (modify) phrase and "What this means" (Task 7)
apps/ui/src/views/IntakePanel.tsx         # dock tab "Plan intake" (Task 8)
apps/ui/src/components/IntakeDecisionCard.tsx  # (Task 8)
apps/ui/src/views/ProjectsSideBar.tsx     # (modify) Plan intake button and state line (Task 8)
apps/ui/src/components/GateCard.tsx       # (Task 9)
apps/ui/src/views/StoryPanel.tsx          # dock tab per card (Task 9)
apps/ui/src/components/Board.tsx          # (modify) card title opens the story (Task 9)
apps/ui/src/components/AgentPanel.tsx, views/AgentsSideBar.tsx  # (modify) optional card for a run (Task 9)
docs/glass-box.md                         # narration, intake, gates, story, export (Task 10)
CHANGELOG.md, README.md                   # (modify) (Task 10)
e2e/intake.spec.ts, e2e/gates.spec.ts, e2e/story.spec.ts, e2e/global-setup.ts  # (Task 11)
```

---

### Task 1: Shared intake and gate catalogs, derivations and event schemas

**Files:** Create `packages/shared/src/intake.ts`, `packages/shared/src/gates.ts`. Modify `packages/shared/src/events.ts`, `index.ts`. Tests `packages/shared/test/intake.test.ts`, `packages/shared/test/gates.test.ts`, `packages/shared/test/domain.test.ts` (event type coverage).

**Interfaces:**
```ts
// shared/intake.ts
export const INTAKE_VERSION = 1;
export const QUESTION_IDS = ["audience", "outcome", "success", "platform", "payments", "personal_data", "exposure", "budget_usd", "existing"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];
export type QuestionKind = "text" | "choice" | "multi" | "number";
export type QuestionOption = { id: string; label: string };
export type IntakeQuestion = { id: QuestionId; kind: QuestionKind; label: string; help: string; required: boolean; options?: QuestionOption[]; max?: number };
export const INTAKE_QUESTIONS: readonly IntakeQuestion[];   // in QUESTION_IDS order
export type IntakeAnswer = string | string[] | number;
export type Answers = Partial<Record<QuestionId, IntakeAnswer>>;
export const DECISION_IDS = ["first_version", "hosting", "exposure_protection", "payments_scope", "data_handling"] as const;
export type DecisionId = (typeof DECISION_IDS)[number];
export type DecisionOption = { id: string; label: string; tradeoffs: string };
export type IntakeDecision = {
  id: DecisionId; question: string; learn: string; risk: string; options: DecisionOption[];
  dependsOn: QuestionId[];                                             // the answers shown as evidence ("Because you answered…")
  appliesWhen: { questionId: QuestionId; anyOf: string[] } | null;     // null: always
  recommend: { default: string; when?: { questionId: QuestionId; anyOf: string[]; option: string }[] };
};
export const INTAKE_DECISIONS: readonly IntakeDecision[];
export type Decisions = Partial<Record<DecisionId, string>>;          // chosen option id
export type IntakeStatus = "open" | "completed";
export type IntakeStep = "answer" | "decide" | "approve" | "completed";
export type ProposedCard = { title: string; stage: Stage };
export function validateAnswer(q: IntakeQuestion, answer: unknown): IntakeAnswer;   // throws ZodError at path ["answer"]
export function renderAnswer(q: IntakeQuestion, answer: IntakeAnswer): string;       // option labels joined ", "; numbers as "$1,000.00" for budget_usd
export function applicableDecisions(answers: Answers): IntakeDecision[];             // INTAKE_DECISIONS order; a decision applies only when every dependsOn question is answered
export function recommendedOption(d: IntakeDecision, answers: Answers): string;
export function intakeStep(status: IntakeStatus, answers: Answers, decisions: Decisions): IntakeStep;
export function proposedCards(answers: Answers, decisions: Decisions): ProposedCard[];
export function planSummary(projectName: string, answers: Answers, decisions: Decisions): string;
export type IntakeSession = { id: string; projectId: string; idea: string; status: IntakeStatus; summary: string | null; createdAt: string; updatedAt: string; completedAt: string | null };
export type IntakeQuestionView = IntakeQuestion & { answer: IntakeAnswer | null; answeredAt: string | null };
export type IntakeDecisionView = Omit<IntakeDecision, "appliesWhen" | "recommend"> & { recommended: string; because: { label: string; answer: string }[]; chosen: string | null; rationale: string | null; owner: string | null; decidedAt: string | null };
export type IntakeView = { intake: IntakeSession; step: IntakeStep; questions: IntakeQuestionView[]; decisions: IntakeDecisionView[]; plan: { summary: string; cards: ProposedCard[] } | null };
export const intakePayloadSchemas = {
  "intake.started":   { intakeId, idea: z.string().min(1).max(4000), version: z.literal(INTAKE_VERSION) },
  "intake.answered":  { intakeId, questionId: z.enum(QUESTION_IDS), answer: z.union([z.string().max(2000), z.array(z.string().max(100)).max(10), z.number().finite().min(0).max(1_000_000)]) }  // superRefine: validateAnswer against the catalog question
  "intake.decided":   { intakeId, decisionId: z.enum(DECISION_IDS), chosen: z.string().min(1).max(40), rationale: z.string().max(1000), owner: z.string().min(1).max(200) }  // superRefine: chosen is one of the decision's options
  "intake.completed": { intakeId, summary: z.string().min(1).max(4000), cards: z.array(z.object({ cardId: id, title: z.string().min(1).max(200), stage: stageSchema, outcome: z.enum(["created", "existing"]) })).max(20) }
  "intake.reopened":  { intakeId, reason: z.string().min(1).max(500) }
}; // all .strict()
export type IntakeEventType = keyof typeof intakePayloadSchemas;   // gates.ts likewise exports GateEventType
```
Catalog (exact ids, kinds, labels and options; `help` is one or two plain sentences saying why the question is asked and is non-empty):
- `audience` text `Who is this for?` · `outcome` text `What should it do for them?` · `success` text `How will you know it worked?` (all required, max 2000)
- `platform` multi `Where will people use it?` options `web` `In a web browser`, `mobile` `On a phone (an app)`, `api` `From other software (an API)`, `desktop` `On a computer (a desktop app)`; required, at least one
- `payments` choice `Will it take payments?` options `yes` `Yes`, `no` `No`, `later` `Not at first`
- `personal_data` choice `What personal data will it hold?` options `none` `None`, `accounts` `Accounts (names, emails, logins)`, `sensitive` `Sensitive data (health, money, identity documents)`
- `exposure` choice `Who can reach it?` options `private` `Only me, on my computer`, `network` `People on my network`, `internet` `Anyone on the internet`
- `budget_usd` number `How much are you willing to spend on agents for this project? (USD)` required, 0 to 1,000,000, at most two decimals
- `existing` text `Is there anything that already exists (code, designs, accounts)?` optional
Decisions (question; options `id` `label`; recommendation; applicability):
- `first_version` `How much should the first version include?`: `smallest` `The smallest version that proves the idea` (recommended), `full` `Everything described`; always; dependsOn `outcome`, `success`.
- `hosting` `Where should it run?`: `local` `On this computer only`, `own_cloud` `In your own cloud account (AWS, Google Cloud or Azure)`; default `own_cloud`, `local` when `exposure` is `private`; always; dependsOn `exposure`.
- `exposure_protection` `Who should be able to use it once it is reachable?`: `login` `Only people who sign in` (recommended), `open` `Anyone who finds it`; applies when `exposure` ∈ `network`, `internet`; dependsOn `exposure`, `personal_data`.
- `payments_scope` `How should payments be handled?`: `provider` `A payment provider's hosted checkout: card details never touch your product` (recommended), `custom` `A checkout built into the product`; applies when `payments` is `yes`; dependsOn `payments`.
- `data_handling` `How much personal data should be kept?`: `minimum` `Only what the product needs, deleted when no longer needed` (recommended), `full` `Everything that might be useful later`; applies when `personal_data` ∈ `accounts`, `sensitive`; dependsOn `personal_data`.
Every option's `tradeoffs`, every decision's `learn` and `risk`, and every question's `help` are plain English of 20 to 400 characters, written by the implementer; a test asserts the bounds. `intakeStep`: `completed` when status is completed; `answer` while a required question is unanswered; `decide` while an applicable decision is undecided; else `approve`. `proposedCards`, in this order: plan `Define what "done" means`; design `Sketch the main screens and flows` when `platform` includes `web`, `mobile` or `desktop`, `Define the API` when it includes `api`; build `Build the smallest version that proves the idea` or `Build everything described` by `first_version`; ship `Run it on this computer` or `Set up hosting in your own cloud account` by `hosting`, then `Payments readiness review` when `payments` is `yes`, `Personal data readiness review` when `personal_data` is not `none`, `Network exposure readiness review` when `exposure` is not `private`; operate `Monitoring and health checks`. `planSummary` is one deterministic paragraph of the shape `<project> is for <audience>. It should <outcome>. You will know it worked when <success>. People use it <platform labels, lower-cased, joined by ", " and " and ">. It <takes payments | does not take payments | will take payments later>. It holds <no personal data | account data | sensitive personal data> and can be reached by <exposure label, lower-cased>. First version: <label>. Hosting: <label>.[ Access: <label>.][ Payments: <label>.][ Personal data: <label>.] Agent budget: $<budget with two decimals>.`

```ts
// shared/gates.ts
export const GATE_IDS = ["plan_approved", "ready_to_ship", "network_exposure", "payments", "personal_data", "go_live", "over_budget"] as const;
export type GateId = (typeof GATE_IDS)[number];
export type ConditionId = "intake_completed" | "no_pending_actions" | "no_running_runs_on_card" | "within_budget" | `decision_made:${DecisionId}`;
export type GateDefinition = { id: GateId; title: string; explanation: string; risks: string[]; learn: string; acknowledgement: string; signOff: boolean; conditions: ConditionId[];
  appliesWhen: (t: { from: Stage; to: Stage }, answers: Answers, facts: GateFacts) => boolean };
export type GateFacts = { intakeCompleted: boolean; budgetUsd: number | null; spendUsd: number };
export const GATES: readonly GateDefinition[];
export type ConditionResult = { id: ConditionId; label: string; met: boolean; detail: string | null };
export type GateOutcome = "pass" | "needs_sign_off" | "blocked";
export type GateEvaluation = Pick<GateDefinition, "id" | "title" | "explanation" | "risks" | "learn" | "acknowledgement" | "signOff"> & { conditions: ConditionResult[]; met: boolean; outcome: GateOutcome };
export type GateDecisionInput = { gateId: GateId; decision: "sign_off" | "waive"; reason?: string; acknowledgement: string };
export const gateDecisionInputSchema; // strict; reason 10..500 required when decision is "waive"
export function applicableGates(t: { from: Stage; to: Stage }, answers: Answers, facts: GateFacts): GateDefinition[];
export function conditionLabel(id: ConditionId, facts: GateFacts): string;
export function outcomeOf(def: GateDefinition, conditions: ConditionResult[]): GateOutcome;  // pass = met && !signOff; needs_sign_off = met && signOff; blocked = !met
export const gatePayloadSchemas = {
  "gate.blocked":    { cardId: id, from: stageSchema, to: stageSchema, gates: z.array(z.object({ gateId: z.enum(GATE_IDS), outcome: z.enum(["needs_sign_off", "blocked"]), unmet: z.array(z.string()).max(20) })).min(1).max(10) }
  "gate.signed_off": { gateId: z.enum(GATE_IDS), cardId: id, from: stageSchema, to: stageSchema, conditions: z.array(z.string()).max(20), acknowledgement: z.string().max(1000), signedBy: z.string().min(1).max(200) }  // refine: acknowledgement equals the gate's
  "gate.waived":     { gateId, cardId, from, to, unmet: z.array(z.string()).min(1).max(20), reason: z.string().min(10).max(500), acknowledgement, waivedBy }         // same refine
}; // all .strict()
```
Gate catalog (id · title · `signOff` · conditions · applies when):
- `plan_approved` · `Plan approved` · false · `intake_completed` · `from === "plan" && to !== "plan"`
- `ready_to_ship` · `Ready to ship` · true · `intake_completed`, `no_pending_actions`, `no_running_runs_on_card` · `to === "ship"`
- `network_exposure` · `Network exposure` · true · `decision_made:exposure_protection` · `to === "ship"` and `exposure` ∈ `network`, `internet`
- `payments` · `Taking payments` · true · `decision_made:payments_scope` · `to === "ship"` and `payments === "yes"`
- `personal_data` · `Holding personal data` · true · `decision_made:data_handling` · `to === "ship"` and `personal_data` ≠ `none`
- `go_live` · `Going live` · true · `intake_completed`, `no_pending_actions`, `no_running_runs_on_card` · `to === "operate"`
- `over_budget` · `Over budget` · true · `within_budget` · `facts.intakeCompleted && facts.budgetUsd !== null && facts.spendUsd > facts.budgetUsd` (any move; its one condition is unmet whenever it applies, so it can only be waived)
Acknowledgements (exact): `plan_approved` none (empty string); every other gate `I have read what <title, lower-cased> means for this project and I take responsibility for this step.` Condition labels (exact): `intake_completed` `The plan has been approved`; `no_pending_actions` `No agent is waiting for a decision in this project`; `no_running_runs_on_card` `No agent is still working on this card`; `decision_made:<id>` `You have decided: <decision question>`; `within_budget` `Agent spend is within the budget you set ($<spend> of $<budget>)`, or `No budget has been set` when `budgetUsd` is null. `explanation` (one or two paragraphs, 100 to 900 characters), `risks` (2 to 5 items) and `learn` (40 to 400 characters, the "what this means" gloss of spec §5) are plain English written by the implementer; a test asserts the bounds and that none contains the words `gate`, `ledger` or `projection` without being the title. `events.ts`: `EventType` gains `IntakeEventType | GateEventType`; `eventPayloadSchemas` spreads both.

- [ ] **Step 1: Write failing tests:**
  - intake: `INTAKE_QUESTIONS` ids equal `QUESTION_IDS` in order; `validateAnswer(platform, ["web", "nope"])` throws, `(["web"])` passes; `(budget_usd, 12.345)` throws, `(12.34)` passes; `(audience, "")` throws for a required question; `applicableDecisions({})` is `[]`; with every required answer and `exposure: "private"`, decisions are `first_version`, `hosting`; with `exposure: "internet"`, `payments: "yes"`, `personal_data: "accounts"` all five apply; `recommendedOption(hosting, { exposure: "private" })` is `local`, `({ exposure: "internet" })` is `own_cloud`; `intakeStep` walks `answer` → `decide` → `approve` → `completed`; `proposedCards` for the full answer set with `first_version: smallest`, `hosting: own_cloud` is the eight titles above in order; `planSummary("Book Club", …)` equals one exact fixture string; every option has `tradeoffs` of 20..400 chars; `intake.answered` with `questionId: "payments", answer: "maybe"` is rejected, `"yes"` accepted; `intake.decided` with `chosen: "nope"` rejected; `intake.completed` with 21 cards rejected;
  - gates: `applicableGates({ from: "plan", to: "build" }, {}, { intakeCompleted: false, budgetUsd: null, spendUsd: 0 })` is `[plan_approved]`; `({ from: "build", to: "ship" }, fullAnswers, facts)` is `ready_to_ship, network_exposure, payments, personal_data` in order; `({ from: "build", to: "design" }, {}, { intakeCompleted: true, budgetUsd: 10, spendUsd: 10.01 })` is `[over_budget]`; `outcomeOf` for each of the three cases; `conditionLabel("within_budget", { budgetUsd: 50, spendUsd: 12.5 })` is `Agent spend is within the budget you set ($12.50 of $50.00)`; `gate.waived` with a 9-character reason or a wrong acknowledgement is rejected; `gate.signed_off` with the exact sentence accepted; `gateDecisionInputSchema` rejects `waive` without a reason; every gate's copy is within the bounds;
  - domain: `eventPayloadSchemas` has a schema for every `EventType` including the new ones.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): intake questions, decisions and plan derivation; readiness gate catalog; intake and gate events`

---

### Task 2: Deterministic narration

**Files:** Create `packages/shared/src/narration.ts`. Modify `packages/shared/src/index.ts`. Test `packages/shared/test/narration.test.ts`.

**Interfaces:**
```ts
export type NarrationTopic = "board" | "agent" | "decision" | "gate" | "intake" | "connection" | "settings" | "other";
export type NarrationRefs = { cardId?: string; runId?: string; actionId?: string; connectionId?: string; intakeId?: string; gateId?: GateId };
export type Narration = { headline: string; detail: string | null; topic: NarrationTopic; attention: boolean; refs: NarrationRefs };
export type NarrationContext = { cardTitle?: (cardId: string) => string | undefined; adapterName?: (runId: string) => string | undefined };
export function narrate(e: LedgerEntry, ctx?: NarrationContext): Narration;      // never throws; headline ≤ 200 chars
export type ActionLike = Pick<AgentAction, "kind" | "tool" | "summary" | "input">;
export function actionPhrase(a: ActionLike): string;                              // a verb phrase: "run the command "npm test""
export function narrateAction(a: AgentAction): { headline: string; detail: string | null; means: string };
export const ACTION_KIND_MEANS: Record<ActionKind, string>;
```
Rules:
- Who: human actor → `Owner` (id `owner`) or the id; for every `agent.*` event other than `agent.started` (whose actor is the human who started it, while `agent.finished` is committed by the runner) → `The <adapterName(runId)> agent` when the context knows it, else `The agent`; system `policy` → `Policy`, other system → `The workspace`. Adapter labels: `Claude`, `Codex`, `Gemini`, `Fake`.
- `actionPhrase` by kind, from the recorded input (`path` / `file_path` / `filePath` / `command` / `url`, first string found), falling back to the recorded `summary`: `file_read` `read <path>`; `file_write` `create or replace <path>`; `file_edit` `change <path>`; `shell` `run the command "<first line of command, clipped to 100>"`, and for tool `codex.stdin` `type "<input.reason clipped 80>" into the running command`; `web` `fetch <url>`; `mcp` `use <summary>`; `other` `<summary>`. An input carrying the runner's truncation marker (`truncated: true`) → `<kind verb> a command too long to show in full (<totalChars> characters)` for shell and `… too long to show in full` for the others **(Review Focus 3)**. `[REDACTED]` in the recorded input stays as is.
- Headlines (exact templates; `<Stage>` capitalised; `clip(s, n)` appends `…`):
  `project.created` `Owner created the project "<name>"` · `card.created` `Owner added "<title>" to <Stage>` · `card.moved` `Owner moved "<cardTitle ?? a card>" from <From> to <To>` · `card.status_changed` `Owner marked "<cardTitle ?? a card>" <to>` · `agent.started` `Owner started a <Adapter from payload> agent on "<cardTitle>"` when `cardId` resolves, else `Owner started a <Adapter> agent: "<clip(prompt, 80)>"`, detail = prompt · `agent.message` `<Who> said: "<clip(text, 120)>"`, detail = text · `agent.action.requested` `<Who> wants to <actionPhrase>`, detail = `JSON.stringify(input, null, 2)`, attention true · `agent.action.decided` human allow `Owner allowed it`, human deny `Owner denied it: <reason or "no reason given">`, policy allow `Allowed automatically: <reason>`, policy deny `Stopped automatically: <reason>` · `agent.action.completed` ok `Done (<n> line(s) of output)`, not ok `It failed: <clip(first line of output, 80)>`, detail = output · `agent.finished` completed `<Who> finished` + ` · cost $<x.xx> (estimate)` when `costUsd` is a number, failed `<Who> failed: <error>` (attention true), stopped `<Who> was stopped` · `agent.rate_limited`, `settings.*`, `connection.*` keep the exact 5A/5B lines from `describeEntry` (moved here verbatim) · `intake.started` `Owner described the idea: "<clip(idea, 80)>"`, detail = idea · `intake.answered` `Owner answered "<question label>": <renderAnswer>` · `intake.decided` `Owner decided "<question>": <option label>`, detail = rationale or null · `intake.completed` `Owner approved the plan (<n created> card(s) added)`, detail = summary · `intake.reopened` `Owner reopened the plan: <reason>` · `gate.blocked` `Moving "<cardTitle>" to <To> is blocked by <titles joined ", ">`, attention true · `gate.signed_off` `Owner signed off "<title>" for "<cardTitle>"` · `gate.waived` `Owner waived "<title>" for "<cardTitle>": <reason>`, attention true · unknown type `<Who> recorded <type>`.
- Topics: `card.*`/`project.*` board; `agent.*` agent except `agent.action.decided` → decision; `gate.*` gate; `intake.*` intake; `connection.*` connection; `settings.*` settings; else other. `refs` carry every id present in the payload.
- `narrateAction`: headline by status: pending `Wants to <phrase>`, allowed `Allowed to <phrase>`, denied `Denied: <phrase>`, completed `Did <phrase>`, failed `Failed to <phrase>`; detail = the output when present else the input JSON; `means = ACTION_KIND_MEANS[kind]`.
- `ACTION_KIND_MEANS` (exact): `file_read` `Reads a file inside the agent's working copy of the project. Nothing changes.` · `file_write` `Creates or replaces a file inside the agent's working copy. The previous contents are gone unless git kept them.` · `file_edit` `Changes part of a file inside the agent's working copy.` · `shell` `Runs a program on this computer, inside the agent's working copy. It can read and change files there and reach the network.` · `web` `Fetches something from the internet. What is sent and received is recorded.` · `mcp` `Uses a tool from a connected MCP server. Every call is recorded and asks first.` · `other` `Something the agent's program asked for that fits no other kind. Read the raw detail before deciding.`
- Purity: the module imports only types and the catalogs from `./intake.js`, `./gates.js`, `./agents.js`, `./domain.js`; a test calls `narrate` twice on the same entry and on a deep clone and asserts equal output.

- [ ] **Step 1: Write failing tests:** one assertion per template above with a fixture entry (project, card with and without `cardTitle`, each agent event and status, each intake and gate event, a connection event equal to the old `describeEntry` string); `actionPhrase` for Claude's `{ file_path }`, the fake's `{ path }`, a shell `{ command: "npm test\necho hi" }` → `run the command "npm test"`, `codex.stdin`, an `mcp` action, and the truncation marker **(Review Focus 3)**; a shell input `{ command: "curl -H [REDACTED]" }` keeps `[REDACTED]`; an entry of type `"future.event"` → `Owner recorded future.event`; a payload where `name` is `42` → headline is a string without `undefined`; `narrateAction` for the five statuses; determinism (same input twice, cloned input); every headline in the suite ≤ 200 characters; a source scan asserts `narration.ts` has no import outside the four allowed modules and does not mention `Date`, `Math.random`, `fetch` or `process`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/shared test narration`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/shared test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(shared): deterministic plain-language narration of ledger entries and agent actions`

---

### Task 3: `commitEvents`, the migration and the intake and gate projections

**Files:** Modify `packages/core/src/events/commit.ts`, `packages/core/src/events/projections.ts`, `packages/core/src/db.ts`, `packages/core/src/index.ts`. Tests `packages/core/test/events/commit.test.ts`, `packages/core/test/events/projections.test.ts`.

**Interfaces:**
```ts
// commit.ts
export function commitEvents<T>(db: Db, ledger: Ledger,
  build: () => { events: NewLedgerEntry[]; result: (entries: LedgerEntry[]) => T },
  apply: (db: Db, e: LedgerEntry) => void = applyEvent): T;   // one immediate transaction; appends and applies in order; notifies each entry in order after commit; events: [] → result([]) with nothing written
// commitEvent keeps its signature and delegates to commitEvents
// db.ts: the migration after 5B's (rate_limits)
`CREATE TABLE intakes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, idea TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
 CREATE TABLE intake_answers (intake_id TEXT NOT NULL, question_id TEXT NOT NULL, answer TEXT NOT NULL, answered_at TEXT NOT NULL, PRIMARY KEY (intake_id, question_id));
 CREATE TABLE intake_decisions (intake_id TEXT NOT NULL, decision_id TEXT NOT NULL, chosen TEXT NOT NULL, rationale TEXT NOT NULL, owner TEXT NOT NULL, decided_at TEXT NOT NULL, PRIMARY KEY (intake_id, decision_id));
 CREATE TABLE gate_decisions (entry_id TEXT PRIMARY KEY, gate_id TEXT NOT NULL, project_id TEXT NOT NULL, card_id TEXT NOT NULL, kind TEXT NOT NULL, from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, reason TEXT, decided_by TEXT NOT NULL, at TEXT NOT NULL);
 CREATE INDEX gate_decisions_card ON gate_decisions (card_id);`
// projections.ts
export type IntakeRow = IntakeSession; export type GateDecision = { entryId: string; gateId: GateId; projectId: string; cardId: string; kind: "signed_off" | "waived"; from: Stage; to: Stage; reason: string | null; decidedBy: string; at: string };
export function getIntake(db: Db, projectId: string): { intake: IntakeSession; answers: Record<QuestionId, { answer: IntakeAnswer; answeredAt: string }>; decisions: Record<DecisionId, { chosen: string; rationale: string; owner: string; decidedAt: string }> } | null;
export function listOpenIntakes(db: Db): IntakeSession[];
export function listGateDecisions(db: Db, cardId: string): GateDecision[];
export function projectSpendUsd(db: Db, projectId: string): number;   // SUM(cost_usd) over the project's runs, 0 when none
export function countPendingActions(db: Db, projectId: string): number;
export function countRunningRuns(db: Db, cardId: string): number;
```
Reducers: `intake.started` → INSERT (`status 'open'`, `summary NULL`); `intake.answered` → INSERT OR REPLACE into `intake_answers` (answer as canonical JSON) and `updated_at`; `intake.decided` → INSERT OR REPLACE into `intake_decisions`; `intake.completed` → `status 'completed'`, `summary`, `completed_at` (the `card.created` entries that follow in the same transaction are reduced by the existing case); `intake.reopened` → `status 'open'`, `completed_at NULL` (summary kept); `gate.signed_off` / `gate.waived` → INSERT into `gate_decisions` with `entry_id = e.id`, `decided_by` from the payload, `reason` NULL for a sign-off; `gate.blocked` → no projection. `PROJECTION_TABLES` gains the four tables.

- [ ] **Step 1: Write failing tests:**
  - commit: `commitEvents` with two events appends seqs n+1 and n+2, applies both, and a listener sees both in order after the transaction; a `build` that throws after reading state leaves the ledger and projections unchanged; a listener that throws on the first entry does not stop the second notification; `events: []` writes nothing and returns `result([])`; `commitEvent` still works through it;
  - projections: each reducer above against the live table; `rebuildAllProjections` after a start, three answers, one decision, a completion, a reopen and a waiver equals the live tables row for row (compare `SELECT *` of each table); `projectSpendUsd` sums only that project's runs; `countRunningRuns(cardId)` counts only `status = 'running'` for that card.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test events`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @theterminal/core test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): multi-event commits; intake and gate projections`

---

### Task 4: Intake service and routes

**Files:** Create `packages/core/src/intake/service.ts`, `packages/core/src/server/intake-routes.ts`. Modify `packages/core/src/server/routes.ts` (error map), `connection-routes.ts` (`/api/status`), `server.ts`, `index.ts`. Tests `packages/core/test/intake/service.test.ts`, `packages/core/test/server/intake-routes.test.ts`, `connection-routes.test.ts`.

**Interfaces:**
```ts
// intake/service.ts
export class HumanRequiredError extends Error {}        // "a named human must decide"
export class SecretInTextError extends Error {}         // "text contains a secret"
export class IntakeCompletedError extends Error {}      // "the intake is completed"
export class IntakeIncompleteError extends Error { constructor(public readonly missing: { questions: QuestionId[]; decisions: DecisionId[] }) }
export class DecisionNotApplicableError extends Error {}
export class IntakeService {
  constructor(deps: { db: Db; ledger: Ledger; newId?: () => string });
  get(projectId: string): IntakeView | null;                                   // NotFoundError for an unknown project
  start(actor: Actor, projectId: string, idea: string): IntakeView;            // ConflictError when an intake exists
  answer(actor: Actor, projectId: string, questionId: QuestionId, answer: unknown): IntakeView;
  decide(actor: Actor, projectId: string, decisionId: DecisionId, chosen: string, rationale?: string): IntakeView;
  complete(actor: Actor, projectId: string): IntakeView;
  reopen(actor: Actor, projectId: string, reason: string): IntakeView;
  openDecisionCount(): number;   // over every open intake: applicable decisions not yet decided
}
```
Rules: every text (idea, text answers, rationale, reason) is trimmed, then refused with `SecretInTextError` when `redact(text) !== text`; `start`/`answer`/`decide`/`complete`/`reopen` refuse a non-human actor with `HumanRequiredError`; `answer` and `decide` refuse a completed intake (`IntakeCompletedError`); `decide` refuses a decision that is not applicable to the current answers or whose `dependsOn` questions are unanswered (`DecisionNotApplicableError`) and records `owner: actor.id`; `complete` computes `intakeStep` inside the transaction and throws `IntakeIncompleteError` unless it is `approve`, else commits `intake.completed` followed by one `card.created` (actor = the human) per proposed card whose exact title does not already exist in the project (`outcome: "created"`), listing the others with their existing `cardId` as `existing` **(Review Focus 5)**; `reopen` refuses an open intake (`ConflictError`). The view's `decisions[].because` renders each `dependsOn` question that is answered as `{ label, answer: renderAnswer(...) }`. `plan` is set when `step` is `approve` (computed) or `completed` (summary from the projection, cards recomputed).

Routes (all behind auth; errors through `routes.ts`): `GET /api/projects/:id/intake` → `IntakeView` or 404 `{ error: "no_intake" }` when the project exists but has none; `POST /api/projects/:id/intake` `{ idea }` → 201; `POST /api/projects/:id/intake/answers` `{ questionId, answer }` → 200; `POST /api/projects/:id/intake/decisions` `{ decisionId, chosen, rationale? }` → 200; `POST /api/projects/:id/intake/complete` → 200; `POST /api/projects/:id/intake/reopen` `{ reason }` → 200. Error map: `HumanRequiredError` → 403 `human_required`; `SecretInTextError` → 400 `secret_in_text`; `IntakeCompletedError` → 409 `intake_completed`; `IntakeIncompleteError` → 409 `{ error: "intake_incomplete", missing }`; `DecisionNotApplicableError` → 409 `decision_not_applicable`. `/api/status` gains `intakeDecisions: number` from `openDecisionCount()`; `ConnectionRouteDeps` gains `intake: IntakeService`.

- [ ] **Step 1: Write failing tests:**
  - service: start → one `intake.started` with `version: 1`, `get()` shows `step: "answer"`; nine answers → `step: "decide"` with two decisions for a private, no-payments, no-data idea; deciding both → `approve` and a `plan` whose cards are `Define what "done" means`, `Sketch the main screens and flows`, `Build the smallest version that proves the idea`, `Run it on this computer`, `Monitoring and health checks`; `complete()` → one `intake.completed` with five `created` cards and five `card.created` entries with the human actor, all with consecutive seqs; `get()` then has `step: "completed"` and `plan.summary` equal to the recorded one; `answer()` after completion → `IntakeCompletedError`; `reopen` then change `payments` to `yes` → `payments_scope` becomes applicable, `complete()` refuses with `missing.decisions: ["payments_scope"]`; after deciding it, `complete()` creates exactly one card (`Payments readiness review`) and lists five `existing` **(Review Focus 5)**; `start()` twice → `ConflictError`; `decide("payments_scope")` while `payments` is `no` → `DecisionNotApplicableError`; an idea containing `sk-ant-TESTKEY-0000000000` → `SecretInTextError` and `ledger.headSeq()` unchanged **(Review Focus 4)**; actor `{ kind: "system", id: "runner" }` → `HumanRequiredError`; `openDecisionCount()` is 2 after the answers and 0 after the decisions; rebuild after the whole sequence equals the live tables;
  - routes: every row above with status codes; 404 `no_intake` before start; 400 `secret_in_text` whose body does not contain `TESTKEY` **(Review Focus 4)**; `answer: "maybe"` for `payments` → 400 `invalid_input` with issues without `received`; `/api/status.intakeDecisions` goes 0 → 2 → 0; every intake route → 401 without the cookie.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): guided intake as ledger events, with a derived plan that creates the board's cards`

---

### Task 5: Gate evaluation and moving cards through gates

**Files:** Create `packages/core/src/gates/conditions.ts`, `packages/core/src/gates/service.ts`. Modify `packages/core/src/server/routes.ts` (move body, GET gates, error map), `server.ts`, `index.ts`. Tests `packages/core/test/gates/{conditions,service}.test.ts`, `packages/core/test/server/routes.test.ts`.

**Interfaces:**
```ts
// gates/conditions.ts
export function gateFacts(db: Db, projectId: string): { answers: Answers; facts: GateFacts };   // answers from the intake projection (empty when none); spend from projectSpendUsd
export function evaluateConditions(db: Db, ids: ConditionId[], ctx: { projectId: string; cardId: string; facts: GateFacts; decisions: Decisions }): ConditionResult[];
// gates/service.ts
export class GateBlockedError extends Error { constructor(public readonly gates: GateEvaluation[]) }
export class GateNotMetError extends Error { constructor(public readonly gateId: GateId, public readonly unmet: ConditionId[]) }
export class GateService {   // reuses HumanRequiredError and SecretInTextError from intake/service.ts
  constructor(deps: { db: Db; ledger: Ledger });
  evaluate(cardId: string, to: Stage): GateEvaluation[];          // no recording; [] when to === card.stage; NotFoundError
  move(actor: Actor, cardId: string, to: Stage, decisions?: GateDecisionInput[]): Card;
}
```
`move` runs one `commitEvents` transaction: load the card (`NotFoundError`); `to === card.stage` → no event, return the card; evaluate; for each applicable gate in catalog order: `pass` → nothing; `needs_sign_off` with a `sign_off` decision carrying the exact acknowledgement → `gate.signed_off` (`conditions` = the met ids, `signedBy: actor.id`); `blocked` with a `waive` decision (reason 10..500, exact acknowledgement) → `gate.waived` (`unmet` ids, `waivedBy`); `sign_off` for a gate whose outcome is `blocked` → `GateNotMetError`; a decision for a gate that does not apply is ignored and not recorded. If any applicable gate is left without a recorded decision, the transaction commits one `gate.blocked` (every unresolved gate with its outcome and unmet ids) and `move` throws `GateBlockedError(evaluations)`; otherwise the events are `[…gate events, card.moved]`. A non-human actor with any applicable gate that is not `pass` → `HumanRequiredError` before anything is recorded. Waiver reasons go through `redact` as in Task 4 (`SecretInTextError`). `BoardService.moveCard` is kept for tests and internal use; the HTTP route uses `GateService.move` only.

Routes: `POST /api/cards/:id/move` body `{ to, gates?: GateDecisionInput[] }` (`gates` max 10); `GET /api/cards/:id/gates?to=<stage>` → `GateEvaluation[]`. Error map: `GateBlockedError` → 409 `{ error: "gate_blocked", gates }`; `GateNotMetError` → 409 `{ error: "gate_not_met", gateId, unmet }`.

- [ ] **Step 1: Write failing tests** (a project with a completed intake for an internet-facing, paying, account-holding idea, and a second project with none):
  - conditions: each condition met and unmet (`within_budget` with spend 10.01 of 10 → unmet with the detail string; no budget → `No budget has been set`);
  - service: `evaluate(card in build, "ship")` for the first project is `ready_to_ship` (`needs_sign_off`), `network_exposure`, `payments`, `personal_data`; for the second project `ready_to_ship` is `blocked` with `intake_completed` unmet; `move` with no decisions → `GateBlockedError`, one `gate.blocked` entry listing four gates, no `card.moved` **(Review Focus 1)**; `move` with four `sign_off` decisions and the exact sentences → four `gate.signed_off` then one `card.moved`, consecutive seqs, card in Ship; a `sign_off` for the second project's `ready_to_ship` → `GateNotMetError` and nothing recorded **(Review Focus 1)**; a `waive` with reason `"deadline"` → ZodError; with a 12-character reason and the sentence → `gate.waived` with `unmet: ["intake_completed"]` then `card.moved`; actor `{ kind: "system", id: "runner" }` → `HumanRequiredError` **(Review Focus 1)**; `from: "plan"` to `build` without an intake → blocked by `plan_approved` only, and with a completed intake → passes with no gate event and one `card.moved`; `over_budget` applies to a move from `build` to `design` when spend exceeds the budget and can only be waived; **(Review Focus 2)** evaluate `"operate"` → all met, then start a fake run on the card with a pending action, then `move` with the sign-off → `GateNotMetError` naming `no_pending_actions`; after the action is denied and the run finished, the same call succeeds; a waiver reason containing `sk-ant-TESTKEY-0000000000` → `SecretInTextError` **(Review Focus 4)**; rebuild equals live after the sequence;
  - routes: `POST …/move { to: "ship" }` → 409 `gate_blocked` whose body has four `gates` with `conditions`; with decisions → 200 and the card in Ship; `GET …/gates?to=ship` → the evaluations, 400 for `to=nowhere`; a non-human actor cannot be sent over HTTP, so assert the service test instead; without the cookie → 401.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): readiness gates on lifecycle moves, derived from the ledger, with recorded sign-offs, waivers and blocked attempts`

---

### Task 6: Card story and the audit export

**Files:** Create `packages/core/src/story/story.ts`, `packages/core/src/server/story-routes.ts`. Modify `packages/core/src/ledger/ledger.ts`, `server.ts`, `index.ts`. Tests `packages/core/test/ledger/ledger.test.ts`, `packages/core/test/story/story.test.ts`, `packages/core/test/server/story-routes.test.ts`.

**Interfaces:**
```ts
// ledger.ts
list(q: { projectId?: string; afterSeq?: number; limit?: number; cardId?: string; runIds?: string[] }): LedgerEntry[];
// cardId / runIds: keep entries where json_extract(payload, '$.cardId') = cardId OR json_extract(payload, '$.runId') IN (runIds); runIds capped at 200
// story/story.ts
export type CardStory = { card: Card; runs: AgentRun[]; actions: AgentAction[]; entries: LedgerEntry[]; gateDecisions: GateDecision[]; costUsd: number | null };
export function cardStory(db: Db, ledger: Ledger, cardId: string): CardStory;   // NotFoundError; entries in seq order, paged through list(); costUsd = sum over runs or null when none reported
export function narrationContext(db: Db): NarrationContext;                     // cardTitle from cards, adapterName from agent_runs (ADAPTER label: Claude / Codex / Gemini / Fake)
// story-routes.ts
GET /api/cards/:id/story   → CardStory
GET /api/ledger/export?projectId=<id>   → 200 application/x-ndjson, Content-Disposition: attachment; filename="theterminal-ledger-<projectId or all>.ndjson"
```
Export body: first line `{ "kind": "header", "exportedAt": <ISO>, "projectId": <id or null>, "headSeq": <n>, "integrity": <ledger.verify()> }`, then one line per entry (pages of 500 through `ledger.list`, streamed as a `Readable`) `{ "kind": "entry", …entry, "headline": narrate(entry, narrationContext(db)).headline }`. Nothing is added that the ledger does not hold except the header and the headline.

- [ ] **Step 1: Write failing tests:**
  - ledger: `list({ cardId })` returns `card.created`, `card.moved` and `gate.signed_off` for that card and not another card's; `list({ runIds: [a] })` returns run a's `agent.*` entries and not run b's; both together union; `runIds` of 201 → RangeError;
  - story: a card with two runs (one allowed shell action with output, one denied) and a waiver → `entries` hold the card events, both runs' events and the waiver in seq order; `runs.length` 2, `actions.length` 2, `costUsd` equals the fake's reported sum; `narrationContext(db).cardTitle(cardId)` is the title and `.adapterName(runId)` is `Fake`;
  - routes: `GET /api/cards/:id/story` → the story; unknown → 404; `GET /api/ledger/export?projectId=` → the content type and disposition headers, a header line with `integrity.ok: true`, a line whose `headline` is `Owner created the project "Book Club"`, and line count = entries + 1; without `projectId` every project's entries; without the cookie → 401.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(core): a card's story from the ledger; NDJSON audit export with narrated headlines`

---

### Task 7: Narration in the feed, the ledger and the decision card; ledger topics and export

**Files:** Modify `apps/ui/src/components/LedgerPanel.tsx`, `apps/ui/src/views/LedgerSideBar.tsx`, `apps/ui/src/views/AgentFeedPanel.tsx`, `apps/ui/src/components/DecisionCard.tsx`, `apps/ui/src/shell/model.ts`, `apps/ui/src/App.tsx`, `apps/ui/src/api.ts`, `apps/ui/src/styles.css`. Tests `apps/ui/test/{LedgerPanel,AgentFeedPanel,DecisionCard,LedgerSideBar}.test.tsx`.

**Interfaces and copy:**
```ts
// api.ts
exportLedgerUrl(projectId: string | null): string;   // "/api/ledger/export" or "?projectId=…"
// model.ts
ledgerTopics: NarrationTopic[];  onLedgerTopicsChange(topics: NarrationTopic[]): void;   // default: every topic
narration: NarrationContext;      // cardTitle from model.board, adapterName from model.runs
// LedgerPanel.tsx
export const describeEntry = (e: LedgerEntry, ctx?: NarrationContext) => narrate(e, ctx).headline;   // kept for callers and tests
export function LedgerPanel(props: { entries: LedgerEntry[]; topics?: NarrationTopic[]; ctx?: NarrationContext }): JSX.Element;
```
- Ledger panel: each `<li>` shows the time, the headline, and when `detail` is not null a `<details><summary>Raw</summary><pre>…</pre></details>` holding the detail and the canonical payload; entries whose `attention` is true carry class `attention`; entries outside `topics` are not rendered. Side bar: a `fieldset` with legend `Show` and one checkbox per topic labelled `Board`, `Agents`, `Decisions`, `Gates`, `Intake`, `Connections`, `Settings`, `Other`; a link `Export for audit` (`<a download href={exportLedgerUrl(scope === "all" ? null : selectedId)}>`) with the note `Downloads every entry as one line of JSON with its hash chain and a plain-language headline.`
- Agent feed: each action renders `narrateAction(a).headline`, the status word, `decidedBy`, and `<details><summary>Raw</summary>` with the input JSON and, when present, the output; the run's `agent.message` entries from `model.entries` are shown in order as `The agent said: …` items. The old `summary · status` line goes.
- Decision card: `<h3>` becomes `Agent wants to <actionPhrase(action)>`; a `<p className="means">` shows `ACTION_KIND_MEANS[kind]`; the existing command block, Details and the hidden-characters note stay. `aria-label` stays `Decision: <summary>` so 5A/5B selectors hold.

- [ ] **Step 1: Write failing tests:** `describeEntry` for a `connection.added` entry equals the 5A string; a `card.moved` entry with a ctx resolving the title renders `Owner moved "Login" from Build to Ship`; the Raw details hold the payload; an `attention` entry has the class; topics `["gate"]` hide a board entry; the side bar renders eight checkboxes and the export link with `download` and the project query; the feed renders `Wants to run the command "nvidia-smi"` for a pending shell action and the raw output after completion; the decision card shows the phrase and the shell `means` sentence; the existing 5A/5B `describeEntry` assertions still pass.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): plain-language narration with the raw record underneath in the feed, the ledger and decision cards; ledger topics and audit export`

---

### Task 8: The Plan intake tab

**Files:** Create `apps/ui/src/views/IntakePanel.tsx`, `apps/ui/src/components/IntakeDecisionCard.tsx`. Modify `apps/ui/src/views/ProjectsSideBar.tsx`, `apps/ui/src/shell/{Dock,dock-layout,Workbench,StatusBar}.tsx`, `model.ts`, `App.tsx`, `api.ts`, `styles.css`. Tests `apps/ui/test/{IntakePanel,IntakeDecisionCard,ProjectsSideBar,StatusBar,Workbench}.test.tsx`.

**Interfaces and copy:**
```ts
// api.ts
Status gains intakeDecisions: number;
getIntake(projectId): Promise<IntakeView | null>;   // 404 no_intake → null
startIntake(projectId, idea); answerIntake(projectId, questionId, answer); decideIntake(projectId, decisionId, chosen, rationale?); completeIntake(projectId); reopenIntake(projectId, reason);
// model.ts
intake: IntakeView | null | undefined;   // undefined while loading; reloaded on any intake.* or card.* entry of the selected project
onStartIntake(idea): Promise<boolean>; onAnswerIntake(questionId, answer): Promise<boolean>; onDecideIntake(decisionId, chosen, rationale?): Promise<boolean>; onCompleteIntake(): Promise<boolean>; onReopenIntake(reason): Promise<boolean>;
// Dock.tsx
export type DockPanelId = … | "intake" | `story:${string}`;   // DEFAULTS gains intake: { title: "Plan intake", where: "main" }; PANELS gains intake: IntakePanel (Task 8) and story: StoryPanel (Task 9)
```
- Projects side bar: under the project list, for the selected project, a line `Plan: not started` / `Plan: <n> of 9 questions answered` / `Plan: <n> decision(s) to make` / `Plan: ready to approve` / `Plan: approved <date>` and a button `Plan intake` that focuses the `intake` tab.
- `IntakePanel` (`section[aria-label="Plan intake"]`), by `step`: no intake → the permanence notice (Global Constraints), a textarea `Describe your idea` and a button `Begin`; `answer` → every question in catalog order as a labelled field (`text` → textarea, `choice` → radios, `multi` → checkboxes, `number` → `input type="number" min="0" step="0.01"`), its `help` under the label, saved on blur or on `Save answer`, a progress line `<n> of 9 answered`; `decide` → one `IntakeDecisionCard` per decision; `approve` → heading `Your plan`, the summary paragraph, a list `Cards this adds to the board` grouped by stage, and a button `Approve plan` with the note `Approving records this plan in the ledger and adds the cards. You can reopen it later.`; `completed` → the summary, `Approved <date>`, and `Reopen plan` with a reason input (`Why are you reopening?`, required). Errors: `intake_incomplete` → `Answer every question and make every decision first`; `secret_in_text` → `That text looks like it contains a key or password. It was not saved.`; `intake_completed` → `This plan is approved. Reopen it to change answers.`
- `IntakeDecisionCard` (`article[aria-label="Decision: <question>"]`): the question; `Because you answered:` with the `because` pairs; options as radios, each with its `tradeoffs`, the recommended one marked `Recommended`; `What this means` (`learn`) and `Risk` (`risk`); an optional `Why (optional)` input; button `Decide`. Decided cards show `Decided by <owner> on <date>: <label>`.
- Status bar: `Needs you: <pendingDecisions + intakeDecisions>`; Workbench's strip shows, when `model.intake?.step === "decide"`, a `div.needs-you-item` reading `Your plan needs <n> decision(s)` with a button `Open intake` focusing the tab.

- [ ] **Step 1: Write failing tests:** no intake → `Begin` posts the idea; the `answer` view renders nine fields with their labels and `help`, a radio change calls `answerIntake(…, "payments", "yes")`; `decide` renders the cards with `Recommended` on `smallest`, choosing `full` and clicking `Decide` calls `decideIntake("first_version", "full", "")`; `approve` renders the summary and the card titles and `Approve plan` calls `completeIntake`; `completed` renders `Reopen plan` disabled until a reason is typed; the side bar line for each step and the button focuses `intake` (mock dock); the status bar shows `Needs you: 3` for `pendingDecisions: 1, intakeDecisions: 2`; the strip item appears in the `connections` view with the bottom panel closed (Review Focus 5 of 5A, extended).
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): guided Plan intake tab with decision cards, plan approval and reopening`

---

### Task 9: Gate cards in the Needs-you strip, the card story tab, runs on a card

**Files:** Create `apps/ui/src/components/GateCard.tsx`, `apps/ui/src/views/StoryPanel.tsx`. Modify `apps/ui/src/components/Board.tsx`, `AgentPanel.tsx`, `apps/ui/src/views/AgentsSideBar.tsx`, `apps/ui/src/shell/Workbench.tsx`, `model.ts`, `App.tsx`, `api.ts`, `styles.css`. Tests `apps/ui/test/{GateCard,StoryPanel,Board,AgentPanel,Workbench,App}.test.tsx`.

**Interfaces and copy:**
```ts
// api.ts
getCardGates(cardId, to): Promise<GateEvaluation[]>;
moveCard(cardId, to, gates?: GateDecisionInput[]): Promise<Card>;   // 409 gate_blocked → ApiError with detail { gates }
getCardStory(cardId): Promise<CardStory>;
startRun(projectId, { adapter, prompt, cardId?, connectionIds? });
// model.ts
gate: { cardId: string; cardTitle: string; to: Stage; evaluations: GateEvaluation[] } | null;   // evaluations re-fetched on any agent.*, card.*, intake.* or gate.* entry of the project while set
onMoveCard(cardId, to): Promise<void>;                 // GET gates; every outcome pass → move; else set `gate`
onResolveGate(decisions: GateDecisionInput[]): Promise<boolean>;   // move with decisions; gate_blocked → refresh evaluations and keep the card; success → clear
onCancelGate(): void;
onOpenStory(cardId): void;                             // dock.open(`story:<id>`, <title>, "main")
story: (cardId) => Promise<CardStory>;
onStartRun(adapter, prompt, cardId?: string | null): Promise<boolean>;
```
- `GateCard` (`article[aria-label="Gate: <title>"]`), one per evaluation whose outcome is not `pass`: the title, `Moving "<card>" to <Stage>`, the explanation, `Risks` as a list, the checklist (`✓`/`✗` with each label and detail, `aria-label="met"`/`"unmet"`), `What this means` (`learn`), a checkbox with the exact acknowledgement sentence, and buttons: `Sign off` (only when `met`, enabled when acknowledged), `Waive` (only when not `met`, enabled when acknowledged and `Why are you proceeding anyway?` has ≥ 10 characters; the input shows `At least 10 characters`), `Cancel`. The strip's footer has `Move "<card>" to <Stage>` enabled once every gate card has a decision, which calls `onResolveGate`. A card that passed (`outcome: "pass"`) is listed in one line `Passed: <title>`. Errors: `gate_not_met` → `Something changed: a condition is no longer met. The checklist was refreshed.`; `gate_blocked` → same refresh.
- Board: the card title becomes a button (`aria-label="Open the story of <title>"`) calling `onOpenStory`; `Move to…` calls the gated `onMoveCard`.
- `StoryPanel` (`section[aria-label="Story: <title>"]`): header with the title, stage, status, `Agent cost so far: $<x.xx> (estimate)` or `No agent cost recorded`; `What happened` as an ordered list of `narrate(entry, ctx)` headlines, where `ctx` is built from `story.card` and `story.runs` (so the adapter is named), with time and, under each, `<details><summary>Raw</summary>` holding the detail and the payload; `Decisions and why` listing `agent.action.decided` by a human, `gate.signed_off`, `gate.waived` and `intake.decided` entries with their reasons; `Nothing has happened on this card yet.` when only `card.created` exists. Loaded on open and reloaded on any entry whose `refs` name the card or one of its runs.
- Agents side bar: a `select` labelled `Card (optional)` listing the project's cards with `No card` first; `Start agent` passes the chosen `cardId`.

- [ ] **Step 1: Write failing tests:** GateCard: a blocked gate shows `✗` for `The plan has been approved`, `Waive` disabled until the box is ticked and 10 characters typed, then `Move "Login" to Ship` calls `onResolveGate([{ gateId, decision: "waive", reason, acknowledgement }])`; a met gate shows `Sign off` and no reason input; Board: clicking the title calls `onOpenStory`; App/model: `moveCard` with all-pass evaluations posts the move at once and with a blocked one sets `gate` and renders the card in the strip while the `connections` view is active with the bottom panel closed; a 409 `gate_not_met` on resolve shows the refresh note and keeps the card; StoryPanel: a story with an allowed shell action on a fake run renders `The Fake agent wants to run the command "nvidia-smi"`, `Owner allowed it`, `Done (1 line of output)` with the raw output under it, and the cost line; AgentPanel: the card select is sent as `cardId`.
- [ ] **Step 2:** Run `pnpm --filter @theterminal/ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(ui): readiness gate cards in the Needs-you strip, a story tab for every card, and runs tied to cards`

---

### Task 10: Documentation and changelog

**Files:** Create `docs/glass-box.md`. Modify `CHANGELOG.md` (an `Added` block for this plan), `README.md` (one paragraph: describe an idea, approve the plan, gates, story). Tests: none beyond `pnpm test` staying green; the doc is reviewed by reading.

`docs/glass-box.md` covers: that narration is a deterministic template over ledger entries and is never stored; that an optional model summary, if ever added, would be opt-in, labelled and never the source of truth; the intake as events (what each event holds, that text is permanent and checked for secrets, that re-planning reopens and reuses cards by title); the gates (the seven ids, what triggers each, each condition in plain words, sign-off versus waiver, what `gate.blocked` records, that evaluation happens inside the move's transaction); the card story and which entries it includes; the audit export format line by line and how to verify the hash chain from it; what later plans add (agent-proposed decisions, roles, share view, pausing runs on budget).

- [ ] **Step 1:** Write the sections. Run `pnpm test`. Expected: PASS.
- [ ] **Step 2: Commit:** `docs: the glass box: narration, intake, readiness gates, card stories and the audit export`

---

### Task 11: End-to-end: intake to plan, gates on a move, a card's story, the export

**Files:** Create `e2e/intake.spec.ts`, `e2e/gates.spec.ts`, `e2e/story.spec.ts`. Modify `e2e/global-setup.ts` (nothing new in env; the fake script's shell step and its `nvidia-smi` summary are reused), `e2e/board.spec.ts` (card moves now go through the gated flow: a move out of Plan without an intake shows the `Plan approved` gate card, which the spec waives).

- [ ] **Step 1: Write the failing e2e tests:**
  - intake: create project `Book Club` → `Plan intake` → the permanence notice is visible → describe → answer the nine questions (`private`, `no`, `none`, budget `25`) → two decision cards, `Recommended` on `The smallest version that proves the idea` → decide both → `Your plan` shows the summary containing `Book Club is for` and `Agent budget: $25.00` → `Approve plan` → the Board shows `Define what "done" means` in Plan, `Run it on this computer` in Ship and `Monitoring and health checks` in Operate → the Ledger tab shows `Owner approved the plan (5 cards added)`; reopen with a reason, change `payments` to `Yes`, decide `payments_scope`, approve → exactly one new card `Payments readiness review` and the Ship column holds two cards **(Review Focus 5)**;
  - gates: a new project without an intake; `+ Add` a card `Login` in Build; `Move to… Ship` → the strip shows `Gate: Ready to ship` with `✗ The plan has been approved`; `Waive` stays disabled until the acknowledgement is ticked and `We are only testing this` is typed; `Move "Login" to Ship` → the card is in Ship and the ledger shows `Owner waived "Ready to ship" for "Login": We are only testing this` **(Review Focus 1)**; then start the fake agent on `Login` (card select) and, while its shell step is pending, `Move to… Operate` → `Gate: Going live` shows `✗ The plan has been approved` and `✗ No agent is waiting for a decision in this project` **(Review Focus 2)**; allow the step; the second line refreshes to `✓` while the first stays `✗`, so `Sign off` is absent and `Waive` with a reason moves the card to Operate; the ledger shows the waiver with `unmet` naming only the plan condition;
  - story: click `Login` → `Story: Login` tab shows `The Fake agent wants to run the command "nvidia-smi"`, `Owner allowed it`, `Done (1 line of output)` and, under `Raw`, the recorded output; the `Decisions and why` section lists the waiver; `Export for audit` downloads `theterminal-ledger-<id>.ndjson` whose first line has `"kind":"header"` and some line has `"headline":"Owner waived`; the decision card during the run shows `What this means` with the shell sentence;
  - with the bottom panel closed and `Connections` selected, the gate card still renders in the strip;
  - `GET /api/cards/<id>/story`, `GET /api/projects/<id>/intake` and `GET /api/ledger/export` without the cookie → 401.
- [ ] **Step 2:** Run `pnpm e2e`. Expected: FAIL.
- [ ] **Step 3:** Fix whatever the tests expose.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: PASS. Push; CI must be green on macOS and Windows. Open the pull request from `plan-3-intake-glass-box` to `main`.
- [ ] **Step 5: Commit:** `test(e2e): guided intake to an approved plan, readiness gates on moves, card stories and the audit export`

---

## Done when

- A person describes an idea in the Plan intake tab, answers nine questions, makes the decisions the answers raise (each with options, a recommendation, trade-offs, a risk and what it means), reads the plan in plain language and approves it; the approval and the cards it adds are one ledger transaction, and every decision names the human who made it.
- Moving a card to Ship or Operate (or out of Plan, or while over budget) stops at readiness gates that explain the step, show a checklist derived from the ledger, and require the Owner's sign-off with the exact acknowledgement, or a waiver with a reason; sign-offs, waivers and blocked attempts are in the ledger; a stale sign-off is refused.
- Every ledger entry reads in plain language in the ledger panel, the agent feed, the decision card and a card's story, with the raw record underneath; the same ledger reads the same everywhere, with no model involved.
- The ledger can be filtered by topic and exported for audit as NDJSON with the hash chain and a headline per line.
- Text written into the intake or a waiver that looks like a secret is refused and never recorded.
- `pnpm test` and `pnpm e2e` are green on macOS and Windows CI; the work is merged to `main` through a pull request.
