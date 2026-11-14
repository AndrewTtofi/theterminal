import { test, expect, type Locator, type Page } from "@playwright/test";

// The agent server runs the fake Codex and Gemini CLIs (packages/core/test/fixtures) with the scripts set in global-setup.ts.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ledger lines whose description is exactly `text` (each line is "<time> · <description>"). */
const line = (ledger: Locator, text: string) => ledger.filter({ hasText: new RegExp(` · ${escape(text)}$`) });

async function openProject(page: Page, name: string) {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  return page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
}

async function startAgent(page: Page, adapter: "codex" | "gemini", prompt: string) {
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

  await expect(line(ledger, "Agent run completed")).toHaveCount(1);
  await expect(line(ledger, "Owner allowed: approved")).toHaveCount(1);
  await expect(line(ledger, 'Owner started a Codex agent: "Run the tests"')).toHaveCount(1);
  // Newest first: the allow comes before (below) the completion.
  const texts = (await ledger.allInnerTexts()).map((t) => t.trim());
  const at = (text: string) => texts.findIndex((t) => t.endsWith(` · ${text}`));
  expect(at("Agent run completed")).toBeLessThan(at("Owner allowed: approved"));
  await expect(card).toHaveCount(0);
});

test("Gemini: a read outside the worktree is denied by policy, and the owner denies a write", async ({ page }) => {
  const ledger = await openProject(page, "Gemini Project");
  await startAgent(page, "gemini", "Write the notes");

  await expect(line(ledger, "Policy denied: outside worktree")).toHaveCount(1);

  const card = page.getByRole("article", { name: "Decision: Write notes.txt" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  await card.getByRole("textbox").fill("not now");
  await card.getByRole("button", { name: "Confirm deny" }).click();

  await expect(line(ledger, "Owner denied: not now")).toHaveCount(1);
  await expect(line(ledger, "Agent run completed")).toHaveCount(1);
  await expect(card).toHaveCount(0);
});
