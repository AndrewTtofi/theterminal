import { test, expect } from "@playwright/test";

test("full board + ledger flow served by core", async ({ page, browser }) => {
  const url = process.env.TT_E2E_URL!;
  const origin = new URL(url).origin;

  // 1. the token moves into a cookie and disappears from the URL
  await page.goto(url);
  await expect(page).toHaveURL(`${origin}/`);

  // 2. create a project
  await page.getByLabel("New project name").fill("Local Model Hub");
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Local Model Hub" })).toHaveClass(/selected/);

  // 3. add a card to Plan and move it to Build
  await page.getByLabel("Add card to Plan").fill("Detect GPU");
  await page.getByLabel("Add card to Plan").press("Enter");
  const plan = page.getByRole("region", { name: "Plan" });
  await expect(plan.getByText("Detect GPU")).toBeVisible();
  await page.getByLabel("Move Detect GPU to").selectOption("build");
  await expect(page.getByRole("region", { name: "Build" }).getByText("Detect GPU")).toBeVisible();

  // 4. the ledger, newest first
  const items = page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
  const expected = [
    "Owner moved a card from Plan to Build",
    'Owner added "Detect GPU" to Plan',
    'Owner created project "Local Model Hub"',
  ];
  await expect(items).toHaveCount(3);
  for (const [i, text] of expected.entries()) await expect(items.nth(i)).toContainText(text);

  // 5. a context without the cookie is rejected
  const anon = await browser.newContext();
  const res = await anon.request.get(`${origin}/api/projects`);
  expect(res.status()).toBe(401);
  await anon.close();

  // 6. everything survives a reload
  await page.reload();
  // selection is not persisted by the UI, so pick the project again
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Local Model Hub" }).click();
  await expect(page.getByRole("region", { name: "Build" }).getByText("Detect GPU")).toBeVisible();
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText(expected[0]);
});
