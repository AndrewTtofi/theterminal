import { test, expect } from "@playwright/test";
import { addCard, boardCard, enableBoard, moveCardViaApi, openBoard, operatorLayout } from "./support.js";

test("full board + ledger flow served by core", async ({ page, browser }) => {
  const url = process.env.TT_E2E_URL!;
  const origin = new URL(url).origin;

  // 1. the token moves into a cookie and disappears from the URL
  await enableBoard(page);
  await page.goto(url);
  await expect(page).toHaveURL(`${origin}/`);

  // 2. create a project
  await page.getByLabel("New project name").fill("Local Model Hub");
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Local Model Hub" })).toHaveClass(/selected/);
  await operatorLayout(page);
  await openBoard(page);

  // 3. the Board belongs to the agents: nothing on it adds, drags or moves a card. A card added to Design through the
  // API (as the intake does) and moved to Build (no gate stands between them; a move out of Plan needs a plan) follows.
  await expect(page.locator(".agent-board").locator('select, input, textarea, [draggable="true"]')).toHaveCount(0);
  await expect(page.getByPlaceholder("+ Add")).toHaveCount(0);
  await expect(page.getByText("Cards are managed by agents · click a card to leave a note")).toBeVisible();
  const card = await addCard(page, "Design", "Detect GPU");
  expect((await moveCardViaApi(page, card, "build")).status).toBe(200);
  await expect(boardCard(page, "Detect GPU", "Build")).toBeVisible();

  // Clicking the card opens its panel beside the columns; Escape closes it and puts focus back on the card.
  await boardCard(page, "Detect GPU").click();
  const panel = page.getByRole("complementary", { name: "Card" });
  await expect(panel.getByText("Detect GPU", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open the full story" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Say something about this" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(boardCard(page, "Detect GPU")).toBeFocused();

  // 4. the ledger, newest first
  const items = page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
  const expected = [
    'Owner moved "Detect GPU" from Design to Build',
    'Owner added "Detect GPU" to Design',
    'Owner created the project "Local Model Hub"',
  ];
  await expect(items).toHaveCount(3);
  for (const [i, text] of expected.entries()) await expect(items.nth(i).locator(".headline")).toHaveText(text);

  // 5. a context without the cookie is rejected. Node-side requests use the loopback address:
  // Node on Windows does not resolve *.localhost (browser navigation still uses the app host).
  const anon = await browser.newContext();
  const res = await anon.request.get(`http://127.0.0.1:${new URL(url).port}/api/projects`);
  expect(res.status()).toBe(401);
  await anon.close();

  // 6. everything survives a reload
  await page.reload();
  // selection is not persisted by the UI, so pick the project again
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Local Model Hub" }).click();
  await expect(boardCard(page, "Detect GPU", "Build")).toBeVisible();
  await expect(items).toHaveCount(3);
  await expect(items.first().locator(".headline")).toHaveText(expected[0]!);
});
