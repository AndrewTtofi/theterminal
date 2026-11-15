import { useEffect } from "react";
import { AgentPanel } from "../components/AgentPanel";
import { useShell } from "../shell/model";

/** Start form and run list; the selected run's actions show in the Agent feed panel. */
export function AgentsSideBar() {
  const { model, dock } = useShell();
  const linked = (model.status?.machines?.linked ?? 0) > 0;
  const refreshMachines = model.machines?.refresh;
  // The Run on picker lists the paired machines with whether they answer now.
  useEffect(() => {
    if (linked) refreshMachines?.();
  }, [linked, refreshMachines]);
  if (!model.selectedId) return <p className="empty">Select a project to start an agent.</p>;
  if (!model.agentsInfo) return <p className="empty">Loading agents…</p>;
  return (
    <AgentPanel
      adapters={model.agentsInfo.adapters}
      providers={model.agentsInfo.providers}
      connections={model.connections.list}
      cards={model.board ? Object.values(model.board.columns).flat() : []}
      runs={model.runs}
      selectedRunId={model.selectedRunId}
      offline={model.status?.network.state === "offline"}
      onStart={model.onStartRun}
      onSelectRun={(runId) => {
        model.onSelectRun(runId);
        if (runId) dock()?.focus("agent_feed");
      }}
      onStop={model.onStopRun}
      machines={model.machines?.overview?.machines ?? []}
      {...(model.machines?.capacity !== undefined && { machineCapacity: model.machines?.capacity })}
      {...(model.narration?.machineName !== undefined && { machineName: model.narration?.machineName })}
    />
  );
}
