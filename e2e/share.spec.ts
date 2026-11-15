import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { HIDDEN_HARDWARE_LINE, HIDDEN_PROMPTS_LINE } from "../packages/shared/dist/index.js";
import {
  allowIn,
  anonymousUrl,
  latestSeq,
  ledgerItems,
  lineMatching,
  openEditor,
  openView,
  operatorLayout,
  prepareRun,
  projectId,
  removeConnection,
  RUN_FINISHED,
  saveWithSecret,
  startRun,
  statusBar,
  watchForLeaks,
} from "./support.js";

// The fake agent's shell step prints this key, bare, and writes it into notes.txt (see global-setup.ts). Stored as the
// Claude connection's secret, it is redacted from the agent's output; the share page never holds file contents.
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";
// No step prints this, so it must never appear anywhere: a page that held it would have kept a provider key's shape.
const CLAUDE_KEY_SHAPE = "sk-ant-TESTKEY";
const NAME = "Book Club";
// A card title with a right-to-left override, which would reorder what follows it on the page if it were not escaped.
const HOSTILE_TITLE = "Sign‮up";
const HOSTILE_SHOWN = "Sign\\u202eup";

/** Creates the project (with a pitch, which the side bar's form does not take) and its cards, then selects it. */
async function createBookClub(page: Page) {
  const status = await page.evaluate(
    async ({ name, hostile }) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, pitch: "Reading lists for a club, someone@example.test" }),
      });
      if (!res.ok) return res.status;
      const project = (await res.json()) as { id: string };
      for (const title of ["Login", hostile]) {
        const card = await fetch(`/api/projects/${encodeURIComponent(project.id)}/cards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, stage: "build" }),
        });
        if (!card.ok) return card.status;
      }
      return 201;
    },
    { name: NAME, hostile: HOSTILE_TITLE },
  );
  expect(status).toBe(201);
  await page.reload();
  const button = page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: NAME });
  await button.click();
  await expect(button).toHaveClass(/selected/);
  await operatorLayout(page);
}

const shareSide = (page: Page) => page.locator(".share-side");
const preview = (page: Page) => page.getByRole("region", { name: "Share preview" });
const frame = (page: Page) => preview(page).locator('iframe[title="Share page preview"]');

/** The preview's exact HTML, as the iframe was given it. */
async function previewHtml(page: Page): Promise<string> {
  await expect(frame(page)).toBeVisible();
  return (await frame(page).getAttribute("srcdoc")) ?? "";
}

test("a share page is previewed, confirmed, downloaded and shared on this computer, without a secret", async ({ page }) => {
  // A whole agent run and a link on a slow CI machine: every wait below is on state, this only bounds them all.
  test.setTimeout(180_000);
  const watch = watchForLeaks(page, [KEY, CLAUDE_KEY_SHAPE]);
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  const since = await latestSeq(page);
  await createBookClub(page);
  const claude = await openEditor(page, "Claude (Anthropic)");
  await claude.getByLabel("API key", { exact: true }).fill(KEY);
  await saveWithSecret(claude, "API key");

  // A run on Login: the shell step asks, prints the key and writes notes.txt.
  await prepareRun(page, "fake", "Build the login page");
  await page.getByLabel("Card (optional)").selectOption({ label: "Login" });
  await startRun(page);
  await allowIn(page, "Run: nvidia-smi", NAME);
  await expect(lineMatching(ledgerItems(page), RUN_FINISHED("Fake"))).toHaveCount(1);

  // Preview with the defaults: no prompts, and nothing the cleaner keeps out.
  await openView(page, "Share");
  const side = shareSide(page);
  await side.getByRole("button", { name: "Preview share page" }).click();
  await expect(page.getByRole("tab", { name: "Share" })).toBeVisible();
  const body = preview(page).frameLocator('iframe[title="Share page preview"]').locator("body");
  for (const text of [NAME, "Reading lists for a club, [email]", "Login", 'wants to run the command "nvidia-smi"', "estimate"]) {
    await expect(body).toContainText(text);
  }
  // Hidden characters are shown as escapes, never written raw.
  await expect(body).toContainText(HOSTILE_SHOWN);
  let html = await previewHtml(page);
  expect(html).not.toContain("‮");
  for (const absent of [KEY, "TESTKEY", "Build the login page", CLAUDE_KEY_SHAPE, "someone@example.test", "<script"]) {
    expect(html, absent).not.toContain(absent);
  }
  // The page's own "Not included" footer, and the same list beside the preview.
  const footer = body.locator("footer");
  await expect(footer).toContainText("Not included:");
  await expect(footer).toContainText(HIDDEN_PROMPTS_LINE);
  await expect(footer).toContainText(HIDDEN_HARDWARE_LINE);
  await expect(preview(page).getByRole("heading", { name: "Not included" })).toBeVisible();
  await expect(preview(page)).toContainText(HIDDEN_PROMPTS_LINE);

  // With prompts included, the prompt is on the page and its "Not included" line is gone.
  await side.getByRole("checkbox", { name: "Include my prompts to agents" }).check();
  await side.getByRole("button", { name: "Preview share page" }).click();
  await expect(body).toContainText("Build the login page");
  await expect(footer).not.toContainText(HIDDEN_PROMPTS_LINE);
  html = await previewHtml(page);
  expect(html).not.toContain("TESTKEY");

  // Confirm: recorded with the page's hash, and listed as a saved snapshot.
  await preview(page).getByRole("checkbox", { name: "I have read this page and I am happy to share everything on it." }).check();
  await preview(page).getByRole("button", { name: "Confirm and save snapshot" }).click();
  await expect(preview(page).getByText("Saved.", { exact: false })).toBeVisible();
  await expect(lineMatching(ledgerItems(page), "Owner confirmed a share page \\(12 sections,.*")).toHaveCount(1);
  const snapshots = side.getByRole("list", { name: "Saved snapshots" }).getByRole("listitem");
  await expect(snapshots).toHaveCount(1);

  // Download: one file, no script, and the hash the ledger recorded.
  const id = await projectId(page, NAME);
  const [download] = await Promise.all([page.waitForEvent("download"), snapshots.getByRole("link", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^theterminal-share-[0-9a-f]{8}\.html$/);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.toString("utf8")).not.toContain("<script");
  expect(bytes.toString("utf8")).not.toContain("TESTKEY");
  const listed = await page.evaluate(async (pid) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/share/snapshots`);
    return (await res.json()) as { id: string; contentHash: string }[];
  }, id);
  expect(listed).toHaveLength(1);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(listed[0]!.contentHash);
  expect(download.suggestedFilename()).toBe(`theterminal-share-${listed[0]!.id.slice(0, 8)}.html`);

  // A link on this computer, for 24 hours, shown once.
  await snapshots.getByRole("button", { name: "Share on your network…" }).click();
  const form = page.getByRole("form", { name: "Share on your network" });
  await form.getByRole("combobox", { name: "Address" }).selectOption({ label: "This computer only" });
  await form.getByRole("combobox", { name: "Valid for" }).selectOption({ label: "24 hours" });
  await form.getByRole("button", { name: "Create link" }).click();
  const input = form.getByRole("textbox", { name: "Share link" });
  await expect(input).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/);
  const url = await input.inputValue();
  await expect(statusBar(page).getByRole("button", { name: "Sharing: 1 link live" })).toBeVisible();

  // From the test, with no cookie: the same bytes; anything else is not found or not allowed.
  const served = await fetch(url);
  expect(served.status).toBe(200);
  expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  expect((await fetch(`${url}x`)).status).toBe(404);
  const post = await fetch(url, { method: "POST" });
  expect(post.status).toBe(405);
  expect(await post.text()).not.toContain("TESTKEY");

  // Revoke: the status item goes, and the link no longer answers with the page.
  const live = side.getByRole("list", { name: "Live links" }).getByRole("listitem");
  await expect(live).toHaveCount(1);
  await live.getByRole("button", { name: "Revoke" }).click();
  await expect(statusBar(page).getByRole("button", { name: /^Sharing:/ })).toHaveCount(0);
  await expect(live).toHaveCount(0);
  const after = await fetch(url).then(
    (r) => r.status,
    () => "refused",
  );
  expect([404, "refused"]).toContain(after);

  // Leave the server without a Claude connection, then check every response the page saw.
  await removeConnection(await openEditor(page, "Claude (Anthropic)"));
  await watch.check(since);
});

test("twenty wrong tokens revoke a link", async ({ page }) => {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  const id = await projectId(page, NAME);
  const [snapshot] = await page.evaluate(async (pid) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/share/snapshots`);
    return (await res.json()) as { id: string }[];
  }, id);
  const created = await page.evaluate(async (sid) => {
    const res = await fetch(`/api/share/snapshots/${encodeURIComponent(sid)}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "127.0.0.1", ttlMinutes: 60 }),
    });
    return { status: res.status, body: (await res.json()) as { url: string; link: { id: string } } };
  }, snapshot!.id);
  expect(created.status).toBe(201);
  expect(JSON.stringify(created.body)).not.toContain("TESTKEY");
  const { url, link } = created.body;
  expect((await fetch(url)).status).toBe(200);

  const base = url.slice(0, url.lastIndexOf("/") + 1);
  for (let i = 0; i < 20; i++) {
    const wrong = `${"A".repeat(40)}${String(i).padStart(3, "0")}`;
    expect((await fetch(`${base}${wrong}`)).status).toBe(404);
  }
  // The end is recorded in the background: wait for the ledger, not for time.
  await expect
    .poll(() =>
      page.evaluate(async (lid) => {
        const links = (await (await fetch("/api/share/links")).json()) as { id: string; state: string }[];
        return links.find((l) => l.id === lid)?.state;
      }, link.id),
    )
    .toBe("revoked");
  const after = await fetch(url).then(
    (r) => r.status,
    () => "refused",
  );
  expect([404, "refused"]).toContain(after);
});

test("GET /api/share/links without the session cookie is rejected", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get(anonymousUrl("/api/share/links"));
  expect(res.status()).toBe(401);
  expect(await res.text()).not.toContain("TESTKEY");
  await anon.close();
});
