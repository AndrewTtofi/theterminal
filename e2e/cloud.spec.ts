import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { redact } from "../packages/core/dist/index.js";
import {
  allow, completedOutputs, ledgerItems, line, lineMatching, openEditor, openProject, prepareRun, removeConnection, runStatuses,
  saveWithSecret, showAllProjects, startRun, testConnection, watchForLeaks,
} from "./support.js";

// The agent server answers AWS through its fake STS (any access key id with TESTKEY) and Azure through its fake token
// endpoint (any client secret with TESTKEY). The fake STS mints these values; the fake agent's "Run: printenv" step,
// present only in runs given AWS credentials, prints the session token bare and the Azure secret (see global-setup.ts).
const AZURE_SECRET = "TESTKEY-azure-secret-0000000000";
const AWS_SECRET = "TESTKEY-aws-secret-0000000000";
const MINTED_TOKEN = "FQoGZXIvYXdzTESTKEY-session-0000000000";
const MINTED_SECRET = "TESTKEY-session-secret-0000000000";
const SECRETS = [AZURE_SECRET, AWS_SECRET, MINTED_TOKEN, MINTED_SECRET];

const AZURE_GIVEN = 'Agent [0-9a-f]{8} was given the Azure client secret from "Azure"';
const AWS_GIVEN = 'Agent [0-9a-f]{8} was given a 12-hour AWS session token from "AWS"';

test("the minted session token matches no built-in redaction pattern, so only the run's own redaction can hide it", () => {
  expect(redact(MINTED_TOKEN)).toBe(MINTED_TOKEN);
});

async function addAzure(page: Page) {
  const editor = await openEditor(page, "Azure");
  await editor.getByLabel("Tenant ID").fill("00000000-0000-4000-8000-000000000001");
  await editor.getByLabel("Client ID").fill("00000000-0000-4000-8000-000000000002");
  await editor.getByLabel("Subscription ID").fill("00000000-0000-4000-8000-000000000003");
  await editor.getByLabel("Client secret").fill(AZURE_SECRET);
  await saveWithSecret(editor, "Client secret");
  await testConnection(editor);
}

async function addAws(page: Page) {
  const editor = await openEditor(page, "AWS");
  await editor.getByLabel("Access key ID").fill("AKIATESTKEY000000000");
  await editor.getByLabel("Secret access key").fill(AWS_SECRET);
  await editor.getByLabel("Region").fill("eu-west-1");
  await saveWithSecret(editor, "Secret access key");
  await testConnection(editor);
}

const box = (page: Page, name: string) => page.getByRole("checkbox", { name: `${name} (cloud account)` });

/** The env the fake Gemini CLI recorded at its most recent start, from its own log file (not the ledger). */
function lastGeminiEnv(): Record<string, string> | undefined {
  const entries = readFileSync(process.env.TT_E2E_FAKE_LOG!, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { initialize?: { env: Record<string, string> } });
  return entries.filter((e) => e.initialize).at(-1)?.initialize?.env;
}

test("a run gets only the cloud accounts ticked for it, and a minted token is redacted from its output", async ({ page }) => {
  const watch = watchForLeaks(page, SECRETS);
  const project = "Cloud Project";
  await openProject(page, project);
  await addAzure(page);
  await addAws(page);

  // Run 1: both accounts ticked. The printenv step asks; once allowed, it prints the minted token and the secret.
  await prepareRun(page, "fake", "Use the cloud");
  await box(page, "Azure").check();
  await box(page, "AWS").check();
  await startRun(page);
  await allow(page, "Run: nvidia-smi");
  await allow(page, "Run: printenv");
  const ledger = ledgerItems(page);
  await expect(line(ledger, "Agent run completed")).toHaveCount(1);
  // Review Focus 1: the bare minted token (never stored, matched by no pattern) is redacted, as is the Azure secret.
  expect((await completedOutputs(page, project)).at(-1)).toBe("[REDACTED]\nenv=AZURE_CLIENT_SECRET=[REDACTED]");

  // Run 2: nothing ticked. No grant, so no printenv step and no "was given" line.
  await box(page, "Azure").uncheck();
  await box(page, "AWS").uncheck();
  await page.getByLabel("Prompt").fill("No cloud this time");
  await startRun(page);
  await allow(page, "Run: nvidia-smi");
  await expect(line(ledger, "Agent run completed")).toHaveCount(2);
  const outputs = await completedOutputs(page, project);
  expect(outputs).toHaveLength(3); // nvidia-smi and printenv, then nvidia-smi only
  expect(outputs.filter((o) => o.includes("AZURE_CLIENT_SECRET"))).toHaveLength(1);

  // Review Focus 2: one grant per ticked account, from run 1 only.
  await showAllProjects(page);
  await expect(lineMatching(ledger, AZURE_GIVEN)).toHaveCount(1);
  await expect(lineMatching(ledger, AWS_GIVEN)).toHaveCount(1);

  // Run 3: Gemini with both ticked. Its fake CLI records the env it started with: the cloud variables, never the
  // server's OpenAI key.
  await prepareRun(page, "gemini", "Write the notes");
  await box(page, "Azure").check();
  await box(page, "AWS").check();
  await startRun(page);
  const card = page.getByRole("article", { name: "Decision: Write notes.txt" });
  await expect(card).toBeVisible(); // the CLI has started (and logged its env) by the time it asks
  const env = lastGeminiEnv()!;
  expect(env.AZURE_CLIENT_SECRET).toBe(AZURE_SECRET);
  expect(env.AWS_SESSION_TOKEN).toBe(MINTED_TOKEN);
  expect(env).not.toHaveProperty("OPENAI_API_KEY");
  expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => runStatuses(page, project)).toEqual(["completed", "completed", "completed"]);
  await expect(lineMatching(ledger, AZURE_GIVEN)).toHaveCount(2);
  await expect(lineMatching(ledger, AWS_GIVEN)).toHaveCount(2);

  // Leave the server without cloud connections for the next spec.
  await removeConnection(await openEditor(page, "AWS"));
  await removeConnection(await openEditor(page, "Azure"));
  await expect(line(ledger, 'Owner removed "AWS"')).toHaveCount(1);
  await expect(line(ledger, 'Owner removed "Azure"')).toHaveCount(1);
  await watch.check();
});
