import { test, expect, type Locator, type Page } from "@playwright/test";

// The agent server keeps secrets in memory and answers connection tests with a stub (see global-setup.ts). Its fake
// agent's shell step prints this same key once allowed.
const KEY = "sk-ant-TESTKEY-e2e-00000000000000";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Ledger lines whose description is exactly `text` (each line is "<time> · <description>"). */
const line = (ledger: Locator, text: string) => ledger.filter({ hasText: new RegExp(` · ${escape(text)}$`) });

const ledgerItems = (page: Page) => page.getByRole("complementary", { name: "Ledger" }).getByRole("listitem");
const openView = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name }).click();

/**
 * Collects every response body and WebSocket frame that contains the key. `check()` awaits the pending body reads,
 * so none is still in flight when the test asserts.
 */
function watchForLeaks(page: Page) {
  const leaks: string[] = [];
  const reads: Promise<void>[] = [];
  let frames = 0;
  page.on("response", (res) => {
    reads.push(
      res.text().then(
        (body) => {
          if (body.includes(KEY)) leaks.push(res.url());
        },
        () => undefined, // no body (a redirect or an aborted request)
      ),
    );
  });
  page.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => {
      frames++;
      if (String(payload).includes(KEY)) leaks.push(`${ws.url()} (frame)`);
    });
  });
  return {
    frames: () => frames,
    async check() {
      await Promise.all(reads);
      expect(reads.length).toBeGreaterThan(0);
      expect(leaks).toEqual([]);
    },
  };
}

/** Opens the Claude editor from the Connections view, stores the key and waits until the field shows it is stored. */
async function addClaude(page: Page): Promise<Locator> {
  await openView(page, "Connections");
  await page.getByRole("button", { name: "Claude (Anthropic)", exact: true }).click();
  const editor = page.getByRole("form", { name: "Claude (Anthropic)" });
  await editor.getByRole("textbox", { name: "API key" }).fill(KEY);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("textbox", { name: "API key" })).toHaveAttribute("placeholder", "Stored in your keychain");
  return editor;
}

async function removeConnection(editor: Locator) {
  await editor.getByRole("button", { name: "Remove connection" }).click();
  await editor.getByRole("group", { name: "Confirm removal" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

test("adds a Claude connection, tests it, and never sees the key in a response or a WebSocket frame", async ({ page }) => {
  const watch = watchForLeaks(page);
  await page.goto(process.env.TT_E2E_AGENT_URL!);

  const editor = await addClaude(page);
  await expect(editor.getByText("Not tested", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Test connection" }).click();
  await expect(editor.getByText("Connected", { exact: true })).toBeVisible();

  // Connection entries belong to no project: the ledger shows them under "All projects".
  await openView(page, "Ledger");
  await page.getByRole("radio", { name: "All projects" }).check();
  const ledger = ledgerItems(page);
  await expect(line(ledger, 'Owner connected "Claude" (AI model)')).toHaveCount(1);
  await expect(line(ledger, '"Claude" connected')).toHaveCount(1);
  await expect.poll(() => watch.frames()).toBeGreaterThan(0); // the ledger stream delivered the connection events

  // Leave the server without a Claude connection for the next test.
  await removeConnection(editor);
  await expect(line(ledger, 'Owner removed "Claude"')).toHaveCount(1);
  await watch.check();
});

/** The outputs of the project's completed actions, read from the ledger API in the page (it carries the cookie). */
function completedOutputs(page: Page, projectName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === name)!;
    const res = await fetch(`/api/ledger?projectId=${encodeURIComponent(project.id)}`);
    if (!res.ok) throw new Error(`GET /api/ledger: ${res.status}`);
    const entries = (await res.json()) as {
      type: string;
      payload: { output?: string };
    }[];
    return entries.filter((e) => e.type === "agent.action.completed").map((e) => String(e.payload.output));
  }, projectName);
}

async function runAndAllowShell(page: Page, prompt: string, completedRuns: number) {
  await openView(page, "Agents");
  await page.getByRole("combobox", { name: "Agent" }).selectOption("fake");
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: "Start agent" }).click();
  const card = page.getByRole("article", { name: "Decision: Run: nvidia-smi" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(line(ledgerItems(page), "Agent run completed")).toHaveCount(completedRuns);
}

test("a stored key is redacted from agent output, and stays redacted after the connection is removed", async ({ page }) => {
  const watch = watchForLeaks(page);
  const project = "Redaction Project";
  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByLabel("New project name").fill(project);
  await page.getByLabel("New project name").press("Enter");
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: project })).toHaveClass(/selected/);

  const editor = await addClaude(page);
  await runAndAllowShell(page, "Print the key", 1);
  // The ledger panel names the completed action; its output is in the entry's payload.
  await expect(ledgerItems(page).filter({ hasText: / · Agent [0-9a-f]{8} finished an action$/ })).toHaveCount(1);
  expect(await completedOutputs(page, project)).toEqual(["key=[REDACTED]"]);

  await openView(page, "Connections");
  await page.getByRole("button", { name: "Claude (Anthropic)", exact: true }).click();
  await removeConnection(editor);

  await runAndAllowShell(page, "Print the key again", 2);
  expect(await completedOutputs(page, project)).toEqual(["key=[REDACTED]", "key=[REDACTED]"]);
  await watch.check();
});

test("GET /api/connections without the session cookie is rejected", async ({ browser }) => {
  // Node-side requests use the loopback address: Node on Windows does not resolve *.localhost.
  const anon = await browser.newContext();
  const res = await anon.request.get(`http://127.0.0.1:${new URL(process.env.TT_E2E_AGENT_URL!).port}/api/connections`);
  expect(res.status()).toBe(401);
  expect(await res.text()).not.toContain(KEY);
  await anon.close();
});
