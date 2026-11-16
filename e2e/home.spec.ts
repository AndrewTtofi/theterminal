import { test, expect } from "@playwright/test";
import { approvalRow, askOnHome, homeBlock, homeView, newProject, views, workingCard } from "./support.js";

// The Home server (TT_E2E_HOME_URL): its fake agent states a plan of three steps, finishes step 1, asks to write
// src/app.txt during step 2 ("Change"), finishes it, then asks to run a command during step 3 ("Check").

test("Home: ask, step progress, approve on Home, and the run lands in Finished today", async ({ page }) => {
  await page.goto(process.env.TT_E2E_HOME_URL!);
  // A fresh start opens on Home.
  await expect(views(page).getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
  await newProject(page, "Home Project");

  const prompt = "Tidy the app text";
  await askOnHome(page, prompt);
  // A run's title is the first step of the plan the agent stated.
  const card = workingCard(page, "Read");
  await expect(card).toBeVisible();
  // After the plan and step 1, the agent's own report says a third of the way.
  await expect(card.getByRole("progressbar", { name: "Read" })).toHaveAttribute("aria-valuenow", "33");
  await expect(card.getByText("33%")).toBeVisible();

  // The write waits under Needs your approval, as one sentence with the current step as its reason.
  const write = approvalRow(page, /src\/app\.txt/);
  await expect(write).toHaveCount(1);
  await expect(write.locator(".approval-sentence")).toHaveText(/ wants to .*src\/app\.txt$/);
  await expect(write.locator(".approval-reason")).toHaveText("Change");
  const needYou = homeBlock(page, "Totals").getByRole("button", { name: /need you$/ });
  await expect(needYou).toHaveText("1 need you");
  await write.getByRole("button", { name: "Approve" }).click();
  await expect(write).toHaveCount(0);

  // Step 2 done: two thirds (floored, as every percentage is), while the check command waits with its own reason.
  await expect(card.getByRole("progressbar", { name: "Read" })).toHaveAttribute("aria-valuenow", "66");
  await expect(card.getByText("66%")).toBeVisible();
  const check = approvalRow(page, /npm test/);
  await expect(check.locator(".approval-reason")).toHaveText("Check");
  await check.getByRole("button", { name: "Approve" }).click();
  await expect(check).toHaveCount(0);
  await expect(needYou).toHaveText("0 need you");

  // The run ends: it leaves Working now and is listed as done today.
  await expect(card).toHaveCount(0);
  const finished = homeBlock(page, "Finished today").getByRole("listitem").filter({ hasText: /^Read — / });
  await expect(finished).toHaveCount(1);
  await expect(finished.locator(".finished-line")).toHaveText(/^Read — .* — done$/);
  await expect(homeBlock(page, "Totals").getByRole("button", { name: /done today$/ })).toHaveText("1 done today");
});

test("Edit Home: a hidden block stays hidden after a reload, and Reset brings it back", async ({ page }) => {
  await page.goto(process.env.TT_E2E_HOME_URL!);
  await expect(homeBlock(page, "Project files")).toBeVisible();

  await homeView(page).getByRole("button", { name: "Edit Home" }).click();
  const editor = homeView(page).getByRole("group", { name: "Edit Home" });
  await editor.getByRole("listitem", { name: "Project files" }).getByRole("checkbox").uncheck();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(editor).toHaveCount(0);
  await expect(homeBlock(page, "Project files")).toHaveCount(0);

  await page.reload();
  await expect(homeBlock(page, "Working now")).toBeVisible();
  await expect(homeBlock(page, "Project files")).toHaveCount(0);

  await homeView(page).getByRole("button", { name: "Edit Home" }).click();
  await editor.getByRole("button", { name: "Reset" }).click();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(homeBlock(page, "Project files")).toBeVisible();
});
