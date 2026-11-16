import { test, expect, type Browser, type Page, type WebSocket } from "@playwright/test";
import {
  decisionCard, invite, ledgerItems, line, lineMatching, newestRunId, openView, operatorLayout, peoplePanel, prepareRun, RUN_FINISHED,
  showAllProjects, startRun, statusBar, virtualAuthenticator, watchForLeaks,
} from "./support.js";

// The People flow on this computer's own listener (remote access is off on this server, see global-setup.ts): the
// Owner invites a reviewer, who joins in a second browser with a passkey made by Chromium's virtual authenticator,
// signs in again with it, decides, reads a run's files, is made a viewer and then removed, while the Owner watches
// them come and go.

const OWNER_URL = () => process.env.TT_E2E_PEOPLE_URL!;
const OWNER_TOKEN = () => new URL(OWNER_URL()).searchParams.get("token")!;
const PROJECT = "People Project";

/**
 * The event-stream sockets the page's current document opened, in order. A document the page navigated away from is
 * forgotten: Playwright does not report its sockets as closed.
 */
function eventSockets(page: Page): WebSocket[] {
  const sockets: WebSocket[] = [];
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).pathname === "/api/events") sockets.push(ws);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) sockets.length = 0;
  });
  return sockets;
}

/** A request the page makes with its own cookie: the status and the JSON body. */
function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    },
    { method, path, body },
  );
}

async function newContextPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test("the Owner invites a reviewer who joins with a passkey, signs in again, decides, reads files, is made a viewer and is removed", async ({ page: owner, browser }) => {
  test.setTimeout(240_000);
  const forbiddenOwner = { error: "forbidden", required: "owner" };

  await owner.goto(OWNER_URL());
  await owner.getByLabel("New project name").fill(PROJECT);
  await owner.getByLabel("New project name").press("Enter");
  await expect(owner.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: PROJECT })).toHaveClass(/selected/);
  await operatorLayout(owner);
  // People entries belong to no project: the Ledger panel shows every project's.
  await showAllProjects(owner);

  // A link on this computer: no fingerprint (there is no certificate to compare).
  const link = await invite(owner, "Reviewer");
  expect(link).toMatch(/^http:\/\/theterminal\.localhost:\d+\/join\/[A-Za-z0-9_-]+$/);

  const { context, page: reviewer } = await newContextPage(browser);
  try {
    const watch = watchForLeaks(reviewer, ["TESTKEY", OWNER_TOKEN()]);
    const sockets = eventSockets(reviewer);
    await virtualAuthenticator(reviewer);

    // The join page: the role, no fingerprint section, and never a claim that anything matches.
    await reviewer.goto(link);
    const join = reviewer.getByRole("main", { name: "Join this workspace" });
    await expect(join.getByText("You have been invited as a Reviewer.")).toBeVisible();
    await expect(join.getByRole("region", { name: "Certificate fingerprint" })).toHaveCount(0);
    await expect(join.getByText(/they match/i)).toHaveCount(0);
    await join.getByLabel("Your name").fill("Reviewer One");
    await join.getByRole("button", { name: "Create a passkey and join" }).click();
    const reviewerBar = statusBar(reviewer);
    await expect(reviewerBar.getByRole("button", { name: "You: Reviewer One (Reviewer)" })).toBeVisible();
    // The join was recorded under the name they chose.
    await expect(lineMatching(ledgerItems(owner), "Reviewer One joined as .*")).toHaveCount(1);

    // Presence: the Owner sees them in the project and on the view they look at.
    await reviewer.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: PROJECT }).click();
    await openView(reviewer, "Home");
    await openView(owner, "People");
    const here = owner.locator(".people-side").getByRole("region", { name: "People here" });
    await expect(here.getByRole("listitem").filter({ hasText: /^Reviewer One · Reviewer · Home in People Project$/ })).toHaveCount(1);
    const everyone = owner.locator(".people-side").getByRole("region", { name: "Everyone" });
    await expect(everyone.getByRole("listitem").filter({ hasText: "Reviewer One" }).getByRole("img", { name: "Online" })).toBeVisible();

    // A reviewer cannot start work: the button says why.
    await openView(reviewer, "Agents");
    const start = reviewer.getByRole("button", { name: "Start agent" });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("title", "Your role (Reviewer) cannot do this.");

    // The Owner starts the fake agent; the reviewer allows its shell step from the Needs-you strip.
    await prepareRun(owner, "fake", "Write the shared notes");
    await startRun(owner);
    const card = decisionCard(reviewer, "Run: nvidia-smi", PROJECT);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Allow" }).click();
    await expect(card).toHaveCount(0);
    const ledger = ledgerItems(owner);
    await expect(line(ledger, "Reviewer One allowed it")).toHaveCount(1);
    await expect(lineMatching(ledger, RUN_FINISHED("Fake"))).toHaveCount(1);
    const runId = await newestRunId(owner, PROJECT);

    // A reviewer opens a run's file contents.
    await openView(reviewer, "Changes");
    await expect(reviewer.getByRole("combobox", { name: "Run" })).toHaveValue(runId);
    await reviewer.getByRole("list", { name: "Files", exact: true }).getByRole("button", { name: "notes.txt", exact: true }).click();
    const file = reviewer.getByRole("region", { name: "File: notes.txt" });
    await expect(file.locator(".line .text")).toHaveText(["shared notes", "hello"]);

    // Signed out (the cookie gone), the next load goes to sign-in, and the same passkey signs them in again.
    await context.clearCookies();
    await reviewer.goto(new URL("/", link).href);
    await expect(reviewer).toHaveURL(/\/sign-in$/);
    await reviewer.getByRole("main", { name: "Sign in" }).getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(reviewerBar.getByRole("button", { name: "You: Reviewer One (Reviewer)" })).toBeVisible();
    // Joining signed them in once; this is the second.
    await expect(line(ledgerItems(owner), "Reviewer One signed in locally")).toHaveCount(2);
    await reviewer.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: PROJECT }).click();
    await openView(reviewer, "Changes");
    await expect(reviewer.getByRole("list", { name: "Files", exact: true }).getByRole("button", { name: "notes.txt", exact: true })).toBeVisible();

    // The Owner makes them a viewer: their event stream is closed (1008) and opened again with the new role, and the
    // page shows it without a reload.
    const navigations: string[] = [];
    reviewer.on("framenavigated", (f) => {
      if (f === reviewer.mainFrame()) navigations.push(f.url());
    });
    await expect.poll(() => sockets.filter((s) => !s.isClosed()).length).toBeGreaterThan(0);
    const before = sockets.length;
    const open = sockets.filter((s) => !s.isClosed());
    await openView(owner, "People");
    await owner.locator(".people-side").getByRole("button", { name: "Open People" }).click();
    const panel = peoplePanel(owner);
    await panel.getByRole("combobox", { name: "Role of Reviewer One" }).selectOption({ label: "Viewer" });
    await expect(reviewerBar.getByRole("button", { name: "You: Reviewer One (Viewer)" })).toBeVisible();
    await expect.poll(() => open.every((s) => s.isClosed())).toBe(true);
    await expect.poll(() => sockets.slice(before).filter((s) => !s.isClosed()).length).toBeGreaterThan(0);
    expect(navigations).toEqual([]);
    await expect(line(ledgerItems(owner), "Owner made Reviewer One a viewer")).toHaveCount(1);

    // A viewer: no file contents, no Owner controls, and the routes say 403 too.
    await openView(reviewer, "Changes");
    await expect(reviewer.getByText("Only reviewers and above can open file contents.")).toBeVisible();
    await openView(reviewer, "People");
    await expect(reviewer.getByRole("button", { name: "Invite someone" })).toHaveCount(0);
    await reviewer.locator(".people-side").getByRole("button", { name: "Open People" }).click();
    const theirPanel = peoplePanel(reviewer);
    await expect(theirPanel.getByRole("heading", { name: "Your credentials" })).toBeVisible();
    await expect(theirPanel.getByRole("switch", { name: "Remote access" })).toHaveCount(0);
    await expect(theirPanel.getByRole("combobox")).toHaveCount(0);
    await expect(theirPanel.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    expect(await call(reviewer, "GET", `/api/runs/${encodeURIComponent(runId)}/file?path=notes.txt`)).toEqual({
      status: 403, body: { error: "forbidden", required: "reviewer" },
    });
    expect(await call(reviewer, "POST", "/api/people/invites", { role: "viewer" })).toEqual({ status: 403, body: forbiddenOwner });
    expect(await call(reviewer, "PUT", "/api/remote", { enabled: true })).toEqual({ status: 403, body: forbiddenOwner });
    expect(await call(reviewer, "GET", "/api/people/invites")).toEqual({ status: 403, body: forbiddenOwner });
    // What a viewer may read still answers.
    expect((await call(reviewer, "GET", "/api/me")).status).toBe(200);

    // Removed: their sockets close and the page goes to sign-in at once.
    await panel.getByRole("button", { name: "Remove", exact: true }).click();
    await panel.getByRole("button", { name: "Remove Reviewer One" }).click();
    await expect(reviewer).toHaveURL(/\/sign-in$/);
    await expect(reviewer.getByRole("main", { name: "Sign in" })).toBeVisible();
    await expect(panel.getByRole("cell", { name: "Reviewer One", exact: true })).toHaveCount(0);
    expect((await call(reviewer, "GET", "/api/me")).status).toBe(401);

    await watch.check();
  } finally {
    await context.close();
  }
});
