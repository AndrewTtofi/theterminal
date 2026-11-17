import { test, expect } from "@playwright/test";
import {
  SECRET_LIKE,
  addCard,
  allow,
  anonymousUrl,
  boardCard,
  cardGates,
  conditionMet,
  gatesOf,
  ledgerItems,
  line,
  lineMatching,
  moveCardViaApi,
  openProject,
  openView,
  prepareRun,
  projectEntries,
  projectId,
  RUN_FINISHED,
  startRun,
  statusBar,
  waivers,
} from "./support.js";

const STAGE_GATED = "Add the card to an earlier stage, then move it, so its readiness checks run.";
const PLAN = "The plan has been approved";
const NOBODY_WAITING = "No agent is waiting for a decision in this project";

// The Board no longer moves cards (agents do, and a move a gate holds becomes a request on Home), so these specs move
// cards through the same route the Board used to call.

test("a card cannot be created in Ship or Operate: it is added earlier and moved, so its gates run", async ({ page }) => {
  const name = "Gate Shortcut";
  await openProject(page, name);
  const id = await projectId(page, name);
  for (const stage of ["ship", "operate"]) {
    const res = await page.evaluate(
      async ({ pid, stage }) => {
        const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/cards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Skip the checks", stage }),
        });
        return { status: r.status, body: (await r.json()) as unknown };
      },
      { pid: id, stage },
    );
    expect(res, stage).toEqual({ status: 409, body: { error: "stage_gated", message: STAGE_GATED } });
  }
  await expect(boardCard(page, "Skip the checks")).toHaveCount(0);
  expect((await projectEntries(page, name)).map((e) => e.type)).toEqual(["project.created"]);
});

test("moves stop at readiness gates: a waiver with a reason, and a checklist that refreshes as an agent finishes", async ({ page }) => {
  const name = "Gate Checks";
  await openProject(page, name);
  const ledger = ledgerItems(page);
  const card = await addCard(page, "Build", "Login");

  // A move to Ship stops at its gate and moves nothing.
  const blocked = await moveCardViaApi(page, card, "ship");
  expect(blocked.status).toBe(409);
  expect(blocked.body.error).toBe("gate_blocked");
  const ship = gatesOf(blocked.body);
  expect(conditionMet(ship, "ready_to_ship", PLAN)).toBe(false);
  expect(conditionMet(ship, "ready_to_ship", NOBODY_WAITING)).toBe(true);

  // A waiver needs a reason of at least 10 characters; one that looks like a secret is refused and never recorded.
  expect((await moveCardViaApi(page, card, "ship", waivers(ship, "too short"))).status).toBe(400);
  const secret = await moveCardViaApi(page, card, "ship", waivers(ship, `only testing ${SECRET_LIKE}`));
  expect(secret.status).toBe(400);
  expect(secret.body.error).toBe("secret_in_text");
  await expect(boardCard(page, "Login", "Build")).toBeVisible();
  expect(JSON.stringify(await projectEntries(page, name))).not.toContain("TESTKEY");

  expect((await moveCardViaApi(page, card, "ship", waivers(ship, "We are only testing this"))).status).toBe(200);
  await expect(boardCard(page, "Login", "Ship")).toBeVisible();
  await expect(line(ledger, 'Owner waived "Ready to ship" for "Login": We are only testing this')).toHaveCount(1);
  await expect(line(ledger, 'Owner moved "Login" from Build to Ship')).toHaveCount(1);

  // The fake agent works on Login; while its shell step waits for the Owner, a move to Operate is held back.
  await prepareRun(page, "fake", "Check the login page");
  await page.getByLabel("Card (optional)").selectOption({ label: "Login" });
  await startRun(page);
  const decision = page.getByRole("article", { name: "Decision: Run: nvidia-smi" });
  await expect(decision).toBeVisible();
  const held = await moveCardViaApi(page, card, "operate");
  expect(held.status).toBe(409);
  expect(conditionMet(gatesOf(held.body), "go_live", PLAN)).toBe(false);
  expect(conditionMet(gatesOf(held.body), "go_live", NOBODY_WAITING)).toBe(false);

  // Once the step is allowed and the run has finished, the checklist reads differently: only the plan is still missing.
  await allow(page, "Run: nvidia-smi");
  await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(1);
  const live = await cardGates(page, card, "operate");
  expect(conditionMet(live, "go_live", NOBODY_WAITING)).toBe(true);
  expect(conditionMet(live, "go_live", "No agent is still working on this card")).toBe(true);
  expect(conditionMet(live, "go_live", PLAN)).toBe(false);

  expect((await moveCardViaApi(page, card, "operate", waivers(live, "Still only a test of the gates"))).status).toBe(200);
  await openView(page, "Board");
  await expect(boardCard(page, "Login", "Operate")).toBeVisible();
  await expect(line(ledger, 'Owner waived "Going live" for "Login": Still only a test of the gates')).toHaveCount(1);

  const recorded = (await projectEntries(page, name)).filter((e) => e.type === "gate.waived");
  expect(recorded.map((e) => [e.payload.gateId, e.payload.to, e.payload.unmet])).toEqual([
    ["ready_to_ship", "ship", ["intake_completed"]],
    ["go_live", "operate", ["intake_completed"]],
  ]);
  // Nothing is left waiting on the Owner for the specs that follow on this server.
  await expect(statusBar(page).getByRole("button", { name: "Needs you: 0" })).toBeVisible();
});

test("GET /api/cards/:id/gates without the session cookie is rejected", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get(anonymousUrl("/api/cards/00000000-0000-0000-0000-000000000000/gates?to=ship"));
  expect(res.status()).toBe(401);
  await anon.close();
});
