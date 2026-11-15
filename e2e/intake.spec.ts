import { test, expect, type Locator, type Page } from "@playwright/test";
import { SECRET_LIKE, SECRET_REFUSED, ledgerItems, line, projectEntries } from "./support.js";

const PERMANENCE =
  "What you write here is recorded permanently in this project's ledger. Do not paste passwords, keys or other people's personal details.";

const intakePanel = (page: Page) => page.getByRole("region", { name: "Plan intake" });

/** The field of one intake question, with its Save answer button, inside the panel. */
const question = (panel: Locator, label: string) => panel.locator(".intake-question").filter({ has: panel.page().getByText(label, { exact: true }) });

/** Types a text or number answer and saves it, then waits for the progress line. */
async function answer(panel: Locator, label: string, value: string, answered: number) {
  const q = question(panel, label);
  await q.getByLabel(label, { exact: true }).fill(value);
  await q.getByRole("button", { name: "Save answer" }).click();
  await expect(panel.getByText(`${answered} of 9 answered`)).toBeVisible();
}

/** Picks an option of a choice or list question; each change is saved at once. */
async function choose(panel: Locator, label: string, option: string, answered: number) {
  await panel.getByRole("group", { name: label }).getByLabel(option, { exact: true }).check();
  await expect(panel.getByText(`${answered} of 9 answered`)).toBeVisible();
}

const decisionCard = (panel: Locator, q: string) => panel.getByRole("article", { name: `Plan decision: ${q}` });

/** Decides a plan decision with the given option and waits until the card shows it as decided. */
async function decide(panel: Locator, q: string, option: string) {
  const card = decisionCard(panel, q);
  await card.getByLabel(option, { exact: true }).check();
  await card.getByRole("button", { name: "Decide" }).click();
  await expect(card.getByText(new RegExp(`^Decided by Owner on .*: ${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeVisible();
}

const column = (page: Page, stage: string) => page.getByRole("region", { name: stage });
const cardsIn = (page: Page, stage: string) => column(page, stage).locator(".card");

test("guided intake: describe, answer, decide, approve; then reopen, take payments and approve again", async ({ page }) => {
  const name = "Book Club";
  await page.goto(process.env.TT_E2E_URL!);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);

  await page.getByRole("button", { name: "Plan intake" }).click();
  const panel = intakePanel(page);
  await expect(panel.getByText(PERMANENCE)).toBeVisible();
  await panel.getByLabel("Describe your idea").fill("A shared reading list for a book club");
  await panel.getByRole("button", { name: "Begin" }).click();
  await expect(panel.getByText("0 of 9 answered")).toBeVisible();
  await expect(panel.getByText(PERMANENCE)).toBeVisible();

  // An answer that looks like a secret is refused, and nothing of it reaches the ledger.
  const audience = question(panel, "Who is this for?");
  await audience.getByLabel("Who is this for?").fill(`members who log in with ${SECRET_LIKE}`);
  await audience.getByRole("button", { name: "Save answer" }).click();
  await expect(page.getByText(SECRET_REFUSED)).toBeVisible();
  await expect(panel.getByText("0 of 9 answered")).toBeVisible();
  expect(JSON.stringify(await projectEntries(page, name))).not.toContain("TESTKEY");

  await answer(panel, "Who is this for?", "the members of a small book club", 1);
  await answer(panel, "What should it do for them?", "keep one reading list everyone can see", 2);
  await answer(panel, "How will you know it worked?", "every member picks the next book from the list", 3);
  await choose(panel, "Where will people use it?", "In a web browser", 4);
  await choose(panel, "Will it take payments?", "No", 5);
  await choose(panel, "What personal data will it hold?", "None", 6);
  await choose(panel, "Who can reach it?", "Only me, on my computer", 7);
  await answer(panel, "How much are you willing to spend on agents for this project? (USD)", "25", 8);
  await answer(panel, "Is there anything that already exists (code, designs, accounts)?", "Nothing yet", 9);

  // The answers raise two decisions, each with a recommendation.
  await expect(panel.getByRole("article", { name: /^Plan decision: / })).toHaveCount(2);
  const firstVersion = decisionCard(panel, "How much should the first version include?");
  await expect(
    firstVersion.getByRole("listitem").filter({ hasText: "The smallest version that proves the idea" }).getByText("Recommended", { exact: true }),
  ).toBeVisible();
  await expect(firstVersion.getByText("Recommended", { exact: true })).toHaveCount(1);
  await decide(panel, "How much should the first version include?", "The smallest version that proves the idea");
  await decide(panel, "Where should it run?", "On this computer only");

  await expect(panel.getByRole("heading", { name: "Your plan" })).toBeVisible();
  const summary = panel.locator(".intake-plan .summary");
  await expect(summary).toContainText("Book Club is for the members of a small book club.");
  await expect(summary).toContainText("People use it in a web browser.");
  await expect(summary).toContainText("Agent budget: $25.00");
  await panel.getByRole("button", { name: "Approve plan" }).click();
  await expect(panel.getByText(/^Approved /)).toBeVisible();

  await page.getByRole("tab", { name: "Board" }).click();
  await expect(column(page, "Plan").getByText('Define what "done" means')).toBeVisible();
  await expect(column(page, "Ship").getByText("Run it on this computer")).toBeVisible();
  await expect(column(page, "Operate").getByText("Monitoring and health checks")).toBeVisible();
  const ledger = ledgerItems(page);
  await expect(line(ledger, "Owner approved the plan (5 cards added)")).toHaveCount(1);
  const shipBefore = await cardsIn(page, "Ship").allInnerTexts();
  expect(shipBefore).toHaveLength(1);

  // Reopen with a reason, take payments, decide how, approve: one new card.
  await page.getByRole("button", { name: "Plan intake" }).click();
  await panel.getByLabel("Why are you reopening?").fill("We will sell book club memberships");
  await panel.getByRole("button", { name: "Reopen plan" }).click();
  const change = panel.getByRole("button", { name: "Change your answers" });
  await expect(change).toHaveAttribute("aria-expanded", "false");
  await change.click();
  await expect(change).toHaveAttribute("aria-expanded", "true");
  await panel.getByRole("group", { name: "Will it take payments?" }).getByLabel("Yes", { exact: true }).check();
  const payments = decisionCard(panel, "How should payments be handled?");
  await expect(payments).toBeVisible();
  await decide(panel, "How should payments be handled?", "A payment provider's hosted checkout: card details never touch your product");
  await expect(panel.locator(".intake-plan .summary")).toContainText(
    "Payments: A payment provider's hosted checkout: card details never touch your product.",
  );
  await panel.getByRole("button", { name: "Approve plan" }).click();
  await expect(panel.getByText(/^Approved /)).toBeVisible();

  await page.getByRole("tab", { name: "Board" }).click();
  await expect(line(ledger, "Owner reopened the plan: We will sell book club memberships")).toHaveCount(1);
  await expect(line(ledger, "Owner approved the plan (1 card added)")).toHaveCount(1);
  await expect(cardsIn(page, "Ship")).toHaveCount(2);
  await expect(column(page, "Ship").getByText("Payments readiness review")).toBeVisible();
  await expect(column(page, "Ship").getByText("Payments readiness review")).toHaveCount(1);

  // Exactly one card was created by the second approval; the first plan's cards were kept.
  const completions = (await projectEntries(page, name)).filter((e) => e.type === "intake.completed");
  const created = (e: (typeof completions)[number]) =>
    (e.payload.cards as { title: string; outcome: string }[]).filter((c) => c.outcome === "created").map((c) => c.title);
  expect(completions.map(created)).toEqual([
    [
      'Define what "done" means',
      "Sketch the main screens and flows",
      "Build the smallest version that proves the idea",
      "Run it on this computer",
      "Monitoring and health checks",
    ],
    ["Payments readiness review"],
  ]);
  // No plan decision is left open.
  expect(await page.evaluate(async () => ((await (await fetch("/api/status")).json()) as { intakeDecisions: number }).intakeDecisions)).toBe(0);
});

test("GET /api/projects/:id/intake without the session cookie is rejected", async ({ browser }) => {
  const anon = await browser.newContext();
  const port = new URL(process.env.TT_E2E_URL!).port;
  const res = await anon.request.get(`http://127.0.0.1:${port}/api/projects/00000000-0000-0000-0000-000000000000/intake`);
  expect(res.status()).toBe(401);
  await anon.close();
});
