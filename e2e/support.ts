import { expect, type Locator, type Page } from "@playwright/test";

// Helpers shared by the 5B specs (cloud, github, mcp, capacity). Every spec creates the connections it needs and
// removes them before it ends: all specs share one agent server, one at a time, in file order.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ledger lines whose headline matches `pattern` (anchored at both ends); the raw record under it is ignored. */
export const lineMatching = (ledger: Locator, pattern: string) =>
  ledger.filter({ has: ledger.page().locator(".headline", { hasText: new RegExp(`^${pattern}$`) }) });
/** Ledger lines whose headline is exactly `text`. */
export const line = (ledger: Locator, text: string) => lineMatching(ledger, escape(text));
/** The ledger's headlines, in the order shown (newest first). */
export const headlines = async (ledger: Locator) => (await ledger.locator(".headline").allInnerTexts()).map((t) => t.trim());
/** How a completed run of the given adapter reads in the ledger (a reported cost follows the headline). */
export const RUN_FINISHED = (adapter: string) => `The ${adapter} agent finished( · .*)?`;

export const ledgerItems = (page: Page) => page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
export const statusBar = (page: Page) => page.getByRole("contentinfo", { name: "Status bar" });

/** Shows the view in the side bar. Clicking the active view's button would hide the side bar, so it is left alone. */
export async function openView(page: Page, name: string) {
  const button = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** Shows every project's entries (connection entries belong to no project) in the Ledger panel. */
export async function showAllProjects(page: Page) {
  await openView(page, "Ledger");
  await page.getByRole("radio", { name: "All projects" }).check();
}

/**
 * Chooses the Operator layout, whose bottom panel holds the Terminal, the Agent feed and the Ledger. The default
 * layout (Guided) has no bottom panel, so every spec that reads the Ledger or the Agent feed tab chooses this first.
 */
export async function operatorLayout(page: Page) {
  await statusBar(page).getByRole("combobox", { name: "Layout" }).selectOption({ label: "Operator" });
  await expect(page.getByRole("tab", { name: "Ledger" })).toBeVisible();
}

/** Opens the agent server, creates (and selects) a project, and chooses the Operator layout. */
export async function openProject(page: Page, name: string) {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);
  await operatorLayout(page);
}

/** Opens a catalog entry's editor from the Connections view (a new connection, or the existing one). */
export async function openEditor(page: Page, label: string): Promise<Locator> {
  await openView(page, "Connections");
  await page.locator(".connections-side").getByRole("button", { name: label, exact: true }).click();
  const editor = page.getByRole("form", { name: label });
  await expect(editor).toBeVisible();
  return editor;
}

/** Saves the editor and waits until the given secret field shows that its value is stored. */
export async function saveWithSecret(editor: Locator, secretField: string) {
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByLabel(secretField, { exact: true })).toHaveAttribute("placeholder", "Stored in your keychain");
}

export async function testConnection(editor: Locator) {
  await editor.getByRole("button", { name: "Test connection" }).click();
  await expect(editor.getByText("Connected", { exact: true })).toBeVisible();
}

export async function removeConnection(editor: Locator) {
  await editor.getByRole("button", { name: "Remove connection" }).click();
  await editor.getByRole("group", { name: "Confirm removal" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

/** The id of the connection named `name`, read in the page (it carries the cookie). */
export function connectionId(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const list = (await (await fetch("/api/connections")).json()) as { id: string; name: string }[];
    const found = list.find((c) => c.name === n);
    if (!found) throw new Error(`no connection named ${n}`);
    return found.id;
  }, name);
}

/** The outputs of the project's completed actions, oldest first, read from the ledger API in the page. */
export function completedOutputs(page: Page, projectName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === name)!;
    const res = await fetch(`/api/ledger?projectId=${encodeURIComponent(project.id)}`);
    if (!res.ok) throw new Error(`GET /api/ledger: ${res.status}`);
    const entries = (await res.json()) as { seq: number; type: string; payload: { output?: string } }[];
    return entries
      .filter((e) => e.type === "agent.action.completed")
      .sort((a, b) => a.seq - b.seq)
      .map((e) => String(e.payload.output));
  }, projectName);
}

/** The statuses of the project's runs, read from the API in the page. */
export function runStatuses(page: Page, projectName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === name)!;
    const runs = (await (await fetch(`/api/projects/${encodeURIComponent(project.id)}/runs`)).json()) as { status: string }[];
    return runs.map((r) => r.status);
  }, projectName);
}

/** The id of the project's newest run, read from the API in the page. */
export function newestRunId(page: Page, projectName: string): Promise<string> {
  return page.evaluate(async (name) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === name)!;
    const runs = (await (await fetch(`/api/projects/${encodeURIComponent(project.id)}/runs`)).json()) as { id: string; startedAt: string }[];
    const newest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!newest) throw new Error(`no run in ${name}`);
    return newest.id;
  }, projectName);
}

/** Selects the agent in the Agents view and fills the prompt; the caller ticks connections and starts it. */
export async function prepareRun(page: Page, adapter: "fake" | "codex" | "gemini", prompt: string) {
  await openView(page, "Agents");
  await page.getByRole("combobox", { name: "Agent" }).selectOption(adapter);
  await page.getByLabel("Prompt").fill(prompt);
}

export const startRun = (page: Page) => page.getByRole("button", { name: "Start agent" }).click();

/** The Needs-you strip above the dock, where decisions are taken (the Needs-you tab shows read-only copies). */
export const needsYouStrip = (page: Page) => page.getByRole("region", { name: "Needs you", exact: true });

/**
 * The strip's card for the decision with this summary in the named project. The strip shows every project's pending
 * decisions, so a card another spec left pending would otherwise match too.
 */
export const decisionCard = (page: Page, summary: string, projectName: string) =>
  needsYouStrip(page)
    .getByRole("article", { name: `Decision: ${summary}` })
    .filter({ has: page.locator(".project-name", { hasText: new RegExp(`^${escape(projectName)}$`) }) });

/** Clicks Allow on the decision card with this summary, once it appears. */
export async function allow(page: Page, summary: string) {
  const card = page.getByRole("article", { name: `Decision: ${summary}` });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveCount(0);
}

/** The seq of the last ledger entry of every project, read in the page (it carries the cookie). */
export function latestSeq(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let last = 0;
    for (;;) {
      const res = await fetch(`/api/ledger?afterSeq=${last}&limit=500`);
      if (!res.ok) throw new Error(`GET /api/ledger: ${res.status}`);
      const entries = (await res.json()) as { seq: number }[];
      if (entries.length === 0) return last;
      last = entries[entries.length - 1]!.seq;
    }
  });
}

/**
 * Whether `body` is ledger JSON (an entry, or an array of them) in which every entry holding `secret` has `seq` at
 * most `since`. Earlier specs let the fake agent print the Claude test key before the spec stored it, when it was not
 * yet a secret: those entries are not leaks, and the ledger keeps serving them.
 */
function onlyEntriesBefore(body: string, secret: string, since: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return entries.every((e) => {
    if (typeof e !== "object" || e === null || typeof (e as { seq?: unknown }).seq !== "number") return false;
    return !JSON.stringify(e).includes(secret) || (e as { seq: number }).seq <= since;
  });
}

/**
 * Collects every response body and WebSocket frame of the page, to check that none contains any of `secrets`.
 * `check()` awaits the pending body reads, so none is still in flight when the test asserts. Given `since` (a ledger
 * seq read when the test began), ledger entries recorded up to it are not counted: see `onlyEntriesBefore`.
 */
export function watchForLeaks(page: Page, secrets: string[]) {
  const seen: { source: string; body: string }[] = [];
  const reads: Promise<void>[] = [];
  page.on("response", (res) => {
    reads.push(
      res.text().then(
        (body) => {
          seen.push({ source: res.url(), body });
        },
        () => undefined, // no body (a redirect or an aborted request)
      ),
    );
  });
  page.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => {
      seen.push({ source: `${ws.url()} (frame)`, body: String(payload) });
    });
  });
  return {
    async check(since?: number) {
      await Promise.all(reads);
      expect(reads.length).toBeGreaterThan(0);
      const leaks = seen.flatMap(({ source, body }) =>
        secrets
          .filter((s) => body.includes(s) && (since === undefined || !onlyEntriesBefore(body, s, since)))
          .map((s) => `${s} in ${source}`),
      );
      expect(leaks).toEqual([]);
    },
  };
}

/** A GET without the session cookie, from Node: the loopback address, since Node on Windows does not resolve *.localhost. */
export function anonymousUrl(path: string): string {
  return `http://127.0.0.1:${new URL(process.env.TT_E2E_AGENT_URL!).port}${path}`;
}

/** A value that looks like a token to the redaction patterns; refused wherever intake or waiver text is written. */
export const SECRET_LIKE = "ghp_TESTKEY0000000000000000000000000000";
/** The message shown when text that looks like a secret is refused. */
export const SECRET_REFUSED = "That text looks like it contains a key or password. It was not saved.";

/** The id of the project named `name`, read in the page (it carries the cookie). */
export function projectId(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const found = projects.find((p) => p.name === n);
    if (!found) throw new Error(`no project named ${n}`);
    return found.id;
  }, name);
}

/** Every ledger entry of the project, oldest first, read from the ledger API in the page. */
export function projectEntries(
  page: Page,
  projectName: string,
): Promise<{ seq: number; type: string; payload: Record<string, unknown> }[]> {
  return page.evaluate(async (name) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === name)!;
    const out: { seq: number; type: string; payload: Record<string, unknown> }[] = [];
    for (;;) {
      const after = out.length === 0 ? 0 : out[out.length - 1]!.seq;
      const res = await fetch(`/api/ledger?projectId=${encodeURIComponent(project.id)}&afterSeq=${after}&limit=500`);
      if (!res.ok) throw new Error(`GET /api/ledger: ${res.status}`);
      const page = (await res.json()) as { seq: number; type: string; payload: Record<string, unknown> }[];
      if (page.length === 0) return out.sort((a, b) => a.seq - b.seq);
      out.push(...page);
    }
  }, projectName);
}

/** The readiness gate card in the Needs-you strip. */
export const gateCard = (page: Page, title: string) => page.getByRole("article", { name: `Gate: ${title}` });
/** One line of a gate card's checklist ("✓" or "✗", then the condition). */
export const checklistLine = (gate: Locator, label: string) =>
  gate.getByRole("list", { name: "Checklist" }).getByRole("listitem").filter({ hasText: label });

/** Ticks the gate's acknowledgement, gives the reason and chooses Waive; the move button below records it. */
export async function waive(gate: Locator, reason: string) {
  await gate.getByRole("checkbox").check();
  await gate.getByLabel("Why are you proceeding anyway?").fill(reason);
  await gate.getByRole("button", { name: "Waive" }).click();
  await expect(gate.getByRole("button", { name: "Waive" })).toHaveAttribute("aria-pressed", "true");
}

/** The button under the gate cards that makes the move with the decisions taken. */
export const moveButton = (page: Page, card: string, stage: string) =>
  page.getByRole("region", { name: "Needs you" }).getByRole("button", { name: `Move "${card}" to ${stage}` });

/** Adds a card to a column of the Board and waits until it shows there. */
export async function addCard(page: Page, stage: string, title: string) {
  await page.getByLabel(`Add card to ${stage}`).fill(title);
  await page.getByLabel(`Add card to ${stage}`).press("Enter");
  await expect(page.getByRole("region", { name: stage }).getByRole("button", { name: `Open the story of ${title}` })).toBeVisible();
}
