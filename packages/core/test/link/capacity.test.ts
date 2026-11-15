import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINKING_ACK, machineCapacityBodySchema, machineCapacitySchema, type AdapterId, type LocalEngine,
} from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { NotFoundError } from "../../src/board/board-service.js";
import { ConnectionService } from "../../src/connections/service.js";
import { capacityReport } from "../../src/capacity/report.js";
import { LinkListener } from "../../src/link/listener.js";
import { LinkClient } from "../../src/link/client.js";
import { LinkService } from "../../src/link/service.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { registerLinkProtocolRoutes, type LinkProtocolDeps } from "../../src/link/protocol-routes.js";
import { LinkCapacity } from "../../src/link/capacity.js";
import { LinkIdentity } from "../../src/link/identity.js";
import { holdPort, newIdentity, rawTlsGet, tlsServer } from "./helpers.js";

const owner = { kind: "human", id: "owner" } as const;
const SECRETS = {
  claude: "sk-ant-TESTKEY-cap-0000000000",
  awsAccess: "AKIATESTKEYCAP00000",
  awsSecret: "TESTKEY-aws-cap-secret-0000000000",
  header: "Bearer TESTKEY-hdr-0000000000",
  local: "TESTKEY-local-cap-000000",
};
const ENGINES: LocalEngine[] = [
  {
    engine: "ollama", baseUrl: "http://127.0.0.1:11434/v1", version: "0.5.0", detectedAt: "2026-11-15T09:00:00.000Z",
    models: [{ id: "qwen2.5-coder:14b", sizeBytes: 9_000_000_000, parameters: "14B", quantization: "Q4_K_M" }],
  },
];
const HARDWARE = {
  cpu: "AMD Ryzen 9 7950X", cores: 16, memoryGb: 64, gpu: "NVIDIA RTX 4090", gpuMemoryGb: 24, platform: "linux" as const, wsl: false,
  detectedAt: "2026-11-15T09:00:00.000Z",
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let ids = 0;
const uuidId = () => `${String(++ids).padStart(8, "0")}-0000-4000-8000-000000000000`;

type Capacity = NonNullable<LinkProtocolDeps["capacity"]>;

/** A service on its own memory db and store, binding loopback; `capacity` makes it answer `/link/v1/capacity`. */
function makeService(o: { capacity?: (db: Db, ledger: Ledger) => Capacity; now?: () => Date } = {}) {
  const db = openDatabase(":memory:");
  const ledger = new Ledger(db);
  const secrets = new MemorySecretStore();
  const capacity = o.capacity?.(db, ledger);
  const link: LinkService = new LinkService({
    db, ledger, secrets,
    listener: (deps) => new LinkListener(deps),
    client: (identity, timeoutMs) => new LinkClient({ identity, ...(timeoutMs !== undefined && { timeoutMs }) }),
    registerProtocol: (app) => registerLinkProtocolRoutes(app, { link, ...(capacity && { capacity }) }),
    discovery: fakeDiscovery(),
    bind: "127.0.0.1",
    ...(o.now && { now: o.now }),
  });
  cleanups.push(() => link.shutdown());
  return { db, ledger, secrets, link };
}

function recordPaired(db: Db, ledger: Ledger, other: LinkIdentity, port: number, name = "GPU box") {
  commitEvent(db, ledger, () => ({
    event: {
      projectId: null, actor: owner, type: "machine.paired",
      payload: { machineId: other.machineId, name, publicKey: other.publicKeyBase64, fingerprint: other.fingerprint, address: `127.0.0.1:${port}`, role: "entered_code" },
    },
    result: () => undefined,
  }));
}

/** The worker's connections: Claude (a key, a plan naming a home path, a name with an email), AWS, an MCP server with a header, a local model with a key. */
async function seedWorker(connections: ConnectionService) {
  const claude = await connections.add(owner, {
    kind: "llm", provider: "claude", name: "Claude for owner@example.com",
    config: { plan: `Max 5x, notes in ${join(homedir(), "plan.txt")}` }, secrets: { apiKey: SECRETS.claude },
  });
  const aws = await connections.add(owner, {
    kind: "cloud", provider: "aws", name: "Work AWS", config: { region: "us-east-1" },
    secrets: { accessKeyId: SECRETS.awsAccess, secretAccessKey: SECRETS.awsSecret },
  });
  const mcp = await connections.add(owner, {
    kind: "mcp", provider: "mcp_http", name: "Docs", config: { url: "https://mcp.example.com/mcp" }, secrets: { headers: `Authorization=${SECRETS.header}` },
  });
  const local = await connections.add(owner, {
    kind: "llm", provider: "local_model", name: "Qwen on Ollama",
    config: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:14b" }, secrets: { apiKey: SECRETS.local },
  });
  await connections.writeHardware(owner, HARDWARE);
  return { claude, aws, mcp, local };
}

/**
 * Two services: A (requester) and B (worker, linking on, answering capacity from its own report). Each has the other
 * recorded as paired. `reports` counts B's capacity answers.
 */
async function pairOfServices(o: { now?: () => Date; adapters?: AdapterId[] } = {}) {
  let connections!: ConnectionService;
  const counter = { reports: 0 };
  const b = makeService({
    capacity: (db, ledger) => {
      connections = new ConnectionService({ db, ledger, secrets: new MemorySecretStore(), testers: {}, newId: uuidId });
      return {
        report: async () => {
          counter.reports++;
          return capacityReport(db, {
            budgets: () => connections.budgets(), modes: () => "api_key", hardware: () => connections.hardware(), localModels: () => ENGINES,
          });
        },
        adapters: () => o.adapters ?? ["codex", "fake"],
        connections,
      };
    },
  });
  const a = makeService(o.now ? { now: o.now } : {});
  await connections.load();
  const seeded = await seedWorker(connections);
  await a.link.load();
  await b.link.load();
  const bPort = await b.link.enableLinking(owner, LINKING_ACK, 0);
  const aId = await LinkIdentity.load({ secrets: a.secrets, onCreated: () => undefined });
  const bId = await LinkIdentity.load({ secrets: b.secrets, onCreated: () => undefined });
  recordPaired(a.db, a.ledger, bId, bPort);
  recordPaired(b.db, b.ledger, aId, 1, "Mac");
  return { a, b, aId, bId, bPort, connections, seeded, counter };
}

describe("GET /link/v1/capacity (the worker)", { timeout: 20_000 }, () => {
  it("answers a paired machine with its hardware, local models, sources, available adapters and public connections, and nothing secret", async () => {
    const { a, bId, connections, seeded } = await pairOfServices();
    const body = await a.link.newClient().request(a.link.peerFor(bId.machineId), "GET", "/link/v1/capacity");
    const parsed = machineCapacityBodySchema.strict().safeParse(body);
    expect(parsed.success).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toContain("TESTKEY");
    for (const value of [...Object.values(SECRETS), ...connections.secretValues()]) expect(text).not.toContain(value);
    for (const key of ["apiKey", "secret", "token", "cliHome", "headers", "env", "enabled", "config", "private"]) {
      expect(text, key).not.toContain(`"${key}":`);
    }
    const capacity = parsed.data!;
    expect(capacity.connections).toEqual([
      { id: seeded.aws.id, kind: "cloud", provider: "aws", name: "Work AWS" },
      { id: seeded.mcp.id, kind: "mcp", provider: "mcp_http", name: "Docs" },
      { id: seeded.local.id, kind: "llm", provider: "local_model", name: "Qwen on Ollama" },
    ]);
    expect(capacity.connections.map((c) => c.id)).not.toContain(seeded.claude.id);
    expect(capacity.hardware).toEqual(HARDWARE);
    expect(capacity.localModels).toEqual(ENGINES);
    expect(capacity.adapters).toEqual(["codex", "fake"]);
    // A source's name and plan leave the computer cleaned like a public connection name: no email, no home folder.
    const claude = capacity.sources.find((s) => s.provider === "claude")!;
    expect(claude.name).toBe("Claude for <email>");
    expect(claude.plan).toBe(`Max 5x, notes in ${join("~", "plan.txt")}`);
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain(homedir());
  });

  it("sends no hardware while the Owner has This computer turned off", async () => {
    const { a, bId, connections } = await pairOfServices();
    const hw = connections.list().find((c) => c.provider === "local_hardware")!;
    await connections.update(owner, hw.id, { enabled: false });
    const body = machineCapacityBodySchema.parse(await a.link.newClient().request(a.link.peerFor(bId.machineId), "GET", "/link/v1/capacity"));
    expect(body.hardware).toBeNull();
  });

  it("drops an unpaired client at the handshake, and refuses it with 403 while a code is shown", async () => {
    const { b, bPort } = await pairOfServices();
    const stranger = await newIdentity();
    const dropped = await rawTlsGet(bPort, "/link/v1/capacity", stranger);
    expect(dropped.kind).toBe("closed");
    b.link.showCode();
    const refused = await rawTlsGet(bPort, "/link/v1/capacity", stranger);
    expect(refused).toMatchObject({ kind: "reply", status: 403 });
    expect(JSON.parse((refused as { body: string }).body)).toEqual({ error: "unknown_machine" });
  });
});

describe("LinkCapacity (the requester)", { timeout: 20_000 }, () => {
  it("validates what the worker sent, adds the id, recorded name and times, and caches it for 30 s", async () => {
    let now = new Date("2026-11-15T12:00:00.000Z");
    const { a, bId, counter } = await pairOfServices();
    const capacity = new LinkCapacity({ link: a.link, now: () => now });
    const first = await capacity.capacityOf(bId.machineId);
    expect(machineCapacitySchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({
      machineId: bId.machineId, name: "GPU box", online: true, checkedAt: now.toISOString(), lastSeenAt: now.toISOString(), hardware: HARDWARE,
    });
    expect(counter.reports).toBe(1);
    now = new Date(now.getTime() + 29_000);
    expect(await capacity.capacityOf(bId.machineId)).toEqual(first);
    expect(counter.reports).toBe(1);
    // Two at once while nothing is cached: one request.
    now = new Date(now.getTime() + 2_000);
    const [x, y] = await Promise.all([capacity.capacityOf(bId.machineId), capacity.capacityOf(bId.machineId)]);
    expect(counter.reports).toBe(2);
    expect(x).toEqual(y);
    expect(x.checkedAt).toBe(now.toISOString());
    // Fresh: asks again, cache or not.
    await capacity.capacityOf(bId.machineId, { fresh: true });
    expect(counter.reports).toBe(3);
  });

  it("keeps the last good values when the worker stops answering: online false, checkedAt now, lastSeenAt the last answer", async () => {
    let now = new Date("2026-11-15T12:00:00.000Z");
    const { a, b, bId } = await pairOfServices();
    const capacity = new LinkCapacity({ link: a.link, now: () => now });
    const seen = await capacity.capacityOf(bId.machineId);
    await b.link.disableLinking(owner);
    now = new Date(now.getTime() + 60_000);
    const gone = await capacity.capacityOf(bId.machineId);
    expect(gone).toEqual({ ...seen, online: false, checkedAt: now.toISOString(), lastSeenAt: seen.checkedAt });
    expect(gone.hardware).toEqual(HARDWARE);
  });

  it("a machine never reached is offline with nothing known; an unknown id is NotFoundError", async () => {
    const a = makeService();
    await a.link.load();
    const stranger = await newIdentity();
    const held = await holdPort();
    await held.release();
    recordPaired(a.db, a.ledger, stranger, held.port, "Spare");
    const capacity = new LinkCapacity({ link: a.link });
    const row = await capacity.capacityOf(stranger.machineId);
    expect(row).toMatchObject({
      machineId: stranger.machineId, name: "Spare", online: false, lastSeenAt: null,
      hardware: null, localModels: [], sources: [], adapters: [], connections: [],
    });
    expect(machineCapacitySchema.safeParse(row).success).toBe(true);
    await expect(capacity.capacityOf("0".repeat(32))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a worker that refuses (no capacity route) is offline, and nothing from its reply is kept", async () => {
    const a = makeService();
    const b = makeService();
    await a.link.load();
    await b.link.load();
    const bPort = await b.link.enableLinking(owner, LINKING_ACK, 0);
    const aId = await LinkIdentity.load({ secrets: a.secrets, onCreated: () => undefined });
    const bId = await LinkIdentity.load({ secrets: b.secrets, onCreated: () => undefined });
    recordPaired(a.db, a.ledger, bId, bPort);
    recordPaired(b.db, b.ledger, aId, 1, "Mac");
    const row = await new LinkCapacity({ link: a.link }).capacityOf(bId.machineId);
    expect(row).toMatchObject({ online: false, lastSeenAt: null, hardware: null });
    expect(JSON.stringify(row)).not.toContain("not_found");
  });

  /** A server holding `identity`'s key that answers every request with this HTTP reply (or never, when null). */
  async function fakeWorker(identity: LinkIdentity, reply: string | null) {
    const server = await tlsServer(identity, (socket) => {
      socket.once("data", () => {
        if (reply !== null) socket.end(reply);
      });
    });
    cleanups.push(() => server.close());
    return server;
  }
  const http200 = (body: string) =>
    `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
  const validBody = {
    hardware: { ...HARDWARE, enabled: true }, localModels: [], sources: [], adapters: ["codex"],
    connections: [{ id: "c1", kind: "cloud", provider: "aws", name: "Work AWS" }],
  };

  it("treats what the worker sends as untrusted: unknown fields dropped, a body outside the bounds is offline", async () => {
    const a = makeService();
    await a.link.load();
    const worker = await newIdentity();
    const extra = await fakeWorker(worker, http200(JSON.stringify({ ...validBody, machineId: "f".repeat(32), name: "Spoofed", online: true, apiKey: "TESTKEY-x" })));
    recordPaired(a.db, a.ledger, worker, extra.port);
    const capacity = new LinkCapacity({ link: a.link });
    const row = await capacity.capacityOf(worker.machineId);
    expect(row).toMatchObject({ machineId: worker.machineId, name: "GPU box", online: true });
    expect(Object.keys(row).sort()).toEqual(
      ["adapters", "checkedAt", "connections", "hardware", "lastSeenAt", "localModels", "machineId", "name", "online", "sources"],
    );
    expect(row.hardware).not.toHaveProperty("enabled");
    expect(JSON.stringify(row)).not.toContain("TESTKEY");

    const other = await newIdentity();
    const tooLong = { ...validBody, connections: [{ id: "c1", kind: "cloud", provider: "aws", name: "x".repeat(121) }] };
    const bad = await fakeWorker(other, http200(JSON.stringify(tooLong)));
    recordPaired(a.db, a.ledger, other, bad.port, "Bad");
    expect(await capacity.capacityOf(other.machineId)).toMatchObject({ online: false, hardware: null, connections: [] });
  });

  it("all(): every paired machine at once, each within the timeout; one that never answers is offline", async () => {
    const a = makeService();
    await a.link.load();
    const fast = await newIdentity();
    const slow = await newIdentity();
    const fastServer = await fakeWorker(fast, http200(JSON.stringify(validBody)));
    const slowServer = await fakeWorker(slow, null);
    recordPaired(a.db, a.ledger, fast, fastServer.port, "Fast");
    recordPaired(a.db, a.ledger, slow, slowServer.port, "Slow");
    const capacity = new LinkCapacity({ link: a.link, timeoutMs: 300 });
    const started = Date.now();
    const rows = await capacity.all();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rows.map((r) => [r.name, r.online])).toEqual(
      a.link.machines().map((m) => [m.name, m.name === "Fast"]),
    );
  });
});
