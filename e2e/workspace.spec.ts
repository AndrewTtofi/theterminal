import { test, expect, type Page } from "@playwright/test";
import { openView, operatorLayout, statusBar } from "./support.js";

const tabNames = async (page: Page) => (await page.getByRole("tab").allInnerTexts()).map((t) => t.trim());
const layoutSelect = (page: Page) => statusBar(page).getByRole("combobox", { name: "Layout" });

test("Guided by default: ask in the Conversation, decide in the strip with more context in the Needs-you tab", async ({ page }) => {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  // The workspace shows once it knows who is signed in.
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
  // A fresh browser: the Guided layout, with the Board and the Conversation only.
  expect(await tabNames(page)).toEqual(["Board", "Conversation"]);
  await expect(layoutSelect(page).locator("option:checked")).toHaveText("Guided");

  const name = "Workspace Project";
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);

  // Ask from the Conversation tab, with another view (Connections) in the side bar.
  await page.getByRole("tab", { name: "Conversation" }).click();
  const conversation = page.getByRole("region", { name: "Conversation", exact: true });
  await expect(conversation.getByText("Nothing asked yet. Ask an agent below.")).toBeVisible();
  const ask = conversation.getByRole("region", { name: "Ask an agent" });
  await ask.getByRole("combobox", { name: "Agent" }).selectOption("fake");
  await ask.getByLabel("Prompt").fill("Write some notes");
  await openView(page, "Connections");
  await ask.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(statusBar(page).getByRole("button", { name: "Needs you: 1" })).toBeVisible();

  // The decision shows in the strip above the dock, whatever the layout and the side bar show.
  const strip = page.getByRole("region", { name: "Needs you", exact: true });
  const card = strip.getByRole("article", { name: "Decision: Run: nvidia-smi" });
  await expect(card).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Connections" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // More context opens the Needs-you tab, leaves focus on the button pressed, and says so in the live region.
  const more = card.getByRole("button", { name: "More context" });
  await more.click();
  await expect(page.getByRole("tab", { name: "Needs you" })).toBeVisible();
  const tab = page.getByRole("region", { name: "Everything that needs you" });
  await expect(tab).toBeInViewport();
  await expect(more).toBeFocused();
  await expect(page.locator(".sr-only[aria-live=polite]")).toHaveText("Opened Needs you");
  await expect(tab.getByRole("heading", { name: "Decisions", level: 2 })).toBeVisible();
  const copy = tab.getByRole("article", { name: "Decision: Run: nvidia-smi" });
  await expect(copy.getByRole("heading", { name: 'Agent wants to run the command "nvidia-smi"', level: 3 })).toBeVisible();
  await expect(tab.getByText("Before this, the agent said:")).toBeVisible();
  await expect(tab.locator(".agent-said").getByRole("listitem")).toHaveText(["I read README.md. Next I check the GPU."]);
  // The run is live while it waits on the decision, so its changes are not read yet, and the tab says when they show.
  await expect(tab.getByText("Changes show when the run is stopped or finished.")).toBeVisible();
  // The tab's copy is read-only while the strip shows the card, so the step is decided once.
  await expect(copy.getByText("Decide in the strip above")).toBeVisible();
  await expect(copy.getByRole("button", { name: "Allow" })).toHaveCount(0);
  // Pressed again once the tab exists but is behind another, it brings the tab forward; focus still stays put.
  await page.getByRole("tab", { name: "Conversation" }).click();
  await expect(tab).not.toBeInViewport();
  await more.click();
  await expect(tab).toBeInViewport();
  await expect(more).toBeFocused();

  // Learn more on the card opens its topic and says so; focus stays on the button, as with More context.
  // (The Needs-you tab's read-only copy has one too: this is the strip's, above the dock.)
  const learn = page.locator("section.needs-you").getByRole("article", { name: "Decision: Run: nvidia-smi" }).getByRole("button", { name: "Learn more" });
  await learn.click();
  await expect(page.locator(".sr-only[aria-live=polite]")).toHaveText("Opened Learn: Kinds of action");
  await expect(learn).toBeFocused();

  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveCount(0);
  await expect(statusBar(page).getByRole("button", { name: "Needs you: 0" })).toBeVisible();

  // The Conversation holds the ask and what the agent said.
  await page.getByRole("tab", { name: "Conversation" }).click();
  const asked = conversation.getByRole("article", { name: "You asked Fake" });
  await expect(asked.locator("blockquote")).toHaveText("Write some notes");
  await expect(asked.getByText("I wrote notes.txt.", { exact: true })).toBeVisible();
  await expect(asked.locator(".result")).toHaveText(/^completed · 3 actions, 2 allowed, 1 denied · /);

  // Learn more in the Changes view says which topic opened and, since Learn replaced the button, focuses the topic.
  await openView(page, "Changes");
  await page.locator(".changes p.note", { hasText: "Read-only. Agents change code" }).getByRole("button", { name: "Learn more" }).click();
  await expect(page.locator(".sr-only[aria-live=polite]")).toHaveText("Opened Learn: Reading a diff");
  await expect(page.locator(".learn-side summary:focus")).toHaveText("Reading a diff");
});

test("the Operator preset, a saved layout kept across a reload and restored without a stale tab, and Learn by context", async ({ page }) => {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await operatorLayout(page);
  for (const t of ["Terminal", "Agent feed", "Ledger"]) await expect(page.getByRole("tab", { name: t })).toBeVisible();

  await page.getByRole("button", { name: "Close Ledger" }).click();
  await statusBar(page).getByRole("button", { name: "Save layout" }).click();
  await statusBar(page).getByLabel("Layout name").fill("Mine");
  await statusBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(layoutSelect(page).locator("option:checked")).toHaveText("Mine");
  await page.reload();
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ledger" })).toHaveCount(0);
  await expect(layoutSelect(page).locator("option:checked")).toHaveText("Mine");

  await statusBar(page).getByRole("button", { name: "Reset layout" }).click();
  await expect(layoutSelect(page).locator("option:checked")).toHaveText("Guided");
  expect(await tabNames(page)).toEqual(["Board", "Conversation"]);

  // A saved layout holding a diff tab of a run the server does not know restores without that tab.
  await page.evaluate(() => {
    type Node = { type: string; data: unknown };
    type Layout = { grid: { root: Node }; panels: Record<string, { id: string; contentComponent?: string; title?: string }> };
    const saved = JSON.parse(localStorage.getItem("tt.layouts.v1")!) as { name: string; layout: Layout }[];
    const mine = saved.find((s) => s.name === "Mine")!.layout;
    const leafWith = (n: Node, id: string): { views: string[] } | null => {
      if (n.type === "leaf") return (n.data as { views: string[] }).views.includes(id) ? (n.data as { views: string[] }) : null;
      for (const child of n.data as Node[]) {
        const found = leafWith(child, id);
        if (found) return found;
      }
      return null;
    };
    leafWith(mine.grid.root, "board")!.views.push("diff:gone:x");
    mine.panels["diff:gone:x"] = { id: "diff:gone:x", contentComponent: "diff", title: "x" };
    localStorage.setItem("tt.layouts.v1", JSON.stringify(saved));
  });
  await layoutSelect(page).selectOption({ label: "Mine" });
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Board" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "x", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Ledger" })).toHaveCount(0);
  await expect(layoutSelect(page).locator("option:checked")).toHaveText("Mine");

  await statusBar(page).getByRole("button", { name: "Reset layout" }).click();
  await expect(layoutSelect(page).locator("option:checked")).toHaveText("Guided");

  // Learn ranks its topics by the view the Owner was looking at: from Changes, reading a diff comes first.
  await openView(page, "Changes");
  await openView(page, "Learn");
  await expect(page.getByRole("heading", { name: "For what you are looking at", level: 2 })).toBeVisible();
  await expect(page.locator(".learn-side details summary").first()).toHaveText("Reading a diff");
});
