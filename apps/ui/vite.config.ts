import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1" },
  // Served locally from 127.0.0.1, so bundle size matters little; the docking library alone is ~500 kB.
  build: { chunkSizeWarningLimit: 1000 },
});
