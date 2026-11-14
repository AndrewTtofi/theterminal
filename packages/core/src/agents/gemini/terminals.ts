import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { heldTailStart } from "../redact.js";

export type ExitStatus = { exitCode: number | null; signal: string | null };
export type TerminalOutput = { output: string; truncated: boolean; exitStatus: ExitStatus | null };

/** Output kept per terminal (the tail); a smaller agent-requested limit is honoured. */
export const MAX_TERMINAL_OUTPUT = 1024 * 1024;
const KILL_GRACE_MS = 5000;

type Terminal = {
  child: ChildProcess;
  limit: number;
  /** The tail of the output, for the agent: its own command's output, as it was printed. */
  output: string;
  truncated: boolean;
  /**
   * The output for the record. Null while `output` is still whole (then they are the same). From the first cut on it
   * is kept apart: cleaned before every cut, so a cut never parts a secret from the context redaction finds it by,
   * or leaves a fragment of one at the start. Empty for good once `clean` has failed: the record is withheld.
   */
  record: string | null;
  withheld: boolean;
  exit: ExitStatus | null;
  exited: Promise<ExitStatus>;
};

/**
 * The terminals we run for the agent after a gate allowed them: spawned without a shell, with the
 * output tail kept under a byte cap. Every terminal is ours alone; ids the agent did not get from us
 * are unknown. `onExit` reports each terminal's outcome once, with the output for the record, so the
 * gated action gets its result.
 */
export class Terminals {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly spawn: typeof nodeSpawn,
    /** The run's live redaction, applied to the record before each cut. */
    private readonly clean: (s: string) => string,
    private readonly onExit: (terminalId: string, status: ExitStatus, record: string) => void,
  ) {}

  create(command: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outputByteLimit?: number | null }): string {
    const terminalId = randomUUID();
    const limit = typeof o.outputByteLimit === "number" && o.outputByteLimit > 0 ? Math.min(o.outputByteLimit, MAX_TERMINAL_OUTPUT) : MAX_TERMINAL_OUTPUT;
    const child = this.spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const t: Terminal = {
      child, limit, output: "", truncated: false, record: null, withheld: false, exit: null, exited: Promise.resolve({ exitCode: null, signal: null }),
    };
    t.exited = new Promise<ExitStatus>((resolve) => {
      let settled = false;
      const finish = (status: ExitStatus) => {
        if (settled) return;
        settled = true;
        t.exit = status;
        resolve(status);
        this.onExit(terminalId, status, this.record(t));
      };
      child.on("error", (e) => {
        this.append(t, `${e.message}\n`);
        finish({ exitCode: null, signal: null });
      });
      child.on("close", (code, signal) => finish({ exitCode: code, signal }));
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => this.append(t, decoder.write(chunk)));
      stream.on("end", () => this.append(t, decoder.end()));
    }
    this.terminals.set(terminalId, t);
    return terminalId;
  }

  output(terminalId: string): TerminalOutput | undefined {
    const t = this.terminals.get(terminalId);
    return t && { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }

  waitForExit(terminalId: string): Promise<ExitStatus> | undefined {
    return this.terminals.get(terminalId)?.exited;
  }

  kill(terminalId: string): boolean {
    const t = this.terminals.get(terminalId);
    if (!t) return false;
    this.terminate(t);
    return true;
  }

  release(terminalId: string): boolean {
    const t = this.terminals.get(terminalId);
    if (!t) return false;
    this.terminate(t);
    this.terminals.delete(terminalId);
    return true;
  }

  /** Kills every terminal still running and waits (bounded) for them to exit. */
  async closeAll(): Promise<void> {
    const open = [...this.terminals.values()];
    this.terminals.clear();
    for (const t of open) this.terminate(t);
    await Promise.all(open.map((t) => t.exited));
  }

  private terminate(t: Terminal): void {
    if (t.exit !== null) return;
    try {
      t.child.kill();
    } catch {
      // Already gone.
    }
    const hard = setTimeout(() => {
      try {
        t.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    void t.exited.then(() => clearTimeout(hard));
  }

  private append(t: Terminal, text: string): void {
    if (text === "") return;
    const whole = t.output + text;
    if (t.record !== null && !t.withheld) t.record += text;
    if (Buffer.byteLength(whole, "utf8") <= t.limit) {
      t.output = whole;
      return;
    }
    // The first cut: the record starts from the whole output, which is still here.
    if (t.record === null) t.record = whole;
    t.output = tail(whole, t.limit);
    t.truncated = true;
    // Cleaned and cut once it holds twice the cap, so each byte is cleaned a bounded number of times however long
    // the output runs, while the cleaned text before a cut always holds the whole of the kept tail's secrets.
    if (!t.withheld && Buffer.byteLength(t.record, "utf8") > 2 * t.limit) this.cutRecord(t, false);
  }

  /** The record at exit: the output itself while it was never cut, else the record cleaned and cut one last time. */
  private record(t: Terminal): string {
    if (t.record === null) return t.output;
    this.cutRecord(t, true);
    return t.record;
  }

  /**
   * Cleans the record, then keeps its last `limit` bytes without the partial word a cut leaves at the start. While
   * output may still come (`final` false), the tail that may go on (see `heldTailStart`) stays raw and whole: cleaned
   * alone, a secret the output is still in the middle of could be redacted and its rest, still to come, left plain.
   * Only the cleaned part is cut, so the record holds at most `limit` bytes plus that tail (at most 8 KiB). A clean
   * that throws withholds the record for good: what it would have let through is unknown.
   */
  private cutRecord(t: Terminal, final: boolean): void {
    if (t.withheld) return;
    const all = t.record!;
    const held = final ? all.length : heldTailStart(all);
    const raw = all.slice(held);
    try {
      const cleaned = this.clean(all.slice(0, held));
      const room = t.limit - Buffer.byteLength(raw, "utf8");
      const kept = Buffer.byteLength(cleaned, "utf8") <= room ? cleaned : room <= 0 ? "" : tail(cleaned, room).replace(/^\S*/, "");
      t.record = kept + raw;
    } catch {
      t.record = "";
      t.withheld = true;
    }
  }
}

/** The last `limit` bytes of `s`, cut at a character boundary (a partial leading character decodes to U+FFFD and is dropped). */
function tail(s: string, limit: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= limit) return s;
  return buf.subarray(buf.length - limit).toString("utf8").replace(/^�/, "");
}
