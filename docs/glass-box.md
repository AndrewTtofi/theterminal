# The glass box: plans, readiness gates and the audit trail

The Terminal keeps a permanent record of what happens in a project, and it shows you that record in plain language. This page explains how the plain-language lines are made, how planning is recorded, which checks stand in front of risky moves, and how to export and verify the whole record.

The record is the ledger: an append-only list of events where each entry includes the hash of the one before it. Changing or removing an entry breaks the chain, and the break is reported rather than hidden.

## Plain-language lines (narration)

Next to the raw ledger entries, the Ledger panel and each card's story show a one-line headline such as `Wants to run the command "npm test"`. The agent feed uses the same lines for each action, and a decision card asks in the same words ("Agent wants to run the command …"). These lines have three properties.

- **Local and deterministic.** A headline is built from a fixed template and the entry's own fields, on your computer. No model is involved, and the same entry always gives the same headline.
- **Never stored.** Headlines are computed whenever they are shown or exported. They are not written to the ledger, so they can never disagree with, or replace, what the ledger holds.
- **Honest.** A headline is not allowed to hide anything. A long command is cut with "(and n more lines)" so you know there is more. Characters that are invisible or that reverse the direction of text are shown as visible escapes (for example `\u202e`) instead of being applied. The raw entry is always one click away.

If a model-written summary is ever added, it will be opt-in and clearly labelled, and it will never be the source of truth.

## Planning is recorded (intake)

When you describe an idea for a project, The Terminal asks a short series of questions, then a few decisions that depend on your answers (for example how much the first version should include, or how to protect a product that others can reach). Everything is recorded as ledger events:

| Event | What it holds |
| --- | --- |
| `intake.started` | The idea you typed. |
| `intake.answered` | One answer to one question. |
| `intake.decided` | A decision, the option you chose, your reason and who decided. |
| `intake.completed` | The approved plan summary and the cards it created or reused. |
| `intake.reopened` | Your reason for changing the answers. |

What you should know:

- **The record is permanent.** Text you type becomes part of the ledger and cannot be edited or deleted later. If you change your mind, you reopen the plan and answer again; the earlier answers stay in the history.
- **Secrets are refused, never stored.** Everything you type is checked for secrets, such as API keys and tokens. The check runs on the text as you wrote it and again after paths are cleaned up, so a secret that contains a path or your username is still caught. If something looks like a secret, the step is refused, nothing is recorded, and the message names the field to change without repeating the text. Project names and card titles get the same check and the same path rewriting.
- **Paths are rewritten.** Your home folder is recorded as `~` and your username as `<user>`, so the ledger carries no personal paths.
- **Re-planning reuses cards.** Approving a plan creates its cards. If you reopen and approve again, a card whose title already exists in the project is reused instead of duplicated.
- **A human decides.** Agents cannot answer, decide, approve or reopen a plan.

## Readiness gates

A gate is a check that stands in front of a move on the board. It explains the risk in plain words and lists its conditions. The seven gates are:

| Gate | Raised when | Conditions |
| --- | --- | --- |
| Plan approved | A card leaves Plan | The plan has been approved. |
| Ready to ship | A card moves to Ship | The plan is approved; no agent is waiting for a decision in the project; no agent is still working on the card. |
| Network exposure | A card moves to Ship and you said the product is reachable on your network or the internet | You have decided who may use it. |
| Taking payments | A card moves to Ship and the product takes payments | You have decided how payments are handled. |
| Holding personal data | A card moves to Ship and the product keeps personal data | You have decided how much data to keep. |
| Going live | A card moves to Operate | Same conditions as Ready to ship. |
| Over budget | A move when agent spend is above the budget you set during planning | Spend is within the budget. |

Gates are evaluated at the moment of the move, from the current ledger, inside the same transaction that records the move. A gate cannot be satisfied by something that was true earlier but is no longer true.

**Clearing a gate.** There are two ways, and both are recorded:

- **Sign off.** Possible when every condition holds. You confirm by typing the gate's exact acknowledgement sentence. The ledger records `gate.signed_off` with the conditions and your confirmation.
- **Waive.** Possible when a condition is unmet and you choose to go ahead anyway. You give the same confirmation and a reason of 10 to 500 characters, which is checked for secrets like any typed text. The ledger records `gate.waived` with the unmet conditions and your reason. A gate whose conditions hold needs a sign-off, not a waiver. The Plan approved gate has no sign-off: the plan is either approved or the gate is waived.

**Blocked attempts are recorded.** If you try a move and a gate has no decision, the card does not move and the ledger records a `gate.blocked` event listing the gates and what was unmet. Only a human can clear a gate; an agent's move that would raise one is refused.

**Where cards can be created.** You can add a card directly to Plan, Design or Build. Only Ship and Operate are gated at creation: a card created there would skip the gates a move runs, so create it earlier and move it. The exception is the cards created by approving a plan, since approving the plan is itself your decision.

## Card story

Each card has a story: everything that happened to it, in order. It includes:

- the card's own events (created and moved);
- the gate events: sign-offs, waivers and blocked attempts;
- its agent runs, their actions and approvals;
- the plan it came from: the approval and the decisions made before it;
- the cost of its runs.

Cost figures are labelled "estimate". Some providers report no cost and some costs are computed from usage, so a total is never presented as a bill. A run that reported no cost shows as not reported, not as zero.

The story checks the ledger's hash chain each time it is read. If the chain is broken, the story says so and names the first broken entry. Entries that cannot be read are listed as unreadable. Nothing is quietly left out.

## Audit export

Use **Export** in the Ledger panel (or `GET /api/ledger/export`, with an optional `projectId`) to download the record as NDJSON: one JSON object per line. The file is named `theterminal-ledger-<project or all>.ndjson`.

1. **Header.** One line with `kind: "header"`, the export time, the project (or null for everything), `headSeq` (the last entry included) and `integrity`: `{"ok":true}` or `{"ok":false,"brokenAtSeq":n}`.
2. **Entries.** One line per entry, with `kind: "entry"`, all ledger fields (`seq`, `id`, `ts`, `projectId`, `actor`, `type`, `payload`, `prevHash`, `hash`) and a `headline`. With a project, you get that project's entries plus the connection uses of its runs. Later entries are never mixed in, because the export stops at `headSeq`.
3. **Gaps.** A line with `kind: "gap"` and a `seq` appears where an entry is `missing` or `unreadable`. Gaps appear in every export, including project exports, so tampering is never hidden.
4. **Trailer.** The last line, `kind: "end"`, holds `lastSeq` and the number of `gaps`. A file without it was cut short.

Headlines are computed during the export and are not part of the hash. Secrets are already redacted in the ledger itself.

### Verifying the chain

For each entry line, rebuild the object `{seq, id, ts, projectId, actor, type, payload, prevHash}` and serialise it as canonical JSON: object keys sorted at every level, no whitespace. The SHA-256 of that text, in lowercase hex, must equal `hash`, and `prevHash` must equal the previous entry's `hash`. The first entry's `prevHash` is 64 zeros. Checking the chain end to end needs the whole-ledger export, where every `seq` is consecutive from 1. A project export leaves out other projects' entries, so the links between its entries cannot be checked on their own. For a project export, rely on the `integrity` result in the header, which The Terminal computed over the whole ledger.

## Roles

For now there is one role, the Owner, and every human decision (answers, plan approval, sign-offs and waivers) is recorded as theirs. Other roles arrive in a later release.

## Coming later

Agent-proposed decisions, roles, a shareable read-only view and pausing agent runs when a budget is reached are planned for later releases.
