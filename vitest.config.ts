import { defineConfig } from "vitest/config";

// Vitest 4 dropped workspace files: each package is a project of the root config.
export default defineConfig({
  test: { projects: ["packages/*", "apps/*"] },
});
