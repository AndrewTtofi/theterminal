import { beforeEach, describe, expect, it } from "vitest";
import { STACK_LICENCES, type StackRow } from "@theterminal/shared";
import { getIntake, listRuns } from "../../src/events/projections.js";
import { techStack } from "../../src/share/stack.js";
import { completeIntake, emit, human, startRun, world, type World } from "./setup.js";

let w: World;
let projectId: string;

beforeEach(() => {
  w = world();
  projectId = w.board.createProject(human, { name: "Book Club" }).id;
});

const AWS = { accessKeyId: "AKIATESTKEY00000000", secretAccessKey: "aws-TESTKEY-secret-0000000000" };

const stack = (): StackRow[] =>
  techStack({
    intake: getIntake(w.db, projectId),
    connections: w.connections.list(),
    runs: listRuns(w.db, projectId),
    entries: w.ledger.list({ limit: 500 }),
  });

describe("techStack", () => {
  it("derives the rows from the decisions, the platform answer, the connections and the programs that ran", async () => {
    completeIntake(w, projectId, { hosting: ["own_cloud", "Cheaper to start"], first_version: ["smallest"] });
    await w.connections.add(human, {
      kind: "cloud", provider: "aws", name: "My prod account", config: { region: "us-east-1" }, secrets: AWS,
    });
    await w.connections.add(human, { kind: "llm", provider: "claude", name: "Work Claude", config: {}, secrets: { apiKey: "sk-ant-TESTKEY-0000000000" } });
    startRun(w, projectId, "r1", "claude", null);
    startRun(w, projectId, "r2", "claude", null);

    const rows = stack();
    expect(rows.map((r) => [r.layer, r.choice, r.why, r.licence])).toEqual([
      ["Scope", "The smallest version that proves the idea",
        "Cheaper and faster to try, and you learn early. Some things you described wait for a later version.", null],
      ["Hosting", "In your own cloud account (AWS, Google Cloud or Azure)", "Cheaper to start", null],
      ["Platforms", "In a web browser", "From the plan", null],
      ["AI agents", "Claude (Anthropic)", "Connected by the Owner", STACK_LICENCES.claude],
      ["Cloud", "AWS", "Connected by the Owner", "AWS customer agreement"],
      ["Agent programs", "Claude Code (Claude Agent SDK)", "2 runs", STACK_LICENCES.claude],
    ]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain("My prod account");
    expect(json).not.toContain("us-east-1");
    expect(json).not.toContain("Work Claude");
    for (const r of rows) expect(r.evidence?.hash12).toMatch(/^[0-9a-f]{12}$/);
  });

  it("points each row at the entry that decided it", async () => {
    completeIntake(w, projectId);
    await w.connections.add(human, { kind: "cloud", provider: "aws", name: "A", config: { region: "us-east-1" }, secrets: AWS });
    startRun(w, projectId, "r1", "fake", null);
    const entries = w.ledger.list({ limit: 500 });
    const rows = stack();
    const typeOf = (seq: number | undefined) => entries.find((e) => e.seq === seq)?.type;
    expect(rows.map((r) => typeOf(r.evidence?.seq))).toEqual([
      "intake.decided", "intake.decided", "intake.answered", "connection.added", "agent.started",
    ]);
    const started = entries.find((e) => e.type === "agent.started")!;
    expect(rows.at(-1)!.evidence).toEqual({ seq: started.seq, hash12: started.hash.slice(0, 12), at: started.ts });
    expect(rows.at(-1)!.why).toBe("1 run");
  });

  it("collapses two connections of one provider and leaves out disabled connections", async () => {
    await w.connections.add(human, { kind: "cloud", provider: "aws", name: "One", config: { region: "us-east-1" }, secrets: AWS });
    await w.connections.add(human, { kind: "cloud", provider: "aws", name: "Two", config: { region: "eu-west-1" }, secrets: AWS });
    const gh = await w.connections.add(human, { kind: "github", provider: "github", name: "GH", config: {}, secrets: { token: "ghp_TESTKEY0000000000000000" } });
    await w.connections.update(human, gh.id, { enabled: false });
    expect(stack().map((r) => r.layer)).toEqual(["Cloud"]);
  });

  it("is empty for a project with no intake, connections or runs", () => {
    expect(stack()).toEqual([]);
  });

  it("one row per adapter that ran, in adapter order", () => {
    startRun(w, projectId, "r1", "fake", null);
    startRun(w, projectId, "r2", "codex", null);
    startRun(w, projectId, "r3", "gemini", null);
    emit(w, projectId, "agent.finished", { runId: "r1", status: "completed", costUsd: null, error: null });
    expect(stack().map((r) => [r.choice, r.licence])).toEqual([
      ["Codex CLI", STACK_LICENCES.codex],
      ["Gemini CLI", STACK_LICENCES.gemini],
      ["Fake agent", null],
    ]);
  });
});
