import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type RunningServer } from "../../src/server/server.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";

/** Codex's Rust target triple per platform, as in bundled.ts. */
const CODEX_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

const running: RunningServer[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
});

/** A core directory in the hoisted layout the desktop app ships, holding only Codex and its platform binary. */
function hoistedCore(): string {
  const root = mkdtempSync(join(tmpdir(), "tt-core-"));
  const core = join(root, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@theterminal/core" }));
  const codex = join(core, "node_modules", "@openai", "codex");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  const native = join(core, "node_modules", "@openai", `codex-${process.platform}-${process.arch}`);
  const target = CODEX_TARGETS[`${process.platform}-${process.arch}`]!;
  const bin = join(native, "vendor", target, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(native, "package.json"), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
  const exe = join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  return core;
}

describe("createServer coreDir", () => {
  it("coreDir decides where bundled programs are found (the hoisted layout the desktop app ships)", async () => {
    const coreDir = hoistedCore();
    const dataDir = mkdtempSync(join(tmpdir(), "tt-data-"));
    const s = await createServer({ dataDir, port: 0, coreDir, which: () => null, secrets: new MemorySecretStore() });
    running.push(s);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/agents`, {
      headers: { authorization: `Bearer ${s.token}`, host: `127.0.0.1:${s.port}` },
    });
    expect(res.status).toBe(200);
    const { providers } = (await res.json()) as { providers: Record<string, { available: boolean }> };
    expect(providers.codex?.available).toBe(true);
    expect(providers.claude?.available).toBe(false);
    expect(providers.gemini?.available).toBe(false);
  });
});
