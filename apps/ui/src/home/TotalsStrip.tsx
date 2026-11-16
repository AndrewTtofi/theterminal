import { formatUsd } from "@theterminal/shared";
import { useShell } from "../shell/model";
import { waitingCount } from "./ApprovalsBlock";

/** Which total, if any, switches Working now or Finished today to every project. */
export type HomeFilter = "working" | "finished" | null;

type Props = {
  filter: HomeFilter;
  onFilter(f: HomeFilter): void;
  /** "need you": scrolls to the approvals block and focuses its heading. */
  onNeedYou(): void;
};

/** Totals across every project: working, need you, done today and today's cost. Cost is not a filter. */
export function TotalsStrip({ filter, onFilter, onNeedYou }: Props) {
  const { model } = useShell();
  const status = model.status;
  const waiting = waitingCount(model);
  const count = (n: number | undefined) => (status === null || n === undefined ? "–" : String(n));
  const toggle = (f: Exclude<HomeFilter, null>) => {
    // The same total again switches back to the selected project.
    const next = filter === f ? null : f;
    onFilter(next);
    model.home.setScope(next === null ? "project" : "all");
  };
  return (
    <section className="home-totals" aria-label="Totals">
      <button type="button" className="total" aria-pressed={filter === "working"} onClick={() => toggle("working")}>
        <b>{count(status?.runningAgents)}</b> working
      </button>
      <button type="button" className={`total${waiting > 0 ? " attention" : ""}`} onClick={onNeedYou}>
        <b>{waiting}</b> need you
      </button>
      <button type="button" className="total" aria-pressed={filter === "finished"} onClick={() => toggle("finished")}>
        <b>{count(status === null ? undefined : (status.doneToday ?? 0))}</b> done today
      </button>
      <span className="total total-cost">
        <span>today</span> <b>{status === null ? "–" : formatUsd(status.todayCostUsd)}</b>
      </span>
    </section>
  );
}
