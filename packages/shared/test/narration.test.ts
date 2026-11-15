import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACTION_KIND_MEANS,
  ACTION_KINDS,
  actionPhrase,
  eventPayloadSchemas,
  GATES,
  narrate,
  narrateAction,
  type Actor,
  type AgentAction,
  type EventType,
  type LedgerEntry,
  type Narration,
  type NarrationContext,
} from "../src/index.js";

const owner: Actor = { kind: "human", id: "owner" };
const agentActor: Actor = { kind: "agent", id: "abcdef1234567890" };
const policy: Actor = { kind: "system", id: "policy" };
const runner: Actor = { kind: "system", id: "runner" };

let seq = 0;
const entry = (type: string, payload: unknown, actor: Actor = owner): LedgerEntry => ({
  seq: ++seq,
  id: `e${seq}`,
  ts: "2026-01-01T10:00:00Z",
  projectId: "p1",
  actor,
  type: type as EventType,
  payload,
  prevHash: "",
  hash: "",
});

/** Every headline the suite produces, checked against the 200-character cap at the end. */
const headlines: string[] = [];
const n = (e: LedgerEntry, ctx?: NarrationContext): Narration => {
  const out = narrate(e, ctx);
  headlines.push(out.headline);
  return out;
};
const h = (e: LedgerEntry, ctx?: NarrationContext) => n(e, ctx).headline;

const ctx: NarrationContext = {
  cardTitle: (id) => (id === "c1" ? "Detect GPU" : undefined),
  adapterName: (id) => (id === "r1" ? "claude" : undefined),
};

afterAll(() => {
  for (const line of headlines) expect(line.length).toBeLessThanOrEqual(200);
});

describe("narrate: project sources", () => {
  it("narrates imports, links, accepts, applies and publishes", () => {
    const sha = "a".repeat(40);
    const imp = (from: string, files: number, bytes: number) =>
      h(entry("project.files_imported", { projectId: "p1", from, commit: sha, files, bytes, skipped: 0, secretsIncluded: false }));
    expect(imp("github", 12, 3_565_158)).toBe("Owner added 12 files (3.4 MB) from GitHub");
    expect(imp("folder", 12, 3_565_158)).toBe("Owner added 12 files (3.4 MB) from a folder");
    expect(imp("files", 1, 500)).toBe("Owner added 1 file (500 bytes) to the project");
    expect(h(entry("project.source_set", { projectId: "p1", kind: "github", repo: "o/r", branch: "main", remoteCommit: sha, syncedCommit: sha }))).toBe(
      "Owner linked the project to GitHub: o/r",
    );
    const folder = h(entry("project.source_set", { projectId: "p1", kind: "folder", path: "/Users/secret/folder", syncedCommit: sha }));
    expect(folder).toBe("Owner linked the project to a folder on this computer");
    expect(folder).not.toContain("secret");
    expect(h(entry("run.accepted", { runId: "r1", commit: sha, files: 2 }), ctx)).toMatch(/^Owner accepted the changes of /);
    expect(h(entry("project.folder_applied", { projectId: "p1", from: sha, to: sha, written: 3, deleted: 1, skipped: 1 }))).toBe(
      "Owner applied 4 files to the folder (1 skipped)",
    );
    expect(h(entry("project.published", { projectId: "p1", branch: "the-terminal/0123abcd", pullUrl: "https://github.com/o/r/pull/1", from: sha, to: sha, files: 2 }))).toBe(
      "Owner opened a pull request on GitHub",
    );
  });
  it("files run.accepted under agent and project.* under board", () => {
    expect(n(entry("run.accepted", { runId: "r1", commit: "a".repeat(40), files: 1 })).topic).toBe("agent");
    expect(n(entry("project.published", { projectId: "p1", branch: "the-terminal/0123abcd", pullUrl: "https://github.com/o/r/pull/1", from: "a".repeat(40), to: "a".repeat(40), files: 1 })).topic).toBe("board");
  });
});

describe("narrate: board", () => {
  it("narrates project and card events", () => {
    expect(h(entry("project.created", { projectId: "p1", name: "Book club", pitch: "" }))).toBe(
      'Owner created the project "Book club"',
    );
    expect(h(entry("card.created", { cardId: "c1", title: "Detect GPU", stage: "plan" }))).toBe(
      'Owner added "Detect GPU" to Plan',
    );
    expect(h(entry("card.moved", { cardId: "c1", from: "plan", to: "build" }), ctx)).toBe(
      'Owner moved "Detect GPU" from Plan to Build',
    );
    expect(h(entry("card.moved", { cardId: "c9", from: "plan", to: "build" }), ctx)).toBe(
      "Owner moved a card from Plan to Build",
    );
    expect(h(entry("card.status_changed", { cardId: "c1", from: "todo", to: "done" }), ctx)).toBe(
      'Owner marked "Detect GPU" done',
    );
    expect(h(entry("card.status_changed", { cardId: "c9", from: "todo", to: "done" }))).toBe("Owner marked a card done");
  });

  it("names the actor rather than assuming the Owner", () => {
    expect(h(entry("card.moved", { cardId: "c1", from: "build", to: "ship" }, agentActor), ctx)).toBe(
      'The agent moved "Detect GPU" from Build to Ship',
    );
    expect(h(entry("card.moved", { cardId: "c1", from: "build", to: "ship" }, { kind: "human", id: "ana" }), ctx)).toBe(
      'Someone moved "Detect GPU" from Build to Ship',
    );
    expect(h(entry("card.moved", { cardId: "c1", from: "build", to: "ship" }, runner), ctx)).toBe(
      'The workspace moved "Detect GPU" from Build to Ship',
    );
  });

  it("puts board events under the board topic with their ids", () => {
    const out = n(entry("card.moved", { cardId: "c1", from: "plan", to: "build" }));
    expect(out.topic).toBe("board");
    expect(out.refs).toEqual({ cardId: "c1" });
    expect(out.attention).toBe(false);
    expect(out.detail).toBeNull();
  });
});

describe("narrate: agent", () => {
  it("narrates a start, on a card or with the prompt", () => {
    const started = (cardId: string | null, prompt = "Fix the build") =>
      entry("agent.started", { runId: "r1", adapter: "claude", authMode: "api_key", prompt, cardId, worktree: "w/r1" });
    expect(h(started("c1"), ctx)).toBe('Owner started a Claude agent on "Detect GPU"');
    const out = n(started(null), ctx);
    expect(out.headline).toBe('Owner started a Claude agent: "Fix the build"');
    expect(out.detail).toBe("Fix the build");
    expect(out.topic).toBe("agent");
    expect(out.refs).toEqual({ runId: "r1" });
    expect(h(started(null, "x".repeat(90)))).toBe(`Owner started a Claude agent: "${"x".repeat(80)}…"`);
    expect(
      h(entry("agent.started", { runId: "r2", adapter: "fake", authMode: "none", prompt: "go", cardId: null, worktree: "w" })),
    ).toBe('Owner started a Fake agent: "go"');
  });

  it("narrates agent.progress", () => {
    const steps = ["Read the code", "Write the fix", "Run the tests"];
    const fin = n(entry("agent.progress", { runId: "r1", steps, done: [1, 2], current: null }, agentActor), ctx);
    expect(fin.headline).toBe('Claude finished step 2 of 3: "Write the fix"');
    expect(fin.topic).toBe("agent");
    expect(h(entry("agent.progress", { runId: "r1", steps, done: [1, 2], current: 3 }, agentActor), ctx)).toBe(
      'Claude started step 3 of 3: "Run the tests"',
    );
  });

  it("names the agent by its adapter when the context knows the run", () => {
    expect(h(entry("agent.message", { runId: "r1", text: "hi" }, agentActor), ctx)).toBe('The Claude agent said: "hi"');
    const out = n(entry("agent.message", { runId: "r2", text: "y".repeat(130) }, agentActor), ctx);
    expect(out.headline).toBe(`The agent said: "${"y".repeat(120)}…"`);
    expect(out.detail).toBe("y".repeat(130));
  });

  it("narrates a request as a plain verb phrase with the raw input as detail", () => {
    const input = { file_path: "src/app.ts" };
    const out = n(
      entry(
        "agent.action.requested",
        { runId: "r1", actionId: "a1", kind: "file_read", tool: "Read", summary: "Read src/app.ts", input },
        agentActor,
      ),
      ctx,
    );
    expect(out.headline).toBe("The Claude agent wants to read src/app.ts");
    expect(out.detail).toBe(JSON.stringify(input, null, 2));
    expect(out.attention).toBe(true);
    expect(out.topic).toBe("agent");
    expect(out.refs).toEqual({ runId: "r1", actionId: "a1" });
  });

  it("narrates decisions by who decided", () => {
    const decided = (decision: string, by: string, reason: string, actor: Actor) =>
      n(entry("agent.action.decided", { runId: "r1", actionId: "a1", decision, by, reason }, actor));
    const allowed = decided("allow", "human", "", owner);
    expect(allowed.headline).toBe("Owner allowed it");
    expect(allowed.topic).toBe("decision");
    expect(decided("deny", "human", "too risky", owner).headline).toBe("Owner denied it: too risky");
    expect(decided("deny", "human", "", owner).headline).toBe('Owner denied it: no reason given');
    expect(decided("allow", "policy", "reads are allowed", policy).headline).toBe(
      "Allowed automatically: reads are allowed",
    );
    expect(decided("deny", "policy", "outside the working copy", policy).headline).toBe(
      "Stopped automatically: outside the working copy",
    );
  });

  it("narrates completions with a real plural", () => {
    const done = (ok: boolean, output: string) =>
      n(entry("agent.action.completed", { runId: "r1", actionId: "a1", ok, output }, agentActor));
    expect(done(true, "one").headline).toBe("Done (1 line of output)");
    expect(done(true, "a\nb\nc").headline).toBe("Done (3 lines of output)");
    expect(done(true, "").headline).toBe("Done (0 lines of output)");
    const failed = done(false, "ENOENT: no such file\nat line 2");
    expect(failed.headline).toBe("It failed: ENOENT: no such file");
    expect(failed.detail).toBe("ENOENT: no such file\nat line 2");
    expect(done(false, "z".repeat(90)).headline).toBe(`It failed: ${"z".repeat(80)}…`);
  });

  it("narrates the end of a run", () => {
    const fin = (status: string, costUsd: number | null, error: string | null = null) =>
      n(entry("agent.finished", { runId: "r1", status, costUsd, error }, runner), ctx);
    expect(fin("completed", 0.2856).headline).toBe("The Claude agent finished · cost $0.29 (estimate)");
    expect(fin("completed", null).headline).toBe("The Claude agent finished");
    const failed = fin("failed", null, "exit code 1");
    expect(failed.headline).toBe("The Claude agent failed: exit code 1");
    expect(failed.attention).toBe(true);
    expect(fin("stopped", null).headline).toBe("The Claude agent was stopped");
    expect(fin("stopped", null).attention).toBe(false);
    expect(fin("failed", 0.2856, "exit code 1").headline).toBe("The Claude agent failed: exit code 1 · cost $0.29 (estimate)");
    expect(fin("failed", 0.1, null).headline).toBe("The Claude agent failed · cost $0.10 (estimate)");
    expect(fin("stopped", 0.1).headline).toBe("The Claude agent was stopped · cost $0.10 (estimate)");
  });
});

describe("narrate: 5A/5B lines kept word for word", () => {
  it("keeps rate limits", () => {
    expect(h(entry("agent.rate_limited", { runId: "abcdef1234567890", retryAfterS: null }, agentActor), ctx)).toBe(
      "Agent abcdef12 was rate-limited by the provider",
    );
    expect(h(entry("agent.rate_limited", { runId: "abcdef1234567890", retryAfterS: 30 }, agentActor))).toBe(
      "Agent abcdef12 was rate-limited by the provider; retry after 30 s",
    );
  });

  it("keeps settings", () => {
    expect(h(entry("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }))).toBe(
      "Owner set Claude to use API key",
    );
    expect(h(entry("settings.claude_auth_changed", { mode: "subscription", acknowledgement: "" }))).toBe(
      "Owner set Claude to use own subscription",
    );
    const d = (provider: string, mode: string) => h(entry("settings.provider_auth_changed", { provider, mode }));
    expect(d("claude", "api_key")).toBe("Owner set Claude to use API key");
    expect(d("claude", "subscription")).toBe("Owner set Claude to use own subscription");
    expect(d("codex", "chatgpt")).toBe("Owner set Codex to use own ChatGPT plan");
    expect(d("gemini", "google")).toBe("Owner set Gemini to use own Google account");
    expect(n(entry("settings.claude_auth_changed", { mode: "api_key" })).topic).toBe("settings");
  });

  it("keeps connection lines", () => {
    const c = { connectionId: "c1", name: "Work key" };
    const added = n(
      entry("connection.added", { ...c, kind: "llm", provider: "claude", config: {}, secretFields: [], privateFields: [] }),
    );
    expect(added.headline).toBe('Owner connected "Work key" (AI model)');
    expect(added.topic).toBe("connection");
    expect(added.refs).toEqual({ connectionId: "c1" });
    expect(h(entry("connection.updated", { ...c, changes: { enabled: true } }))).toBe('Owner enabled "Work key"');
    expect(h(entry("connection.updated", { ...c, changes: { enabled: false } }))).toBe('Owner disabled "Work key"');
    expect(h(entry("connection.updated", { ...c, changes: { secretsSet: ["apiKey", "token"] } }))).toBe(
      'Owner replaced the apiKey, token of "Work key"',
    );
    expect(h(entry("connection.updated", { ...c, changes: { name: "New" } }))).toBe('Owner updated "Work key"');
    expect(h(entry("connection.removed", c))).toBe('Owner removed "Work key"');
    expect(h(entry("connection.tested", { ...c, ok: true, message: "" }))).toBe('"Work key" connected');
    expect(h(entry("connection.tested", { ...c, ok: false, message: "Key rejected" }))).toBe(
      '"Work key" failed to connect: Key rejected',
    );
    expect(h(entry("connection.tested", { ...c, ok: false, message: "x".repeat(300) }))).toBe(
      `"Work key" failed to connect: ${"x".repeat(168)}…`,
    );
    expect(h(entry("connection.signin", { provider: "codex", ok: true }))).toBe("Owner signed in to Codex");
    expect(h(entry("connection.signin", { provider: "claude", ok: false }))).toBe("Sign-in to Claude failed");
  });

  it("keeps what a run was given: an API key, cloud credentials by kind, an MCP server", () => {
    const used = (purpose: string, extra: Record<string, unknown> = {}) =>
      n(
        entry(
          "connection.used",
          { connectionId: "c1", name: "Ops", runId: "abcdef1234567890", purpose, ...extra },
          runner,
        ),
        ctx,
      );
    const key = used("api_key");
    expect(key.headline).toBe('Agent abcdef12 was given access to "Ops"');
    expect(key.refs).toEqual({ connectionId: "c1", runId: "abcdef1234567890" });
    expect(used("cli_home").headline).toBe('Agent abcdef12 was given access to "Ops"');
    expect(used("cloud_credentials", { credential: "aws_session_token", expiresAt: null }).headline).toBe(
      'Agent abcdef12 was given a 12-hour AWS session token from "Ops"',
    );
    expect(used("cloud_credentials", { credential: "aws_static_keys", expiresAt: null }).headline).toBe(
      'Agent abcdef12 was given the AWS access keys (no session token available) from "Ops"',
    );
    expect(used("cloud_credentials", { credential: "gcp_access_token", expiresAt: null }).headline).toBe(
      'Agent abcdef12 was given a 1-hour Google Cloud token from "Ops"',
    );
    expect(used("cloud_credentials", { credential: "azure_client_secret", expiresAt: null }).headline).toBe(
      'Agent abcdef12 was given the Azure client secret from "Ops"',
    );
    expect(used("mcp_server").headline).toBe('Agent abcdef12 was given the MCP server "Ops"');
  });
});

describe("narrate: intake", () => {
  it("narrates each intake event", () => {
    const started = n(entry("intake.started", { intakeId: "i1", idea: "A reading list for a book club", version: 1 }));
    expect(started.headline).toBe('Owner described the idea: "A reading list for a book club"');
    expect(started.detail).toBe("A reading list for a book club");
    expect(started.topic).toBe("intake");
    expect(started.refs).toEqual({ intakeId: "i1" });
    expect(h(entry("intake.started", { intakeId: "i1", idea: "i".repeat(100), version: 1 }))).toBe(
      `Owner described the idea: "${"i".repeat(80)}…"`,
    );

    const answered = (questionId: string, answer: unknown) => h(entry("intake.answered", { intakeId: "i1", questionId, answer }));
    expect(answered("audience", "Book club members")).toBe('Owner answered "Who is this for?": Book club members');
    expect(answered("platform", ["web", "mobile"])).toBe(
      'Owner answered "Where will people use it?": In a web browser, On a phone (an app)',
    );
    expect(answered("payments", "later")).toBe('Owner answered "Will it take payments?": Not at first');
    expect(answered("budget_usd", 1000)).toMatch(/: \$1,000\.00$/);

    const decided = n(
      entry("intake.decided", {
        intakeId: "i1",
        decisionId: "first_version",
        chosen: "smallest",
        rationale: "We want to learn first",
        owner: "owner",
      }),
    );
    expect(decided.headline).toBe(
      'Owner decided "How much should the first version include?": The smallest version that proves the idea',
    );
    expect(decided.detail).toBe("We want to learn first");
    expect(
      n(entry("intake.decided", { intakeId: "i1", decisionId: "first_version", chosen: "smallest", rationale: "", owner: "owner" }))
        .detail,
    ).toBeNull();

    const card = (cardId: string, outcome: string) => ({ cardId, title: `Card ${cardId}`, stage: "plan", outcome });
    const completed = n(
      entry("intake.completed", {
        intakeId: "i1",
        summary: "The plan in words",
        cards: [card("c1", "created"), card("c2", "created"), card("c3", "existing")],
      }),
    );
    expect(completed.headline).toBe("Owner approved the plan (2 cards added)");
    expect(completed.detail).toBe("The plan in words");
    expect(h(entry("intake.completed", { intakeId: "i1", summary: "s", cards: [card("c1", "created")] }))).toBe(
      "Owner approved the plan (1 card added)",
    );
    expect(h(entry("intake.reopened", { intakeId: "i1", reason: "The audience changed" }))).toBe(
      "Owner reopened the plan: The audience changed",
    );
  });
});

describe("narrate: gates", () => {
  const title = (id: string) => GATES.find((g) => g.id === id)!.title;
  it("narrates a blocked move with every gate in the way", () => {
    const blocked = n(
      entry(
        "gate.blocked",
        {
          cardId: "c1",
          from: "build",
          to: "ship",
          gates: [
            { gateId: "ready_to_ship", outcome: "needs_sign_off", unmet: [] },
            { gateId: "payments", outcome: "blocked", unmet: ["decision_made:payments_scope"] },
          ],
        },
        owner,
      ),
      ctx,
    );
    expect(blocked.headline).toBe(`Moving "Detect GPU" to Ship is blocked by ${title("ready_to_ship")}, ${title("payments")}`);
    expect(blocked.headline).toBe('Moving "Detect GPU" to Ship is blocked by Ready to ship, Taking payments');
    expect(blocked.attention).toBe(true);
    expect(blocked.topic).toBe("gate");
    expect(blocked.refs).toEqual({ cardId: "c1", gateId: "ready_to_ship" });
    expect(
      h(entry("gate.blocked", { cardId: "c9", from: "plan", to: "build", gates: [{ gateId: "plan_approved", outcome: "blocked", unmet: [] }] }), ctx),
    ).toBe("Moving a card to Build is blocked by Plan approved");
  });

  it("narrates sign-offs and waivers", () => {
    const signed = n(
      entry("gate.signed_off", { gateId: "ready_to_ship", cardId: "c1", from: "build", to: "ship", conditions: [], acknowledgement: "", signedBy: "owner" }),
      ctx,
    );
    expect(signed.headline).toBe('Owner signed off "Ready to ship" for "Detect GPU"');
    expect(signed.attention).toBe(false);
    expect(signed.refs).toEqual({ cardId: "c1", gateId: "ready_to_ship" });
    expect(
      h(entry("gate.signed_off", { gateId: "go_live", cardId: "c9", from: "ship", to: "operate", conditions: [], acknowledgement: "", signedBy: "owner" }), ctx),
    ).toBe('Owner signed off "Going live" for a card');
    const waived = n(
      entry("gate.waived", {
        gateId: "plan_approved",
        cardId: "c1",
        from: "plan",
        to: "build",
        unmet: ["intake_completed"],
        reason: "A spike to test the idea",
        acknowledgement: "",
        waivedBy: "owner",
      }),
      ctx,
    );
    expect(waived.headline).toBe('Owner waived "Plan approved" for "Detect GPU": A spike to test the idea');
    expect(waived.attention).toBe(true);
  });
});

describe("narrate: override", () => {
  const fake: NarrationContext = { adapterName: (id) => (id === "r1" ? "fake" : undefined) };
  const reason = "Checking the override path end to end";
  const command = (over: Record<string, unknown> = {}) =>
    entry("override.command", { overrideId: "o1", runId: "r1", program: "node", args: ["-e", 'console.log("hi")'], cwd: ".", reason, ...over });
  const completed = (over: Record<string, unknown>) =>
    entry(
      "override.completed",
      { overrideId: "o1", runId: "r1", ok: true, exitCode: 0, signal: null, timedOut: false, durationMs: 5, output: "hi\n", ...over },
      runner,
    );

  it("narrates a command in red with the exact words", () => {
    const out = n(command(), fake);
    expect(out.headline).toBe(
      'OVERRIDE: Owner ran "node -e console.log(\\"hi\\")" in the Fake agent\'s working copy: Checking the override path end to end',
    );
    expect(out.detail).toBe(JSON.stringify({ program: "node", args: ["-e", 'console.log("hi")'], cwd: "." }, null, 2));
    expect(out.topic).toBe("override");
    expect(out.attention).toBe(true);
    expect(out.refs).toEqual({ runId: "r1", overrideId: "o1" });
    expect(h(command({ runId: "r9" }), fake)).toBe(
      'OVERRIDE: Owner ran "node -e console.log(\\"hi\\")" in the agent\'s working copy: Checking the override path end to end',
    );
  });

  it("clips the command at 80 characters and keeps the reason", () => {
    const out = h(command({ program: "git", args: ["x".repeat(100)] }), fake);
    expect(out).toBe(`OVERRIDE: Owner ran "git ${"x".repeat(76)}…" in the Fake agent's working copy: ${reason}`);
    expect(h(command({ args: [] }), fake)).toBe(`OVERRIDE: Owner ran "node" in the Fake agent's working copy: ${reason}`);
  });

  it("narrates a discard", () => {
    const out = n(entry("override.discard", { overrideId: "o2", runId: "r1", reason, files: 1 }), fake);
    expect(out.headline).toBe(`OVERRIDE: Owner discarded 1 changed file(s) of the Fake agent's run: ${reason}`);
    expect(out.topic).toBe("override");
    expect(out.attention).toBe(true);
    expect(out.refs).toEqual({ runId: "r1", overrideId: "o2" });
  });

  it("narrates how the override ended, with the output as detail", () => {
    const ok = n(completed({}), fake);
    expect(ok.headline).toBe("Override finished (exit 0)");
    expect(ok.detail).toBe("hi\n");
    expect(ok.topic).toBe("override");
    expect(ok.attention).toBe(true);
    expect(ok.refs).toEqual({ runId: "r1", overrideId: "o1" });
    expect(h(completed({ ok: false, exitCode: null, signal: "SIGKILL", timedOut: true }))).toBe("Override killed after 10 minutes");
    expect(h(completed({ ok: false, exitCode: 2 }))).toBe("Override failed (exit 2)");
    expect(h(completed({ ok: false, exitCode: null, signal: "SIGTERM" }))).toBe("Override failed (signal SIGTERM)");
    expect(h(completed({ ok: false, exitCode: null, signal: null, output: "workspace restarted" }))).toBe("Override failed (exit unknown)");
    expect(n(completed({ output: "" })).detail).toBeNull();
  });
});

describe("narrate: linked machines", () => {
  const fp = "0123456789abcdef".repeat(4);
  const machineId = "ab".repeat(16);
  const machines: NarrationContext = { ...ctx, machineName: (id) => (id === machineId ? "GPU box" : undefined) };
  const system: Actor = { kind: "system", id: "link" };

  it("narrates this computer's identity, name and linking switch", () => {
    const identity = n(entry("machine.identity_created", { machineId, publicKey: "k", fingerprint: fp }, system));
    expect(identity.headline).toBe("This computer got its identity (0123 4567 89ab cdef)");
    expect(identity.topic).toBe("machine");
    expect(identity.attention).toBe(false);
    expect(h(entry("machine.named", { name: "Mac" }))).toBe('Owner named this computer "Mac"');
    const on = n(entry("machine.linking_enabled", { port: 4418, acknowledgement: "…" }));
    expect(on.headline).toBe("Owner allowed other computers on the local network to link with this one (port 4418)");
    expect(on.attention).toBe(true);
    expect(on.topic).toBe("machine");
    expect(h(entry("machine.linking_disabled", {}))).toBe("Owner stopped linking");
  });

  it("narrates pairing and unpairing", () => {
    const paired = n(
      entry("machine.paired", { machineId, name: "GPU box", publicKey: "k", fingerprint: fp, address: "192.168.1.10:4418", role: "entered_code" }),
    );
    expect(paired.headline).toBe('Owner linked "GPU box" (0123456789abcdef)');
    expect(paired.topic).toBe("machine");
    expect(paired.refs).toEqual({ machineId });
    expect(h(entry("machine.unpaired", { machineId, name: "GPU box" }))).toBe('Owner unlinked "GPU box"');
  });

  it("narrates why a remote run failed in fixed words, never the recorded error", () => {
    const failed = (error: string) => h(entry("link.run_failed", { runId: "r1", machineId, error }, system), machines);
    for (const code of ["unreachable", "not_sent", "machine_bad_reply", "upload_refused", "connection_disabled", "no_repo", "invalid_input", "repo_too_large"]) {
      expect(failed(code)).toBe("GPU box could not start the run");
    }
    for (const code of ["bad_signature", "wrong_run", "wrong_project", "foreign_action", "invalid_payload", "not_mirrorable", "too_large", "invalid_frame"]) {
      expect(failed(code)).toBe("The run on GPU box stopped: signature check failed");
    }
    expect(failed("machine_unpaired")).toBe("The run on GPU box stopped: the machine was unlinked");
    expect(failed("conflict")).toBe("The run on GPU box stopped: its entries clash with records here");
    expect(failed("remote_not_found")).toBe("The run on GPU box stopped: the machine refused");
    expect(failed("machine_key_mismatch")).toBe("The run on GPU box stopped: the machine's key changed");
    expect(failed("<b>sk-ant-TESTKEY-000</b>")).toBe("The run on GPU box failed");
    expect(failed("__proto__")).toBe("The run on GPU box failed");
  });

  it("narrates refused changes in fixed words", () => {
    const refused = (reason: string) => n(entry("link.changes_refused", { runId: "r1", machineId, reason }, system), machines);
    expect(refused("bad_bundle").headline).toBe("The changes from GPU box were refused: what it sent could not be read");
    expect(refused("conflict").headline).toBe("The changes from GPU box were refused: they clash with records here");
    expect(refused("not_from_base").headline).toBe("The changes from GPU box were refused: they do not start from the project as it was sent");
    expect(refused("wrong_path").headline).toBe("The changes from GPU box were refused: they name the wrong working copy");
    expect(refused("machine_refused").headline).toBe("The changes from GPU box were refused: the machine no longer has them");
    expect(refused("machine_unpaired").headline).toBe("The changes from GPU box were refused: the machine was unlinked before they arrived");
    expect(refused("other").headline).toBe("The changes from GPU box were refused");
    expect(refused("bad_bundle")).toMatchObject({ attention: true, topic: "machine" });
  });

  it("narrates a run requested from and accepted by another machine", () => {
    const requested = n(
      entry("link.run_requested", { runId: "r1", machineId, adapter: "codex", prompt: "Train the model", cardId: null, connectionIds: [] }),
      machines,
    );
    expect(requested.headline).toBe('Owner asked GPU box to run a Codex agent: "Train the model"');
    expect(requested.detail).toBe("Train the model");
    expect(requested.topic).toBe("machine");
    expect(requested.refs).toEqual({ runId: "r1", machineId });
    expect(h(entry("link.run_requested", { runId: "r1", machineId: "cd".repeat(16), adapter: "codex", prompt: "x".repeat(100), cardId: null, connectionIds: [] }), machines)).toBe(
      `Owner asked a linked machine to run a Codex agent: "${"x".repeat(80)}…"`,
    );
    const failed = n(entry("link.run_failed", { runId: "r1", machineId, error: "no_repo" }, system), machines);
    expect(failed.headline).toBe("GPU box could not start the run");
    expect(failed.attention).toBe(true);
    expect(failed.topic).toBe("machine");
    expect(h(entry("link.run_failed", { runId: "r1", machineId, error: "unreachable" }, system))).toBe(
      "A linked machine could not start the run",
    );
    expect(h(entry("link.project_received", { projectId: "p1", machineId, name: "Book club" }, system), machines)).toBe(
      'Received the project "Book club" from GPU box',
    );
    expect(h(entry("link.run_accepted", { runId: "r1", machineId, projectId: "p1" }, system), machines)).toBe("Accepted a run from GPU box");
    const decided = (decision: string) =>
      n(entry("link.decision_received", { runId: "r1", actionId: "a1", machineId, decision }, system), machines);
    expect(decided("allow").headline).toBe("Owner's decision arrived from GPU box: allowed");
    expect(decided("deny").headline).toBe("Owner's decision arrived from GPU box: denied");
    expect(decided("allow").topic).toBe("machine");
    expect(decided("allow").refs).toEqual({ runId: "r1", actionId: "a1", machineId });
    const imported = n(entry("link.changes_imported", { runId: "r1", machineId, commit: "d".repeat(40) }, system), machines);
    expect(imported.headline).toBe("The run's changes arrived from GPU box");
    expect(imported.topic).toBe("machine");
  });

  it("narrates a mirrored entry as the inner entry, on the machine it came from", () => {
    const origin = {
      seq: 3, id: "e3", ts: "2026-11-15T10:00:00.000Z", projectId: "p1", actor: { kind: "agent", id: "r7" },
      type: "agent.action.requested",
      payload: { runId: "r7", actionId: "a7", kind: "shell", tool: "Bash", summary: "Run tests", input: { command: "npm test" } },
      prevHash: "a".repeat(64), hash: "b".repeat(64),
    };
    const out = n(entry("link.mirrored", { machineId, origin, signature: "c".repeat(128) }, system), machines);
    expect(out.headline).toBe('On GPU box: The agent wants to run the command "npm test"');
    expect(out.attention).toBe(true);
    expect(out.topic).toBe("agent");
    expect(out.detail).toBe(JSON.stringify({ command: "npm test" }, null, 2));
    expect(out.refs).toEqual({ runId: "r7", actionId: "a7", machineId });
    const decided = n(
      entry("link.mirrored", {
        machineId, signature: "c".repeat(128),
        origin: { ...origin, actor: owner, type: "agent.action.decided", payload: { runId: "r7", actionId: "a7", decision: "allow", by: "human", reason: "" } },
      }, system),
    );
    expect(decided.headline).toBe("On a linked machine: Owner allowed it");
    expect(decided.topic).toBe("decision");
    expect(decided.attention).toBe(false);
    const long = n(
      entry("link.mirrored", {
        machineId, signature: "c".repeat(128),
        origin: { ...origin, type: "agent.message", payload: { runId: "r7", text: "y".repeat(4000) } },
      }, system),
      machines,
    );
    expect(long.headline.length).toBeLessThan(200);
    expect(long.headline.startsWith('On GPU box: The agent said: "yyy')).toBe(true);
    expect(long.headline.endsWith('…"')).toBe(true);
    const wide: NarrationContext = { machineName: () => "M".repeat(100) };
    const failed = n(
      entry("link.mirrored", {
        machineId, signature: "c".repeat(128),
        origin: { ...origin, type: "agent.finished", payload: { runId: "r7", status: "failed", costUsd: 1e15, error: "e".repeat(1000) } },
      }, system),
      wide,
    );
    expect(failed.headline.length).toBeLessThan(200);
    expect(failed.headline.startsWith(`On ${"M".repeat(40)}…: The agent failed: eee`)).toBe(true);
  });

  it("does not narrate a mirrored entry of a type that is not mirrored", () => {
    const out = n(entry("link.mirrored", { machineId, origin: { type: "card.moved", payload: {}, actor: owner }, signature: "" }, system));
    expect(out.headline).toBe("A linked machine sent an entry that could not be read");
    expect(out.topic).toBe("machine");
    expect(out.attention).toBe(false);
  });

  it("narrates a run given a local model", () => {
    const out = n(
      entry("connection.used", { connectionId: "c1", name: "Qwen", runId: "abcdef1234567890", purpose: "local_model" }, runner),
    );
    expect(out.headline).toBe('Agent abcdef12 was given the local model "Qwen"');
    expect(out.topic).toBe("connection");
  });
});

describe("narrate: share", () => {
  const confirmed = {
    shareId: "s1",
    contentHash: "a".repeat(64),
    bytes: 48213,
    sections: ["overview", "progress", "audit"],
    options: { includePrompts: false, includeHardware: true, digestDays: 14 },
    headSeq: 42,
  };

  it("narrates a confirmed share page with its options as detail", () => {
    const out = n(entry("share.confirmed", confirmed));
    expect(out.headline).toBe("Owner confirmed a share page (3 sections, 48213 bytes)");
    expect(out.detail).toBe(JSON.stringify(confirmed.options));
    expect(out.topic).toBe("share");
    expect(out.attention).toBe(false);
    expect(out.refs).toEqual({ shareId: "s1" });
  });

  it("narrates a link for this computer or the local network, with attention", () => {
    const link = {
      linkId: "l1",
      shareId: "s1",
      tokenDigest: "b".repeat(64),
      expiresAt: "2026-11-15T18:00:00.000Z",
      port: 8080,
      scope: "this_computer",
    };
    const here = n(entry("share.link_created", link));
    expect(here.headline).toBe("Owner created a share link for this computer only, valid until 2026-11-15T18:00:00.000Z");
    expect(here.attention).toBe(true);
    expect(here.topic).toBe("share");
    expect(here.refs).toEqual({ shareId: "s1", linkId: "l1" });
    expect(here.headline).not.toContain("b".repeat(12));
    expect(h(entry("share.link_created", { ...link, scope: "local_network" }))).toBe(
      "Owner created a share link for the local network, valid until 2026-11-15T18:00:00.000Z",
    );
  });

  it("narrates revocation by the Owner and after too many wrong attempts", () => {
    const owned = n(entry("share.revoked", { linkId: "l1", reason: "owner" }));
    expect(owned.headline).toBe("Owner revoked a share link");
    expect(owned.refs.linkId).toBe("l1");
    const guessed = n(entry("share.revoked", { linkId: "l1", reason: "too_many_failures" }, { kind: "system", id: "share" }));
    expect(guessed.headline).toBe("A share link was revoked after too many wrong attempts");
    expect(guessed.attention).toBe(true);
    expect(guessed.topic).toBe("share");
  });

  it("narrates expiry and stopping", () => {
    const system: Actor = { kind: "system", id: "share" };
    expect(h(entry("share.expired", { linkId: "l1" }, system))).toBe("A share link expired");
    expect(h(entry("share.stopped", { linkId: "l1", reason: "shutdown" }, system))).toBe(
      "A share link stopped: The Terminal closed",
    );
    expect(h(entry("share.stopped", { linkId: "l1", reason: "restart" }, system))).toBe(
      "A share link stopped: The Terminal restarted",
    );
    expect(n(entry("share.expired", { linkId: "l1" }, system)).topic).toBe("share");
  });

  it("survives malformed share payloads", () => {
    for (const type of ["share.confirmed", "share.link_created", "share.revoked", "share.expired", "share.stopped"]) {
      for (const payload of [null, {}, { sections: "x", bytes: {}, scope: 5, reason: [] }]) {
        const out = n(entry(type, payload));
        expect(out.topic).toBe("share");
        expect(typeof out.headline).toBe("string");
      }
    }
  });
});

describe("narrate: robustness", () => {
  it("falls back for an unknown type", () => {
    const out = n(entry("future.event", { x: 1 }));
    expect(out.headline).toBe("Owner recorded future.event");
    expect(out.topic).toBe("other");
    expect(n(entry("future.event", {}, runner)).headline).toBe("The workspace recorded future.event");
    expect(n(entry("future.event", {}, policy)).headline).toBe("Policy recorded future.event");
  });

  it("turns odd payload values into words without undefined", () => {
    const out = h(entry("project.created", { projectId: "p1", name: 42, pitch: "" }));
    expect(typeof out).toBe("string");
    expect(out).not.toContain("undefined");
    expect(out).toBe('Owner created the project "42"');
  });

  it("has a narration for every event type, which never throws or prints undefined", () => {
    const types = Object.keys(eventPayloadSchemas) as EventType[];
    expect(types.length).toBeGreaterThan(20);
    for (const type of types) {
      for (const payload of [{}, null, "text", [1, 2], { runId: 7, cardId: {}, name: null }]) {
        const out = n(entry(type, payload), ctx);
        expect(out.headline, type).not.toBe(`Owner recorded ${type}`);
        expect(out.headline, type).not.toMatch(/undefined|\[object|NaN/);
        expect(out.topic, type).not.toBe("other");
      }
    }
  });

  it("never throws when the context throws", () => {
    const bad: NarrationContext = {
      cardTitle: () => {
        throw new Error("boom");
      },
    };
    expect(() => narrate(entry("card.moved", { cardId: "c1", from: "plan", to: "build" }), bad)).not.toThrow();
  });

  it("caps the headline at 200 characters by clipping the free text, not the end of the line", () => {
    const out = h(entry("intake.reopened", { intakeId: "i1", reason: "r".repeat(500) }));
    expect(out).toBe(`Owner reopened the plan: ${"r".repeat(173)}…`);
    const waived = h(
      entry("gate.waived", { gateId: "go_live", cardId: "c1", from: "ship", to: "operate", unmet: ["x"], reason: "\u202e".repeat(300) }),
      ctx,
    );
    expect(waived.length).toBeLessThanOrEqual(200);
    expect(waived.startsWith('Owner waived "Going live" for "Detect GPU": \\u202e')).toBe(true);
    expect(waived.endsWith("\\u202e…")).toBe(true);
  });

  it("keeps the hidden-line count and the closing quote when escapes make a command longer", () => {
    const command = `${"\u202e".repeat(100)}\nrm -rf build`;
    const input = { command };
    const req = h(
      entry("agent.action.requested", { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "Run", input }, agentActor),
      { adapterName: () => "a-long-adapter-name-that-goes-on-and-on" },
    );
    expect(req.length).toBeLessThanOrEqual(200);
    expect(req.endsWith('…" (and 1 more line)')).toBe(true);
    const many = narrateAction(action({ status: "failed", input: { command: `${"\u202e".repeat(100)}${"\nx".repeat(999999)}` } }));
    expect(many.headline.length).toBeLessThanOrEqual(200);
    expect(many.headline.endsWith('…" (and 999999 more lines)')).toBe(true);
    for (const status of ["pending", "allowed", "denied", "completed", "failed"] as const) {
      const out = narrateAction(action({ status, input })).headline;
      expect(out.length).toBeLessThanOrEqual(200);
      expect(out.endsWith('…" (and 1 more line)')).toBe(true);
    }
  });

  it("fits every template's worst case under the cap without cutting its fixed words", () => {
    const long = "\u202e".repeat(400);
    const longCtx: NarrationContext = { cardTitle: () => long, adapterName: () => long };
    const variants: Record<string, unknown>[] = [
      { status: "completed", ok: true, decision: "allow", by: "human", purpose: "api_key", mode: "api_key" },
      { status: "failed", ok: false, decision: "deny", by: "human", purpose: "mcp_server", mode: "subscription" },
      { status: "stopped", ok: "?", decision: "allow", by: "policy", purpose: "cloud_credentials", mode: "chatgpt" },
      { status: "?", decision: "deny", by: "policy", mode: "google" },
      { decision: "maybe", by: "x", mode: "other" },
    ];
    const fields = {
      name: long, title: long, stage: long, from: long, to: long, prompt: long, adapter: long, text: long, kind: "shell",
      tool: "Bash", summary: long, input: { command: `${long}\n${"x\n".repeat(999)}` }, reason: long, output: long,
      error: long, costUsd: 1e15, message: long, changes: { secretsSet: Array(50).fill(long) }, provider: long,
      credential: "aws_static_keys", runId: long, idea: long, questionId: "existing", answer: long, decisionId: "payments_scope",
      chosen: long, rationale: long, summaryText: long, cards: [], gates: Array(10).fill({ gateId: long }), gateId: long,
      retryAfterS: 1e15, program: long, args: Array(64).fill(long), cwd: long, files: 1e15, exitCode: 1e15, signal: long,
    };
    const actors: Actor[] = [owner, { kind: "human", id: long }, agentActor, policy, runner];
    for (const type of [...Object.keys(eventPayloadSchemas), "future.event." + long]) {
      for (const actor of actors) {
        for (const v of variants) {
          const out = narrate(entry(type, { ...fields, ...v }, actor), longCtx).headline;
          // The blind cap produces exactly 200 characters; staying under it means every fixed word survived.
          expect(out.length, `${type} ${JSON.stringify(v)}`).toBeLessThan(200);
        }
      }
    }
  });

  it("uses neutral words for values it does not recognise", () => {
    const dec = (decision: unknown, by: unknown, actor: Actor) =>
      h(entry("agent.action.decided", { runId: "r1", actionId: "a1", decision, by, reason: "" }, actor));
    expect(dec("maybe", "human", owner)).toBe("Owner decided something");
    expect(dec(undefined, "policy", policy)).toBe("Policy decided something");
    expect(h(entry("agent.action.completed", { runId: "r1", actionId: "a1", output: "x" }, agentActor))).toBe(
      "Finished with an unknown result",
    );
    expect(h(entry("agent.finished", { runId: "r1", status: "paused", costUsd: null, error: null }, runner), ctx)).toBe(
      "The Claude agent finished with an unknown result",
    );
    expect(h(entry("connection.tested", { connectionId: "c1", name: "Ops", message: "" }))).toBe(
      'Testing "Ops" finished with an unknown result',
    );
    expect(h(entry("connection.signin", { provider: "codex" }))).toBe("Sign-in to Codex finished with an unknown result");
    expect(h(entry("settings.claude_auth_changed", { mode: "other" }))).toBe("Owner changed how Claude signs in");
    expect(h(entry("settings.provider_auth_changed", { provider: "codex", mode: "other" }))).toBe(
      "Owner changed how Codex signs in",
    );
  });

  it("shows hidden and bidi characters instead of letting them reorder the line", () => {
    expect(h(entry("agent.message", { runId: "r9", text: "ok\u202egnp.exe" }, agentActor))).toBe(
      'The agent said: "ok\\u202egnp.exe"',
    );
    expect(h(entry("card.created", { cardId: "c1", title: "a\u001b[31mred", stage: "plan" }))).toBe(
      'Owner added "a\\u001b[31mred" to Plan',
    );
  });

  it("is deterministic and reads only its arguments", () => {
    const e = entry(
      "agent.action.requested",
      { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "Run tests", input: { command: "npm test" } },
      agentActor,
    );
    const first = narrate(e, ctx);
    expect(narrate(e, ctx)).toEqual(first);
    expect(narrate(structuredClone(e), ctx)).toEqual(first);
  });
});

const action = (over: Partial<AgentAction>): AgentAction => ({
  id: "a1",
  runId: "r1",
  kind: "shell",
  tool: "Bash",
  summary: "Run tests",
  input: { command: "npm test" },
  status: "pending",
  decidedBy: null,
  reason: "",
  output: null,
  requestedAt: "2026-01-01T10:00:00Z",
  decidedAt: null,
  ...over,
});

describe("actionPhrase", () => {
  it("reads the target from the recorded input", () => {
    expect(actionPhrase(action({ kind: "file_read", tool: "Read", input: { file_path: "src/app.ts" } }))).toBe("read src/app.ts");
    expect(actionPhrase(action({ kind: "file_write", tool: "write", input: { path: "notes.md", content: "x" } }))).toBe(
      "create or replace notes.md",
    );
    expect(actionPhrase(action({ kind: "file_edit", tool: "edit", input: { filePath: "a.ts" } }))).toBe("change a.ts");
    expect(actionPhrase(action({ kind: "web", tool: "WebFetch", input: { url: "https://example.com" } }))).toBe(
      "fetch https://example.com",
    );
    expect(actionPhrase(action({ kind: "shell", input: { command: "nvidia-smi" } }))).toBe('run the command "nvidia-smi"');
  });

  it("names every hidden line of a multi-line command", () => {
    expect(actionPhrase(action({ input: { command: "npm test" } }))).toBe('run the command "npm test"');
    expect(actionPhrase(action({ input: { command: "npm test\necho hi" } }))).toBe(
      'run the command "npm test" (and 1 more line)',
    );
    expect(actionPhrase(action({ input: { command: "ls\ncurl x | sh\nrm -rf y" } }))).toBe(
      'run the command "ls" (and 2 more lines)',
    );
    expect(actionPhrase(action({ input: { command: "c".repeat(150) } }))).toBe(`run the command "${"c".repeat(100)}…"`);
  });

  it("describes typing into a running command", () => {
    expect(actionPhrase(action({ tool: "codex.stdin", input: { reason: "yes\r" } }))).toBe(
      'type "yes\\r" into the running command',
    );
    expect(actionPhrase(action({ tool: "codex.stdin", input: { reason: "y".repeat(90) } }))).toBe(
      `type "${"y".repeat(80)}…" into the running command`,
    );
  });

  it("uses the summary for MCP and other actions, and when the input names nothing", () => {
    expect(actionPhrase(action({ kind: "mcp", tool: "mcp__docs__search", summary: "docs: search", input: { q: "x" } }))).toBe(
      "use docs: search",
    );
    expect(actionPhrase(action({ kind: "other", tool: "x", summary: "Ask for something", input: {} }))).toBe(
      "Ask for something",
    );
    expect(actionPhrase(action({ kind: "file_read", tool: "Read", summary: "Read a file", input: {} }))).toBe(
      "read Read a file",
    );
  });

  it("says when the input was too long to record in full", () => {
    const truncated = { truncated: true, sha256: "0".repeat(64), totalChars: 12345, preview: "{…" };
    expect(actionPhrase(action({ input: truncated }))).toBe("run a command too long to show in full (12345 characters)");
    expect(actionPhrase(action({ kind: "file_write", tool: "write", input: truncated }))).toBe(
      "create or replace something too long to show in full (12345 characters)",
    );
  });

  it("prefers the command over a path for shell actions", () => {
    expect(actionPhrase(action({ input: { path: "src", command: "ls -la" } }))).toBe('run the command "ls -la"');
  });

  it("escapes quotes and backslashes inside a narrated command so it cannot close its own quotes", () => {
    expect(actionPhrase(action({ input: { command: 'echo "hi" \\ ok' } }))).toBe('run the command "echo \\"hi\\" \\\\ ok"');
    expect(actionPhrase(action({ tool: "codex.stdin", input: { reason: 'say "y"' } }))).toBe(
      'type "say \\"y\\"" into the running command',
    );
  });

  it("keeps redaction markers as they were recorded", () => {
    expect(actionPhrase(action({ input: { command: "curl -H [REDACTED]" } }))).toBe('run the command "curl -H [REDACTED]"');
  });
});

describe("narrateAction", () => {
  it("phrases the action by its status", () => {
    const by = (status: AgentAction["status"]) => narrateAction(action({ status })).headline;
    expect(by("pending")).toBe('Wants to run the command "npm test"');
    expect(by("allowed")).toBe('Allowed to run the command "npm test"');
    expect(by("denied")).toBe('Denied: run the command "npm test"');
    expect(by("completed")).toBe('Did run the command "npm test"');
    expect(by("failed")).toBe('Failed to run the command "npm test"');
    for (const s of ["pending", "allowed", "denied", "completed", "failed"] as const) headlines.push(by(s));
  });

  it("gives the output when there is one, else the input, and what the kind means", () => {
    const pending = narrateAction(action({}));
    expect(pending.detail).toBe(JSON.stringify({ command: "npm test" }, null, 2));
    expect(pending.means).toBe(ACTION_KIND_MEANS.shell);
    expect(narrateAction(action({ status: "completed", output: "ok" })).detail).toBe("ok");
  });
});

describe("ACTION_KIND_MEANS", () => {
  it("explains every kind in exact words", () => {
    expect(Object.keys(ACTION_KIND_MEANS).sort()).toEqual([...ACTION_KINDS].sort());
    expect(ACTION_KIND_MEANS).toEqual({
      file_read: "Reads a file inside the agent's working copy of the project. Nothing changes.",
      file_write:
        "Creates or replaces a file inside the agent's working copy. The previous contents are gone unless git kept them.",
      file_edit: "Changes part of a file inside the agent's working copy.",
      shell:
        "Runs a program on this computer, inside the agent's working copy. It can read and change files there and reach the network.",
      web: "Fetches something from the internet. What is sent and received is recorded.",
      mcp: "Uses a tool from a connected MCP server. Every call is recorded and asks first.",
      other: "Something the agent's program asked for that fits no other kind. Read the raw detail before deciding.",
    });
  });
});

describe("narration.ts purity", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/narration.ts", import.meta.url)), "utf8");
  it("imports only the pure catalogs", () => {
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(source.match(/^\s*import\b/gm)?.length).toBe(imports.length);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect([
        "./intake.js",
        "./gates.js",
        "./agents.js",
        "./domain.js",
        "./connections.js",
        "./text.js",
        "./override.js",
        "./people.js",
        "./learn.js",
        "./link.js",
        "./share.js",
      ]).toContain(spec);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it("reads no clock, randomness, network or environment", () => {
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bprocess\b/);
    expect(source).not.toMatch(/\bglobalThis\b/);
  });
});

describe("narrate: people", () => {
  const p1: Actor = { kind: "human", id: "p1" };
  const machineId = "ab".repeat(16);
  const named: NarrationContext = {
    ...ctx,
    machineName: (id) => (id === machineId ? "GPU box" : undefined),
    personName: (id) => ({ p1: "Reviewer One", p2: "Maint Two", owner: "Andrea" })[id],
  };
  const CERT = Array.from({ length: 32 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0")).join(":");

  it("names a person from the context, the Owner without one, and anyone else as Someone", () => {
    const moved = (actor: Actor, c?: NarrationContext) =>
      h(entry("card.moved", { cardId: "c1", from: "build", to: "ship" }, actor), c);
    expect(moved(p1, { ...ctx, personName: () => "Reviewer One" })).toBe('Reviewer One moved "Detect GPU" from Build to Ship');
    expect(moved(p1)).toBe("Someone moved a card from Build to Ship");
    expect(moved(owner)).toBe("Owner moved a card from Build to Ship");
    expect(moved(owner, { personName: () => undefined })).toBe("Owner moved a card from Build to Ship");
    expect(moved(owner, { personName: (id) => (id === "owner" ? "Andrea" : undefined) })).toBe("Andrea moved a card from Build to Ship");
  });

  it("shows a hostile name inert and survives a context that throws", () => {
    const evil = "Eve\u202e\u0007<script>\n" + "x".repeat(100);
    const out = h(entry("card.moved", { cardId: "c1", from: "build", to: "ship" }, p1), { personName: () => evil });
    expect([...out].map((c) => c.charCodeAt(0)).filter((c) => c < 32 || (c >= 0x202a && c <= 0x202e))).toEqual([]);
    expect(out).toContain("\\n");
    expect(out).toContain("\\u202e");
    expect(out.indexOf(" moved ")).toBeLessThanOrEqual(62);
    const thrown = n(entry("card.moved", { cardId: "c1", from: "build", to: "ship" }, p1), {
      personName: () => {
        throw new Error("boom");
      },
    });
    expect(thrown.headline).toBe("Someone moved a card from Build to Ship");
  });

  it("names the person in each of Plan 6's and Plan 7's ten templates", () => {
    const tenOf = (actor: Actor) => [
      h(entry("machine.named", { name: "Mac" }, actor), named),
      h(entry("machine.linking_enabled", { port: 4418, acknowledgement: "…" }, actor), named),
      h(entry("machine.linking_disabled", {}, actor), named),
      h(entry("machine.paired", { machineId, name: "GPU box", publicKey: "k", fingerprint: "0123456789abcdef", address: "a", role: "entered_code" }, actor), named),
      h(entry("machine.unpaired", { machineId, name: "GPU box" }, actor), named),
      h(entry("link.run_requested", { runId: "r1", machineId, adapter: "codex", prompt: "go", cardId: null, connectionIds: [] }, actor), named),
      h(entry("link.decision_received", { runId: "r1", actionId: "a1", machineId, decision: "allow" }, actor), named),
      h(entry("share.confirmed", { shareId: "s1", contentHash: "a".repeat(64), bytes: 10, sections: ["overview"], options: {}, headSeq: 1 }, actor), named),
      h(entry("share.link_created", { linkId: "l1", shareId: "s1", tokenDigest: "b".repeat(64), expiresAt: "2026-11-15T18:00:00.000Z", port: 8080, scope: "this_computer" }, actor), named),
      h(entry("share.revoked", { linkId: "l1", reason: "owner" }, actor), named),
    ];
    const byP1 = tenOf(p1);
    expect(byP1).toHaveLength(10);
    for (const line of byP1) expect(line.startsWith("Reviewer One")).toBe(true);
    expect(byP1[6]).toBe("Reviewer One's decision arrived from GPU box: allowed");
    const byOwner = tenOf(owner);
    for (const line of byOwner) expect(line.startsWith("Andrea")).toBe(true);
  });

  it("keeps a decision arriving from another machine as the Owner's, never this machine's person", () => {
    const system: Actor = { kind: "system", id: "link" };
    expect(h(entry("link.decision_received", { runId: "r1", actionId: "a1", machineId, decision: "deny" }, system), named)).toBe(
      "Owner's decision arrived from GPU box: denied",
    );
  });

  it("uses no literal Owner outside actorName in narration.ts and digest.ts", () => {
    for (const file of ["narration.ts", "digest.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
      const start = src.indexOf("function actorName(");
      const end = start < 0 ? -1 : src.indexOf("\n}\n", start);
      const outside = start < 0 ? src : src.slice(0, start) + src.slice(end);
      expect(outside.includes('"Owner'), file).toBe(false);
      expect(outside.includes("`Owner"), file).toBe(false);
    }
  });

  it("narrates invitations, joining and credentials", () => {
    const invited = n(entry("person.invited", { inviteId: "i1", role: "reviewer", codeHash: "c".repeat(64), expiresAt: "2026-11-22T10:00:00.000Z" }), named);
    expect(invited.headline).toBe("Andrea invited a reviewer");
    expect(invited.topic).toBe("people");
    expect(JSON.stringify(invited)).not.toContain("c".repeat(12));
    expect(h(entry("person.invited", { inviteId: "i1", role: "maintainer", codeHash: "c".repeat(64), expiresAt: "2026-11-22T10:00:00.000Z" }))).toBe(
      "Owner invited a maintainer",
    );
    expect(h(entry("person.invite_revoked", { inviteId: "i1" }))).toBe("Owner revoked an invitation");
    const credential = { kind: "passkey", credentialId: "Y3JlZA", publicKey: "TESTKEY-cHVi", transports: ["usb"], label: "Laptop" };
    const joined = n(entry("person.joined", { personId: "p1", inviteId: "i1", name: "Reviewer One", role: "reviewer", credential }, p1), named);
    expect(joined.headline).toBe("Reviewer One joined as reviewer");
    expect(JSON.stringify(joined)).not.toContain("TESTKEY");
    expect(h(entry("person.joined", { personId: "p1", inviteId: "i1", name: "Eve\u202e", role: "viewer", credential }, p1))).toBe(
      "Eve\\u202e joined as viewer",
    );
    const added = n(entry("person.credential_added", { personId: "p1", credential }, p1), named);
    expect(added.headline).toBe('Reviewer One added a passkey ("Laptop")');
    expect(JSON.stringify(added)).not.toContain("TESTKEY");
    expect(JSON.stringify(added)).not.toContain("Y3JlZA");
    const keyCred = { kind: "key", credentialId: "a2V5", publicKey: "TESTKEY-c3Br", label: "This browser" };
    expect(h(entry("person.credential_added", { personId: "p1", credential: keyCred }, p1), named)).toBe('Reviewer One added a key ("This browser")');
    // A label is chosen by the person: a line break in it is shown as an escape, so it cannot fake a second line.
    const sneaky = { ...keyCred, label: 'x")\nOwner revoked\tall' };
    const sneakyLine = h(entry("person.credential_added", { personId: "p1", credential: sneaky }, p1), named);
    expect(sneakyLine).not.toContain("\n");
    expect(sneakyLine).not.toContain("\t");
    expect(sneakyLine).toContain("\\n");
    expect(h(entry("person.credential_removed", { personId: "p1", credentialId: "a2V5" }, p1), named)).toBe("Reviewer One removed a credential");
  });

  it("narrates renames, role changes, removals, sign-ins and lockouts", () => {
    expect(h(entry("person.renamed", { personId: "p1", name: "Ana" }, p1), named)).toBe('Reviewer One is now called "Ana"');
    expect(h(entry("person.role_changed", { personId: "p2", from: "reviewer", to: "maintainer" }), named)).toBe("Andrea made Maint Two a maintainer");
    expect(h(entry("person.role_changed", { personId: "p9", from: "maintainer", to: "viewer" }))).toBe("Owner made Someone a viewer");
    expect(h(entry("person.removed", { personId: "p2" }), named)).toBe("Andrea removed Maint Two");
    const system: Actor = { kind: "system", id: "auth" };
    const signedIn = n(entry("person.signed_in", { personId: "p1", listener: "remote", method: "passkey" }, system), named);
    expect(signedIn).toMatchObject({ headline: "Reviewer One signed in remotely", topic: "people", attention: false });
    expect(h(entry("person.signed_in", { personId: "owner", listener: "local", method: "token" }, system))).toBe("Owner signed in locally");
    const locked = n(entry("person.locked", { personId: "p1", until: "2026-11-15T10:15:00.000Z", failures: 5 }, system), named);
    expect(locked).toMatchObject({ headline: "Reviewer One was locked out after 5 failed sign-ins", topic: "people", attention: true });
  });

  it("narrates remote access and certificate changes", () => {
    const on = n(entry("remote.enabled", { port: 4318, bind: "0.0.0.0", domain: null, tls: "self_signed", fingerprint: CERT }), named);
    expect(on).toMatchObject({ headline: "Andrea turned remote access on (this machine's addresses, port 4318)", topic: "remote", attention: true });
    expect(h(entry("remote.enabled", { port: 443, bind: "0.0.0.0", domain: "example.org", tls: "acme", fingerprint: CERT }))).toBe(
      "Owner turned remote access on (example.org, port 443)",
    );
    expect(h(entry("remote.disabled", {}))).toBe("Owner turned remote access off");
    const system: Actor = { kind: "system", id: "remote" };
    const cert = (tls: string) =>
      n(entry("remote.certificate_changed", { tls, fingerprint: CERT, domain: null, expiresAt: "2036-11-15T10:00:00.000Z" }, system));
    expect(cert("self_signed").headline).toBe("The remote certificate changed (self-signed, fingerprint 00:01:02…)");
    expect(cert("acme").headline).toBe("The remote certificate changed (Let's Encrypt, fingerprint 00:01:02…)");
    expect(cert("provided").headline).toBe("The remote certificate changed (own certificate files, fingerprint 00:01:02…)");
    expect(cert("acme").topic).toBe("remote");
  });

  it("narrates who may sign a gate", () => {
    const set = (requirement: unknown, c?: NarrationContext) => n(entry("gate.requirement_set", { gateId: "go_live", requirement }), c);
    expect(set({ role: "reviewer" }, named).headline).toBe('Andrea set who may sign "Going live": a reviewer or above');
    expect(set({ role: "owner" }).headline).toBe('Owner set who may sign "Going live": the Owner');
    expect(set({ personId: "p2" }, named).headline).toBe('Andrea set who may sign "Going live": Maint Two only');
    expect(set({ personId: "p9" }).headline).toBe('Owner set who may sign "Going live": Someone only');
    expect(set(null).headline).toBe('Owner set who may sign "Going live" back to the default');
    expect(set(null).topic).toBe("gate");
  });
});
