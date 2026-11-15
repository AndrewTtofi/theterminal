import type { NarrationTopic } from "@theterminal/shared";
import { exportLedgerUrl } from "../api";
import { LEDGER_TOPICS, useShell } from "../shell/model";
import type { LedgerScope } from "../shell/model";

const SCOPES: { value: LedgerScope; label: string }[] = [
  { value: "project", label: "This project" },
  { value: "all", label: "All projects" },
];

const TOPIC_LABELS: Record<NarrationTopic, string> = {
  board: "Board",
  agent: "Agents",
  decision: "Decisions",
  gate: "Gates",
  intake: "Intake",
  connection: "Connections",
  settings: "Settings",
  other: "Other",
};

export function LedgerSideBar() {
  const { model, dock } = useShell();
  const toggle = (topic: NarrationTopic, on: boolean) =>
    model.onLedgerTopicsChange(LEDGER_TOPICS.filter((t) => (t === topic ? on : model.ledgerTopics.includes(t))));
  // Every project's entries, one project's, or nothing to export yet (this project chosen, none selected).
  const exportFrom = model.ledgerScope === "all" ? null : (model.selectedId ?? undefined);
  return (
    <div className="ledger-side">
      <fieldset>
        <legend>Show entries from</legend>
        {SCOPES.map((s) => (
          <label key={s.value}>
            <input
              type="radio"
              name="ledger-scope"
              value={s.value}
              checked={model.ledgerScope === s.value}
              onChange={() => model.onLedgerScopeChange(s.value)}
            />
            {s.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Show</legend>
        {LEDGER_TOPICS.map((t) => (
          <label key={t}>
            <input type="checkbox" checked={model.ledgerTopics.includes(t)} onChange={(e) => toggle(t, e.target.checked)} />
            {TOPIC_LABELS[t]}
          </label>
        ))}
      </fieldset>
      <button type="button" onClick={() => dock()?.focus("ledger")}>
        Open ledger panel
      </button>
      <p className="ledger-export">
        {exportFrom === undefined ? (
          <>
            <button type="button" disabled aria-describedby="ledger-export-hint ledger-export-note">
              Export for audit
            </button>
            <span id="ledger-export-hint" className="hint">
              Select a project
            </span>
          </>
        ) : (
          <a download href={exportLedgerUrl(exportFrom)} aria-describedby="ledger-export-note">
            Export for audit
          </a>
        )}
        <span id="ledger-export-note" className="note">Downloads every entry as one line of JSON with its hash chain and a plain-language headline.</span>
      </p>
    </div>
  );
}
