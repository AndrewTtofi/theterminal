import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium" },
  // A run start creates the project repository and the worktree through runGit, whose hardening checks make five or
  // six git processes of every call: about fifty per start, then the agent's own process. On the Windows runner that
  // is 5 to 10 s, so the first decision card of a run showed up after Playwright's default 5 s had given up. The
  // assertions are unchanged; this is only how long each may wait for the state it asserts.
  expect: { timeout: 15_000 },
});
