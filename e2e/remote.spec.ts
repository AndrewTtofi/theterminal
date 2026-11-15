import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import {
  allowIn, completedOutputs, invite, ledgerItems, line, lineMatching, openEditor, openView, operatorLayout, peoplePanel, prepareRun,
  RUN_FINISHED, saveWithSecret, showAllProjects, startRun, statusBar, testConnection, virtualAuthenticator, watchForLeaks,
} from "./support.js";

// Remote access over TLS (see global-setup.ts: this server's remote listener is on from the start, on loopback, with a
// self-signed certificate). The Owner works on this computer's own listener; a maintainer joins over the remote
// listener with a key this browser makes (an IP address cannot be a passkey's relying party), works, and loses the
// listener when the Owner turns remote access off. Browsers cannot verify the self-signed certificate, so the
// collaborator's context ignores certificate errors; the page itself never claims to have checked it.

const OWNER_URL = () => process.env.TT_E2E_REMOTE_OWNER_URL!;
const OWNER_TOKEN = () => new URL(OWNER_URL()).searchParams.get("token")!;
const REMOTE_URL = () => process.env.TT_E2E_REMOTE_URL!;
const FINGERPRINT = () => process.env.TT_E2E_FINGERPRINT!;
const REMOTE_LABEL = () => new URL(REMOTE_URL()).host;
/** This computer's listener, by address: Node on Windows does not resolve *.localhost. */
const LOCAL_URL = () => `http://127.0.0.1:${new URL(OWNER_URL()).port}/`;
const PROJECT = "Remote Project";
const AZURE_SECRET = "TESTKEY-azure-remote-0000000000";
const COMPARE =
  "Compare it with the fingerprint your browser shows for this site's certificate (click the lock icon). Continue only if they are the same.";
const MISMATCH = "They do not match. Do not continue: someone may be intercepting the connection.";

/** The link with its fingerprint's first pair changed: what an interceptor's certificate would not match. */
function tampered(link: string): string {
  const [before, fp] = link.split("#fp=") as [string, string];
  return `${before}#fp=${fp.startsWith("00") ? "11" : "00"}${fp.slice(2)}`;
}

/** A request from the page with its own cookie: the status, or "failed" when nothing answers. */
function statusOf(page: Page, path: string) {
  return page.evaluate(async (p) => {
    try {
      return (await fetch(p)).status;
    } catch {
      return "failed" as const;
    }
  }, path);
}

test("the remote listener refuses the token and anonymous requests, and plain HTTP gets no answer", async () => {
  const api = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    // Review Focus 2: the Owner's token never works over the network, in the query or as a bearer.
    const withToken = await api.get(`${REMOTE_URL()}?token=${OWNER_TOKEN()}`, { maxRedirects: 0 });
    expect(withToken.status()).toBe(401);
    expect(withToken.headers()["set-cookie"]).toBeUndefined();
    const bearer = await api.get(`${REMOTE_URL()}api/me`, { headers: { authorization: `Bearer ${OWNER_TOKEN()}` } });
    expect(bearer.status()).toBe(401);
    // Without a cookie, people and presence are closed on both listeners.
    for (const base of [REMOTE_URL(), LOCAL_URL()]) {
      for (const path of ["api/people", "api/presence"]) {
        expect((await api.get(`${base}${path}`)).status(), `${base}${path}`).toBe(401);
      }
    }
    // The join page itself is public, and so is what an invitation offers (here: nothing, for a made-up code).
    expect((await api.get(`${REMOTE_URL()}join/no-such-code`)).status()).toBe(200);
    expect((await api.get(`${REMOTE_URL()}api/join/no-such-code`)).status()).toBe(404);
    // Plain HTTP on the TLS port: no HTTP answer at all.
    const plain = await api.get(REMOTE_URL().replace(/^https:/, "http:"), { timeout: 10_000 }).then(
      (r) => r.status(),
      () => "failed" as const,
    );
    expect(plain).toBe("failed");
  } finally {
    await api.dispose();
  }
});

test("a maintainer joins over TLS with a browser key, works without seeing a secret, and loses access when remote access goes off", async ({ page: owner, browser }) => {
  test.setTimeout(300_000);

  await owner.goto(OWNER_URL());
  await owner.getByLabel("New project name").fill(PROJECT);
  await owner.getByLabel("New project name").press("Enter");
  await expect(owner.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: PROJECT })).toHaveClass(/selected/);
  await operatorLayout(owner);
  await showAllProjects(owner);
  const ownerBar = statusBar(owner);
  await expect(ownerBar.getByRole("button", { name: `Remote: on · ${REMOTE_LABEL()}` })).toBeVisible();

  // An Azure connection, whose secret the maintainer's run gets and nobody but the run ever sees.
  const azure = await openEditor(owner, "Azure");
  await azure.getByLabel("Tenant ID").fill("00000000-0000-4000-8000-000000000001");
  await azure.getByLabel("Client ID").fill("00000000-0000-4000-8000-000000000002");
  await azure.getByLabel("Subscription ID").fill("00000000-0000-4000-8000-000000000003");
  await azure.getByLabel("Client secret").fill(AZURE_SECRET);
  await saveWithSecret(azure, "Client secret");
  await testConnection(azure);
  const azureId = await owner.evaluate(async () => {
    const list = (await (await fetch("/api/connections")).json()) as { id: string; name: string }[];
    return list.find((c) => c.name === "Azure")!.id;
  });

  // The invitation names the remote listener and carries its certificate's fingerprint.
  const link = await invite(owner, "Maintainer", FINGERPRINT());
  expect(link.startsWith(`${REMOTE_URL()}join/`)).toBe(true);
  expect(link.endsWith(`#fp=${FINGERPRINT()}`)).toBe(true);
  expect(link).toMatch(/\/join\/[A-Za-z0-9_-]+#fp=/);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const maintainer = await context.newPage();
    const watch = watchForLeaks(maintainer, ["TESTKEY", OWNER_TOKEN()]);

    // The join page: both fingerprints and the line asking the person to compare, and never a claim that they match.
    await maintainer.goto(link);
    const join = maintainer.getByRole("main", { name: "Join this workspace" });
    await expect(join.getByText("You have been invited as a Maintainer.")).toBeVisible();
    const prints = join.getByRole("region", { name: "Certificate fingerprint" });
    await expect(prints.getByTestId("link-fingerprint")).toHaveText(FINGERPRINT());
    await expect(prints.getByTestId("served-fingerprint")).toHaveText(FINGERPRINT());
    await expect(prints.getByText(COMPARE)).toBeVisible();
    await expect(maintainer.getByText(/they match/i)).toHaveCount(0);
    await expect(maintainer.getByRole("alert")).toHaveCount(0);
    await join.getByLabel("Your name").fill("Maintainer Two");
    await join.getByRole("button", { name: "Create a key in this browser and join" }).click();
    const maintainerBar = statusBar(maintainer);
    await expect(maintainerBar.getByRole("button", { name: "You: Maintainer Two (Maintainer)" })).toBeVisible();
    expect(new URL(maintainer.url()).origin).toBe(new URL(REMOTE_URL()).origin);
    const ledger = ledgerItems(owner);
    await expect(line(ledger, "Maintainer Two joined as maintainer")).toHaveCount(1);
    await expect(line(ledger, "Maintainer Two signed in remotely")).toHaveCount(1);
    // Nobody else's address: the maintainer's status bar shows no remote listener item with an address.
    await expect(maintainerBar.getByText(REMOTE_LABEL())).toHaveCount(0);

    // Presence over the remote listener.
    await maintainer.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: PROJECT }).click();
    await openView(maintainer, "Home");
    await openView(owner, "People");
    await expect(
      owner.locator(".people-side").getByRole("region", { name: "People here" }).getByRole("listitem")
        .filter({ hasText: /^Maintainer Two · Maintainer · Home in Remote Project$/ }),
    ).toHaveCount(1);

    // Connections: names only. The details are the Owner's, in the view and at the route.
    await openView(maintainer, "Connections");
    await expect(maintainer.getByText("Only the Owner can see or change connection details.")).toBeVisible();
    await expect(maintainer.getByRole("form", { name: "Azure" })).toHaveCount(0);
    expect(await statusOf(maintainer, `/api/connections/${encodeURIComponent(azureId)}`)).toBe(403);

    // A run with the Azure connection: the ledger names the maintainer, and the secret it printed is redacted.
    await prepareRun(maintainer, "fake", "Use the cloud");
    await maintainer.getByRole("checkbox", { name: "Azure (cloud account)" }).check();
    await startRun(maintainer);
    await allowIn(maintainer, "Run: nvidia-smi", PROJECT);
    await allowIn(maintainer, "Run: printenv", PROJECT);
    await expect(lineMatching(ledger, "Maintainer Two started a Fake agent.*")).toHaveCount(1);
    await expect(line(ledger, "Maintainer Two allowed it")).toHaveCount(2);
    await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(1);
    // Review Focus 1: what the run printed reached the ledger with the secret replaced.
    expect((await completedOutputs(owner, PROJECT)).at(-1)).toBe("env=AZURE_CLIENT_SECRET=[REDACTED]");

    // A link whose fingerprint was changed on the way: the page says so and will not join.
    const viewerLink = await invite(owner, "Viewer", FINGERPRINT());
    const stranger = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await stranger.newPage();
      await page.goto(tampered(viewerLink));
      const strangerJoin = page.getByRole("main", { name: "Join this workspace" });
      await expect(strangerJoin.getByRole("alert").filter({ hasText: MISMATCH })).toBeVisible();
      await expect(strangerJoin.getByLabel("Your name")).toBeDisabled();
      await expect(strangerJoin.getByRole("button", { name: "Create a key in this browser and join" })).toBeDisabled();
      await expect(page.getByText(/they match/i)).toHaveCount(0);
      // The untouched link still offers the form.
      await page.goto("about:blank");
      await page.goto(viewerLink);
      await expect(strangerJoin.getByLabel("Your name")).toBeEnabled();
      await expect(strangerJoin.getByRole("alert")).toHaveCount(0);
    } finally {
      await stranger.close();
    }

    // The maintainer sees that remote access is on, but not its address; the Owner sees both.
    await openView(maintainer, "People");
    await maintainer.locator(".people-side").getByRole("button", { name: "Open People" }).click();
    const theirPanel = peoplePanel(maintainer);
    await expect(theirPanel.getByRole("region", { name: "Remote access" })).toContainText("On");
    await expect(theirPanel.getByRole("switch", { name: "Remote access" })).toHaveCount(0);
    await expect(theirPanel).not.toContainText(REMOTE_LABEL());
    await expect(ownerBar.getByRole("button", { name: `Remote: on · ${REMOTE_LABEL()}` })).toBeVisible();

    // The Owner turns remote access off from the People view: recorded, shown, and the listener is closed.
    await owner.locator(".people-side").getByRole("button", { name: "Open People" }).click();
    const panel = peoplePanel(owner);
    const remoteSwitch = panel.getByRole("switch", { name: "Remote access" });
    await expect(remoteSwitch).toHaveAttribute("aria-checked", "true");
    await remoteSwitch.click();
    await expect(remoteSwitch).toHaveAttribute("aria-checked", "false");
    await expect(line(ledger, "Owner turned remote access off")).toHaveCount(1);
    await expect(ownerBar.getByRole("button", { name: "Remote: off" })).toBeVisible();
    await expect.poll(() => statusOf(maintainer, "/api/me")).toBe("failed");

    // Turning it on again needs a credential of the Owner's own: refused, and nothing recorded, until there is one.
    await remoteSwitch.click();
    await expect(panel.getByRole("alert").filter({ hasText: "Add a passkey or key for yourself first, under Your credentials." })).toBeVisible();
    await expect(remoteSwitch).toHaveAttribute("aria-checked", "false");
    await virtualAuthenticator(owner);
    await panel.getByRole("button", { name: "Add a passkey" }).click();
    await expect(lineMatching(ledger, 'Owner added a passkey \\(".*"\\)')).toHaveCount(1);
    await remoteSwitch.click();
    await expect(remoteSwitch).toHaveAttribute("aria-checked", "true");
    // The same port and certificate as before.
    await expect(line(ledger, `Owner turned remote access on (this machine's addresses, port ${new URL(REMOTE_URL()).port})`)).toHaveCount(1);
    await expect(ownerBar.getByRole("button", { name: `Remote: on · ${REMOTE_LABEL()}` })).toBeVisible();
    await expect(panel.getByLabel("Certificate fingerprint")).toHaveValue(FINGERPRINT());

    // Back over TLS, the maintainer signs in again with the key this browser kept.
    await context.clearCookies();
    await maintainer.goto(REMOTE_URL());
    await expect(maintainer).toHaveURL(/\/sign-in$/);
    await maintainer.getByRole("main", { name: "Sign in" }).getByRole("button", { name: "Sign in with this browser's key" }).click();
    await expect(maintainerBar.getByRole("button", { name: "You: Maintainer Two (Maintainer)" })).toBeVisible();
    await expect(line(ledger, "Maintainer Two signed in remotely")).toHaveCount(2);

    await watch.check();
  } finally {
    await context.close();
  }
});
