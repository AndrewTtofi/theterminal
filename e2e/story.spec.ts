import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  addCard,
  allow,
  anonymousUrl,
  boardCard,
  decisionCard,
  gatesOf,
  ledgerItems,
  line,
  lineMatching,
  moveCardViaApi,
  openEditor,
  openProject,
  openView,
  prepareRun,
  projectId,
  removeConnection,
  RUN_FINISHED,
  saveWithSecret,
  startRun,
  waivers,
} from "./support.js";

// The fake agent's shell step prints this key, bare (see global-setup.ts). Stored as a connection's secret, it is
// redacted from the agent's output, so neither the story nor the export ever holds it.
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";
const SHELL_MEANS =
  "Runs a program on this computer, inside the agent's working copy. It can read and change files there and reach the network.";

test("a card's story tells what happened in plain language, its decisions and why, and the project exports for audit", async ({ page }) => {
  const name = "Story Project";
  await openProject(page, name);
  const claude = await openEditor(page, "Claude (Anthropic)");
  await claude.getByLabel("API key", { exact: true }).fill(KEY);
  await saveWithSecret(claude, "API key");

  await openView(page, "Board");
  // The Board no longer moves cards: the move and its waiver go through the route it used to call.
  const card = await addCard(page, "Build", "Login");
  const blocked = await moveCardViaApi(page, card, "ship");
  expect(blocked.status).toBe(409);
  expect((await moveCardViaApi(page, card, "ship", waivers(gatesOf(blocked.body), "We are only testing this"))).status).toBe(200);
  await expect(boardCard(page, "Login", "Ship")).toBeVisible();

  // During the run, the decision card says what the step means.
  await prepareRun(page, "fake", "Check the login page");
  await page.getByLabel("Card (optional)").selectOption({ label: "Login" });
  await startRun(page);
  const decision = decisionCard(page, "Run: nvidia-smi", name);
  await expect(decision.getByRole("heading", { name: "What this means", level: 4 })).toBeVisible();
  await expect(decision.getByText(SHELL_MEANS)).toBeVisible();
  await allow(page, "Run: nvidia-smi");
  await expect(lineMatching(ledgerItems(page), RUN_FINISHED("Fake"))).toHaveCount(1);

  // A card opens its panel, and the panel opens its story.
  await openView(page, "Board");
  await boardCard(page, "Login").click();
  await page.getByRole("complementary", { name: "Card" }).getByRole("button", { name: "Open the full story" }).click();
  const story = page.getByRole("region", { name: "Story: Login" });
  await expect(story).toBeVisible();
  const happened = story.getByRole("list", { name: "What happened" }).getByRole("listitem");
  for (const headline of ['The Fake agent wants to run the command "nvidia-smi"', "Owner allowed it", "Done (1 line of output)"]) {
    await expect(line(happened, headline)).toHaveCount(1);
  }
  const done = line(happened, "Done (1 line of output)");
  await done.getByRole("group").getByText("Raw", { exact: true }).click();
  await expect(done.locator("pre")).toContainText('"output": "[REDACTED]"');
  await expect(story).not.toContainText("TESTKEY");
  const decisions = story.getByRole("list", { name: "Decisions and why" }).getByRole("listitem");
  await expect(decisions.filter({ hasText: 'Owner waived "Ready to ship" for "Login": We are only testing this' })).toHaveCount(1);
  await expect(decisions.filter({ hasText: "Owner allowed it" })).toHaveCount(1);
  // A healthy ledger shows no integrity warning.
  await expect(story.getByRole("alert")).toHaveCount(0);
  await expect(story).not.toContainText("could not be read");

  // The project's audit export: the integrity header first, every entry with its headline, the trailer last.
  await openView(page, "Ledger");
  await page.getByRole("radio", { name: "This project" }).check();
  const id = await projectId(page, name);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export for audit" }).click()]);
  expect(download.suggestedFilename()).toBe(`theterminal-ledger-${id}.ndjson`);
  const text = readFileSync((await download.path())!, "utf8");
  expect(text).not.toContain("TESTKEY");
  const lines = text.trimEnd().split("\n");
  const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(records[0]).toMatchObject({ kind: "header", projectId: id, integrity: { ok: true } });
  expect(lines[0]).toContain('"kind":"header"');
  expect(records.at(-1)).toMatchObject({ kind: "end", gaps: 0 });
  expect(lines.at(-1)).toMatch(/^\{"kind":"end",/);
  expect(lines.some((l) => l.includes('"headline":"Owner waived'))).toBe(true);
  const entries = records.slice(1, -1);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((e) => e.kind === "entry" && e.projectId === id && typeof e.headline === "string")).toBe(true);

  // Leave the server without a Claude connection.
  await removeConnection(await openEditor(page, "Claude (Anthropic)"));
});

test("the story and export routes reject a request without the session cookie", async ({ browser }) => {
  const anon = await browser.newContext();
  for (const path of [
    "/api/cards/00000000-0000-0000-0000-000000000000/story",
    "/api/ledger/export",
    "/api/ledger/export?projectId=00000000-0000-0000-0000-000000000000",
  ]) {
    const res = await anon.request.get(anonymousUrl(path));
    expect(res.status(), path).toBe(401);
  }
  await anon.close();
});
