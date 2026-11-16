import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import {
  HOME_APP_TEXT, approvalRow, askOnHome, homeBlock, ledgerItems, lineMatching, newProject, operatorLayout, showAllProjects,
} from "./support.js";

// The Home server (TT_E2E_HOME_URL) is headless, so it has no folder picker: the dialog falls back to a typed path.
// The fixture folder is copied to a temporary folder first, so Apply writes to the copy, never to the repository.

const FIXTURE = join(import.meta.dirname, "fixtures", "project-folder");
let folder: string;
test.beforeEach(() => {
  folder = join(mkdtempSync(join(tmpdir(), "tt-e2e-folder-")), "project-folder");
  cpSync(FIXTURE, folder, { recursive: true });
});
test.afterEach(() => {
  rmSync(join(folder, ".."), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a project from a folder: refused for a possible secret, imported once ticked, then accept and apply back", async ({ page }) => {
  await page.goto(process.env.TT_E2E_HOME_URL!);
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name").fill("Folder Project");
  // The choices are cards whose radios are visually hidden: click the card, as a person does.
  await dialog.getByText("A folder on this computer", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /^A folder on this computer/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Choose folder…" }).click();
  await dialog.getByLabel("Folder path").fill(folder);

  // .env looks like it holds a secret: the whole import is refused, naming it.
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("These files may contain secrets: .env.");
  await dialog.getByRole("checkbox", { name: "include files that may contain secrets" }).check();
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByText("Folder Project is ready.")).toBeVisible();
  // readme.md, src/app.txt, .env and .gitignore; dist/ is ignored by the folder's .gitignore.
  await expect(dialog.getByText("Copied in 4 files", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Folder Project" })).toHaveClass(/selected/);

  const files = homeBlock(page, "Project files");
  await expect(files.getByText("from a folder", { exact: true })).toBeVisible();
  const list = files.locator(".home-file-list > li");
  await expect(list).toHaveText([/src$/, /\.env$/, /\.gitignore$/, /readme\.md$/]);
  await expect(files.getByText("dist")).toHaveCount(0);

  // The fake agent changes src/app.txt once its write and its check are approved.
  const prompt = "Change the app text";
  await askOnHome(page, prompt);
  for (const sentence of [/src\/app\.txt/, /npm test/]) {
    const row = approvalRow(page, sentence);
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);
  }
  // A run's title is the first step of its plan.
  const finished = homeBlock(page, "Finished today").getByRole("listitem").filter({ hasText: /^Read — / });
  await expect(finished.locator(".finished-line")).toHaveText(/ — done$/);

  // Accept these changes: the confirmation lists the changed file, then the run is merged into the project.
  await finished.getByRole("button", { name: "Accept these changes" }).click();
  const confirm = finished.getByRole("group", { name: "Accept these changes" });
  await expect(confirm.getByText("Merge 1 changed file into the project?")).toBeVisible();
  await expect(confirm.getByRole("listitem")).toHaveText(["src/app.txt"]);
  await confirm.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(finished.getByText("Accepted")).toBeVisible();

  // Apply to my folder: the preview lists src/app.txt, and the folder copy then holds the agent's text.
  expect(readFileSync(join(folder, "src", "app.txt"), "utf8")).not.toBe(HOME_APP_TEXT);
  await files.getByRole("button", { name: "Apply to my folder…" }).click();
  const apply = page.getByRole("dialog", { name: "Apply to my folder" });
  await expect(apply.getByText("Write this 1 file to your folder?")).toBeVisible();
  await expect(apply.getByRole("list", { name: "Files to write" }).getByRole("listitem")).toHaveText(["changedsrc/app.txt"]);
  await apply.getByRole("button", { name: "Apply to my folder" }).click();
  await expect(apply.getByText("Wrote 1 file to your folder.")).toBeVisible();
  expect(readFileSync(join(folder, "src", "app.txt"), "utf8")).toBe(HOME_APP_TEXT);
  // Nothing outside the list was touched: the ignored build output is still there, unchanged.
  expect(readFileSync(join(folder, "dist", "out.txt"), "utf8")).toBe(readFileSync(join(FIXTURE, "dist", "out.txt"), "utf8"));
  await apply.getByRole("button", { name: "Close" }).click();
  await expect(apply).toHaveCount(0);
});

test("files dropped onto Project files are added to the project and recorded in the ledger", async ({ page }) => {
  await page.goto(process.env.TT_E2E_HOME_URL!);
  await newProject(page, "Dropped Files");
  const files = homeBlock(page, "Project files");
  await expect(files.getByText("No files yet", { exact: true })).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["first notes\n"], "notes.md", { type: "text/markdown" }));
    dt.items.add(new File(["a,b\n1,2\n"], "table.csv", { type: "text/csv" }));
    return dt;
  });
  const drop = files.locator(".drop-area");
  await drop.dispatchEvent("dragenter", { dataTransfer });
  await drop.dispatchEvent("dragover", { dataTransfer });
  await drop.dispatchEvent("drop", { dataTransfer });

  await expect(files.getByText("Added 2 files", { exact: false })).toBeVisible();
  await expect(files.getByText("added files", { exact: true })).toBeVisible();
  await expect(files.locator(".home-file-list > li")).toHaveText([/notes\.md$/, /table\.csv$/]);

  await operatorLayout(page);
  await showAllProjects(page);
  await expect(lineMatching(ledgerItems(page), ".* added 2 files \\(.*\\) to the project")).toHaveCount(1);
});
