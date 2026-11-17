import { test, expect, type Page } from "@playwright/test";
import {
  askOnHome, homeBlock, importSite, ledgerItems, line, lineMatching, openPreview, operatorLayout, previewPanel, removeSite,
} from "./support.js";

// The website preview in browser mode (the site server is headless, so there is no desktop host and the devices are
// iframes). The site server's fake agent offers `npm run dev` for the website fixture, whose dev script serves one
// page on the port and address The Terminal gives it. Asking again after package.json changes is covered by the
// core and UI tests, where the files can be changed directly.

const PROJECT = "Preview Site";
// A run's title is the first step of its plan.
const JOB = "Build";
const HEADING = "Contact us";
const DEVICES = ["iPhone 16", "iPad", "Laptop"];

let folder: string | null = null;
test.afterEach(() => {
  if (folder !== null) removeSite(folder);
  folder = null;
});

/** The preview's id and its view, read from the API in the page (it carries the cookie). */
function previewView(page: Page, runId: string) {
  return page.evaluate(async (id) => {
    const home = (await (await fetch("/api/home")).json()) as { finishedToday: { run: { id: string }; livePreviewId: string | null }[] };
    const pid = home.finishedToday.find((h) => h.run.id === id)?.livePreviewId ?? null;
    if (pid === null) return null;
    return (await (await fetch(`/api/previews/${encodeURIComponent(pid)}`)).json()) as { id: string; state: string; percent: number | null };
  }, runId);
}

/** Every device frame inside the host frame shows the fixture's heading. */
async function expectSiteInEveryDevice(page: Page) {
  const host = previewPanel(page).frameLocator('iframe[title="Device previews"]');
  for (const device of DEVICES) {
    await expect(host.frameLocator(`iframe[title="The site on ${device}"]`).getByRole("heading", { name: HEADING })).toBeVisible();
  }
}

test("a run's website: confirmed once, started with real stage progress, shown on three devices, stopped with its tab", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(process.env.TT_E2E_SITE_URL!);
  folder = await importSite(page, PROJECT);
  // The Operator layout shows the Ledger below Home. Chosen first: changing the layout closes the tabs it does not hold,
  // and closing the Preview tab stops its preview.
  await operatorLayout(page);
  const ledger = ledgerItems(page);

  await askOnHome(page, "Add a contact form");
  const finished = homeBlock(page, "Finished today").getByRole("listitem").filter({ has: page.locator(".finished-line", { hasText: /^Build — / }) });
  await expect(finished.locator(".finished-line")).toHaveText(/ — done$/);
  const runId = await page.evaluate(async (name) => {
    const home = (await (await fetch("/api/home")).json()) as { finishedToday: { projectName: string; run: { id: string } }[] };
    return home.finishedToday.find((h) => h.projectName === name)!.run.id;
  }, PROJECT);

  // Preview on its Home entry opens the Preview tab; Preview there asks first, listing what will run.
  const tab = await openPreview(page, JOB);
  const panel = previewPanel(page);
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start the website preview" });
  await expect(dialog.getByRole("list", { name: "Commands" }).getByRole("listitem")).toHaveText(["npm run dev"]);
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog).toHaveCount(0);

  // Ready: every stage of the fixed plan done, and the fixture's page in each device's frame inside the host frame.
  await expectSiteInEveryDevice(page);
  await expect.poll(async () => (await previewView(page, runId))?.percent).toBe(100);
  await expect(panel.getByText("Screenshots need the desktop app")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Screenshot all" })).toHaveCount(0);

  await expect(lineMatching(ledger, ".* confirmed starting the website preview: npm run dev")).toHaveCount(1);
  await expect(line(ledger, "Website preview: step 3 of 3 done")).toHaveCount(1);
  await expect(line(ledger, "The website preview is ready")).toHaveCount(1);

  // Reload loads every device again, and the site still answers.
  await panel.getByRole("button", { name: "⟳ Reload" }).click();
  await expect(panel.locator('iframe[title="Device previews"]')).toHaveAttribute("src", /&k=1$/);
  await expectSiteInEveryDevice(page);

  // Closing the tab stops the preview.
  await tab.locator(".dv-default-tab-action").click();
  await expect(tab).toHaveCount(0);
  await expect(line(ledger, "The website preview stopped")).toHaveCount(1);
  await expect.poll(async () => await previewView(page, runId)).toBeNull();

  // Opened again, Preview starts at once: the same commands and files were confirmed earlier. The start is still
  // recorded.
  await page.getByRole("tab", { name: "Home", exact: true }).click();
  await openPreview(page, JOB);
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await expectSiteInEveryDevice(page);
  await expect(page.getByRole("dialog", { name: "Start the website preview" })).toHaveCount(0);
  await expect(lineMatching(ledger, ".* confirmed starting the website preview: npm run dev")).toHaveCount(2);
  await expect(line(ledger, "The website preview is ready")).toHaveCount(2);
  await expect(panel.getByText("Screenshots need the desktop app")).toBeVisible();

  // Stop ends it before the spec does.
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(line(ledger, "The website preview stopped")).toHaveCount(2);
  await expect(panel.getByText("The preview stopped.")).toBeVisible();
});
