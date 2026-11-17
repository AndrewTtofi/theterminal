import { test, expect, type Locator, type Page } from "@playwright/test";
import { addCard, approvalRow, askOnHome, boardCard, enableBoard, homeBlock, newProject, openBoard, workingCard } from "./support.js";

// The approved style (Plan 12, Task 18), as the browser computes it: a visible focus ring, no motion under reduced
// motion, cards that never resize as their data changes, and the shape tokens in use. The Home server's fake agent
// states three steps, finishes step 1 (33%) and asks to write, then finishes step 2 (66%) and asks to run a command.

/** A computed style property of the element. */
const style = (el: Locator, prop: string) => el.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

/** Presses Tab until `target` has focus (at most `max` times), as a keyboard user would reach it. */
async function tabTo(page: Page, target: Locator, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((e) => e === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function expectRing(el: Locator) {
  expect(await style(el, "outline-style")).toBe("solid");
  expect(await style(el, "outline-width")).toBe("2px");
}

test("the focus ring shows on Go, a Board card and the Show the Board switch", async ({ page }) => {
  await enableBoard(page);
  await page.goto(process.env.TT_E2E_HOME_URL!);
  await newProject(page, "Style Focus");

  // Go: from the ask box's text, on by Tab.
  const ask = homeBlock(page, "Ask box");
  await ask.getByLabel("Tell an agent what you want").fill("Look at the focus ring");
  await ask.getByLabel("Tell an agent what you want").focus();
  const go = ask.getByRole("button", { name: "Go" });
  await tabTo(page, go);
  await expectRing(go);

  // A Board card, reached by Tab from the start of the Board tab.
  await openBoard(page);
  await addCard(page, "Design", "Focus card");
  const card = boardCard(page, "Focus card");
  await page.getByRole("tab", { name: "Board" }).focus();
  await tabTo(page, card);
  await expectRing(card);

  // The switch in Settings, Workspace.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Show the Board" });
  await expect(toggle).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await tabTo(page, toggle);
  await expectRing(toggle);
});

test("progress stops moving under reduced motion, and a Working now card keeps its size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(process.env.TT_E2E_HOME_URL!);
  await newProject(page, "Style Motion");
  await askOnHome(page, "Hold the card still");

  const card = workingCard(page, "Read");
  await expect(card.getByRole("progressbar", { name: "Read" })).toHaveAttribute("aria-valuenow", "33");
  const write = approvalRow(page, /src\/app\.txt/);
  await expect(write).toHaveCount(1);
  await expect(card.locator(".card-waiting")).toBeVisible();

  expect(await style(card.locator(".progress-fill"), "transition-duration")).toBe("0s");

  const at33 = await card.boundingBox();
  await write.getByRole("button", { name: "Approve" }).click();
  // Two thirds, floored: 66%.
  await expect(card.getByRole("progressbar", { name: "Read" })).toHaveAttribute("aria-valuenow", "66");
  const check = approvalRow(page, /npm test/);
  await expect(check).toHaveCount(1);
  await expect(card.locator(".card-waiting")).toBeVisible();
  const at66 = await card.boundingBox();
  expect(at66!.height).toBe(at33!.height);
  await check.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
});

test("a long title truncates instead of resizing its card, and the shape tokens are in use", async ({ page }) => {
  await enableBoard(page);
  await page.goto(process.env.TT_E2E_HOME_URL!);
  await newProject(page, "Style Shape");

  // Home: a button and a field.
  const go = homeBlock(page, "Ask box").getByRole("button", { name: "Go" });
  expect(await style(go, "border-radius")).toBe("999px");
  expect(await style(page.getByLabel("New project name"), "border-radius")).toBe("8px");

  // A Home card: the Working now card of a run.
  await askOnHome(page, "Show a card");
  const card = workingCard(page, "Read");
  await expect(card).toBeVisible();
  expect(await style(card, "border-radius")).toBe("8px");
  const write = approvalRow(page, /src\/app\.txt/);
  await write.getByRole("button", { name: "Approve" }).click();
  const check = approvalRow(page, /npm test/);
  await check.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);

  // The open New project dialog.
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog).toBeVisible();
  expect(await style(dialog, "border-radius")).toBe("10px");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Board cards: a 200-character title is the same size as a short one.
  await openBoard(page);
  const title = `${"A very long card title ".repeat(9).slice(0, 199)}x`;
  expect(title).toHaveLength(200);
  await addCard(page, "Design", "Short");
  await addCard(page, "Design", title);
  const short = await boardCard(page, "Short").boundingBox();
  const big = await boardCard(page, title).boundingBox();
  expect(big!.width).toBe(short!.width);
  expect(big!.height).toBe(short!.height);
});
