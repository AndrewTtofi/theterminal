import { test, expect } from "@playwright/test";
import {
  SECRET_LIKE,
  SECRET_REFUSED,
  addCard,
  allow,
  anonymousUrl,
  checklistLine,
  gateCard,
  ledgerItems,
  line,
  lineMatching,
  moveButton,
  openProject,
  openView,
  prepareRun,
  projectEntries,
  projectId,
  RUN_FINISHED,
  startRun,
  waive,
} from "./support.js";

const STAGE_GATED = "Add the card to an earlier stage, then move it, so its readiness checks run.";

test("a card cannot be created in Ship or Operate: it is added earlier and moved, so its gates run", async ({ page }) => {
  const name = "Gate Shortcut";
  await openProject(page, name);
  await page.getByLabel("Add card to Ship").fill("Skip the checks");
  await page.getByLabel("Add card to Ship").press("Enter");
  await expect(page.getByText(STAGE_GATED)).toBeVisible();
  await expect(page.getByRole("region", { name: "Ship" }).getByText("Skip the checks")).toHaveCount(0);

  const id = await projectId(page, name);
  const res = await page.evaluate(async (pid) => {
    const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Skip the checks", stage: "operate" }),
    });
    return { status: r.status, body: (await r.json()) as unknown };
  }, id);
  expect(res).toEqual({ status: 409, body: { error: "stage_gated", message: STAGE_GATED } });
  expect((await projectEntries(page, name)).map((e) => e.type)).toEqual(["project.created"]);
});

test("moves stop at readiness gates: a waiver with a reason, and a checklist that refreshes as an agent finishes", async ({ page }) => {
  const name = "Gate Checks";
  await openProject(page, name);
  const ledger = ledgerItems(page);
  await addCard(page, "Build", "Login");

  // With the bottom panel closed and Connections selected, the gate card still renders in the strip.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("tab", { name: "Ledger" })).not.toBeInViewport();
  await openView(page, "Connections");
  await page.getByLabel("Move Login to").selectOption("ship");
  const ship = gateCard(page, "Ready to ship");
  await expect(ship).toBeVisible();
  await expect(checklistLine(ship, "The plan has been approved")).toContainText("✗ The plan has been approved");
  await expect(checklistLine(ship, "No agent is waiting for a decision in this project")).toContainText("✓");
  await expect(ship.getByRole("button", { name: "Sign off" })).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("tab", { name: "Ledger" })).toBeInViewport();
  await openView(page, "Board");

  // Waive stays disabled until the acknowledgement is ticked and a reason of at least 10 characters is typed.
  const waiveButton = ship.getByRole("button", { name: "Waive" });
  await expect(waiveButton).toBeDisabled();
  await ship.getByRole("checkbox").check();
  await expect(waiveButton).toBeDisabled();
  await ship.getByLabel("Why are you proceeding anyway?").fill("too short");
  await expect(waiveButton).toBeDisabled();
  await expect(moveButton(page, "Login", "Ship")).toBeDisabled();

  // A reason that looks like a secret is refused and never recorded.
  await ship.getByLabel("Why are you proceeding anyway?").fill(`only testing ${SECRET_LIKE}`);
  await waiveButton.click();
  await moveButton(page, "Login", "Ship").click();
  await expect(page.getByText(SECRET_REFUSED)).toBeVisible();
  await expect(page.getByRole("region", { name: "Build" }).getByText("Login")).toBeVisible();
  expect(JSON.stringify(await projectEntries(page, name))).not.toContain("TESTKEY");

  await waive(ship, "We are only testing this");
  await moveButton(page, "Login", "Ship").click();
  await expect(ship).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Ship" }).getByText("Login")).toBeVisible();
  await expect(line(ledger, 'Owner waived "Ready to ship" for "Login": We are only testing this')).toHaveCount(1);
  await expect(line(ledger, 'Owner moved "Login" from Build to Ship')).toHaveCount(1);

  // The fake agent works on Login; while its shell step waits for the Owner, a move to Operate is held back.
  await prepareRun(page, "fake", "Check the login page");
  await page.getByLabel("Card (optional)").selectOption({ label: "Login" });
  await startRun(page);
  const decision = page.getByRole("article", { name: "Decision: Run: nvidia-smi" });
  await expect(decision).toBeVisible();
  await openView(page, "Board");
  await page.getByLabel("Move Login to").selectOption("operate");
  const live = gateCard(page, "Going live");
  await expect(live).toBeVisible();
  await expect(checklistLine(live, "The plan has been approved")).toContainText("✗ The plan has been approved");
  await expect(checklistLine(live, "No agent is waiting for a decision in this project")).toContainText(
    "✗ No agent is waiting for a decision in this project",
  );

  // Once the step is allowed and the run has finished, the checklist refreshes: only the plan is still missing.
  await allow(page, "Run: nvidia-smi");
  await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(1);
  await expect(checklistLine(live, "No agent is waiting for a decision in this project")).toContainText(
    "✓ No agent is waiting for a decision in this project",
  );
  await expect(checklistLine(live, "No agent is still working on this card")).toContainText("✓ No agent is still working on this card");
  await expect(checklistLine(live, "The plan has been approved")).toContainText("✗ The plan has been approved");
  await expect(live.getByRole("button", { name: "Sign off" })).toHaveCount(0);

  await waive(live, "Still only a test of the gates");
  await moveButton(page, "Login", "Operate").click();
  await expect(live).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Operate" }).getByText("Login")).toBeVisible();
  await expect(line(ledger, 'Owner waived "Going live" for "Login": Still only a test of the gates')).toHaveCount(1);

  const waivers = (await projectEntries(page, name)).filter((e) => e.type === "gate.waived");
  expect(waivers.map((e) => [e.payload.gateId, e.payload.to, e.payload.unmet])).toEqual([
    ["ready_to_ship", "ship", ["intake_completed"]],
    ["go_live", "operate", ["intake_completed"]],
  ]);
  // Nothing is left waiting on the Owner for the specs that follow on this server.
  await expect(page.getByRole("contentinfo", { name: "Status bar" }).getByRole("button", { name: "Needs you: 0" })).toBeVisible();
});

test("GET /api/cards/:id/gates without the session cookie is rejected", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get(anonymousUrl("/api/cards/00000000-0000-0000-0000-000000000000/gates?to=ship"));
  expect(res.status()).toBe(401);
  await anon.close();
});
