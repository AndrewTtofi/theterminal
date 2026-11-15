import { test, expect } from "@playwright/test";
import {
  allow, latestSeq, ledgerItems, lineMatching, newestRunId, openEditor, openProject, prepareRun, projectEntries, removeConnection,
  runStatuses, showAllProjects, startRun, watchForLeaks,
} from "./support.js";

// The agent server's model servers are fakes (THETERMINAL_FAKE_HTTP=1): Ollama on 127.0.0.1:11434 lists fake-coder:7b,
// and llama.cpp server is not running. Codex is the fake CLI, which never calls the model server.
const LOCAL_MODEL = "Local model (Ollama or llama.cpp)";
const NAME = "Fake coder";
const ONLY_CODEX = "Only Codex can run on a local model in The Terminal yet.";

test("a local model found on this computer tests cleanly and Codex runs on it with no provider key", async ({ page }) => {
  test.setTimeout(90_000);
  const watch = watchForLeaks(page, ["TESTKEY", "PRIVATE KEY"]);
  const project = "Local Model Project";
  await openProject(page, project);
  const since = await latestSeq(page);

  // The editor lists what the detection found; Use fills the server URL and the model.
  const editor = await openEditor(page, LOCAL_MODEL);
  await editor.getByRole("button", { name: "Use fake-coder:7b" }).click();
  await expect(editor.getByLabel("Server URL")).toHaveValue("http://127.0.0.1:11434/v1");
  await expect(editor.getByLabel("Model", { exact: true })).toHaveValue("fake-coder:7b");
  await editor.getByLabel("Name", { exact: true }).fill(NAME);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor.getByText("Not tested", { exact: true })).toBeVisible();
  try {
    await editor.getByRole("button", { name: "Test connection" }).click();
    await expect(editor.getByText("Connected", { exact: true })).toBeVisible();
    // The editor says Connected; the server's message says what the test proved.
    const message = await page.evaluate(async (n) => {
      const list = (await (await fetch("/api/connections")).json()) as { name: string; status: { message: string | null } }[];
      return list.find((c) => c.name === n)?.status.message;
    }, NAME);
    expect(message).toBe("Connected (model available)");

    // Only Codex can use it: under Gemini the box is disabled and says so.
    await prepareRun(page, "gemini", "Write the tests");
    const box = page.getByRole("group", { name: "Run on a local model" });
    await expect(box.getByRole("checkbox", { name: NAME })).toBeDisabled();
    await expect(box.getByText(ONLY_CODEX)).toBeVisible();

    await prepareRun(page, "codex", "Run the tests on the local model");
    await expect(box.getByRole("checkbox", { name: NAME })).toBeEnabled();
    await expect(box.getByText(ONLY_CODEX)).toHaveCount(0);
    await box.getByRole("checkbox", { name: NAME }).check();
    await startRun(page);
    await allow(page, "Run: npm test");
    await expect.poll(() => runStatuses(page, project)).toEqual(["completed"]);

    // The run was given the local model, and ran with no provider key (authMode none).
    const runId = await newestRunId(page, project);
    await showAllProjects(page); // connection entries belong to no project
    await expect(lineMatching(ledgerItems(page), `Agent ${runId.slice(0, 8)} was given the local model "${NAME}"`)).toHaveCount(1);
    const started = (await projectEntries(page, project)).find((e) => e.type === "agent.started" && e.payload.runId === runId);
    expect(started?.payload).toMatchObject({ adapter: "codex", authMode: "none" });
  } finally {
    await removeConnection(await openEditor(page, LOCAL_MODEL));
  }
  await watch.check(since);
});
