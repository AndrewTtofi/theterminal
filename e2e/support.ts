import { expect, type Locator, type Page } from "@playwright/test";

// Helpers shared by the 5B specs (cloud, github, mcp, capacity). Every spec creates the connections it needs and
// removes them before it ends: all specs share one agent server, one at a time, in file order.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ledger lines whose description is exactly `text` (each line is "<time> · <description>"). */
export const line = (ledger: Locator, text: string) => ledger.filter({ hasText: new RegExp(` · ${escape(text)}$`) });
/** Ledger lines whose description matches `pattern` (anchored at both ends). */
export const lineMatching = (ledger: Locator, pattern: string) => ledger.filter({ hasText: new RegExp(` · ${pattern}$`) });

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

/** Opens the agent server and creates (and selects) a project. */
export async function openProject(page: Page, name: string) {
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill(name);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name })).toHaveClass(/selected/);
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

/** Selects the agent in the Agents view and fills the prompt; the caller ticks connections and starts it. */
export async function prepareRun(page: Page, adapter: "fake" | "codex" | "gemini", prompt: string) {
  await openView(page, "Agents");
  await page.getByRole("combobox", { name: "Agent" }).selectOption(adapter);
  await page.getByLabel("Prompt").fill(prompt);
}

export const startRun = (page: Page) => page.getByRole("button", { name: "Start agent" }).click();

/** Clicks Allow on the decision card with this summary, once it appears. */
export async function allow(page: Page, summary: string) {
  const card = page.getByRole("article", { name: `Decision: ${summary}` });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveCount(0);
}

/**
 * Collects every response body and WebSocket frame of the page, to check that none contains any of `secrets`.
 * `check()` awaits the pending body reads, so none is still in flight when the test asserts.
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
    async check() {
      await Promise.all(reads);
      expect(reads.length).toBeGreaterThan(0);
      const leaks = seen.flatMap(({ source, body }) => secrets.filter((s) => body.includes(s)).map((s) => `${s} in ${source}`));
      expect(leaks).toEqual([]);
    },
  };
}

/** A GET without the session cookie, from Node: the loopback address, since Node on Windows does not resolve *.localhost. */
export function anonymousUrl(path: string): string {
  return `http://127.0.0.1:${new URL(process.env.TT_E2E_AGENT_URL!).port}${path}`;
}
