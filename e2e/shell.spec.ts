import { test, expect, type Page } from "@playwright/test";

const views = (page: Page) => page.getByRole("navigation", { name: "Views" });

async function createProject(page: Page, url: string, name: string) {
  await page.goto(url);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);
}

test("the activity bar shows the seven views and the Board is home with the five columns", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  const buttons = views(page).getByRole("button");
  await expect(buttons).toHaveCount(7);
  // Icon buttons: their names are their aria-labels.
  const names = await buttons.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(names).toEqual(["Board", "Agents", "Needs you", "Ledger", "Connections", "GitHub", "Capacity"]);
  await expect(views(page).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: "Board" })).toBeVisible();

  await createProject(page, process.env.TT_E2E_URL!, "Shell Project");
  for (const column of ["Plan", "Design", "Build", "Ship", "Operate"]) {
    await expect(page.getByRole("region", { name: column })).toBeVisible();
  }
});

test("a closed Ledger tab stays closed after a reload, and Reset layout brings it back", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  const ledgerTab = page.getByRole("tab", { name: "Ledger" });
  await expect(ledgerTab).toBeVisible();
  await page.getByRole("button", { name: "Close Ledger" }).click();
  await expect(ledgerTab).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("tab", { name: "Board" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Agent feed" })).toBeVisible();
  await expect(ledgerTab).toHaveCount(0);

  await page.getByRole("contentinfo", { name: "Status bar" }).getByRole("button", { name: "Reset layout" }).click();
  await expect(ledgerTab).toBeVisible();
});

test("with the bottom panel closed and Connections selected, a new decision still shows its card and the count", async ({ page }) => {
  const name = "Shell Decisions";
  await createProject(page, process.env.TT_E2E_AGENT_URL!, name);
  const statusBar = page.getByRole("contentinfo", { name: "Status bar" });
  await expect(statusBar.getByRole("button", { name: "Needs you: 0" })).toBeVisible();

  // Ctrl+J hides the bottom panel (not while typing, so leave the project name field first).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // dockview hides a group by collapsing its container to zero height and clipping it, so the tabs stay in the DOM
  // with a size: what tells them apart is that none of them is in the viewport any more.
  await expect(page.getByRole("tab", { name: "Ledger" })).toBeInViewport();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("tab", { name: "Ledger" })).not.toBeInViewport();
  await expect(page.getByRole("tab", { name: "Agent feed" })).not.toBeInViewport();

  await views(page).getByRole("button", { name: "Connections" }).click();
  await expect(page.getByRole("searchbox", { name: "Search connections" })).toBeVisible();

  // Start the run from outside the Agents view, as another window or a script would.
  const status = await page.evaluate(async (projectName) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === projectName)!;
    const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapter: "fake", prompt: "Detect GPU" }),
    });
    return res.status;
  }, name);
  expect(status).toBe(201);

  const card = page.getByRole("article", { name: "Decision: Run: nvidia-smi" });
  await expect(card).toBeVisible();
  await expect(statusBar.getByRole("button", { name: "Needs you: 1" })).toBeVisible();
  await expect(views(page).getByRole("button", { name: "Connections" })).toHaveAttribute("aria-pressed", "true");

  // Leave nothing pending for the other tests on this server.
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveCount(0);
  await expect(statusBar.getByRole("button", { name: "Needs you: 0" })).toBeVisible();
});
