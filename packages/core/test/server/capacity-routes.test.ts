import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapacityReport, Connection, HardwareInfo, LedgerEntry } from "@theterminal/shared";
import { fakeHardware } from "../../src/capacity/hardware.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, selectHardware, type RunningServer } from "../../src/server/server.js";

const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_HARDWARE", "THETERMINAL_FAKE_SCRIPT"] as const;
const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const KEY = "sk-ant-TESTKEY-0000000000";
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-capacity-"));
  dirs.push(dataDir);
  const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), ...opts });
  running.push(s);
  return s;
}

const send = (s: RunningServer, method: string, path: string, body?: unknown, authed = true) =>
  fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: { ...(authed && { authorization: `Bearer ${s.token}` }), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const hardwareEvents = async (s: RunningServer) =>
  (await json<LedgerEntry[]>(send(s, "GET", "/api/ledger"))).filter((e) => e.type.startsWith("connection."));

describe("selectHardware", () => {
  const injected = async (): Promise<HardwareInfo> => fakeHardware;

  it("selects the fake detector only under THETERMINAL_FAKE_AGENT=1 with THETERMINAL_FAKE_HARDWARE=1", async () => {
    const real = selectHardware({});
    expect(selectHardware({ THETERMINAL_FAKE_HARDWARE: "1" })).toBe(real);
    expect(selectHardware({ THETERMINAL_FAKE_AGENT: "1" })).toBe(real);
    const fake = selectHardware({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_HARDWARE: "1" });
    expect(fake).not.toBe(real);
    expect(await fake()).toMatchObject({ cpu: "Fake CPU", gpu: "Fake GPU" });
    expect(selectHardware({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_HARDWARE: "1" }, injected)).toBe(injected);
  });
});

describe("capacity API", { timeout: 15000 }, () => {
  it("answers 401 without the token", async () => {
    const s = await start();
    expect((await send(s, "GET", "/api/capacity", undefined, false)).status).toBe(401);
    expect((await send(s, "POST", "/api/capacity/detect", undefined, false)).status).toBe(401);
  });

  it("detects this computer into the local_hardware connection, recording an update on every later detect", async () => {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_HARDWARE = "1";
    const s = await start();
    expect((await json<CapacityReport>(send(s, "GET", "/api/capacity"))).hardware).toBeNull();

    const res = await send(s, "POST", "/api/capacity/detect");
    expect(res.status).toBe(200);
    const info = (await res.json()) as HardwareInfo;
    expect(info).toMatchObject({ cpu: "Fake CPU", cores: 8, memoryGb: 32, gpu: "Fake GPU", gpuMemoryGb: 24, wsl: false });

    const [added] = await hardwareEvents(s);
    expect(added).toMatchObject({ type: "connection.added", actor: { kind: "human", id: "owner" } });
    expect(added!.payload).toMatchObject({
      kind: "hardware", provider: "local_hardware", name: "This computer",
      config: { cpu: "Fake CPU", cores: "8", memoryGb: "32", gpu: "Fake GPU", gpuMemoryGb: "24", platform: info.platform, wsl: "false", detectedAt: info.detectedAt },
    });

    expect((await send(s, "POST", "/api/capacity/detect")).status).toBe(200);
    const events = await hardwareEvents(s);
    expect(events.map((e) => e.type)).toEqual(["connection.added", "connection.updated"]);

    const report = await json<CapacityReport>(send(s, "GET", "/api/capacity"));
    expect(report.hardware).toMatchObject({ enabled: true, cpu: "Fake CPU", cores: 8, memoryGb: 32, gpu: "Fake GPU", gpuMemoryGb: 24, wsl: false });
    expect(report.sources.map((x) => x.provider)).toEqual(["claude", "codex", "gemini"]);
  });

  it("lets the Owner disable This computer but never edit its fields", async () => {
    const s = await start({ hardware: async () => fakeHardware });
    await send(s, "POST", "/api/capacity/detect");
    const [hw] = await json<Connection[]>(send(s, "GET", "/api/connections"));
    expect((await send(s, "PATCH", `/api/connections/${hw!.id}`, { config: { cpu: "Mine" } })).status).toBe(400);
    expect((await send(s, "PATCH", `/api/connections/${hw!.id}`, { name: "Mine", enabled: false })).status).toBe(400);
    const off = await send(s, "PATCH", `/api/connections/${hw!.id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, config: { cpu: "Fake CPU" } });
    // A later detection keeps the Owner's choice.
    await send(s, "POST", "/api/capacity/detect");
    expect((await json<Connection[]>(send(s, "GET", "/api/connections")))[0]!.enabled).toBe(false);
    // Still reported, marked as turned off.
    expect((await json<CapacityReport>(send(s, "GET", "/api/capacity"))).hardware).toMatchObject({ enabled: false, cpu: "Fake CPU" });
  });

  it("adds the month's cost and the summed monthly budget to /api/status", async () => {
    const s = await start();
    const before = await json<Record<string, unknown>>(send(s, "GET", "/api/status"));
    expect(before).toMatchObject({ monthCostUsd: 0, monthlyBudgetUsd: null, todayCostUsd: 0, ci: null });
    const add = await send(s, "POST", "/api/connections", {
      kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: KEY }, config: { plan: "Max 5x", monthlyBudgetUsd: "50" },
    });
    expect(add.status).toBe(201);
    expect(await json(send(s, "GET", "/api/status"))).toMatchObject({ monthCostUsd: 0, monthlyBudgetUsd: 50 });
    const report = await json<CapacityReport>(send(s, "GET", "/api/capacity"));
    expect(report.sources[0]).toMatchObject({ provider: "claude", plan: "Max 5x", monthlyBudgetUsd: 50, name: "Claude" });
  });
});
