import { test, expect } from "@playwright/test";
import {
  allow,
  decisionCard,
  ledgerItems,
  line,
  lineMatching,
  newestRunId,
  openProject,
  openView,
  prepareRun,
  projectEntries,
  RUN_FINISHED,
  startRun,
} from "./support.js";

const REASON = "Checking the override path end to end";
const DISCARD_REASON = "Throwing away the notes the agent wrote";
const WHY = "Why? (required, at least 10 characters)";

test("the emergency override waits for the agent to stop, then runs a command and a discard, recorded in red", async ({ page }) => {
  const name = "Override Project";
  await openProject(page, name);
  const ledger = ledgerItems(page);

  // While the run's shell step waits for the Owner, the agent is still working: the override is refused.
  await prepareRun(page, "fake", "Write some notes");
  await startRun(page);
  // This project's card: the run exists once it shows, so the newest run read next is this one.
  await expect(decisionCard(page, "Run: nvidia-smi", name)).toBeVisible();
  const runId = await newestRunId(page, name);
  await openView(page, "Changes");
  const override = page.locator("details.override");
  await override.getByText("Emergency override", { exact: true }).click();
  await expect(override.getByText("Stop the agent first.", { exact: true })).toBeVisible();
  const discard = override.getByRole("group", { name: "Discard this run's changes" });
  const command = override.getByRole("group", { name: "Run a command in this run's working copy" });
  await expect(discard.getByRole("button", { name: "Discard…" })).toBeDisabled();
  await expect(command.getByLabel("Program")).toBeDisabled();
  await expect(command.getByLabel(WHY)).toBeDisabled();
  await expect(command.getByRole("button", { name: "Run as override" })).toBeDisabled();
  // The server refuses it too, and records nothing.
  const refused = await page.evaluate(async (id) => {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/override/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ program: "node", args: ["-e", "1"], reason: "Trying while the agent works" }),
    });
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  }, runId);
  expect(refused).toEqual({ status: 409, error: "run_active" });
  expect((await projectEntries(page, name)).filter((e) => e.type.startsWith("override."))).toEqual([]);

  // Once the step is allowed and the run has finished, the forms open.
  await allow(page, "Run: nvidia-smi");
  await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(1);
  await expect(override.getByText("Stop the agent first.", { exact: true })).toHaveCount(0);

  // A command: program, one argument per line, a reason, then the confirmation that shows exactly what runs.
  await command.getByLabel("Program").fill("node");
  await command.getByLabel("Arguments (one per line)").fill('-e\nconsole.log("override says hi")');
  await command.getByLabel(WHY).fill(REASON);
  await command.getByRole("button", { name: "Run as override" }).click();
  const confirm = command.getByRole("group", { name: "Confirm the override" });
  await expect(confirm.getByRole("listitem")).toHaveText(["“-e”", "“console.log(\"override says hi\")”"]);
  await confirm.getByRole("button", { name: "Confirm and run" }).click();
  await expect(command.getByRole("status")).toHaveText("Recorded. Watch the Ledger or the Terminal for the result.");

  // The Terminal shows the override command and its output in red.
  await page.getByRole("tab", { name: "Terminal" }).click();
  const terminal = page.getByRole("log", { name: "Terminal output" }).getByRole("listitem");
  const ran = terminal.filter({ hasText: /^# OVERRIDE / });
  await expect(ran).toHaveText(['# OVERRIDE node -e console.log("override says hi")']);
  await expect(ran).toHaveClass(/\boverride\b/);
  const said = terminal.filter({ hasText: "override says hi" }).filter({ hasNotText: /^# OVERRIDE / });
  await expect(said).toHaveText(["OVERRIDE override says hi"]);
  await expect(said).toHaveClass(/\boverride\b/);

  // The Ledger records both phases, in red.
  await page.getByRole("tab", { name: "Ledger" }).click();
  const recorded = line(
    ledger,
    `OVERRIDE: Owner ran "node -e console.log(\\"override says hi\\")" in the Fake agent's working copy: ${REASON}`,
  );
  await expect(recorded).toHaveCount(1);
  await expect(recorded).toHaveClass(/\boverride\b/);
  const finished = line(ledger, "Override finished (exit 0)");
  await expect(finished).toHaveCount(1);
  await expect(finished).toHaveClass(/\boverride\b/);

  // A discard drops the untracked notes.txt the agent wrote.
  await expect(page.getByText(/^1 file changed · /)).toBeVisible();
  await discard.getByRole("button", { name: "Discard…" }).click();
  await discard.getByLabel(WHY).fill(DISCARD_REASON);
  await discard.getByRole("button", { name: "Discard 1 file" }).click();
  await discard.getByRole("group", { name: "Confirm the discard" }).getByRole("button", { name: "Confirm discard" }).click();
  await expect(discard.getByRole("status")).toHaveText(
    "Recorded: 1 uncommitted file discarded. Watch the Ledger or the Terminal for the result.",
  );
  await expect(page.getByText(/^0 files changed · /)).toBeVisible();
  await expect(page.getByRole("list", { name: "Changed files" }).getByRole("listitem")).toHaveCount(0);
  const discarded = line(ledger, `OVERRIDE: Owner discarded 1 changed file(s) of the Fake agent's run: ${DISCARD_REASON}`);
  await expect(discarded).toHaveCount(1);
  await expect(discarded).toHaveClass(/\boverride\b/);
  await expect(line(ledger, "Override finished (exit 0)")).toHaveCount(2);
});
