// A stand-in for a provider CLI's login and status commands, for tests only. It never touches the network or
// any credential.
//
// THETERMINAL_FAKE_LOGIN: JSON { exit?: 0, status?: 0, statusDelayMs?: 0, hang?: false, lines?: string[],
//   pidFile?: "…", envFile?: "…", countFile?: "…", grandchildPidFile?: "…", ignoreTerm?: false }.
//   A run whose arguments contain "status" exits with `status` (after `statusDelayMs`) and prints nothing useful.
//   Any other run prints `lines` (default: a device URL and code on the provider's domain), then exits with `exit`,
//   or never exits when `hang` is set. `pidFile` receives the process id, so a test can check it was killed;
//   `envFile` receives the names of its environment variables; `countFile` gets one line per run.
//   `grandchildPidFile`: also starts a child process that never exits on its own (as a browser or a native helper
//   would) and writes its pid there; with `grandchildIgnoreTerm` it ignores SIGTERM too. `ignoreTerm`: ignore
//   SIGTERM, so only SIGKILL ends this process.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const script = JSON.parse(process.env.THETERMINAL_FAKE_LOGIN ?? "{}");
const args = process.argv.slice(2);
if (script.pidFile) writeFileSync(script.pidFile, String(process.pid));
if (script.envFile) writeFileSync(script.envFile, JSON.stringify(Object.keys(process.env)));
if (script.countFile) appendFileSync(script.countFile, "run\n");
if (script.ignoreTerm) process.on("SIGTERM", () => undefined);

if (args.includes("status")) {
  process.stdout.write("status checked\n");
  setTimeout(() => process.exit(script.status ?? 0), script.statusDelayMs ?? 0);
} else {
  if (script.grandchildPidFile) {
    // The grandchild writes its own pid once its handlers are in place, so a test that waits for the file sees it ready.
    const code = `${script.grandchildIgnoreTerm ? "process.on('SIGTERM',()=>{}); " : ""}require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)`;
    spawn(process.execPath, ["-e", code, script.grandchildPidFile], { stdio: "ignore" });
  }

  const lines = script.lines ?? [
    "Follow these steps to sign in:",
    "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
    "ABCD-12345",
  ];
  for (const line of lines) process.stdout.write(line + "\n");

  if (script.hang) {
    setInterval(() => undefined, 1000);
  } else {
    // Let the output drain before exiting.
    setTimeout(() => process.exit(script.exit ?? 0), 20);
  }
}
