import { test, expect } from "@playwright/test";
import { headlines, line, lineMatching, RUN_FINISHED, operatorLayout } from "./support.js";

test("fake agent run: policy auto-allow/deny, human allow and deny", async ({ page }) => {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill("Local Model Hub");
  await page.getByLabel("New project name").press("Enter");
  await operatorLayout(page);

  const ledger = page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
  const needsYou = page.getByRole("region", { name: "Needs you" });
  const card = page.getByRole("article", { name: "Decision: Run: nvidia-smi" });

  // Run 1: human Allow (the start form lives in the Agents view's side bar)
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("combobox", { name: "Agent" }).selectOption("fake");
  await page.getByLabel("Prompt").fill("Detect GPU");
  await page.getByRole("button", { name: "Start agent" }).click();

  await expect(card).toBeVisible();
  await expect(card).toContainText('Agent wants to run the command "nvidia-smi"');
  await card.getByRole("button", { name: "Allow" }).click();

  // newest first
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const run1 = [
    RUN_FINISHED("Fake"),
    escape("Stopped automatically: outside worktree"),
    escape("Owner allowed it"),
    escape("Allowed automatically: read-only inside worktree"),
    escape('Owner started a Fake agent: "Detect GPU"'),
  ];
  await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(1);
  const texts = await headlines(ledger);
  let from = 0;
  for (const want of run1) {
    const idx = texts.findIndex((t, i) => i >= from && new RegExp(`^${want}$`).test(t));
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

  await expect(line(ledger, "Owner denied it: not now")).toHaveCount(1);
  await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(2);
  await expect(card).toHaveCount(0);
});
