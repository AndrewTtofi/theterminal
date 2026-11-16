import { test, expect, type Page } from "@playwright/test";
import { enableBoard, openBoard, operatorLayout } from "./support.js";

const views = (page: Page) => page.getByRole("navigation", { name: "Views" });

async function createProject(page: Page, url: string, name: string) {
  await page.goto(url);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);
}

test("the activity bar shows Home and the twelve views, with the Board hidden, and Home is the default tab", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  const buttons = views(page).getByRole("button");
  await expect(buttons).toHaveCount(12);
  // Icon buttons: their names are their aria-labels.
  const names = await buttons.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(names).toEqual(["Home", "Agents", "Changes", "Needs you", "Ledger", "Connections", "GitHub", "Capacity", "Machines", "People", "Share", "Learn"]);
  await expect(views(page).getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
  // The default layout is Guided: Home and the Conversation, no bottom panel.
  const tabs = await page.getByRole("tab").allInnerTexts();
  expect(tabs.map((t) => t.trim())).toEqual(["Home", "Conversation"]);
  await expect(page.getByRole("contentinfo", { name: "Status bar" }).getByRole("combobox", { name: "Layout" })).toHaveValue("preset:guided");
});

test("with Show the Board on, the Board button opens the Board tab with the five columns", async ({ page }) => {
  await enableBoard(page);
  await page.goto(process.env.TT_E2E_URL!);
  await expect(views(page).getByRole("button", { name: "Board" })).toBeVisible();
  await createProject(page, process.env.TT_E2E_URL!, "Shell Project");
  await openBoard(page);
  for (const column of ["Plan", "Design", "Build", "Ship", "Operate"]) {
    await expect(page.getByRole("region", { name: column })).toBeVisible();
  }
});

test("Settings, Workspace turns the Board button on and keeps it after a reload", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  await expect(views(page).getByRole("button", { name: "Board" })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Show the Board" }).click();
  await expect(views(page).getByRole("button", { name: "Board" })).toBeVisible();
  await page.reload();
  await expect(views(page).getByRole("button", { name: "Board" })).toBeVisible();
});

test("a closed Ledger tab stays closed after a reload, and Reset layout goes back to Guided", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  await operatorLayout(page);
  const layout = page.getByRole("contentinfo", { name: "Status bar" }).getByRole("combobox", { name: "Layout" });
  const ledgerTab = page.getByRole("tab", { name: "Ledger" });
  await page.getByRole("button", { name: "Close Ledger" }).click();
  await expect(ledgerTab).toHaveCount(0);
  await expect(layout.locator("option:checked")).toHaveText("Custom");

  await page.reload();
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Agent feed" })).toBeVisible();
  await expect(ledgerTab).toHaveCount(0);
  await expect(layout.locator("option:checked")).toHaveText("Custom");

  await page.getByRole("contentinfo", { name: "Status bar" }).getByRole("button", { name: "Reset layout" }).click();
  await expect(page.getByRole("tab", { name: "Conversation" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Agent feed" })).toHaveCount(0);
  await expect(layout).toHaveValue("preset:guided");
});

test("a saved layout is kept across a reload, and a restored diff tab of an unknown run is closed", async ({ page }) => {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await operatorLayout(page);
  const bar = page.getByRole("contentinfo", { name: "Status bar" });
  const layout = bar.getByRole("combobox", { name: "Layout" });
  await page.getByRole("button", { name: "Close Ledger" }).click();
  await bar.getByRole("button", { name: "Save layout" }).click();
  await bar.getByLabel("Layout name").fill("Mine");
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(layout.locator("option:checked")).toHaveText("Mine");

  // Resizing, switching tabs and restoring do not make the layout Custom.
  await page.getByRole("tab", { name: "Capacity" }).click();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ledger" })).toHaveCount(0);
  await expect(layout.locator("option:checked")).toHaveText("Mine");

  // Plant a diff tab of a run the server does not know into the working layout, beside Home.
  await page.evaluate(() => {
    type Node = { type: string; data: unknown };
    const saved = JSON.parse(localStorage.getItem("tt.layout.v1")!) as {
      grid: { root: Node };
      panels: Record<string, { id: string; contentComponent?: string; title?: string }>;
    };
    const leafWith = (n: Node, id: string): { views: string[] } | null => {
      if (n.type === "leaf") return (n.data as { views: string[] }).views.includes(id) ? (n.data as { views: string[] }) : null;
      for (const child of n.data as Node[]) {
        const found = leafWith(child, id);
        if (found) return found;
      }
      return null;
    };
    leafWith(saved.grid.root, "home")!.views.push("diff:gone:x");
    saved.panels["diff:gone:x"] = { id: "diff:gone:x", contentComponent: "diff", title: "x" };
    localStorage.setItem("tt.layout.v1", JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "x", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
  // Closing the stale tab on load is not the Owner changing the layout: it keeps its name.
  await expect(layout.locator("option:checked")).toHaveText("Mine");

  await bar.getByRole("button", { name: "Reset layout" }).click();
  await expect(layout).toHaveValue("preset:guided");
  await layout.selectOption({ label: "Mine" });
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ledger" })).toHaveCount(0);
});

test("with the bottom panel closed and Connections selected, a new decision still shows its card and the count", async ({ page }) => {
  const name = "Shell Decisions";
  await createProject(page, process.env.TT_E2E_AGENT_URL!, name);
  await operatorLayout(page);
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

test("the sign-in page and a join link that is no longer valid open on their own, and the Owner's People view lists the Owner", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  const origin = new URL(page.url()).origin;
  await page.getByRole("contentinfo", { name: "Status bar" }).getByRole("button", { name: /^You: .* \(Owner\)$/ }).click();
  await expect(page.getByRole("region", { name: "Everyone" })).toContainText("Owner");
  await expect(page.getByRole("button", { name: "Invite someone" })).toBeVisible();

  await page.goto(`${origin}/sign-in`);
  await expect(page.getByRole("main", { name: "Sign in" }).getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.goto(`${origin}/join/no-such-code`);
  await expect(page.getByRole("main", { name: "Join this workspace" })).toContainText(
    "This invitation is no longer valid. Ask the Owner for a new one.",
  );
});
