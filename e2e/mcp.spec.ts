import { test, expect, type Page } from "@playwright/test";
import {
  allow, connectionId, ledgerItems, line, lineMatching, openEditor, openProject, prepareRun, removeConnection, runStatuses,
  saveWithSecret, showAllProjects, startRun, watchForLeaks,
} from "./support.js";

const HEADER_VALUE = "TESTKEY-mcp-0000000000";
const CODEX_NOTE =
  "Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.";
const GEMINI_NOTE =
  "Gemini cannot use MCP servers in The Terminal yet: Gemini only starts MCP servers in a trusted folder, and The Terminal never trusts agent worktrees.";

/** Starts a run through the API in the page (it carries the cookie): the response status and body. */
function startThroughApi(page: Page, project: string, adapter: string, connectionIds: string[]) {
  return page.evaluate(
    async ({ project, adapter, connectionIds }) => {
      const projects = (await (await fetch("/api/projects")).json()) as { id: string; name: string }[];
      const id = projects.find((p) => p.name === project)!.id;
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter, prompt: "Use the docs", connectionIds }),
      });
      return { status: res.status, body: (await res.json()) as unknown };
    },
    { project, adapter, connectionIds },
  );
}

test("Codex and Gemini refuse an MCP server; an agent that takes one is given it through the gate", async ({ page }) => {
  const watch = watchForLeaks(page, [HEADER_VALUE]);
  const project = "MCP Project";
  await openProject(page, project);

  const editor = await openEditor(page, "MCP server (remote)");
  await editor.getByLabel("URL").fill("https://mcp.example.test/");
  await editor.getByLabel("Headers").fill(`Authorization=Bearer ${HEADER_VALUE}`);
  await saveWithSecret(editor, "Headers");
  // The editor says up front which agents cannot use it.
  await expect(editor.getByText(CODEX_NOTE)).toBeVisible();
  await expect(editor.getByText(GEMINI_NOTE)).toBeVisible();
  const id = await connectionId(page, "MCP server");

  // The run picker disables the box for Codex and Gemini, with the reason.
  const picker = page.getByRole("region", { name: "Agents" });
  const box = picker.getByRole("checkbox", { name: "MCP server (MCP server)" });
  await prepareRun(page, "fake", "Use the docs");
  await box.check();
  await page.getByRole("combobox", { name: "Agent" }).selectOption("codex");
  await expect(box).toBeDisabled();
  await expect(box).not.toBeChecked();
  await expect(picker.getByText(CODEX_NOTE)).toBeVisible();
  await page.getByRole("combobox", { name: "Agent" }).selectOption("gemini");
  await expect(box).toBeDisabled();
  await expect(picker.getByText(GEMINI_NOTE)).toBeVisible();

  // The server refuses them too, before anything is recorded.
  expect(await startThroughApi(page, project, "codex", [id])).toEqual({ status: 400, body: { error: "mcp_unsupported", adapter: "codex" } });
  expect(await startThroughApi(page, project, "gemini", [id])).toEqual({ status: 400, body: { error: "mcp_unsupported", adapter: "gemini" } });
  expect(await runStatuses(page, project)).toEqual([]);

  // An agent that accepts MCP servers (the fake here; Claude at the route level) gets it, and still asks first.
  await page.getByRole("combobox", { name: "Agent" }).selectOption("fake");
  await expect(box).toBeEnabled();
  await expect(box).toBeChecked(); // the tick stayed for another agent
  await startRun(page);
  await allow(page, "Run: nvidia-smi");
  const ledger = ledgerItems(page);
  await expect(line(ledger, "Agent run completed")).toHaveCount(1);
  await showAllProjects(page);
  await expect(lineMatching(ledger, 'Agent [0-9a-f]{8} was given the MCP server "MCP server"')).toHaveCount(1);

  // Leave the server without an MCP connection for the next spec.
  await removeConnection(await openEditor(page, "MCP server (remote)"));
  await expect(line(ledger, 'Owner removed "MCP server"')).toHaveCount(1);
  await watch.check();
});
