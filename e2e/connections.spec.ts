import { test, expect } from "@playwright/test";

// The agent server keeps secrets in memory and answers connection tests with a stub (see global-setup.ts).
const KEY = "sk-ant-TESTKEY-e2e-00000000000000";

test("adds a Claude connection, tests it, and never sees the key in a response", async ({ page }) => {
  const leaks: string[] = [];
  page.on("response", async (res) => {
    try {
      if ((await res.text()).includes(KEY)) leaks.push(res.url());
    } catch {
      // no body (a redirect or an aborted request)
    }
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
  expect(leaks).toEqual([]);
});
