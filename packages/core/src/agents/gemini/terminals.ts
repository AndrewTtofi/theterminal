import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type ExitStatus = { exitCode: number | null; signal: string | null };
export type TerminalOutput = { output: string; truncated: boolean; exitStatus: ExitStatus | null };

/** Output kept per terminal (the tail); a smaller agent-requested limit is honoured. */
export const MAX_TERMINAL_OUTPUT = 1024 * 1024;
const KILL_GRACE_MS = 5000;

type Terminal = {
  child: ChildProcess;
  limit: number;
  output: string;
  truncated: boolean;
  exit: ExitStatus | null;
  exited: Promise<ExitStatus>;
};

/**
 * The terminals we run for the agent after a gate allowed them: spawned without a shell, with the
 * output tail kept under a byte cap. Every terminal is ours alone; ids the agent did not get from us
 * are unknown. `onExit` reports each terminal's outcome once, so the gated action gets its result.
 */
export class Terminals {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly spawn: typeof nodeSpawn,
    private readonly onExit: (terminalId: string, status: ExitStatus, output: string, truncated: boolean) => void,
  ) {}

  create(command: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outputByteLimit?: number | null }): string {
    const terminalId = randomUUID();
    const limit = typeof o.outputByteLimit === "number" && o.outputByteLimit > 0 ? Math.min(o.outputByteLimit, MAX_TERMINAL_OUTPUT) : MAX_TERMINAL_OUTPUT;
    const child = this.spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const t: Terminal = { child, limit, output: "", truncated: false, exit: null, exited: Promise.resolve({ exitCode: null, signal: null }) };
    t.exited = new Promise<ExitStatus>((resolve) => {
      let settled = false;
      const finish = (status: ExitStatus) => {
        if (settled) return;
        settled = true;
        t.exit = status;
        resolve(status);
        this.onExit(terminalId, status, t.output, t.truncated);
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
    t.output += text;
    if (Buffer.byteLength(t.output, "utf8") <= t.limit) return;
    // Keep the tail, cut at a character boundary (a partial leading character decodes to U+FFFD and is dropped).
    const buf = Buffer.from(t.output, "utf8");
    t.output = buf.subarray(buf.length - t.limit).toString("utf8").replace(/^�/, "");
    t.truncated = true;
  }
}
