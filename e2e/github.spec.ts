import { test, expect } from "@playwright/test";
import { anonymousUrl, openEditor, openView, removeConnection, saveWithSecret, statusBar, testConnection, watchForLeaks } from "./support.js";

// The agent server answers api.github.com with canned bodies for any repository when the token holds TESTKEY, and 404
// for a repository named "missing" (see fakeHttp in server.ts).
const TOKEN = "ghp_TESTKEY0000000000000000000000000000";

test("the GitHub view lists the repository's branches, pull requests and CI runs, and a missing one says so", async ({ page }) => {
  const watch = watchForLeaks(page, [TOKEN]);
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await expect(statusBar(page)).toContainText("CI: not connected");

  const editor = await openEditor(page, "GitHub");
  await editor.getByLabel("Personal access token").fill(TOKEN);
  await editor.getByLabel("Repository").fill("octo/example");
  await saveWithSecret(editor, "Personal access token");
  await testConnection(editor);

  await openView(page, "GitHub");
  const view = page.locator(".github-side");
  await expect(view.getByRole("link", { name: "octo/example" })).toBeVisible();
  const section = (name: string) => view.getByRole("region", { name });
  await expect(section("Branches").getByRole("listitem")).toHaveText(["main", "feature/e2e"]);
  await expect(section("Pull requests").getByRole("link", { name: "#7 Add the thing" })).toBeVisible();
  await expect(section("CI runs").getByRole("listitem")).toHaveCount(2);
  await expect(section("CI runs").getByRole("listitem").nth(0)).toContainText("passing");
  await expect(section("CI runs").getByRole("listitem").nth(1)).toContainText("running");
  // The status bar asks for the CI state on load and on every ledger entry; the overview is cached by now.
  await page.reload();
  await expect(statusBar(page)).toContainText("CI: passing");

  // Review Focus 4: another repository starts a new cache, so the old one's data is never shown for it.
  const again = await openEditor(page, "GitHub");
  await again.getByLabel("Repository").fill("octo/missing");
  await again.getByRole("button", { name: "Save" }).click();
  await expect(statusBar(page)).toContainText("CI: unknown");
  await openView(page, "GitHub");
  await expect(page.getByText("Repository not found, or the token has no access to it")).toBeVisible();
  await expect(page.getByRole("link", { name: "octo/example" })).toHaveCount(0);

  // Leave the server without a GitHub connection for the next spec.
  await removeConnection(await openEditor(page, "GitHub"));
  await expect(statusBar(page)).toContainText("CI: not connected");
  await watch.check();
});

test("GET /api/github/overview without the session cookie is rejected", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get(anonymousUrl("/api/github/overview"));
  expect(res.status()).toBe(401);
  await anon.close();
});
