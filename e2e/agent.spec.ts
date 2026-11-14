import { test, expect } from "@playwright/test";

test("fake agent run: policy auto-allow/deny, human allow and deny", async ({ page }) => {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill("Local Model Hub");
  await page.getByLabel("New project name").press("Enter");

  const ledger = page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
  const needsYou = page.getByRole("region", { name: "Needs you" });
  const card = page.getByRole("article", { name: "Decision: Run: nvidia-smi" });

  // Run 1: human Allow (the start form lives in the Agents view's side bar)
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("combobox", { name: "Agent" }).selectOption("fake");
  await page.getByLabel("Prompt").fill("Detect GPU");
  await page.getByRole("button", { name: "Start agent" }).click();

  await expect(card).toBeVisible();
  await expect(card).toContainText("Agent wants to: Run: nvidia-smi");
  await card.getByRole("button", { name: "Allow" }).click();

  // newest first
  const run1 = [
    "Agent run completed",
    "Policy denied: outside worktree",
    "Owner allowed: approved",
    "Policy allowed: read-only inside worktree",
    'Owner started a Fake agent: "Detect GPU"',
  ];
  await expect(ledger.filter({ hasText: "Agent run completed" })).toHaveCount(1);
  const texts = (await ledger.allInnerTexts()).map((t) => t.trim());
  let from = 0;
  for (const want of run1) {
    const idx = texts.findIndex((t, i) => i >= from && t.includes(want));
    expect(idx, `ledger line "${want}" after index ${from}`).toBeGreaterThanOrEqual(from);
    from = idx + 1;
  }
  await expect(card).toHaveCount(0);
  await expect(needsYou.getByRole("button", { name: "Allow" })).toHaveCount(0);

  // Run 2: human Deny (two steps)
  await page.getByLabel("Prompt").fill("Detect GPU again");
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  await card.getByRole("textbox").fill("not now");
  await card.getByRole("button", { name: "Confirm deny" }).click();

  await expect(ledger.filter({ hasText: "Owner denied: not now" })).toHaveCount(1);
  await expect(ledger.filter({ hasText: "Agent run completed" })).toHaveCount(2);
  await expect(card).toHaveCount(0);
});
