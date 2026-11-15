import { test, expect } from "@playwright/test";
import {
  addCard,
  allowIn,
  latestSeq,
  ledgerItems,
  lineMatching,
  openEditor,
  openProject,
  openView,
  prepareRun,
  removeConnection,
  RUN_FINISHED,
  saveWithSecret,
  startRun,
  watchForLeaks,
} from "./support.js";

// The fake agent's shell step prints this key, bare, and writes it into notes.txt (see global-setup.ts).
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";

test("a project's day reads as a daily digest in UTC, without prompts or agent output", async ({ page }) => {
  // A whole agent run on a slow CI machine: every wait below is on state, this only bounds them all.
  test.setTimeout(120_000);
  const watch = watchForLeaks(page, [KEY]);
  const name = "Digest Club";
  await openProject(page, name);
  const since = await latestSeq(page);
  const claude = await openEditor(page, "Claude (Anthropic)");
  await claude.getByLabel("API key", { exact: true }).fill(KEY);
  await saveWithSecret(claude, "API key");

  await openView(page, "Board");
  await addCard(page, "Build", "Login");
  await prepareRun(page, "fake", "Build the login page");
  await page.getByLabel("Card (optional)").selectOption({ label: "Login" });
  await startRun(page);
  await allowIn(page, "Run: nvidia-smi", name);
  await expect(lineMatching(ledgerItems(page), RUN_FINISHED("Fake"))).toHaveCount(1);

  await openView(page, "Share");
  await page.locator(".share-side").getByRole("button", { name: "Open daily digest" }).click();
  const digest = page.locator("section.digest-panel");
  await expect(digest).toBeVisible();
  const today = new Date().toISOString().slice(0, 10);
  const day = digest.getByRole("article", { name: `${today} (UTC)` });
  await expect(day).toHaveCount(1);
  // Every requested action counts (read and edit were decided by policy); one was allowed by a human.
  await expect(day).toContainText("3 agent actions requested, 1 allowed and 0 denied by a human");
  await expect(day.getByRole("listitem").filter({ hasText: 'Owner started a Fake agent on "Login"' })).toHaveCount(1);
  await expect(digest).not.toContainText("Build the login page");
  await expect(digest).not.toContainText("TESTKEY");

  await removeConnection(await openEditor(page, "Claude (Anthropic)"));
  await watch.check(since);
});
