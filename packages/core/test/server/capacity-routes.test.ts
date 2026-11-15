import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINKING_ACK, type CapacityReport, type Connection, type HardwareInfo, type LedgerEntry, type LocalEngine, type MachineCapacity } from "@theterminal/shared";
import { fakeHardware } from "../../src/capacity/hardware.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, selectHardware, selectLocalEngines, type RunningServer } from "../../src/server/server.js";
import { COLLABORATORS, seedPeople } from "../fixtures/people.js";
import { localFetch } from "../fixtures/local-fetch.js";

const ENV_KEYS = ["THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_HARDWARE", "THETERMINAL_FAKE_HTTP", "THETERMINAL_FAKE_SCRIPT"] as const;
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
  // A memory store (never the real keychain), the in-process discovery (never multicast), and loopback linking.
  const s = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(),
    discovery: fakeDiscovery(), linkBind: "127.0.0.1", linkPort: 0, ...opts,
  });
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

describe("selectLocalEngines", () => {
  it("returns the injected detector, else the fake HTTP one only under both fake flags, else the real probe", async () => {
    const injected = async (): Promise<LocalEngine[]> => [];
    expect(selectLocalEngines({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_HTTP: "1" }, injected)).toBe(injected);
    const real = selectLocalEngines({});
    expect(selectLocalEngines({ THETERMINAL_FAKE_HTTP: "1" })).toBe(real);
    expect(selectLocalEngines({ THETERMINAL_FAKE_AGENT: "1" })).toBe(real);
    expect(selectLocalEngines({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_HTTP: "1" })).not.toBe(real);
    const fake = await selectLocalEngines({ THETERMINAL_FAKE_AGENT: "1", THETERMINAL_FAKE_HTTP: "1" })();
    expect(fake).toEqual([{
      engine: "ollama", baseUrl: "http://127.0.0.1:11434/v1", version: "0.0.0-fake", detectedAt: expect.any(String),
      models: [{ id: "fake-coder:7b", sizeBytes: 4 * 1024 ** 3, parameters: "7B", quantization: "Q4_K_M" }],
    }]);
  });
});

describe("local models in the capacity API", { timeout: 15000 }, () => {
  it("lists what the fake HTTP serves on this computer, and the connection tester agrees", async () => {
    process.env.THETERMINAL_FAKE_AGENT = "1";
    process.env.THETERMINAL_FAKE_HTTP = "1";
    const s = await start();
    const report = await json<CapacityReport>(send(s, "GET", "/api/capacity"));
    expect(report.localModels.map((e) => [e.engine, e.models.map((m) => m.id)])).toEqual([["ollama", ["fake-coder:7b"]]]);
    const add = await send(s, "POST", "/api/connections", {
      kind: "llm", provider: "local_model", name: "Fake coder", config: { baseUrl: report.localModels[0]!.baseUrl, model: "fake-coder:7b" },
    });
    expect(add.status).toBe(201);
    const id = ((await add.json()) as Connection).id;
    expect(await json(send(s, "POST", `/api/connections/${id}/test`))).toEqual({ ok: true, message: "Connected (model available)" });
  });

  it("caches the detection, and POST /api/capacity/detect refreshes it", async () => {
    let n = 0;
    const localEngines = async (): Promise<LocalEngine[]> => [{
      engine: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1", version: null, detectedAt: new Date().toISOString(),
      models: [{ id: `model-${++n}`, sizeBytes: null, parameters: null, quantization: null }],
    }];
    const s = await start({ localEngines, hardware: async () => fakeHardware });
    const ids = async () => (await json<CapacityReport>(send(s, "GET", "/api/capacity"))).localModels[0]!.models.map((m) => m.id);
    expect(await ids()).toEqual(["model-1"]);
    expect(await ids()).toEqual(["model-1"]);
    expect((await send(s, "POST", "/api/capacity/detect")).status).toBe(200);
    expect(await ids()).toEqual(["model-2"]);
  });

  it("answers with no local models when detection fails", async () => {
    const s = await start({ localEngines: async () => { throw new Error("boom"); } });
    expect((await json<CapacityReport>(send(s, "GET", "/api/capacity"))).localModels).toEqual([]);
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

/** Pairs two running servers over HTTP: `worker` shows a code, `requester` enters it. Answers the worker's machine id. */
async function pairServers(requester: RunningServer, worker: RunningServer): Promise<string> {
  for (const s of [requester, worker]) expect((await send(s, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK })).status).toBe(200);
  const { self } = await json<{ self: { machineId: string; linking: { port: number } } }>(send(worker, "GET", "/api/link"));
  const { code } = await json<{ code: string }>(send(worker, "POST", "/api/link/code"));
  const res = await send(requester, "POST", "/api/link/pair", { address: `127.0.0.1:${self.linking.port}`, code });
  expect(res.status).toBe(201);
  return self.machineId;
}

describe("linked machines in the capacity API", { timeout: 30_000 }, () => {
  it("GET /api/capacity lists each paired machine as it answered; GET /api/link/machines/:id/capacity asks again", async () => {
    const requester = await start();
    const worker = await start({ hardware: async () => fakeHardware });
    await send(worker, "POST", "/api/link/name", { name: "GPU box" });
    await send(worker, "POST", "/api/capacity/detect");
    const added = await send(worker, "POST", "/api/connections", {
      kind: "cloud", provider: "aws", name: "Work AWS", config: { region: "us-east-1" },
      secrets: { accessKeyId: "AKIATESTKEYSRV00000", secretAccessKey: "TESTKEY-aws-srv-secret-0000000000" },
    });
    expect(added.status).toBe(201);
    const aws = (await added.json()) as Connection;
    const workerId = await pairServers(requester, worker);

    const report = await json<CapacityReport>(send(requester, "GET", "/api/capacity"));
    expect(report.machines).toHaveLength(1);
    const [m] = report.machines;
    expect(m).toMatchObject({ machineId: workerId, name: "GPU box", online: true, hardware: { cpu: "Fake CPU", gpu: "Fake GPU" } });
    expect(m!.lastSeenAt).toBe(m!.checkedAt);
    expect(m!.connections).toEqual([{ id: aws.id, kind: "cloud", provider: "aws", name: "Work AWS" }]);
    expect(JSON.stringify(report.machines)).not.toContain("TESTKEY");

    const fresh = await send(requester, "GET", `/api/link/machines/${workerId}/capacity`);
    expect(fresh.status).toBe(200);
    const one = (await fresh.json()) as MachineCapacity;
    expect(one).toMatchObject({ machineId: workerId, name: "GPU box", online: true });

    // The worker goes away: offline, with the values it last sent and when it last answered.
    expect((await send(worker, "POST", "/api/link/disable")).status).toBe(200);
    const gone = await json<MachineCapacity>(send(requester, "GET", `/api/link/machines/${workerId}/capacity`));
    expect(gone).toMatchObject({ machineId: workerId, name: "GPU box", online: false, lastSeenAt: one.checkedAt, hardware: { cpu: "Fake CPU" } });
  });

  it("?cached=1 answers from the 30 s cache that GET /api/capacity filled; without it, the machine is asked again", async () => {
    const requester = await start();
    const worker = await start({ hardware: async () => fakeHardware });
    const workerId = await pairServers(requester, worker);
    const [listed] = (await json<CapacityReport>(send(requester, "GET", "/api/capacity"))).machines;
    await new Promise((r) => setTimeout(r, 20));
    const cached = await json<MachineCapacity>(send(requester, "GET", `/api/link/machines/${workerId}/capacity?cached=1`));
    expect(cached.checkedAt).toBe(listed!.checkedAt);
    const fresh = await json<MachineCapacity>(send(requester, "GET", `/api/link/machines/${workerId}/capacity`));
    expect(fresh.checkedAt).not.toBe(listed!.checkedAt);
    expect((await send(requester, "GET", `/api/link/machines/${workerId}/capacity?cached=yes`)).status).toBe(400);
  });

  it("a machine answering with another key: 409 machine_key_mismatch from the route, flagged in GET /api/capacity", async () => {
    const requester = await start();
    const worker = await start();
    const workerId = await pairServers(requester, worker);
    const { self } = await json<{ self: { linking: { port: number } } }>(send(worker, "GET", "/api/link"));
    await running.splice(running.indexOf(worker), 1)[0]!.close();
    // Another Terminal, with its own key, now listens at the paired address.
    const impostor = await start({ linkPort: self.linking.port });
    const on = await json<{ linking: { port: number } }>(send(impostor, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK }));
    expect(on.linking.port).toBe(self.linking.port);

    for (const path of [`/api/link/machines/${workerId}/capacity`, `/api/link/machines/${workerId}/capacity?cached=1`]) {
      const res = await send(requester, "GET", path);
      expect(res.status, path).toBe(409);
      expect(await res.json()).toEqual({ error: "machine_key_mismatch" });
    }
    const [row] = (await json<CapacityReport>(send(requester, "GET", "/api/capacity"))).machines;
    expect(row).toMatchObject({ machineId: workerId, online: false, problem: "key_mismatch", lastSeenAt: null, hardware: null, connections: [] });
  });

  it("GET /api/link/machines/:id/capacity: 404 for a machine that is not paired, 401 without the session", async () => {
    const s = await start();
    const missing = await send(s, "GET", `/api/link/machines/${"0".repeat(32)}/capacity`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect((await send(s, "GET", `/api/link/machines/${"0".repeat(32)}/capacity`, undefined, false)).status).toBe(401);
    // The workspace host check for this route is in link-routes.test.ts (fetch cannot set Host).
  });

  it("GET /api/capacity has no machines when none is paired", async () => {
    const s = await start();
    expect((await json<CapacityReport>(send(s, "GET", "/api/capacity"))).machines).toEqual([]);
  });
});

describe("GET /api/capacity for a collaborator", { timeout: 30_000 }, () => {
  it("names each source by provider, connection and usage, never its plan, budget or sign-in mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tt-capacity-roles-"));
    dirs.push(dataDir);
    const cookies = seedPeople(dataDir);
    const s = await start({ dataDir });
    await send(s, "POST", "/api/connections", { kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: KEY }, config: { plan: "Max 5x", monthlyBudgetUsd: "40" } });
    const owners = await json<CapacityReport>(send(s, "GET", "/api/capacity"));
    const claude = owners.sources.find((x) => x.provider === "claude")!;
    expect(claude).toMatchObject({ plan: "Max 5x", monthlyBudgetUsd: 40, mode: "api_key" });
    for (const p of COLLABORATORS) {
      const res = await localFetch(`http://127.0.0.1:${s.port}/api/capacity`, { headers: { cookie: cookies[p.id]! } });
      expect(res.status, p.role).toBe(200);
      const text = await res.text();
      for (const word of ["plan", "monthlyBudgetUsd", "mode", "Max 5x", KEY]) expect(text, `${p.role}: ${word}`).not.toContain(word);
      const theirs = JSON.parse(text) as CapacityReport;
      expect(theirs.sources.map((x) => Object.keys(x).sort())).toEqual(
        owners.sources.map(() => ["connectionId", "month", "name", "provider", "rateLimits", "today"]),
      );
      expect(theirs.sources.find((x) => x.provider === "claude")).toMatchObject({ connectionId: claude.connectionId, name: "Claude" });
    }
  });

  it("trims every linked machine's sources the same way: no plan, budget or sign-in mode of another computer's Owner", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tt-capacity-roles-"));
    dirs.push(dataDir);
    const cookies = seedPeople(dataDir);
    const requester = await start({ dataDir });
    const worker = await start();
    await send(worker, "POST", "/api/connections", { kind: "llm", provider: "claude", name: "Box Claude", secrets: { apiKey: KEY }, config: { plan: "Max 20x", monthlyBudgetUsd: "120" } });
    await pairServers(requester, worker);
    const owners = await json<CapacityReport>(send(requester, "GET", "/api/capacity"));
    expect(owners.machines).toHaveLength(1);
    const theirsOnBox = owners.machines[0]!.sources.find((x) => x.provider === "claude")!;
    expect(theirsOnBox).toMatchObject({ plan: "Max 20x", monthlyBudgetUsd: 120, mode: "api_key" });
    for (const p of COLLABORATORS) {
      const res = await localFetch(`http://127.0.0.1:${requester.port}/api/capacity`, { headers: { cookie: cookies[p.id]! } });
      expect(res.status, p.role).toBe(200);
      const text = await res.text();
      for (const word of ["plan", "monthlyBudgetUsd", "mode", "Max 20x", KEY]) expect(text, `${p.role}: ${word}`).not.toContain(word);
      const theirs = JSON.parse(text) as CapacityReport;
      expect(theirs.machines).toHaveLength(1);
      expect(theirs.machines[0]!.sources.map((x) => Object.keys(x).sort())).toEqual(
        owners.machines[0]!.sources.map(() => ["connectionId", "month", "name", "provider", "rateLimits", "today"]),
      );
      expect(theirs.machines[0]!.sources.find((x) => x.provider === "claude")).toMatchObject({ connectionId: theirsOnBox.connectionId, name: "Box Claude" });
      expect(theirs.machines[0]!.connections).toEqual(owners.machines[0]!.connections);
    }
  });
});
