import { LedgerPanel } from "../components/LedgerPanel";
import { useShell } from "../shell/model";

/** Bottom tab: the ledger, newest first. LedgerPanel renders the `aside[aria-label="Ledger"]`. */
export function LedgerBottomPanel() {
  const { model } = useShell();
  if (model.ledgerScope === "project" && !model.selectedId) {
    return <p className="empty">Select a project to see its ledger, or show all projects from the Ledger view.</p>;
  }
  // Keyed by what it shows, so choosing another project or scope starts again from the newest page.
  return (
    <LedgerPanel
      key={model.ledgerScope === "all" ? "all" : `project:${model.selectedId}`}
      entries={model.entries}
      topics={model.ledgerTopics}
      ctx={model.narration}
      hasOlder={model.ledgerHasOlder}
      onLoadOlder={() => void model.onLoadOlderLedger()}
      loadingOlder={model.ledgerOlder.loading}
      olderError={model.ledgerOlder.error}
    />
  );
}
