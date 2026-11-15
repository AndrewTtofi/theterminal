import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LINKING_ACK, type AgentAction, type AgentRun, type CapacityReport, type Connection, type Machine } from "@theterminal/shared";
import type { FakeStep } from "../../src/agents/fake-adapter.js";
import type { StsCaller } from "../../src/connections/cloud/aws.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import { saysNothingAboutTheInternet } from "../../src/network.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { TOKEN_COOKIE } from "../../src/server/auth.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

/**
 * Spec goal 9, offline mode: with no internet at all, the workspace, the board, the ledger and linked machines keep
 * working, and agents run on local models. The only internet The Terminal could reach here is the injected fetch, which
 * fails every non-local URL the way undici does when name resolution fails; the STS caller fails the way the AWS SDK
 * does. Two servers are paired over 127.0.0.1. Every request carries only the session cookie, never the bearer token.
 */

const ENV_KEYS = [
  "THETERMINAL_FAKE_AGENT", "THETERMINAL_FAKE_SCRIPT", "THETERMINAL_FAKE_HTTP", "THETERMINAL_FAKE_HARDWARE",
  "THETERMINAL_CODEX_BIN", "THETERMINAL_FAKE_CODEX_SCRIPT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
] as const;
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
const servers: RunningServer[] = [];

const dnsFailure = (host: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host }),
  });

/** Every URL that tried to leave this computer; each one was refused. */
const internetCalls: string[] = [];
/** No internet: a local URL answers like the fake model server, anything else cannot be resolved. */
const offlineFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!saysNothingAboutTheInternet(url.hostname)) {
    internetCalls.push(url.origin);
    throw dnsFailure(url.hostname);
  }
  if (url.pathname.replace(/\/+$/, "").endsWith("/v1/models")) {
    return new Response(JSON.stringify({ object: "list", data: [{ id: "fake-coder:7b", object: "model" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
});
/** As the AWS SDK fails offline: the endpoint's name does not resolve. */
const offlineSts: StsCaller = {
  callerIdentity: async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND sts.eu-west-1.amazonaws.com"), { code: "ENOTFOUND" });
  },
  sessionToken: async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND sts.eu-west-1.amazonaws.com"), { code: "ENOTFOUND" });
  },
};

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-offline-"));
  dirs.push(dataDir);
  const s = await createServer({
    dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore(), discovery: fakeDiscovery(),
    linkBind: "127.0.0.1", linkPort: 0, fetch: offlineFetch as unknown as typeof fetch, sts: offlineSts,
  });
  servers.push(s);
  return s;
}

/** Every status any request answered, to prove the cookie alone kept authenticating throughout. */
const statuses: Array<{ path: string; status: number }> = [];
async function send(s: RunningServer, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: {
      cookie: `${TOKEN_COOKIE}=${s.token}`,
      origin: `http://127.0.0.1:${s.port}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  statuses.push({ path, status: res.status });
  return res;
}
const json = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  expect(r.status, `${r.url} answered ${r.status}`).toBeLessThan(400);
  return r.json() as Promise<T>;
};
const network = async (s: RunningServer) =>
  (await json<{ network: { state: string; basis: string; since: string | null; lastError: string | null } }>(send(s, "GET", "/api/status"))).network;
const getRun = (s: RunningServer, id: string) => json<{ run: AgentRun; actions: AgentAction[] }>(send(s, "GET", `/api/runs/${id}`));
const untilFinished = (s: RunningServer, id: string) =>
  vi.waitFor(async () => expect((await getRun(s, id)).run.status).not.toBe("running"), { timeout: 15_000, interval: 50 });

const shell = { tool: "Bash", kind: "shell", summary: "run the tests", input: { command: "npm test" }, paths: [] } as const;
const script: FakeStep[] = [{ propose: { ...shell, paths: [] }, result: { ok: true, output: "(fake) tests passed" } }];

let a: RunningServer;
let b: RunningServer;
let projectId: string;

beforeAll(async () => {
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const) delete process.env[k];
  process.env.THETERMINAL_FAKE_AGENT = "1";
  process.env.THETERMINAL_FAKE_SCRIPT = JSON.stringify(script);
  // Only the local model detector and the hardware detector use these: the injected fetch and STS win over them.
  process.env.THETERMINAL_FAKE_HTTP = "1";
  process.env.THETERMINAL_FAKE_HARDWARE = "1";
  process.env.THETERMINAL_CODEX_BIN = FAKE_CODEX;
  process.env.THETERMINAL_FAKE_CODEX_SCRIPT = JSON.stringify([{ message: "Done on the local model." }]);
  a = await start();
  b = await start();
}, 30_000);

afterAll(async () => {
  while (servers.length) await servers.pop()!.close().catch(() => undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("offline mode (spec goal 9)", { timeout: 30_000 }, () => {
  it("a Claude key test cannot reach the provider, and the inferred state becomes offline", async () => {
    expect((await network(a)).state).toBe("unknown");
    const claude = await json<Connection>(send(a, "POST", "/api/connections", {
      kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: "sk-ant-TESTKEY-0000000000" },
    }));
    expect(await json(send(a, "POST", `/api/connections/${claude.id}/test`))).toEqual({ ok: false, message: "Could not reach the provider" });
    expect(await network(a)).toMatchObject({ state: "offline", basis: "inferred", lastError: "ENOTFOUND" });
    expect(internetCalls.length).toBeGreaterThan(0);
  });

  it("creates a project, adds a card and moves it", async () => {
    projectId = (await json<{ id: string }>(send(a, "POST", "/api/projects", { name: "Offline club", pitch: "x" }))).id;
    const card = await json<{ id: string }>(send(a, "POST", `/api/projects/${projectId}/cards`, { title: "Reading list", stage: "design" }));
    const moved = await send(a, "POST", `/api/cards/${card.id}/move`, { to: "build" });
    expect(moved.status).toBe(200);
    const board = await json<{ columns: Record<string, Array<{ id: string }>> }>(send(a, "GET", `/api/projects/${projectId}/board`));
    expect(board.columns.build!.map((c) => c.id)).toEqual([card.id]);
  });

  it("starts a fake run, allows its action, and the run completes", async () => {
    const run = await json<AgentRun>(send(a, "POST", `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "run the tests" }));
    let action: AgentAction | undefined;
    await vi.waitFor(async () => {
      action = (await json<AgentAction[]>(send(a, "GET", `/api/projects/${projectId}/pending-actions`)))[0];
      expect(action).toBeDefined();
    }, { timeout: 10_000, interval: 50 });
    expect((await send(a, "POST", `/api/actions/${action!.id}/decision`, { decision: "allow" })).status).toBe(200);
    await untilFinished(a, run.id);
    expect((await getRun(a, run.id)).run).toMatchObject({ status: "completed", error: null });
  });

  it("a Codex run on a local model completes, and the local model's answers never count as the internet", async () => {
    const local = await json<Connection>(send(a, "POST", "/api/connections", {
      kind: "llm", provider: "local_model", name: "Fake coder", config: { baseUrl: "http://127.0.0.1:11434/v1", model: "fake-coder:7b" },
    }));
    expect(await json(send(a, "POST", `/api/connections/${local.id}/test`))).toMatchObject({ ok: true });
    const run = await json<AgentRun>(send(a, "POST", `/api/projects/${projectId}/runs`, {
      adapter: "codex", prompt: "go", connectionIds: [local.id],
    }));
    expect(run).toMatchObject({ adapter: "codex", authMode: "none" });
    await untilFinished(a, run.id);
    expect((await getRun(a, run.id)).run).toMatchObject({ status: "completed", error: null });
    // A loopback answer says nothing about the internet: still offline.
    expect((await network(a)).state).toBe("offline");
  });

  it("exports the ledger", async () => {
    const res = await send(a, "GET", `/api/ledger/export?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { kind?: string; gaps?: number });
    expect(lines.at(-1)).toMatchObject({ kind: "end", gaps: 0 });
    expect(lines.length).toBeGreaterThan(3);
  });

  it("detects this computer and answers the capacity report with its hardware and its local models", async () => {
    expect((await send(a, "POST", "/api/capacity/detect")).status).toBe(200);
    const report = await json<CapacityReport>(send(a, "GET", "/api/capacity"));
    expect(report.hardware).not.toBeNull();
    expect(report.localModels.map((e) => [e.engine, e.models.map((m) => m.id)])).toEqual([["ollama", ["fake-coder:7b"]]]);
  });

  it("pairs the two machines over the local network", async () => {
    const aSelf = await json<{ machineId: string; linking: { port: number } }>(send(a, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK }));
    await json(send(b, "POST", "/api/link/enable", { acknowledgement: LINKING_ACK }));
    const { code } = await json<{ code: string }>(send(a, "POST", "/api/link/code"));
    const res = await send(b, "POST", "/api/link/pair", { address: `127.0.0.1:${aSelf.linking.port}`, code });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Machine).id).toBe(aSelf.machineId);
    expect((await json<{ machines: { linked: number } }>(send(b, "GET", "/api/status"))).machines.linked).toBe(1);
    // Pairing used no internet, so B never inferred anything about it.
    expect((await network(b)).state).toBe("unknown");
  });

  // Needs remote runs (Tasks 7c and 8b), which are not on this branch yet.
  it.todo("a remote fake run on the linked machine completes and is imported");

  it("the GitHub overview answers 503 github_unavailable while /api/status still answers 200", async () => {
    const gh = await send(a, "POST", "/api/connections", {
      kind: "github", provider: "github", name: "GitHub", config: { repo: "octo-org/example" }, secrets: { token: "ghp_TESTKEY0000000000" },
    });
    expect(gh.status).toBe(201);
    const overview = await send(a, "GET", "/api/github/overview");
    expect(overview.status).toBe(503);
    expect(await overview.json()).toEqual({ error: "github_unavailable" });
    const status = await send(a, "GET", "/api/status");
    expect(status.status).toBe(200);
  });

  it("a run with an AWS connection is 502 cloud_credentials_failed, and no run is recorded", async () => {
    const before = (await json<AgentRun[]>(send(a, "GET", `/api/projects/${projectId}/runs`))).length;
    const aws = await json<Connection>(send(a, "POST", "/api/connections", {
      kind: "cloud", provider: "aws", name: "AWS dev", config: { region: "eu-west-1" },
      secrets: { accessKeyId: "AKIATESTKEY000000000", secretAccessKey: "TESTKEY-static-secret-0000000000" },
    }));
    const res = await send(a, "POST", `/api/projects/${projectId}/runs`, { adapter: "fake", prompt: "deploy", connectionIds: [aws.id] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "cloud_credentials_failed", name: "AWS dev" });
    expect(await json<AgentRun[]>(send(a, "GET", `/api/projects/${projectId}/runs`))).toHaveLength(before);
  });

  it("the cookie authenticated every request: no 401 or 403 anywhere, and nothing reached the internet", () => {
    expect(statuses.length).toBeGreaterThan(20);
    expect(statuses.filter((s) => s.status === 401 || s.status === 403)).toEqual([]);
    // Every call that tried to leave was refused; none was a local address.
    for (const origin of internetCalls) expect(saysNothingAboutTheInternet(new URL(origin).hostname)).toBe(false);
  });
});
