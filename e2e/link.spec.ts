import { request as httpsRequest } from "node:https";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { LINKING_ACK, encodePairingCode, parsePairingCode } from "../packages/shared/dist/index.js";
import {
  latestSeq, ledgerItems, line, lineMatching, newestRunId, openEditor, operatorLayout, openProject, openView, removeConnection, runStatuses,
  saveWithSecret, showAllProjects, startRun, statusBar, watchForLeaks,
} from "./support.js";

// Two computers on one network, both in this process: the agent server (named "Mac" here) and the peer (named "GPU
// box"), each with its own data, a memory keychain, the in-process discovery and a loopback link listener on a free
// port (see global-setup.ts). The tests run in order: the pairing, then what the pair can do, then the unlinking.
test.describe.configure({ mode: "serial" });

const PEER_URL = () => process.env.TT_E2E_PEER_URL!;
const AGENT_URL = () => process.env.TT_E2E_AGENT_URL!;

// The fake agent's shell step prints this key and writes it into notes.txt (see global-setup.ts). Stored as a Claude
// key on both computers, it is redacted on the peer before anything is signed and again here.
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";
const CLAUDE_NAME = "Claude for Link";

/** The peer's page in its own browser context: cookies do not separate by port, so each server gets its own. */
async function openPeer(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(PEER_URL());
  await operatorLayout(page);
  return page;
}

const machinesSide = (page: Page) => page.locator(".machines-side");
const thisComputer = (page: Page) => machinesSide(page).getByRole("region", { name: "This computer" });
const linkPanel = (page: Page) => page.getByRole("region", { name: "Link a machine" });

/** Renames this computer in the Machines view. */
async function rename(page: Page, name: string) {
  await openView(page, "Machines");
  const self = thisComputer(page);
  await self.getByRole("button", { name: "Rename" }).click();
  await self.getByLabel("Computer name").fill(name);
  await self.getByRole("button", { name: "Save" }).click();
  await expect(self.locator(".machine-name > span")).toHaveText(name);
}

/** Turns linking on, through the dialog that shows the exact sentence; returns the port it shows. */
async function allowLinking(page: Page): Promise<number> {
  await openView(page, "Machines");
  const self = thisComputer(page);
  const toggle = self.getByRole("switch", { name: "Allow linking" });
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
    const dialog = self.getByRole("dialog", { name: "Allow linking" });
    await expect(dialog.locator("p").first()).toHaveText(LINKING_ACK);
    await expect(dialog.getByRole("button", { name: "Allow" })).toBeDisabled();
    await dialog.getByLabel("I have read this").check();
    await dialog.getByRole("button", { name: "Allow" }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const shown = self.getByText(/^Linking on · port \d+$/);
  await expect(shown).toBeVisible();
  return Number((await shown.innerText()).replace(/^.*port /, ""));
}

/** This computer's fingerprint as the Machines view shows it (the first 16 hex characters, in fours). */
async function ownFingerprint(page: Page): Promise<string> {
  await openView(page, "Machines");
  return (await thisComputer(page).locator(".machine-fingerprint code").innerText()).trim();
}

/** A code with the same machine prefix as `code` and a different secret: the other machine rejects it. */
function wrongSecret(code: string): string {
  const parsed = parsePairingCode(code)!;
  const secret = Uint8Array.from(parsed.secret, (b, i) => (i === 0 ? b ^ 0xff : b));
  return encodePairingCode(parsed.fingerprintPrefix.padEnd(64, "0"), secret);
}

/** The linked machine's row in the Machines view. */
const machineRow = (page: Page, name: string) =>
  machinesSide(page).getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });

/** Stores a Claude key under CLAUDE_NAME, so the stored key is a secret this computer redacts. */
async function storeKey(page: Page) {
  const editor = await openEditor(page, "Claude (Anthropic)");
  await editor.getByLabel("Name", { exact: true }).fill(CLAUDE_NAME);
  await editor.getByLabel("API key", { exact: true }).fill(KEY);
  await saveWithSecret(editor, "API key");
}

/** The Agent feed tab's entries. */
async function feed(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Agent feed" }).click();
  return page.getByRole("list", { name: "Agent feed entries" }).getByRole("listitem");
}

/** In the Agents view, sends a fake run to the machine named `machine`. */
async function startRemoteRun(page: Page, machine: string, prompt: string) {
  await openView(page, "Agents");
  await page.getByRole("combobox", { name: "Run on" }).selectOption({ label: machine });
  await page.getByRole("combobox", { name: "Agent" }).selectOption("fake");
  await page.getByLabel("Prompt").fill(prompt);
  await startRun(page);
}

/** The decision card of the remote shell step. */
const shellCard = (page: Page) => page.getByRole("article", { name: "Decision: Run: nvidia-smi" });
/** What no response or frame of either computer may ever carry: a stored key, or a link identity's private key. */
const LEAK_SECRETS = ["TESTKEY", "PRIVATE KEY"];

test("two computers pair with a one-time code typed once, and each shows the other's fingerprint to compare", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const peer = await openPeer(browser);
  const peerWatch = watchForLeaks(peer, LEAK_SECRETS);
  const peerSince = await latestSeq(peer);
  const watch = watchForLeaks(page, LEAK_SECRETS);
  await page.goto(AGENT_URL());
  const since = await latestSeq(page);
  await operatorLayout(page);
  await expect(statusBar(page)).toContainText("Machines: 0 linked");

  // The peer: its (fake) hardware detected, so it has something to report; named; then linking allowed through the
  // dialog with the exact sentence.
  await openView(peer, "Capacity");
  await peer.locator(".capacity-side").getByRole("button", { name: "Detect this computer" }).click();
  await expect(peer.locator(".capacity-side").getByRole("region", { name: "This computer" })).toContainText("CPU: Fake CPU (8 cores)");
  await rename(peer, "GPU box");
  await allowLinking(peer);
  const peerFingerprint = await ownFingerprint(peer);
  await rename(page, "Mac");
  await allowLinking(page);
  const macFingerprint = await ownFingerprint(page);

  // The peer shows a code; it begins with the peer's fingerprint, which the panel shows beside it.
  await machinesSide(peer).getByRole("button", { name: "Link a machine" }).click();
  const show = linkPanel(peer);
  await show.getByRole("button", { name: "Show a code" }).click();
  const code = (await show.getByLabel("Pairing code").innerText()).trim();
  expect(parsePairingCode(code)).not.toBeNull();
  await expect(show.locator(".machine-fingerprint code")).toHaveText(peerFingerprint);

  // This computer finds the peer on the network and enters a wrong code first.
  await openView(page, "Machines");
  await machinesSide(page).getByRole("button", { name: "Link a machine" }).click();
  const enter = linkPanel(page);
  await enter.getByRole("tab", { name: "Enter a code" }).click();
  await expect(enter.getByText("Machines found on your network")).toBeVisible();
  const found = enter.getByRole("listbox").getByRole("option", { name: /^GPU box · 127\.0\.0\.1:\d+$/ });
  await found.click();
  await expect(found).toHaveAttribute("aria-selected", "true");
  await expect(enter.getByLabel("Address")).toHaveValue(/^127\.0\.0\.1:\d+$/);
  await enter.getByRole("textbox", { name: "Code", exact: true }).fill(wrongSecret(code));
  await enter.getByRole("button", { name: "Link", exact: true }).click();
  await expect(enter.getByRole("alert")).toHaveText("The other machine rejected the code");
  // The peer's window stays open: the code is still shown there.
  await expect(show.getByLabel("Pairing code")).toHaveText(code);

  // The right code links them. Each side names the other and shows its fingerprint to compare with the other screen.
  await enter.getByRole("textbox", { name: "Code", exact: true }).fill(code);
  await enter.getByRole("button", { name: "Link", exact: true }).click();
  await expect(enter.getByRole("status")).toContainText('Linked "GPU box".');
  await expect(enter.getByRole("status")).toContainText(`Its fingerprint here is ${peerFingerprint}.`);
  await expect(show.getByRole("status")).toContainText('Linked "Mac".');
  await expect(show.getByRole("status")).toContainText(`Its fingerprint here is ${macFingerprint}.`);
  await expect(show.getByLabel("Pairing code")).toHaveCount(0);

  // Both ledgers record it, and both rows show the other machine online.
  await showAllProjects(page);
  await expect(lineMatching(ledgerItems(page), 'Owner linked "GPU box"( \\(.*\\))?')).toHaveCount(1);
  await showAllProjects(peer);
  await expect(lineMatching(ledgerItems(peer), 'Owner linked "Mac"( \\(.*\\))?')).toHaveCount(1);
  await openView(page, "Machines");
  await expect(machineRow(page, "GPU box").locator(".machine-dot")).toHaveText("online");
  await expect(machineRow(page, "GPU box").locator(".machine-fingerprint code")).toHaveText(peerFingerprint);
  await expect(statusBar(page)).toContainText("Machines: 1 linked, 1 online");
  // Pairing carried the public keys and fingerprints, never a private key, to either screen.
  await watch.check(since);
  await peerWatch.check(peerSince);
  await peer.context().close();
});

test("the Capacity view shows the linked machine's hardware and local models", async ({ page }) => {
  test.setTimeout(60_000);
  const watch = watchForLeaks(page, LEAK_SECRETS);
  // The peer detected its hardware before pairing, so this computer's first ask (its answer is kept 30 s) has it.
  await page.goto(AGENT_URL());
  const since = await latestSeq(page);
  await openView(page, "Capacity");
  const side = page.locator(".capacity-side");
  const gpuBox = side.getByRole("region", { name: /^GPU box · / });
  await expect(gpuBox).toBeVisible();
  await expect(gpuBox.getByRole("heading")).toHaveText(/^GPU box · online/);
  await expect(gpuBox).toContainText("Fake CPU");

  await side.getByRole("button", { name: "Open capacity" }).click();
  const table = page.getByRole("table", { name: "Machines" });
  const row = table.getByRole("row").filter({ has: page.getByRole("cell", { name: "GPU box", exact: true }) });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole("cell");
  // Machine, State, CPU, Memory, GPU, Local models, Checked.
  await expect(cells.nth(1)).toHaveText("online");
  await expect(cells.nth(2)).toHaveText("Fake CPU (8 cores)");
  await expect(cells.nth(3)).toHaveText("32 GB");
  await expect(cells.nth(4)).toContainText("Fake GPU, 24 GB");
  await expect(cells.nth(5)).toHaveText("1");
  // What the machine reported about itself carried no secret of either side.
  await watch.check(since);
});

test("a run started here runs on the linked machine, is decided here, and its changes arrive for review", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const peer = await openPeer(browser);
  const peerWatch = watchForLeaks(peer, ["TESTKEY", "PRIVATE KEY"]);
  const peerSince = await latestSeq(peer);
  await storeKey(peer);

  const watch = watchForLeaks(page, ["TESTKEY", "PRIVATE KEY"]);
  const project = "Remote Project";
  await openProject(page, project);
  const since = await latestSeq(page);
  await storeKey(page);
  try {
    await startRemoteRun(page, "GPU box", "Check the GPU");
    const card = shellCard(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText("This agent runs on GPU box.");
    await card.getByRole("button", { name: "Allow" }).click();
    await expect(card).toHaveCount(0);

    // The feed shows what the agent did there, each line marked with the machine, and the end of the run.
    const entries = await feed(page);
    await expect(entries.filter({ hasText: "On GPU box: Owner started a Fake agent" })).toBeVisible();
    await expect(entries.filter({ hasText: /On GPU box: The Fake agent finished/ })).toHaveCount(1);
    await expect.poll(() => runStatuses(page, project)).toEqual(["completed"]);
    await page.getByRole("tab", { name: "Ledger" }).click();
    await expect(line(ledgerItems(page), "The run's changes arrived from GPU box")).toHaveCount(1);
    const runId = await newestRunId(page, project);

    // The changes arrive as the run's working copy and open in the Changes view, the key redacted.
    await openView(page, "Changes");
    await expect(page.getByRole("combobox", { name: "Run" })).toHaveValue(runId);
    const changed = page.getByRole("list", { name: "Changed files" }).getByRole("listitem");
    // The worker committed its working copy into the snapshot, so the file arrives as added (2 lines in, none out).
    await expect(changed).toHaveText(["A notes.txt +2 \u22120"]);
    await changed.getByRole("button", { name: /notes\.txt/ }).click();
    await expect(page.getByRole("region", { name: "Diff: notes.txt" }).locator(".line.add .text")).toHaveText(["+key=[REDACTED]", "+hello"]);

    // Every mirrored entry still verifies against the machine's pinned key.
    const verify = await page.evaluate(async () => (await (await fetch("/api/link/verify")).json()) as { ok: boolean; checked: number });
    expect(verify.ok).toBe(true);
    expect(verify.checked).toBeGreaterThanOrEqual(5);

    // The peer recorded the run it accepted and the decision that came from here.
    await showAllProjects(peer);
    const peerLedger = ledgerItems(peer);
    await expect(line(peerLedger, "Accepted a run from Mac")).toHaveCount(1);
    await expect(line(peerLedger, "Owner's decision arrived from Mac: allowed")).toHaveCount(1);
  } finally {
    await removeConnection(await openEditor(page, "Claude (Anthropic)"));
    await removeConnection(await openEditor(peer, "Claude (Anthropic)"));
  }
  await watch.check(since);
  await peerWatch.check(peerSince);
  await peer.context().close();
});

test("unlinking a machine ends the runs this computer had on it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const watch = watchForLeaks(page, LEAK_SECRETS);
  const project = "Unlinked Project";
  await openProject(page, project);
  const since = await latestSeq(page);
  await startRemoteRun(page, "GPU box", "Wait for me");
  await expect(shellCard(page)).toBeVisible();

  await openView(page, "Machines");
  const row = machineRow(page, "GPU box");
  await row.getByRole("button", { name: 'Unlink "GPU box"' }).click();
  await row.getByRole("group", { name: 'Unlink "GPU box"?' }).getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(machinesSide(page).getByText("No machines linked yet.")).toBeVisible();
  await expect(statusBar(page)).toContainText("Machines: 0 linked");

  // The run ends here at once: its decision card goes, and the ledger says why.
  await expect.poll(() => runStatuses(page, project)).toEqual(["failed"]);
  await expect(shellCard(page)).toHaveCount(0);
  await expect(lineMatching(ledgerItems(page), "The run on .+ stopped: the machine was unlinked")).toHaveCount(1);
  await showAllProjects(page);
  await expect(line(ledgerItems(page), 'Owner unlinked "GPU box"')).toHaveCount(1);
  // The Run on picker is gone with the last linked machine.
  await openView(page, "Agents");
  await expect(page.getByRole("combobox", { name: "Run on" })).toHaveCount(0);
  await openView(page, "Machines");
  await thisComputer(page).getByRole("switch", { name: "Allow linking" }).click();
  await expect(thisComputer(page).getByRole("switch", { name: "Allow linking" })).toHaveAttribute("aria-checked", "false");

  // Before this computer forgot it, the peer was asked to stop the run: nothing waits there for a decision that will
  // not come, and its ledger records the stop as any stop.
  const peer = await openPeer(browser);
  const peerWatch = watchForLeaks(peer, LEAK_SECRETS);
  const peerSince = await latestSeq(peer);
  await expect(shellCard(peer)).toHaveCount(0);
  await expect.poll(() => runStatuses(peer, project)).toEqual(["stopped"]);
  await showAllProjects(peer);
  // Narrated there without the adapter's name: the peer has no local context for a run it executed for another machine.
  await expect(lineMatching(ledgerItems(peer), "The agent was stopped( · .*)?")).toHaveCount(1);
  await openView(peer, "Machines");
  await machineRow(peer, "Mac").getByRole("button", { name: 'Unlink "Mac"' }).click();
  await machineRow(peer, "Mac").getByRole("group", { name: 'Unlink "Mac"?' }).getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(machinesSide(peer).getByText("No machines linked yet.")).toBeVisible();
  await thisComputer(peer).getByRole("switch", { name: "Allow linking" }).click();
  await expect(thisComputer(peer).getByRole("switch", { name: "Allow linking" })).toHaveAttribute("aria-checked", "false");
  await watch.check(since);
  await peerWatch.check(peerSince);
  await peer.context().close();
});

/** An HTTPS request to the peer's link port with no client certificate: resolves with how it ended. */
function bareRequest(port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = httpsRequest({ host: "127.0.0.1", port, path: "/link/v1/hello", method: "GET", rejectUnauthorized: false, timeout: 10_000 }, (res) => {
      resolve(`status ${res.statusCode}`);
      res.resume();
    });
    req.on("error", (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

test("the link routes need the session cookie, and the link port answers nobody without a paired certificate", async ({ browser }) => {
  const anon = await browser.newContext();
  const port = new URL(AGENT_URL()).port;
  for (const path of ["/api/link", "/api/link/verify", "/api/link/machines", "/api/capacity"]) {
    const res = await anon.request.get(`http://127.0.0.1:${port}${path}`);
    expect(res.status(), path).toBe(401);
  }
  await anon.close();

  // Linking on again on the peer, to have a listener to knock on; then off.
  const peer = await openPeer(browser);
  const linkPort = await allowLinking(peer);
  try {
    // A plain fetch cannot even get through TLS (the certificate is the peer's own), and a client that ignores that
    // but has no certificate of a paired machine is cut off before any route answers.
    await expect(fetch(`https://127.0.0.1:${linkPort}/link/v1/hello`)).rejects.toThrow();
    expect(await bareRequest(linkPort)).toMatch(/^error /);
  } finally {
    await thisComputer(peer).getByRole("switch", { name: "Allow linking" }).click();
    await expect(thisComputer(peer).getByRole("switch", { name: "Allow linking" })).toHaveAttribute("aria-checked", "false");
    await peer.context().close();
  }
});
