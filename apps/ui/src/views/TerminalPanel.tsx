import { useMemo } from "react";
import { visibleControls } from "@theterminal/shared";
import type { LedgerEntry } from "@theterminal/shared";
import { stripAnsi } from "../components/text";
import { useShell } from "../shell/model";
import { FollowSelect } from "./AgentFeedPanel";
import { useFollowBottom } from "./use-follow-bottom";

/** One line of the Terminal tab, derived from one ledger entry. */
export type TerminalItem = {
  key: string;
  kind: "command" | "typed" | "denied" | "output" | "override" | "override_output";
  text: string;
  runId: string;
  ok?: boolean;
};

/** The most lines the Terminal paints: the newest ones. */
const TERMINAL_LIMIT = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** Recorded text as the Owner reads it: terminal codes dropped, hidden characters shown as escapes. */
const clean = (s: string) => visibleControls(stripAnsi(s));

/**
 * The commands agents ran in a project and what came of them, and the Owner's override commands, oldest first:
 * every run's when `runId` is null, else that run's. Pure; keeps the newest 500 lines.
 */
export function terminalItems(entries: LedgerEntry[], runId: string | null): TerminalItem[] {
  const shellActions = new Set<string>();
  const items: TerminalItem[] = [];
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const p = isRecord(e.payload) ? e.payload : {};
    const run = str(p.runId);
    if (run === undefined || (runId !== null && run !== runId)) continue;
    const push = (kind: TerminalItem["kind"], text: string, ok?: boolean) =>
      items.push({ key: String(e.seq), kind, text: clean(text), runId: run, ...(ok !== undefined && { ok }) });
    const action = str(p.actionId);
    switch (e.type) {
      case "agent.action.requested": {
        if (p.kind !== "shell" || action === undefined) break;
        shellActions.add(action);
        const input = isRecord(p.input) ? p.input : {};
        if (p.tool === "codex.stdin") push("typed", `> ${str(input.reason) ?? str(p.summary) ?? ""}`);
        else push("command", `$ ${str(input.command) ?? str(p.summary) ?? ""}`);
        break;
      }
      case "agent.action.decided": {
        if (p.decision !== "deny" || action === undefined || !shellActions.has(action)) break;
        const reason = str(p.reason) ?? "";
        push("denied", reason === "" ? "denied" : `denied: ${reason}`);
        break;
      }
      case "agent.action.completed": {
        const output = str(p.output);
        if (action !== undefined && shellActions.has(action) && output) push("output", output, p.ok === true);
        break;
      }
      case "override.command": {
        const args = Array.isArray(p.args) ? p.args.filter((a): a is string => typeof a === "string") : [];
        push("override", `# OVERRIDE ${[str(p.program) ?? "", ...args].join(" ")}`);
        break;
      }
      case "override.discard":
        // What a discard runs is fixed, so the line says it; its git output follows with override.completed.
        push("override", "# OVERRIDE discard: git reset --hard HEAD, then git clean -fd");
        break;
      case "override.completed": {
        const output = str(p.output);
        if (output) push("override_output", output, p.ok === true);
        break;
      }
    }
  }
  return items.slice(-TERMINAL_LIMIT);
}

/** A line's classes: its kind, red for an override, and `failed` for an output that did not succeed. */
function lineClass(i: TerminalItem): string {
  const names = [`term-${i.kind}`];
  if (i.kind === "override" || i.kind === "override_output") names.push("override");
  if (i.ok === false) names.push("failed");
  return names.join(" ");
}

/** Bottom tab: a read-only terminal view of the commands run in the project, derived from the ledger. */
export function TerminalPanel() {
  const { model } = useShell();
  const { projectEntries, feedRunId } = model;
  const items = useMemo(() => terminalItems(projectEntries, feedRunId), [projectEntries, feedRunId]);
  const follow = useFollowBottom<HTMLOListElement>(items.map((i) => i.key));
  return (
    <section className="terminal" aria-label="Terminal">
      <div className="feed-head">
        <FollowSelect />
      </div>
      {/* A log the keyboard can scroll; not read aloud line by line, since commands can pour out quickly. */}
      <ol
        className="terminal-lines"
        role="log"
        aria-live="off"
        aria-label="Terminal output"
        tabIndex={0}
        ref={follow.ref}
        onScroll={follow.onScroll}
      >
        {items.map((i) => (
          <li key={i.key} data-key={i.key} className={lineClass(i)}>
            {i.kind === "override_output" && (
              <>
                <span className="override-tag">OVERRIDE</span>{" "}
              </>
            )}
            {i.text}
          </li>
        ))}
      </ol>
      {follow.away && (
        <button type="button" className="jump" onClick={follow.jump}>
          Jump to latest <span role="status">({follow.fresh} new)</span>
        </button>
      )}
      <p className="note">
        Read-only. Agents run commands and you approve them. To run something yourself, use the emergency override in the Changes
        view.
      </p>
    </section>
  );
}
