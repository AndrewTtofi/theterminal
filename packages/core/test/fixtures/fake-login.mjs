// A stand-in for a provider CLI's login and status commands, for tests only. It never touches the network or
// any credential.
//
// THETERMINAL_FAKE_LOGIN: JSON { exit?: 0, status?: 0, hang?: false, lines?: string[], pidFile?: "…", envFile?: "…" }.
//   A run whose arguments contain "status" exits with `status` and prints nothing useful.
//   Any other run prints `lines` (default: a device URL and code on the provider's domain), then exits with `exit`,
//   or never exits when `hang` is set. `pidFile` receives the process id,
//   so a test can check it was killed; `envFile` receives the names of its environment variables.
import { writeFileSync } from "node:fs";

const script = JSON.parse(process.env.THETERMINAL_FAKE_LOGIN ?? "{}");
const args = process.argv.slice(2);
if (script.pidFile) writeFileSync(script.pidFile, String(process.pid));
if (script.envFile) writeFileSync(script.envFile, JSON.stringify(Object.keys(process.env)));

if (args.includes("status")) {
  process.stdout.write("status checked\n");
  process.exit(script.status ?? 0);
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
