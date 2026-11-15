import { test, expect, type Page } from "@playwright/test";
import {
  allow, anonymousUrl, ledgerItems, line, openEditor, openProject, openView, prepareRun, removeConnection, runStatuses,
  showAllProjects, startRun, statusBar,
} from "./support.js";

// The agent server detects a fixed fake machine (THETERMINAL_FAKE_HARDWARE=1). No e2e flow runs Claude, and this spec
// runs one fake Codex run of its own (the fake reports tokens but no cost), so the figures below do not depend on the
// order of the specs.
const FOOTER =
  "Rate-limit counts are what The Terminal observed in errors, not a quota the provider published. Figures from the providers themselves are not shown yet.";
const COLUMNS = ["Source", "Mode", "Plan", "Today", "This month", "Budget", "Tokens (in / out)", "Rate limits (24 h)"];

/** The Capacity tab's cell for a provider's row and a column. */
function cell(page: Page, source: string, column: string) {
  const row = page.locator(".capacity-table tbody tr").filter({ has: page.getByRole("cell", { name: source, exact: true }) });
  return row.getByRole("cell").nth(COLUMNS.indexOf(column));
}

test("the Capacity view shows this computer, per-provider figures with honest labels, and a budget", async ({ page }) => {
  const project = "Capacity Project";
  await openProject(page, project);

  // A Codex run, so Codex has a month of runs to observe rate limits in.
  await prepareRun(page, "codex", "Run the tests");
  await startRun(page);
  await allow(page, "Run: npm test");
  await expect.poll(() => runStatuses(page, project)).toEqual(["completed"]);

  await openView(page, "Capacity");
  const side = page.locator(".capacity-side");
  await side.getByRole("button", { name: "Detect this computer" }).click();
  const hardware = side.getByRole("region", { name: "This computer" });
  await expect(hardware).toContainText("CPU: Fake CPU (8 cores)");
  await expect(hardware).toContainText("Memory: 32 GB");
  await expect(hardware).toContainText("GPU: Fake GPU, 24 GB");
  // Every detection stamps a new time, so a second one always records an update.
  await side.getByRole("button", { name: "Detect this computer" }).click();
  await showAllProjects(page);
  const ledger = ledgerItems(page);
  await expect(line(ledger, 'Owner connected "This computer" (hardware)')).toHaveCount(1);
  await expect(line(ledger, 'Owner updated "This computer"')).toHaveCount(1);

  await openView(page, "Capacity");
  await side.getByRole("button", { name: "Open capacity" }).click();
  await expect(page.locator(".capacity-table")).toBeVisible();
  // No Claude run: its cost is not reported (never $0), and with no run there is no rate limit to observe.
  await expect(cell(page, "Claude", "This month")).toHaveText("not reported");
  await expect(cell(page, "Claude", "Rate limits (24 h)")).toHaveText("none observed");
  // Codex reported its tokens (the provider's own figures, so no estimate label) but no cost; the rate-limit count is
  // The Terminal's own observation.
  await expect(cell(page, "Codex", "This month")).toHaveText("not reported");
  await expect(cell(page, "Codex", "Tokens (in / out)")).toHaveText(/^\d[\d,]* \/ \d[\d,]*$/);
  await expect(cell(page, "Codex", "Rate limits (24 h)")).toHaveText("0 estimate");
  await expect(page.locator(".capacity-footer")).toHaveText(FOOTER);

  // A budget on a Claude connection (named so it never matches connections.spec.ts's "Claude" lines).
  const editor = await openEditor(page, "Claude (Anthropic)");
  await editor.getByLabel("Name", { exact: true }).fill("Claude budget");
  await editor.getByLabel("Monthly budget (USD)").fill("50");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(statusBar(page)).toContainText(/Month: \$\d+\.\d{2} of \$50\.00/);
  await openView(page, "Capacity");
  await side.getByRole("button", { name: "Open capacity" }).click();
  await expect(cell(page, "Claude budget", "Budget")).toHaveText("$50.00");
  await expect(cell(page, "Claude budget", "This month")).toHaveText("not reported");

  // Leave the server without a Claude connection for the next spec.
  await removeConnection(await openEditor(page, "Claude (Anthropic)"));
  await expect(line(ledger, 'Owner removed "Claude budget"')).toHaveCount(1);
  await expect(statusBar(page)).not.toContainText("Month:");
});

test("GET /api/capacity without the session cookie is rejected", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get(anonymousUrl("/api/capacity"));
  expect(res.status()).toBe(401);
  await anon.close();
});
