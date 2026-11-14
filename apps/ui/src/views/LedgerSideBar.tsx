import { useShell } from "../shell/model";
import type { LedgerScope } from "../shell/model";

const SCOPES: { value: LedgerScope; label: string }[] = [
  { value: "project", label: "This project" },
  { value: "all", label: "All projects" },
];

export function LedgerSideBar() {
  const { model, dock } = useShell();
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
      <button type="button" onClick={() => dock()?.focus("ledger")}>
        Open ledger panel
      </button>
    </div>
  );
}
