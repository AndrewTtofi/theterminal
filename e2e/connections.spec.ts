import { test, expect } from "@playwright/test";

// The agent server keeps secrets in memory and answers connection tests with a stub (see global-setup.ts).
const KEY = "sk-ant-TESTKEY-e2e-00000000000000";

test("adds a Claude connection, tests it, and never sees the key in a response or a WebSocket frame", async ({ page }) => {
  const leaks: string[] = [];
  // Every body read is kept and awaited before the assertion, so none is still pending when the test checks.
  const reads: Promise<void>[] = [];
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
  let frames = 0;
  page.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => {
      frames++;
      if (String(payload).includes(KEY)) leaks.push(`${ws.url()} (frame)`);
    });
  });

  await page.goto(process.env.TT_E2E_AGENT_URL!);
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Claude (Anthropic)" }).click();

  const editor = page.getByRole("form", { name: "Claude (Anthropic)" });
  await editor.getByRole("textbox", { name: "API key" }).fill(KEY);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByRole("textbox", { name: "API key" })).toHaveAttribute("placeholder", "Stored in your keychain");
  await expect(editor.getByText("Not tested", { exact: true })).toBeVisible();

  await editor.getByRole("button", { name: "Test connection" }).click();
  await expect(editor.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => frames).toBeGreaterThan(0); // the ledger stream delivered the connection events
  await Promise.all(reads);
  expect(reads.length).toBeGreaterThan(0);
  expect(leaks).toEqual([]);
});
