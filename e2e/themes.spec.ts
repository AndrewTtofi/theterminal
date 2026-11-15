import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { operatorLayout } from "./support.js";

const NEON = join(import.meta.dirname, "fixtures", "neon.theme.json");

/** The value of a theme property as the page computes it on <html>. */
const themeProp = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const appearance = (page: Page) => page.getByRole("complementary", { name: "Side bar" }).getByRole("region", { name: "Appearance" });
const card = (page: Page, name: string) => appearance(page).getByRole("list", { name: "Themes" }).getByRole("button", { name, exact: true });

async function openSettings(page: Page) {
  const gear = page.getByRole("button", { name: "Settings", exact: true });
  if ((await gear.getAttribute("aria-pressed")) !== "true") await gear.click();
  await expect(gear).toHaveAttribute("aria-pressed", "true");
  await expect(appearance(page)).toBeVisible();
}

test("the gear opens Settings; a chosen theme applies at once and is still applied after a reload", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  expect(await themeProp(page, "--bg")).toBe("#0d1016");
  await openSettings(page);
  await expect(card(page, "Ice, default")).toHaveAttribute("aria-pressed", "true");

  await card(page, "Light").click();
  await expect(card(page, "Light")).toHaveAttribute("aria-pressed", "true");
  expect(await themeProp(page, "--bg")).toBe("#f6f8fa");

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
  expect(await themeProp(page, "--bg")).toBe("#f6f8fa");
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");

  // The layout presets still work under another theme.
  const layout = page.getByRole("contentinfo", { name: "Status bar" }).getByRole("combobox", { name: "Layout" });
  await operatorLayout(page);
  await expect(page.getByRole("tab", { name: "Agent feed" })).toBeVisible();
  await page.getByRole("contentinfo", { name: "Status bar" }).getByRole("button", { name: "Reset layout" }).click();
  await expect(layout).toHaveValue("preset:guided");
});

test("imports a theme file, selects it, and exports it again", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  await openSettings(page);
  await appearance(page).getByLabel("Import theme file").setInputFiles(NEON);
  await expect(card(page, "Neon")).toHaveAttribute("aria-pressed", "true");
  expect(await themeProp(page, "--accent")).toBe("#39ff14");
  await expect(appearance(page).getByRole("alert")).toHaveCount(0);

  const download = page.waitForEvent("download");
  await appearance(page).getByRole("button", { name: "Export", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("neon.theme.json");
  const saved = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(saved).toEqual(JSON.parse(readFileSync(NEON, "utf8")));

  await page.reload();
  expect(await themeProp(page, "--accent")).toBe("#39ff14");
});

test("refuses a hostile theme file with a plain message and changes nothing", async ({ page }) => {
  await page.goto(process.env.TT_E2E_URL!);
  await openSettings(page);
  const hostile = JSON.stringify({ version: 1, id: "x", name: "X", base: "dark", colors: { bg: "red; background:url(x)" } });
  await appearance(page).getByLabel("Import theme file").setInputFiles({ name: "x.theme.json", mimeType: "application/json", buffer: Buffer.from(hostile) });
  await expect(appearance(page).getByRole("alert")).toContainText("colors.bg: a colour must be #rgb, #rrggbb or #rrggbbaa");
  await expect(card(page, "X")).toHaveCount(0);
  expect(await themeProp(page, "--bg")).toBe("#0d1016");
});
