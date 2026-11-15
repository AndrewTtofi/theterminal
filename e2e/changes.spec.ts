import { test, expect } from "@playwright/test";
import {
  allow,
  anonymousUrl,
  latestSeq,
  ledgerItems,
  lineMatching,
  newestRunId,
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

// The fake agent's shell step, once allowed, writes notes.txt holding this key into its working copy (see
// global-setup.ts). Stored as a connection's secret, it is redacted from every diff and file the Owner reads.
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";

test("a run's changes, diff and files are read-only, show the stored key as [REDACTED] and serve nothing outside", async ({ page }) => {
  const watch = watchForLeaks(page, [KEY]);
  const name = "Changes Project";
  await openProject(page, name);
  const since = await latestSeq(page);
  const claude = await openEditor(page, "Claude (Anthropic)");
  // Its own name, so the ledger lines connections.spec.ts counts (connecting and removing "Claude") stay its own.
  await claude.getByLabel("Name", { exact: true }).fill("Claude for Changes");
  await claude.getByLabel("API key", { exact: true }).fill(KEY);
  await saveWithSecret(claude, "API key");

  await prepareRun(page, "fake", "Write some notes");
  await startRun(page);
  await allow(page, "Run: nvidia-smi");
  await expect(lineMatching(ledgerItems(page), RUN_FINISHED("Fake"))).toHaveCount(1);
  const runId = await newestRunId(page, name);

  // The Changes view picks the project's newest run and lists the one untracked file it left.
  await openView(page, "Changes");
  const run = page.getByRole("combobox", { name: "Run" });
  await expect(run).toHaveValue(runId);
  await expect(run.locator("option:checked")).toHaveText("Fake · Write some notes · completed");
  await expect(page.getByText(/^1 file changed · /)).toBeVisible();
  const changed = page.getByRole("list", { name: "Changed files" }).getByRole("listitem");
  await expect(changed).toHaveCount(1);
  await expect(changed).toHaveText("U notes.txt");

  // Its diff: a new file, with the stored key redacted.
  await changed.getByRole("button", { name: "U notes.txt" }).click();
  await expect(page.getByRole("tab", { name: "notes.txt" })).toBeVisible();
  const diff = page.getByRole("region", { name: "Diff: notes.txt" });
  await expect(diff.getByText("New file, not yet committed")).toBeVisible();
  await expect(diff.locator(".line.add .text")).toHaveText(["+key=[REDACTED]", "+hello"]);

  // The file itself, from the working copy's tree: read-only, the key redacted.
  await page.getByRole("list", { name: "Files", exact: true }).getByRole("button", { name: "notes.txt", exact: true }).click();
  const file = page.getByRole("region", { name: "File: notes.txt" });
  await expect(file.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(file.locator(".line .text")).toHaveText(["key=[REDACTED]", "hello"]);

  // Nothing outside the working copy is served, and the 404 says nothing about why.
  const outside = await page.evaluate(async (id) => {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/file?path=${encodeURIComponent("../token")}`);
    return { status: res.status, body: (await res.json()) as unknown };
  }, runId);
  expect(outside.status).toBe(404);
  expect(outside.body).toEqual({ error: "not_found" });

  // Leave the server without a Claude connection.
  await removeConnection(await openEditor(page, "Claude (Anthropic)"));
  await watch.check(since);
});

test("the changes and override routes reject a request without the session cookie", async ({ browser }) => {
  const anon = await browser.newContext();
  const run = "00000000-0000-0000-0000-000000000000";
  for (const path of [`/api/runs/${run}/changes`, `/api/runs/${run}/diff?path=notes.txt`, `/api/runs/${run}/file?path=notes.txt`]) {
    const res = await anon.request.get(anonymousUrl(path));
    expect(res.status(), path).toBe(401);
  }
  for (const [path, data] of [
    [`/api/runs/${run}/override/discard`, { reason: "Checking that the route is closed" }],
    [`/api/runs/${run}/override/command`, { program: "node", args: [], reason: "Checking that the route is closed" }],
  ] as const) {
    const res = await anon.request.post(anonymousUrl(path), { data });
    expect(res.status(), path).toBe(401);
  }
  await anon.close();
});
