import { configDefaults, defineConfig } from "vitest/config";

// Its own config, so a run inside this package never climbs to the root projects config. The smoke suite runs under
// Playwright against a packaged app, never under Vitest.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "smoke/**"] } });
