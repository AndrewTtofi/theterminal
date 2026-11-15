import { defineConfig } from "@playwright/test";

// Runs against the packaged app named by TT_DESKTOP_APP (see packaged.spec.ts), one test at a time.
export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  workers: 1,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
