import { LedgerPanel } from "../components/LedgerPanel";
import { useShell } from "../shell/model";

/** Bottom tab: the ledger, newest first. LedgerPanel renders the `aside[aria-label="Ledger"]`. */
export function LedgerBottomPanel() {
  const { model } = useShell();
  if (model.ledgerScope === "project" && !model.selectedId) {
    return <p className="empty">Select a project to see its ledger, or show all projects from the Ledger view.</p>;
  }
  return <LedgerPanel entries={model.entries} />;
}
