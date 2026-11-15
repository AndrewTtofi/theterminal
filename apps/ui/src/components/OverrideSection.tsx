import { useEffect, useId, useRef, useState } from "react";
import { OVERRIDE_MEANS, OVERRIDE_PROGRAM, plural, visibleControls } from "@theterminal/shared";
import type { AgentRun, LedgerEntry, RunChanges } from "@theterminal/shared";
import { useShell } from "../shell/model";

/** What the override does and does not protect, said plainly: it is the Owner acting outside every safeguard. */
const SCOPE =
  "It runs as you, outside the agent gate and the working copy's sandbox, and it can change files. Anything it starts, including scripts an agent wrote, is not checked.";
const COMMAND_NOTE =
  "The program is started directly, not through a shell, with no connection keys in its environment. Anything you can reach, including files in your home folder, stays reachable to the program. Output is recorded in the ledger.";
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

/** Focuses the element once `when` turns true: the step that just opened, or the control it went back to. */
function useFocusWhen<T extends HTMLElement>(when: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (when) ref.current?.focus();
  }, [when]);
  return ref;
}

/** The confirm step's buttons and the refusal, when the server refused; the step stays open so the Owner can go Back. */
function ConfirmActions({ confirm, busy, error, onConfirm, onBack }: {
  confirm: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <>
      {error !== null && (
        <p role="alert" className="override-error">
          {error}
        </p>
      )}
      <div className="override-actions">
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
          {confirm}
        </button>
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}

type Step = "closed" | "reason" | "confirm";

function DiscardForm({ run, disabled }: { run: AgentRun; disabled: boolean }) {
  const { model } = useShell();
  const [step, setStep] = useState<Step>("closed");
  /** Set by Back, so focus returns to the button that opened the confirmation, and only then. */
  const [backed, setBacked] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState("");
  const id = useId();
  const n = uncommittedCount(model.changes, run.id);
  const whyRef = useFocusWhen<HTMLInputElement>(step === "reason" && !backed);
  const goRef = useFocusWhen<HTMLButtonElement>(step === "reason" && backed);
  const confirmRef = useFocusWhen<HTMLDivElement>(step === "confirm");

  const go = (next: Step, back = false) => {
    setStep(next);
    setBacked(back);
    setError(null);
    if (next !== "closed") setRecorded("");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const out = await model.onOverrideDiscard(run.id, reason.trim());
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setReason("");
    go("closed");
    setRecorded(`Recorded: ${plural(out.files, "uncommitted file")} discarded. Watch the Ledger or the Terminal for the result.`);
  };

  return (
    <fieldset disabled={disabled}>
      <legend>Discard this run's changes</legend>
      <p className="note">{DISCARD_NOTE}</p>
      {step === "closed" ? (
        <button type="button" onClick={() => go("reason")}>
          Discard…
        </button>
      ) : (
        <>
          <label htmlFor={`${id}-why`}>{WHY}</label>
          <input
            id={`${id}-why`}
            ref={whyRef}
            value={reason}
            maxLength={REASON_MAX}
            readOnly={step === "confirm"}
            onChange={(e) => setReason(e.target.value)}
          />
          {step === "reason" ? (
            <div className="override-actions">
              {/* The cached count may be stale, so a count of 0 does not stop the discard; the server's count is shown after. */}
              <button type="button" ref={goRef} className="danger" disabled={!reasonOk(reason)} onClick={() => go("confirm")}>
                {n === null || n === 0 ? "Discard uncommitted changes" : `Discard ${plural(n, "file")}`}
              </button>
              <button type="button" onClick={() => go("closed")}>
                Cancel
              </button>
            </div>
          ) : (
            <div role="group" aria-label="Confirm the discard" className="override-confirm" tabIndex={-1} ref={confirmRef}>
              <p>This runs git reset --hard and git clean -fd in the run's folder. Commits the agent made are kept.</p>
              <ConfirmActions
                confirm="Confirm discard"
                busy={busy}
                error={error}
                onConfirm={() => void submit()}
                onBack={() => go("reason", true)}
              />
            </div>
          )}
        </>
      )}
      <p role="status">{recorded}</p>
    </fieldset>
  );
}

/** One argument as the confirm step shows it: in visible quotes, so leading and trailing spaces can be seen. */
const quoted = (a: string) => `\u201c${visibleControls(a)}\u201d`;

function CommandForm({ run, disabled }: { run: AgentRun; disabled: boolean }) {
  const { model } = useShell();
  const [program, setProgram] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwd, setCwd] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  /** Set by Back, so focus returns to Run as override, and only then. */
  const [backed, setBacked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState("");
  const id = useId();
  const confirmRef = useFocusWhen<HTMLDivElement>(confirming);
  const runRef = useFocusWhen<HTMLButtonElement>(!confirming && backed);

  const prog = program.trim();
  const args = argsOf(argsText);
  const folder = cwd.trim();
  const argsOk = args.length <= ARGS_MAX && args.every((a) => a.length <= ARG_MAX);
  const valid = programOk(prog) && argsOk && folder.length <= CWD_MAX && reasonOk(reason);
  const step = (open: boolean, back = false) => {
    setConfirming(open);
    setBacked(back);
    setError(null);
  };
  /** Any edit leaves the confirmation, so what is confirmed is always what is sent. */
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    step(false);
    setRecorded("");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const out = await model.onOverrideCommand(run.id, {
      program: prog,
      args,
      ...(folder !== "" && { cwd: folder }),
      reason: reason.trim(),
    });
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    step(false);
    setProgram("");
    setArgsText("");
    setCwd("");
    setReason("");
    setRecorded(RECORDED);
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
        <button type="button" ref={runRef} className="danger" disabled={!valid} onClick={() => step(true)}>
          Run as override
        </button>
      ) : (
        <div role="group" aria-label="Confirm the override" className="override-confirm" tabIndex={-1} ref={confirmRef}>
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
                    <code>{quoted(a)}</code>
                  </li>
                ))}
              </ol>
            </>
          )}
          <p>
            In: {folder === "" ? "the top of the working copy" : <code>{visibleControls(folder)}</code>}
          </p>
          <ConfirmActions
            confirm="Confirm and run"
            busy={busy}
            error={error}
            onConfirm={() => void submit()}
            onBack={() => step(false, true)}
          />
        </div>
      )}
      <p role="status">{recorded}</p>
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
  // The project stream, not the Ledger panel's page: that one may hold every project's entries, or none while it loads.
  const busy = overrideActive(model.projectEntries, run.id);
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
