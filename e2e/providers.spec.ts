import { test, expect, type Page } from "@playwright/test";
import { headlines, line, lineMatching, RUN_FINISHED } from "./support.js";

// The agent server runs the fake Codex and Gemini CLIs (packages/core/test/fixtures) with the scripts set in global-setup.ts.

async function openProject(page: Page, name: string) {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  return page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
}

async function startAgent(page: Page, adapter: "codex" | "gemini", prompt: string) {
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("combobox", { name: "Agent" }).selectOption(adapter);
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Start agent" }).click();
}

test("Codex: a command asks first, the owner allows it, and the run completes", async ({ page }) => {
  const ledger = await openProject(page, "Codex Project");
  await startAgent(page, "codex", "Run the tests");

  const card = page.getByRole("article", { name: "Decision: Run: npm test" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();

  await expect(lineMatching(ledger, RUN_FINISHED("Codex"))).toHaveCount(1);
  await expect(line(ledger, "Owner allowed it")).toHaveCount(1);
  await expect(line(ledger, 'Owner started a Codex agent: "Run the tests"')).toHaveCount(1);
  // Newest first: the allow comes before (below) the completion.
  const texts = await headlines(ledger);
  const at = (pattern: string) => texts.findIndex((t) => new RegExp(`^${pattern}$`).test(t));
  expect(at(RUN_FINISHED("Codex"))).toBeLessThan(at("Owner allowed it"));
  await expect(card).toHaveCount(0);
});

test("Gemini: a read outside the worktree is denied by policy, and the owner denies a write", async ({ page }) => {
  const ledger = await openProject(page, "Gemini Project");
  await startAgent(page, "gemini", "Write the notes");

  await expect(line(ledger, "Stopped automatically: outside worktree")).toHaveCount(1);

  const card = page.getByRole("article", { name: "Decision: Write notes.txt" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  await card.getByRole("textbox").fill("not now");
  await card.getByRole("button", { name: "Confirm deny" }).click();

  await expect(line(ledger, "Owner denied it: not now")).toHaveCount(1);
  await expect(lineMatching(ledger, RUN_FINISHED("Gemini"))).toHaveCount(1);
  // Newest first: the completion, then the owner's deny, then the policy's.
  const texts = await headlines(ledger);
  const at = (pattern: string) => texts.findIndex((t) => new RegExp(`^${pattern}$`).test(t));
  expect(at(RUN_FINISHED("Gemini"))).toBeLessThan(at("Owner denied it: not now"));
  expect(at("Owner denied it: not now")).toBeLessThan(at("Stopped automatically: outside worktree"));
  await expect(card).toHaveCount(0);
});
