import { test, expect, type Page } from "@playwright/test";
import {
  addCard, allow, enableBoard, openBoard, latestSeq, ledgerItems, lineMatching, openEditor, openView, operatorLayout, prepareRun, removeConnection,
  RUN_FINISHED, saveWithSecret, startRun, statusBar, watchForLeaks,
} from "./support.js";

// The peer has no internet: its fetch fails every non-loopback URL the way undici does when the name does not resolve
// (see offlineFetch in global-setup.ts). Nothing here reaches the network; the state is inferred from those failures.
const CLAUDE_KEY = "sk-ant-TESTKEY-offline-000000000000";
const GITHUB_TOKEN = "ghp_TESTKEY0000000000000000000000000001";
const OFFLINE_TITLE =
  "No internet connection was reachable the last time The Terminal tried (inferred). Local work, local models and linked machines keep working.";
const OFFLINE_NOTE = "You seem to be offline. Cloud models will not answer; a local model will.";

/** Opens the peer, creates (and selects) a project, and chooses the Operator layout. */
async function openPeerProject(page: Page, name: string) {
  await enableBoard(page);
  await page.goto(process.env.TT_E2E_PEER_URL!);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);
  await operatorLayout(page);
  await openBoard(page);
}

test("without internet the status bar says Offline (inferred), local work goes on, and cloud features say why they fail", async ({ page }) => {
  test.setTimeout(120_000);
  const watch = watchForLeaks(page, [CLAUDE_KEY, GITHUB_TOKEN, "PRIVATE KEY"]);
  const project = "Offline Project";
  await openPeerProject(page, project);
  const since = await latestSeq(page);

  const claude = await openEditor(page, "Claude (Anthropic)");
  await claude.getByLabel("Name", { exact: true }).fill("Claude offline");
  await claude.getByLabel("API key", { exact: true }).fill(CLAUDE_KEY);
  await saveWithSecret(claude, "API key");
  const github = await openEditor(page, "GitHub");
  await github.getByLabel("Personal access token").fill(GITHUB_TOKEN);
  await github.getByLabel("Repository").fill("octo/example");
  await saveWithSecret(github, "Personal access token");
  try {
    // A key test cannot reach the provider, and from that failure the status bar infers that the internet is away.
    const editor = await openEditor(page, "Claude (Anthropic)");
    await editor.getByRole("button", { name: "Test connection" }).click();
    await expect(editor.getByText("Failed: Could not reach the provider")).toBeVisible();
    const offline = statusBar(page).getByText("Offline (inferred)", { exact: true });
    await expect(offline).toBeVisible();
    await expect(offline).toHaveAttribute("title", OFFLINE_TITLE);

    // The board works.
    await openView(page, "Board");
    await addCard(page, "Design", "Works offline");

    // A cloud agent would not answer, and the start form says so; the fake agent runs and is decided as ever.
    await prepareRun(page, "codex", "Anything");
    await expect(page.getByText(OFFLINE_NOTE)).toBeVisible();
    await prepareRun(page, "fake", "Detect the GPU offline");
    await expect(page.getByText(OFFLINE_NOTE)).toHaveCount(0);
    await startRun(page);
    await allow(page, "Run: nvidia-smi");
    await expect(lineMatching(ledgerItems(page), RUN_FINISHED("Fake"))).toHaveCount(1);

    // The Machines view works: this computer's identity and its switch.
    await openView(page, "Machines");
    const self = page.locator(".machines-side").getByRole("region", { name: "This computer" });
    await expect(self.locator(".machine-fingerprint code")).toHaveText(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    await expect(self.getByRole("switch", { name: "Allow linking" })).toBeEnabled();

    // GitHub cannot be reached, and the view says so with the offline note.
    await openView(page, "GitHub");
    await expect(page.getByRole("complementary", { name: "Side bar" }).getByText("Could not reach GitHub. You seem to be offline.", { exact: true })).toBeVisible();
    await expect(offline).toBeVisible();
  } finally {
    await removeConnection(await openEditor(page, "GitHub"));
    await removeConnection(await openEditor(page, "Claude (Anthropic)"));
  }
  await watch.check(since);
});
