import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";
import { getLinkRun, getRun } from "../../src/events/projections.js";
import { canonicalJson } from "../../src/ledger/canonical.js";
import { BoardService } from "../../src/board/board-service.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { LinkClient, MachineUnreachableError } from "../../src/link/client.js";
import { LinkListener } from "../../src/link/listener.js";
import { LinkService } from "../../src/link/service.js";
import { fakeDiscovery } from "../../src/link/discovery.js";
import type { LinkIdentity } from "../../src/link/identity.js";
import { RemoteRunRefusedError, RemoteRunService } from "../../src/link/remote-runs.js";
import { holdPort } from "./helpers.js";
import { remoteRun, requestRun, type RemoteRun } from "./remote-fixtures.js";

/**
 * The requester's side of a remote run against a scripted worker: an HTTPS server holding the worker's key, whose
 * routes the tests write, so every frame, cut and silence is chosen. The integration with a real worker (two
 * workspace servers) is in test/server/remote-runs.test.ts.
 */

const owner = { kind: "human", id: "owner" } as const;
// Git runs (the repository export), and git on Windows CI is slow.
const GIT_T = 120_000;

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;
type Fixture = { port: number; requests: string[]; close: () => Promise<void> };

/** An HTTPS server presenting `identity`'s certificate (TLS 1.3, client certificates asked for, not checked). */
function fixtureWorker(identity: LinkIdentity, handle: Handler, port = 0): Promise<Fixture> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server = https.createServer(
    { ...identity.tls(), requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" },
    (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      handle(req, res, requests.length);
    },
  );
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port }, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let dataDir: string;
let db: Db;
let ledger: Ledger;
let link: LinkService;
let projectId: string;
let remote: RemoteRun;
let service: RemoteRunService;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "remote-runs-")));
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  link = new LinkService({
    db, ledger, secrets: new MemorySecretStore(), bind: "127.0.0.1", discovery: fakeDiscovery(),
    listener: (deps) => new LinkListener(deps),
    client: (identity, timeoutMs) => new LinkClient({ identity, ...(timeoutMs !== undefined && { timeoutMs }) }),
    registerProtocol: () => undefined,
  });
  await link.load();
  projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
  remote = await remoteRun("run-remote-1", projectId);
  service = new RemoteRunService({
    db, ledger, link, worktrees: new WorktreeManager(dataDir), dataDir, backoffMs: [30, 60], streamIdleMs: 400,
  });
  cleanups.push(async () => {
    await service.shutdown();
    await link.shutdown();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
});

/** Records the worker as paired at `port`, named "GPU box". */
function pairAt(port: number, who: RemoteRun = remote): void {
  commitEvent(db, ledger, () => ({
    event: {
      projectId: null, actor: owner, type: "machine.paired",
      payload: {
        machineId: who.machineId, name: "GPU box", publicKey: who.identity.publicKeyBase64, fingerprint: who.identity.fingerprint,
        address: `127.0.0.1:${port}`, role: "entered_code",
      },
    },
    result: () => undefined,
  }));
}

/** A worker at its own port with the run already requested of it; `resume()` then follows it. */
async function follow(handle: Handler): Promise<Fixture> {
  const fixture = await fixtureWorker(remote.identity, handle);
  cleanups.push(() => fixture.close());
  pairAt(fixture.port);
  requestRun(db, ledger, remote);
  service.resume();
  return fixture;
}

const ndjson = (res: ServerResponse) => res.writeHead(200, { "content-type": "application/x-ndjson" });
const mirrored = () => ledger.list().filter((e) => e.type === "link.mirrored");
const originIds = () => mirrored().map((e) => (e.payload as { origin: { id: string } }).origin.id);
const eventsRequests = (f: Fixture) => f.requests.filter((r) => r.includes("/events"));
const signed = (origin: Record<string, unknown>, via = remote) =>
  JSON.stringify({ origin, signature: via.identity.sign(Buffer.from(canonicalJson(origin))) });
const originOf = (e: LedgerEntry) => JSON.parse(remote.line(e)).origin as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RemoteRunService: following a worker's stream", () => {
  it("commits each good line in order, and imports nothing until the run has finished", async () => {
    const started = remote.started();
    const message = remote.message("hello from the worker");
    await follow((req, res) => {
      if (!req.url!.includes("/events")) return res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
      ndjson(res);
      res.write(`${remote.line(started)}\n`);
      res.write(`${remote.line(message)}\n`);
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id, message.id]), { timeout: 5000 });
    expect(getRun(db, remote.runId)).toMatchObject({ status: "running", machineId: remote.machineId });
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "running", lastSeq: message.seq });
    expect(ledger.list().filter((e) => e.type === "link.changes_imported")).toEqual([]);
  });

  const FATAL: [string, () => Promise<string> | string][] = [
    ["bad_signature", async () => {
      const third = await remoteRun(remote.runId, projectId);
      return third.line(third.message("hi"));
    }],
    ["not_mirrorable", () => signed({ ...originOf(remote.message("x")), type: "card.moved", payload: { runId: remote.runId, cardId: "c1", from: "plan", to: "build" } })],
    ["wrong_run", () => remote.line(remote.record("agent.message", { runId: "another-run", text: "hi" }))],
    ["invalid_payload", () => signed({ ...originOf(remote.message("x")), payload: { runId: remote.runId, text: "y".repeat(4001) } })],
  ];
  for (const [reason, make] of FATAL) {
    it(`a ${reason} frame commits nothing of it, ends the run with link.run_failed, closes the stream and stops following`, async () => {
      const started = remote.started();
      const bad = await make();
      const good = remote.message("never reached");
      const fixture = await follow((req, res) => {
        ndjson(res);
        res.write(`${remote.line(started)}\n`);
        res.write(`${bad}\n`);
        res.write(`${remote.line(good)}\n`);
      });
      await vi.waitFor(() => expect(getLinkRun(db, remote.runId)!.state).toBe("failed"), { timeout: 5000 });
      expect(getLinkRun(db, remote.runId)!.error).toBe(reason);
      expect(originIds()).toEqual([started.id]);
      expect(getRun(db, remote.runId)!.status).toBe("failed");
      await sleep(300); // several backoffs: no reconnect
      expect(eventsRequests(fixture)).toHaveLength(1);
      expect(ledger.list().filter((e) => e.type === "link.run_failed")).toHaveLength(1);
    });
  }

  const UNREADABLE: [string, Buffer][] = [
    // A line past the frame cap, refused before its newline arrives.
    ["too_large", Buffer.from("x".repeat(300_000))],
    // Bytes that are not UTF-8.
    ["invalid_frame", Buffer.from([0xff, 0xfe, 0x0a])],
  ];
  for (const [reason, bytes] of UNREADABLE) {
    it(`a stream the splitter refuses (${reason}) ends the run with link.run_failed and is never retried`, async () => {
      const started = remote.started();
      const good = remote.message("never reached");
      const fixture = await follow((_req, res) => {
        ndjson(res);
        res.write(`${remote.line(started)}\n`);
        res.write(bytes);
        res.write(`${remote.line(good)}\n`);
      });
      await vi.waitFor(() => expect(getLinkRun(db, remote.runId)!.state).toBe("failed"), { timeout: 5000 });
      expect(getLinkRun(db, remote.runId)!.error).toBe(reason);
      expect(originIds()).toEqual([started.id]);
      expect(getRun(db, remote.runId)!.status).toBe("failed");
      await sleep(300); // several backoffs: no reconnect
      expect(eventsRequests(fixture)).toHaveLength(1);
      expect(ledger.list().filter((e) => e.type === "link.run_failed")).toHaveLength(1);
    });
  }

  it("a duplicate frame commits nothing; the stream is closed and the next good frame after a reconnect is committed", async () => {
    const started = remote.started();
    const message = remote.message("after the reconnect");
    const fixture = await follow((_req, res, n) => {
      ndjson(res);
      if (n === 1) {
        res.write(`${remote.line(started)}\n`);
        res.write(`${signed({ ...originOf(started), seq: 50 })}\n`); // the same worker entry again, as a later seq
        res.write(`${remote.line(message)}\n`);
        return;
      }
      res.write(`${remote.line(message)}\n`);
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id, message.id]), { timeout: 5000 });
    const urls = eventsRequests(fixture);
    expect(urls[0]).toContain("afterSeq=0");
    expect(urls[1]).toContain(`afterSeq=${started.seq}`);
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "running", error: null });
    expect(ledger.list().filter((e) => e.type === "link.run_failed")).toEqual([]);
  });

  it("heartbeats keep a quiet stream open; silence past the idle timeout is a cut, and it reconnects from the cursor", async () => {
    const started = remote.started();
    let beat: ReturnType<typeof setInterval> | undefined;
    cleanups.push(() => clearInterval(beat));
    const fixture = await follow((_req, res, n) => {
      ndjson(res);
      if (n === 1) {
        res.write(`${remote.line(started)}\n`);
        // Quiet but alive for three idle periods, then silent.
        let beats = 0;
        beat = setInterval(() => {
          if (++beats > 30) return clearInterval(beat);
          res.write("\n");
        }, 40);
      }
      // Later connections: silent, so each is cut after the idle timeout.
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id]), { timeout: 5000 });
    await sleep(1000);
    expect(eventsRequests(fixture)).toHaveLength(1); // 30 heartbeats, 40 ms apart, against a 400 ms idle timeout
    await vi.waitFor(() => expect(eventsRequests(fixture).length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(eventsRequests(fixture)[1]).toContain(`afterSeq=${started.seq}`);
  });

  it("an unreachable worker shows offline; it reconnects from last_seq when it is back, and nothing is mirrored twice", async () => {
    const started = remote.started();
    const message = remote.message("while you were away");
    const finished = remote.finished();
    const held = await holdPort();
    const port = held.port;
    await held.release();
    // First: the worker answers once, sends one frame and goes away.
    let first: Fixture | null = await fixtureWorker(remote.identity, (_req, res) => {
      ndjson(res);
      res.write(`${remote.line(started)}\n`, () => setTimeout(() => void first?.close(), 20));
    }, port);
    cleanups.push(() => first?.close());
    pairAt(port);
    requestRun(db, ledger, remote);
    service.resume();
    await vi.waitFor(() => expect(originIds()).toEqual([started.id]), { timeout: 5000 });
    await vi.waitFor(() => expect(link.presence()[0]!.online).toBe(false), { timeout: 5000 });
    first = null;
    // Back on the same address: the rest, from the cursor; the changes are not ready (a bad bundle is refused).
    const back = await fixtureWorker(remote.identity, (req, res) => {
      if (req.url!.includes("/changes")) return res.writeHead(200, { "content-type": "application/octet-stream" }).end("not a bundle");
      ndjson(res);
      const after = Number(new URL(req.url!, "https://x").searchParams.get("afterSeq"));
      for (const e of [started, message, finished]) if (e.seq > after) res.write(`${remote.line(e)}\n`);
      res.end();
    }, port);
    cleanups.push(() => back.close());
    await vi.waitFor(() => expect(originIds()).toEqual([started.id, message.id, finished.id]), { timeout: 5000 });
    expect(eventsRequests(back)[0]).toContain(`afterSeq=${started.seq}`);
    await vi.waitFor(() => expect(link.presence()[0]!.online).toBe(true), { timeout: 5000 });
    expect(new Set(originIds()).size).toBe(originIds().length);
    // A snapshot that is not a bundle is never imported: no entry, no working copy, and no file left behind.
    await vi.waitFor(() => expect(back.requests.some((r) => r.includes("/changes"))).toBe(true), { timeout: 5000 });
    // The refused import is recorded once (link.changes_refused), the download removed, and it is never asked again.
    const incoming = join(dataDir, "link", "incoming");
    await vi.waitFor(() => expect(ledger.list().filter((e) => e.type === "link.changes_refused")).toHaveLength(1), { timeout: 60_000, interval: 50 });
    expect(ledger.list().find((e) => e.type === "link.changes_refused")!.payload).toEqual({
      runId: remote.runId, machineId: remote.machineId, reason: "bad_bundle",
    });
    expect(readdirSync(incoming)).toEqual([]);
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "failed", error: "bad_bundle" });
    expect(getRun(db, remote.runId)!.status).toBe("completed"); // the run itself is left as the worker reported it
    expect(ledger.list().filter((e) => e.type === "link.changes_imported")).toEqual([]);
    expect(existsSync(join(dataDir, "projects", projectId, "worktrees", remote.runId))).toBe(false);
    // Not on a restart either.
    service.resume();
    await sleep(300);
    expect(back.requests.filter((r) => r.includes("/changes"))).toHaveLength(1);
  }, GIT_T);

  it("a worker whose snapshot replies cannot be read is asked a bounded number of times, then the changes are refused", async () => {
    const started = remote.started();
    const finished = remote.finished();
    const fixture = await follow((req, res) => {
      if (req.url!.includes("/changes")) return res.writeHead(502, { "content-type": "text/plain" }).end("not json");
      ndjson(res);
      res.write(`${remote.line(started)}\n${remote.line(finished)}\n`);
      res.end();
    });
    await vi.waitFor(() => expect(ledger.list().filter((e) => e.type === "link.changes_refused")).toHaveLength(1), { timeout: 10_000 });
    expect(ledger.list().find((e) => e.type === "link.changes_refused")!.payload).toMatchObject({ reason: "bad_bundle" });
    const asked = fixture.requests.filter((r) => r.includes("/changes")).length;
    expect(asked).toBe(3);
    await sleep(300);
    expect(fixture.requests.filter((r) => r.includes("/changes"))).toHaveLength(asked);
  });

  it("another key at the machine's address ends the run (machine_key_mismatch) instead of retrying quietly", async () => {
    const impostor = await remoteRun(remote.runId, projectId);
    const fixture = await fixtureWorker(impostor.identity, (_req, res) => res.writeHead(500).end());
    cleanups.push(() => fixture.close());
    pairAt(fixture.port);
    requestRun(db, ledger, remote);
    service.resume();
    await vi.waitFor(() => expect(getLinkRun(db, remote.runId)!.state).toBe("failed"), { timeout: 5000 });
    expect(getLinkRun(db, remote.runId)!.error).toBe("machine_key_mismatch");
    await sleep(300);
    expect(ledger.list().filter((e) => e.type === "link.run_failed")).toHaveLength(1);
    expect(fixture.requests).toEqual([]); // nothing was ever sent to it
  });

  it("unlinking the machine ends its runs at once, though the stream is open and quiet, and stops following them", async () => {
    const started = remote.started();
    let beat: ReturnType<typeof setInterval> | undefined;
    cleanups.push(() => clearInterval(beat));
    const fixture = await follow((req, res) => {
      if (!req.url!.includes("/events")) {
        // The stop sent before the unpair is refused (a worker that lost the run): the unlink goes on regardless.
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
        return;
      }
      ndjson(res);
      res.write(`${remote.line(started)}\n`);
      // Alive and waiting (a decision is pending there): heartbeats only, never an end.
      beat = setInterval(() => res.write("\n"), 40);
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id]), { timeout: 5000 });
    await link.unpair(owner, remote.machineId);
    await vi.waitFor(() => expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "failed", error: "machine_unpaired" }), { timeout: 2000 });
    expect(getRun(db, remote.runId)!.status).toBe("failed");
    const failed = ledger.list().filter((e) => e.type === "link.run_failed");
    expect(failed.map((e) => e.payload)).toEqual([{ runId: remote.runId, machineId: remote.machineId, error: "machine_unpaired" }]);
    await sleep(300); // several backoffs: never asked again
    expect(eventsRequests(fixture)).toHaveLength(1);
    expect(ledger.list().filter((e) => e.type === "link.run_failed")).toHaveLength(1);
  });

  it("unlinking the machine first asks it to stop each run it is executing, while its key is still trusted, then forgets it", async () => {
    const started = remote.started();
    let beat: ReturnType<typeof setInterval> | undefined;
    cleanups.push(() => clearInterval(beat));
    const stops: { url: string; trusted: boolean }[] = [];
    const fixture = await follow((req, res) => {
      if (req.url!.includes("/events")) {
        ndjson(res);
        res.write(`${remote.line(started)}\n`);
        beat = setInterval(() => res.write("\n"), 40);
        return;
      }
      // The stop arrives while the machine is still paired here: the unpair is recorded only afterwards.
      stops.push({ url: req.url!, trusted: ledger.list().every((e) => e.type !== "machine.unpaired") });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id]), { timeout: 5000 });
    await link.unpair(owner, remote.machineId);
    expect(stops).toEqual([{ url: `/link/v1/runs/${remote.runId}/stop`, trusted: true }]);
    expect(ledger.list().filter((e) => e.type === "machine.unpaired")).toHaveLength(1);
    await vi.waitFor(() => expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "failed", error: "machine_unpaired" }), { timeout: 2000 });
    await sleep(200);
    expect(fixture.requests.filter((r) => r.endsWith("/stop"))).toHaveLength(1); // once, never retried
  });

  it("a stop the machine cannot take never blocks the unlink: it is forgotten all the same and its runs end here", async () => {
    const started = remote.started();
    const fixture = await follow((_req, res) => {
      ndjson(res);
      res.write(`${remote.line(started)}\n`);
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id]), { timeout: 5000 });
    await fixture.close(); // gone: the stop is refused at the socket
    await link.unpair(owner, remote.machineId);
    expect(ledger.list().filter((e) => e.type === "machine.unpaired")).toHaveLength(1);
    await vi.waitFor(() => expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "failed", error: "machine_unpaired" }), { timeout: 2000 });
    expect(fixture.requests.filter((r) => r.endsWith("/stop"))).toEqual([]);
  });

  it("unlinking another machine leaves this one's runs alone", async () => {
    const started = remote.started();
    let beat: ReturnType<typeof setInterval> | undefined;
    cleanups.push(() => clearInterval(beat));
    await follow((_req, res) => {
      ndjson(res);
      res.write(`${remote.line(started)}\n`);
      beat = setInterval(() => res.write("\n"), 40);
    });
    await vi.waitFor(() => expect(originIds()).toEqual([started.id]), { timeout: 5000 });
    const other = await remoteRun("run-remote-2", projectId);
    commitEvent(db, ledger, () => ({
      event: {
        projectId: null, actor: owner, type: "machine.paired",
        payload: {
          machineId: other.machineId, name: "Laptop", publicKey: other.identity.publicKeyBase64, fingerprint: other.identity.fingerprint,
          address: "127.0.0.1:1", role: "entered_code",
        },
      },
      result: () => undefined,
    }));
    await link.unpair(owner, other.machineId);
    await sleep(200);
    expect(getLinkRun(db, remote.runId)).toMatchObject({ state: "running", error: null });
    expect(ledger.list().filter((e) => e.type === "link.run_failed")).toEqual([]);
  });

  it("a run this computer did not request is never followed, and shutdown stops every stream", async () => {
    const fixture = await fixtureWorker(remote.identity, (_req, res) => {
      ndjson(res);
      res.write(`${remote.line(remote.started())}\n`);
    });
    cleanups.push(() => fixture.close());
    pairAt(fixture.port);
    service.resume(); // nothing requested
    await sleep(150);
    expect(fixture.requests).toEqual([]);
    requestRun(db, ledger, remote);
    service.resume();
    await vi.waitFor(() => expect(mirrored()).toHaveLength(1), { timeout: 5000 });
    await service.shutdown();
    const seen = fixture.requests.length;
    await sleep(200);
    expect(fixture.requests).toHaveLength(seen);
  });
});

describe("RemoteRunService: decisions and stops go to the worker", () => {
  it("a decision is sent to the worker as it is; nothing is recorded here, and the local runner is never asked", async () => {
    const started = remote.started();
    const requested = remote.requested("a1");
    const bodies: unknown[] = [];
    await follow((req, res) => {
      if (req.url!.includes("/events")) {
        ndjson(res);
        res.write(`${remote.line(started)}\n${remote.line(requested)}\n`);
        return;
      }
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        bodies.push({ url: req.url, body: JSON.parse(raw) as unknown });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      });
    });
    await vi.waitFor(() => expect(originIds()).toHaveLength(2), { timeout: 5000 });
    const run = getRun(db, remote.runId)!;
    const head = ledger.headSeq();
    const action = await service.decide(owner, run, "a1", "allow", "looks fine");
    expect(bodies).toEqual([
      { url: `/link/v1/runs/${remote.runId}/actions/a1/decision`, body: { v: 1, decision: "allow", reason: "looks fine" } },
    ]);
    expect(action).toMatchObject({ id: "a1", runId: remote.runId, status: "pending" });
    expect(ledger.headSeq()).toBe(head);
    await service.stop(owner, run);
    expect(bodies.at(-1)).toMatchObject({ url: `/link/v1/runs/${remote.runId}/stop` });
    expect(ledger.headSeq()).toBe(head);
  });

  it("an unreachable worker: the decision throws MachineUnreachableError, the action stays pending and nothing is recorded", async () => {
    const started = remote.started();
    const requested = remote.requested("a1");
    const fixture = await follow((req, res) => {
      ndjson(res);
      res.write(`${remote.line(started)}\n${remote.line(requested)}\n`);
    });
    await vi.waitFor(() => expect(originIds()).toHaveLength(2), { timeout: 5000 });
    await fixture.close();
    const head = ledger.headSeq();
    await expect(service.decide(owner, getRun(db, remote.runId)!, "a1", "allow", "")).rejects.toBeInstanceOf(MachineUnreachableError);
    expect(ledger.headSeq()).toBe(head);
    expect(db.prepare("SELECT status FROM agent_actions WHERE id = 'a1'").get()).toEqual({ status: "pending" });
  });
});

describe("RemoteRunService: starting a run on a worker", () => {
  it("a worker that cuts the upload but still answers: remote_refused upload_refused, link.run_failed, no bundle left", async () => {
    const fixture = await fixtureWorker(remote.identity, (req, res) => {
      if (req.url === "/link/v1/hello") {
        return res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ v: 1, machineId: remote.machineId, name: "GPU box", linking: true }));
      }
      req.socket.destroy(); // the upload is refused partway: the connection is cut
    });
    cleanups.push(() => fixture.close());
    pairAt(fixture.port);
    const err = await service.start(owner, { projectId, machineId: remote.machineId, adapter: "fake", prompt: "Fix the tests" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteRunRefusedError);
    expect(err).toMatchObject({ code: "upload_refused", machine: "GPU box" });
    const failed = ledger.list().filter((e) => e.type === "link.run_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ machineId: remote.machineId, error: "upload_refused" });
    expect(readdirSync(join(dataDir, "link", "outgoing"))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get()).toEqual({ n: 0 });
  }, GIT_T);

  it("an unpaired machine is NotFound before anything is recorded; a non-human actor is refused", async () => {
    const head = ledger.headSeq();
    await expect(service.start(owner, { projectId, machineId: remote.machineId, adapter: "fake", prompt: "x" }))
      .rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.start({ kind: "agent", id: "a" }, { projectId, machineId: remote.machineId, adapter: "fake", prompt: "x" }))
      .rejects.toMatchObject({ name: "HumanRequiredError" });
    expect(ledger.headSeq()).toBe(head);
  });
});
