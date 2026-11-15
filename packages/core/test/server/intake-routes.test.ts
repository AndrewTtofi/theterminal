import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IntakeView, LedgerEntry } from "@theterminal/shared";
import { MemorySecretStore } from "../../src/secrets/memory-store.js";
import { createServer, type RunningServer } from "../../src/server/server.js";

const NO_BUNDLED = { claude: () => null, codex: () => null, gemini: () => null };
const SECRET = "sk-ant-TESTKEY-0000000000";
const IDEA = "A reading list for a book club";
const ANSWERS: Record<string, unknown> = {
  audience: "Members of a book club",
  outcome: "Keep a shared reading list",
  success: "The club picks its next book from the list",
  platform: ["web"],
  payments: "no",
  personal_data: "none",
  exposure: "private",
  budget_usd: 20,
  existing: "Nothing yet",
};
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "tt-intake-"));
  dirs.push(dataDir);
  const s = await createServer({ dataDir, port: 0, which: () => null, bundled: NO_BUNDLED, secrets: new MemorySecretStore() });
  running.push(s);
  return s;
}

const base = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const send = (s: RunningServer, method: string, path: string, body?: unknown, authed = true) =>
  fetch(base(s) + path, {
    method,
    headers: {
      ...(authed && { authorization: `Bearer ${s.token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const status = (s: RunningServer) => json<{ intakeDecisions: number; intakeProjects: unknown[] }>(send(s, "GET", "/api/status"));

async function project(s: RunningServer, name = "Book Club") {
  return (await json<{ id: string }>(send(s, "POST", "/api/projects", { name }))).id;
}

describe("intake API", { timeout: 15000 }, () => {
  it("runs the whole intake over HTTP, with the status count following the open decisions", async () => {
    const s = await start();
    const id = await project(s);
    const path = `/api/projects/${id}/intake`;

    let res = await send(s, "GET", path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_intake" });
    expect((await send(s, "GET", "/api/projects/nope/intake")).status).toBe(404);
    expect((await status(s)).intakeDecisions).toBe(0);

    res = await send(s, "POST", `${path}/answers`, { questionId: "audience", answer: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_intake" });

    res = await send(s, "POST", path, { idea: IDEA });
    expect(res.status).toBe(201);
    expect((await res.json() as IntakeView).step).toBe("answer");
    res = await send(s, "POST", path, { idea: IDEA });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });

    for (const [questionId, answer] of Object.entries(ANSWERS)) {
      res = await send(s, "POST", `${path}/answers`, { questionId, answer });
      expect(res.status).toBe(200);
    }
    expect((await json<IntakeView>(send(s, "GET", path))).step).toBe("decide");
    expect(await status(s)).toMatchObject({ intakeDecisions: 2, intakeProjects: [{ projectId: id, name: "Book Club", decisions: 2 }] });

    res = await send(s, "POST", `${path}/complete`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "intake_incomplete", missing: { questions: [], decisions: ["first_version", "hosting"] } });

    res = await send(s, "POST", `${path}/decisions`, { decisionId: "payments_scope", chosen: "provider" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "decision_not_applicable" });

    res = await send(s, "POST", `${path}/decisions`, { decisionId: "first_version", chosen: "smallest", rationale: "Start small" });
    expect(res.status).toBe(200);
    res = await send(s, "POST", `${path}/decisions`, { decisionId: "hosting", chosen: "local" });
    expect(res.status).toBe(200);
    expect((await res.json() as IntakeView).step).toBe("approve");
    expect(await status(s)).toMatchObject({ intakeDecisions: 0, intakeProjects: [] });

    res = await send(s, "POST", `${path}/complete`);
    expect(res.status).toBe(200);
    const done = await res.json() as IntakeView;
    expect(done.step).toBe("completed");
    expect(done.plan!.cards).toHaveLength(5);
    const board = await json<{ columns: Record<string, unknown[]> }>(send(s, "GET", `/api/projects/${id}/board`));
    expect(Object.values(board.columns).flat()).toHaveLength(5);

    res = await send(s, "POST", `${path}/answers`, { questionId: "audience", answer: "Readers" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "intake_completed" });

    res = await send(s, "POST", `${path}/reopen`, { reason: "We will sell copies" });
    expect(res.status).toBe(200);
    expect((await res.json() as IntakeView).intake.status).toBe("open");
    res = await send(s, "POST", `${path}/reopen`, { reason: "Again" });
    expect(res.status).toBe(409);
  });

  it("refuses a secret with 400 secret_in_text without echoing it, and records nothing", async () => {
    const s = await start();
    const id = await project(s);
    const head = async () => (await json<{ headSeq: number }>(send(s, "GET", "/api/health"))).headSeq;
    const before = await head();
    const res = await send(s, "POST", `/api/projects/${id}/intake`, { idea: `Log in with ${SECRET}` });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("TESTKEY");
    expect(JSON.parse(text)).toEqual({ error: "secret_in_text" });
    expect(await head()).toBe(before);
    const ledger = await json<LedgerEntry[]>(send(s, "GET", "/api/ledger"));
    expect(JSON.stringify(ledger)).not.toContain("TESTKEY");
  });

  it("refuses a secret-looking project name before it reaches the ledger, so no intake can carry it", async () => {
    const s = await start();
    const res = await send(s, "POST", "/api/projects", { name: `Club ${SECRET}` });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("TESTKEY");
    expect(JSON.parse(text)).toEqual({ error: "secret_in_text" });
    const entries = await json<LedgerEntry[]>(send(s, "GET", "/api/ledger"));
    expect(JSON.stringify(entries)).not.toContain("TESTKEY");
  });

  it("refuses an invalid answer with issues that never echo the input", async () => {
    const s = await start();
    const id = await project(s);
    await send(s, "POST", `/api/projects/${id}/intake`, { idea: IDEA });
    const res = await send(s, "POST", `/api/projects/${id}/intake/answers`, { questionId: "payments", answer: "maybe" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; issues: Record<string, unknown>[] };
    expect(body.error).toBe("invalid_input");
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) expect(issue).not.toHaveProperty("received");
    expect(JSON.stringify(body)).not.toContain("maybe");

    const bad = await send(s, "POST", `/api/projects/${id}/intake/answers`, { questionId: "nope-TESTKEY", answer: "x" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("TESTKEY");
    const extra = await send(s, "POST", `/api/projects/${id}/intake`, { idea: IDEA, other: 1 });
    expect(extra.status).toBe(400);
  });

  it("answers 401 on every intake route without the token", async () => {
    const s = await start();
    const id = await project(s);
    const path = `/api/projects/${id}/intake`;
    const routes: [string, string, unknown?][] = [
      ["GET", path],
      ["POST", path, { idea: IDEA }],
      ["POST", `${path}/answers`, { questionId: "audience", answer: "x" }],
      ["POST", `${path}/decisions`, { decisionId: "hosting", chosen: "local" }],
      ["POST", `${path}/complete`],
      ["POST", `${path}/reopen`, { reason: "The scope changed" }],
    ];
    for (const [method, p, body] of routes) {
      expect((await send(s, method, p, body, false)).status).toBe(401);
    }
    expect((await send(s, "GET", path)).status).toBe(404);
  });
});
