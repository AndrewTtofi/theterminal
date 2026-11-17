import { test, expect, type Page } from "@playwright/test";
import {
  boardCard, checklistLine, enableBoard, gateCard, homeBlock, importSite, invite, ledgerItems, line, moveButton, openBoard,
  operatorLayout, prepareRun, removeSite, startRun, statusBar, virtualAuthenticator, waive,
} from "./support.js";

// The Board run by agents, on the site server: its fake agent names a card for its job ("[[card: Contact form]]"),
// states a plan, asks to move the card to Design (held by the "Plan approved" gate, the intake not being complete),
// finishes step 1 of 2 and says it read its notes. People never add or move cards here: they leave notes, and they
// answer the agent's move requests on Home.

const PROJECT = "Board Site";
const CARD = "Contact form";
const NOTE = "Make the error message red";
const REQUEST = `Fake wants to move “${CARD}” to Design`;

let folder: string | null = null;
test.afterEach(() => {
  if (folder !== null) removeSite(folder);
  folder = null;
});

/** Home's row for the agent's request to move the card. */
const moveRequest = (page: Page) =>
  homeBlock(page, "Needs your approval").getByRole("listitem").filter({ has: page.locator(".approval-sentence", { hasText: REQUEST }) });

const showHome = (page: Page) => page.getByRole("tab", { name: "Home", exact: true }).click();

test("agents make and move cards, a person leaves a note the next run reads, and a viewer only reads", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await enableBoard(page);
  await page.goto(process.env.TT_E2E_SITE_URL!);
  folder = await importSite(page, PROJECT);
  await operatorLayout(page);
  const ledger = ledgerItems(page);

  // The first run, from the Agents view (not from Home, so the agent names the card itself).
  await prepareRun(page, "fake", "Build the contact form");
  await startRun(page);
  await expect(line(ledger, "The Fake agent finished · cost $0.00 (estimate)")).toHaveCount(1);
  await expect(line(ledger, `Fake took on “${CARD}”`)).toHaveCount(1);

  // The card is in Plan with its run's agent, its bar at step 1 of 2 and what it is doing; nothing to add or move.
  await openBoard(page);
  const card = boardCard(page, CARD, "Plan");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Fake");
  await expect(card.getByRole("progressbar", { name: `${CARD} progress` })).toHaveAttribute("aria-valuenow", "50");
  await expect(card).toContainText("Finished");
  const board = page.locator(".agent-board");
  await expect(board.getByText(/Move to/)).toHaveCount(0);
  await expect(board.getByText("+ Add")).toHaveCount(0);
  await expect(board.getByRole("combobox")).toHaveCount(0);
  await expect(board.getByRole("textbox")).toHaveCount(0);

  // Home: the agent's move to Design waits for a person; Not yet clears it.
  await showHome(page);
  await expect(moveRequest(page)).toHaveCount(1);
  await moveRequest(page).getByRole("button", { name: "Not yet" }).click();
  await expect(moveRequest(page)).toHaveCount(0);
  await expect(line(ledger, `Owner said not yet to moving “${CARD}” to Design`)).toHaveCount(1);

  // A note for the next run, from the card's panel.
  await openBoard(page);
  await boardCard(page, CARD, "Plan").click();
  const panel = page.getByRole("complementary", { name: "Card" });
  await panel.getByLabel("Say something about this").fill(NOTE);
  await panel.getByRole("button", { name: "Send" }).click();
  const note = panel.getByRole("listitem").filter({ hasText: NOTE });
  await expect(note).toContainText("Waiting for the next run");
  await expect(boardCard(page, CARD, "Plan")).toContainText("1 note waiting");
  await expect(line(ledger, `Owner left a note on “${CARD}”`)).toHaveCount(1);

  // A second run on the card, from the Agents view: it is given the note and says it read it.
  await prepareRun(page, "fake", "Make the error message red");
  await page.getByRole("combobox", { name: "Card (optional)" }).selectOption({ label: CARD });
  await startRun(page);
  await expect(line(ledger, `1 note on “${CARD}” was given to Fake`)).toHaveCount(1);
  await expect(line(ledger, `Fake read the notes on “${CARD}”`)).toHaveCount(1);
  await expect(line(ledger, "The Fake agent finished · cost $0.00 (estimate)")).toHaveCount(2);
  await openBoard(page);
  await expect(note).toContainText("Read by Fake");

  // It asks again to move the card to Design. Review asks for the move as a person would, so the gate's card and its
  // waiver make it.
  await showHome(page);
  await moveRequest(page).getByRole("button", { name: "Review" }).click();
  const gate = gateCard(page, "Plan approved");
  await expect(gate).toBeVisible();
  await expect(checklistLine(gate, "The plan has been approved")).toContainText("✗ The plan has been approved");
  await expect(gate.getByRole("button", { name: "Sign off" })).toHaveCount(0);
  // Waive stays disabled until the acknowledgement is ticked and a reason of at least 10 characters is typed.
  const waiveButton = gate.getByRole("button", { name: "Waive" });
  await expect(waiveButton).toBeDisabled();
  await gate.getByRole("checkbox").check();
  await gate.getByLabel("Why are you proceeding anyway?").fill("too short");
  await expect(waiveButton).toBeDisabled();
  await expect(moveButton(page, CARD, "Design")).toBeDisabled();
  await waive(gate, "We are only testing this");
  await moveButton(page, CARD, "Design").click();
  await expect(gate).toHaveCount(0);
  await expect(moveRequest(page)).toHaveCount(0);
  await expect(line(ledger, `Owner waived "Plan approved" for "${CARD}": We are only testing this`)).toHaveCount(1);
  await expect(line(ledger, `Owner moved "${CARD}" from Plan to Design`)).toHaveCount(1);
  await openBoard(page);
  await expect(boardCard(page, CARD, "Design")).toBeVisible();

  // A viewer reads the card and its notes, and has no box to write one.
  const link = await invite(page, "Viewer");
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await virtualAuthenticator(viewer);
    await enableBoard(viewer);
    await viewer.goto(link);
    const join = viewer.getByRole("main", { name: "Join this workspace" });
    await join.getByLabel("Your name").fill("Viewer One");
    await join.getByRole("button", { name: "Create a passkey and join" }).click();
    await expect(statusBar(viewer).getByRole("button", { name: "You: Viewer One (Viewer)" })).toBeVisible();
    await viewer.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: PROJECT }).click();
    await openBoard(viewer);
    await boardCard(viewer, CARD, "Design").click();
    const theirs = viewer.getByRole("complementary", { name: "Card" });
    await expect(theirs.getByRole("listitem").filter({ hasText: NOTE })).toContainText("Read by Fake");
    await expect(theirs.getByText("Notes are for maintainers and above.")).toBeVisible();
    await expect(theirs.getByRole("textbox")).toHaveCount(0);
    await expect(theirs.getByRole("button", { name: "Send" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
