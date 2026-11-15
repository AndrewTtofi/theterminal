import { useId, useState } from "react";
import { OVERRIDE_MEANS, OVERRIDE_PROGRAM, plural, visibleControls } from "@theterminal/shared";
import type { AgentRun, LedgerEntry, RunChanges } from "@theterminal/shared";
import { useShell } from "../shell/model";

/** What the override does and does not protect, said plainly: it is the Owner acting outside every safeguard. */
const SCOPE =
  "It runs as you, outside the agent gate and the working copy's sandbox, and it can change files. Anything it starts, including scripts an agent wrote, is not checked.";
const COMMAND_NOTE =
  "The program is started directly, not through a shell, with no connection keys in its environment; files in your home folder are still readable. Output is recorded in the ledger.";
const DISCARD_NOTE =
  "Drops every change in this working copy that is not committed (git reset --hard HEAD, then git clean -fd). Commits the agent made are kept.";
const WHY = "Why? (required, at least 10 characters)";
const RECORDED = "Recorded. Watch the Ledger or the Terminal for the result.";
const REASON_MIN = 10;
const REASON_MAX = 500;
const PROGRAM_MAX = 260;
const ARGS_MAX = 64;
const ARG_MAX = 1000;
const CWD_MAX = 500;

const reasonOk = (r: string) => r.trim().length >= REASON_MIN && r.trim().length <= REASON_MAX;
/** A bare program name, or an absolute path (POSIX, or a Windows drive or UNC path); the server decides the rest. */
const programOk = (p: string) =>
  p.length > 0 && p.length <= PROGRAM_MAX && (OVERRIDE_PROGRAM.test(p) || /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p));
/** One argument per line; blank lines are dropped and a Windows line ending is not part of the argument. */
const argsOf = (text: string) =>
  text
    .split("\n")
    .map((a) => a.replace(/\r$/, ""))
    .filter((a) => a.trim() !== "");

/** True while an override.command or override.discard of the run has no override.completed yet. */
function overrideActive(entries: LedgerEntry[], runId: string): boolean {
  const open = new Set<string>();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (!e.type.startsWith("override.") || typeof e.payload !== "object" || e.payload === null) continue;
    const p = e.payload as Record<string, unknown>;
    if (p.runId !== runId || typeof p.overrideId !== "string") continue;
    if (e.type === "override.completed") open.delete(p.overrideId);
    else open.add(p.overrideId);
  }
  return open.size > 0;
}

/**
 * How many files a discard would drop, or null when that is not known: the changes are compared with the run's
 * starting point, so they count only uncommitted files when the agent made no commit (head is still the base).
 */
function uncommittedCount(c: RunChanges | null, runId: string): number | null {
  if (c === null || c.runId !== runId || c.tooMany || c.truncated || c.head !== c.base) return null;
  return c.files.length;
}

function DiscardForm({ run, disabled }: { run: AgentRun; disabled: boolean }) {
  const { model } = useShell();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const id = useId();
  const n = uncommittedCount(model.changes, run.id);

  const submit = async () => {
    setBusy(true);
    setDone(false);
    const ok = await model.onOverrideDiscard(run.id, reason.trim());
    setBusy(false);
    if (!ok) return;
    setReason("");
    setOpen(false);
    setDone(true);
  };

  return (
    <fieldset disabled={disabled}>
      <legend>Discard this run's changes</legend>
      <p className="note">{DISCARD_NOTE}</p>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setDone(false);
          }}
        >
          Discard…
        </button>
      ) : (
        <>
          <label htmlFor={`${id}-why`}>{WHY}</label>
          <input id={`${id}-why`} value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} />
          <div className="override-actions">
            <button type="button" className="danger" disabled={busy || !reasonOk(reason) || n === 0} onClick={() => void submit()}>
              {n === null ? "Discard uncommitted changes" : n === 0 ? "Nothing to discard" : `Discard ${plural(n, "file")}`}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {done && <p role="status">{RECORDED}</p>}
    </fieldset>
  );
}

function CommandForm({ run, disabled }: { run: AgentRun; disabled: boolean }) {
  const { model } = useShell();
  const [program, setProgram] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwd, setCwd] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const id = useId();

  const prog = program.trim();
  const args = argsOf(argsText);
  const folder = cwd.trim();
  const argsOk = args.length <= ARGS_MAX && args.every((a) => a.length <= ARG_MAX);
  const valid = programOk(prog) && argsOk && folder.length <= CWD_MAX && reasonOk(reason);
  /** Any edit leaves the confirmation, so what is confirmed is always what is sent. */
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setConfirming(false);
    setDone(false);
  };

  const submit = async () => {
    setBusy(true);
    const ok = await model.onOverrideCommand(run.id, {
      program: prog,
      args,
      ...(folder !== "" && { cwd: folder }),
      reason: reason.trim(),
    });
    setBusy(false);
    setConfirming(false);
    if (!ok) return;
    setProgram("");
    setArgsText("");
    setCwd("");
    setReason("");
    setDone(true);
  };

  return (
    <fieldset disabled={disabled}>
      <legend>Run a command in this run's working copy</legend>
      <label htmlFor={`${id}-program`}>Program</label>
      <input id={`${id}-program`} placeholder="git" value={program} maxLength={PROGRAM_MAX} onChange={edit(setProgram)} />
      <label htmlFor={`${id}-args`}>Arguments (one per line)</label>
      <textarea id={`${id}-args`} rows={3} value={argsText} onChange={edit(setArgsText)} />
      {!argsOk && <p className="note">At most {ARGS_MAX} arguments of {ARG_MAX.toLocaleString("en-US")} characters each.</p>}
      <label htmlFor={`${id}-cwd`}>Folder (optional, inside the working copy)</label>
      <input id={`${id}-cwd`} value={cwd} maxLength={CWD_MAX} onChange={edit(setCwd)} />
      <label htmlFor={`${id}-why`}>{WHY}</label>
      <input id={`${id}-why`} value={reason} maxLength={REASON_MAX} onChange={edit(setReason)} />
      <p className="note">{COMMAND_NOTE}</p>
      {!confirming ? (
        <button type="button" className="danger" disabled={!valid} onClick={() => setConfirming(true)}>
          Run as override
        </button>
      ) : (
        <div role="group" aria-label="Confirm the override" className="override-confirm">
          <p>This runs, as you, outside the agent gate and the sandbox:</p>
          <p>
            Program: <code>{visibleControls(prog)}</code>
          </p>
          {args.length === 0 ? (
            <p>No arguments.</p>
          ) : (
            <>
              <p>Arguments, each passed as one:</p>
              <ol>
                {args.map((a, i) => (
                  <li key={i}>
                    <code>{visibleControls(a)}</code>
                  </li>
                ))}
              </ol>
            </>
          )}
          <p>
            In: {folder === "" ? "the top of the working copy" : <code>{visibleControls(folder)}</code>}
          </p>
          <div className="override-actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void submit()}>
              Confirm and run
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </button>
          </div>
        </div>
      )}
      {done && <p role="status">{RECORDED}</p>}
    </fieldset>
  );
}

/**
 * The emergency override for one run: the Owner discarding its uncommitted changes, or running one program in its
 * working copy. Both need a reason, are refused while the agent runs or another override of the run is unfinished,
 * and are recorded in red in the ledger.
 */
export function OverrideSection({ run }: { run: AgentRun }) {
  const { model, openLearn } = useShell();
  const running = run.status === "running";
  const busy = overrideActive(model.entries, run.id);
  const disabled = running || busy;
  return (
    <details className="override">
      <summary>Emergency override</summary>
      <p>
        {OVERRIDE_MEANS} {SCOPE}{" "}
        <button type="button" className="link" onClick={() => openLearn("emergency_override")}>
          Learn more
        </button>
      </p>
      {running ? (
        <p className="note">Stop the agent first.</p>
      ) : (
        busy && <p className="note">An override is already running for this run</p>
      )}
      <DiscardForm run={run} disabled={disabled} />
      <CommandForm run={run} disabled={disabled} />
    </details>
  );
}
