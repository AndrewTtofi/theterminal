import { defineConfig } from "@playwright/test";

// Runs against the packaged app named by TT_DESKTOP_APP (see packaged.spec.ts), one test at a time.
export default defineConfig({
  testDir: ".",
  workers: 1,
  timeout: 120_000,
  reporter: "list",
});
