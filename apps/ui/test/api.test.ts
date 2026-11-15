import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, blockedGates, errorMessage, exportLedgerUrl, shareDownloadUrl, shareSnapshotUrl } from "../src/api";

function respond(status: number, body?: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const call = (f: ReturnType<typeof vi.fn>, i: number) => f.mock.calls[i] as [string, RequestInit];

afterEach(() => vi.unstubAllGlobals());

describe("run refusals from the server", () => {
  it("carries which agent refused MCP servers", async () => {
    respond(400, { error: "mcp_unsupported", adapter: "gemini" });
    const err = await api.startRun("p1", { adapter: "gemini", prompt: "go", connectionIds: ["m1"] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "mcp_unsupported", detail: { adapter: "gemini" } });
  });
});

describe("error detail", () => {
  it("carries the rest of the error body as the detail, whatever its shape", async () => {
    respond(409, { error: "gate_blocked", gates: [{ id: "payments", met: false }] });
    const err = await api.moveCard("c1", "ship").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "gate_blocked", detail: { gates: [{ id: "payments", met: false }] } });
  });

  it("has no detail for a bare error or a non-JSON body", async () => {
    respond(404, { error: "not_found" });
    expect(await api.moveCard("c1", "ship").catch((e: unknown) => e)).toMatchObject({ code: "not_found", detail: undefined });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    expect(await api.moveCard("c1", "ship").catch((e: unknown) => e)).toMatchObject({ code: "internal", detail: undefined });
  });

  it("ignores a detail of the wrong type when wording a message", () => {
    expect(errorMessage(new ApiError(502, "cloud_credentials_failed", { name: 7 }), "run")).toBe(
      'Could not get credentials from "a cloud connection". The run did not start.',
    );
  });
});

describe("audit export", () => {
  it("links every project's ledger, or one project's", () => {
    expect(exportLedgerUrl(null)).toBe("/api/ledger/export");
    expect(exportLedgerUrl("p/1 x")).toBe("/api/ledger/export?projectId=p%2F1%20x");
  });
});

describe("connections api", () => {
  it("lists connections and the catalog", async () => {
    const f = respond(200, []);
    await api.listConnections();
    expect(call(f, 0)[0]).toBe("/api/connections");
    await api.getConnectionCatalog();
    expect(call(f, 1)[0]).toBe("/api/connections/catalog");
  });

  it("adds with POST, updates with PATCH and tests with POST", async () => {
    const f = respond(200, {});
    await api.addConnection({ kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: "sk-ant-TESTKEY-0000000000" } });
    expect(call(f, 0)[0]).toBe("/api/connections");
    expect(call(f, 0)[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(call(f, 0)[1].body as string)).toEqual({
      kind: "llm", provider: "claude", name: "Claude", secrets: { apiKey: "sk-ant-TESTKEY-0000000000" },
    });
    await api.updateConnection("a/b", { enabled: false });
    expect(call(f, 1)[0]).toBe("/api/connections/a%2Fb");
    expect(call(f, 1)[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ enabled: false }) });
    await api.testConnection("c1");
    expect(call(f, 2)[0]).toBe("/api/connections/c1/test");
    expect(call(f, 2)[1]).toMatchObject({ method: "POST" });
    expect(call(f, 2)[1].body).toBeUndefined();
    expect(call(f, 2)[1].headers).toBeUndefined();
  });

  it("removes with DELETE and accepts an empty 204", async () => {
    const f = respond(204);
    await expect(api.removeConnection("c1")).resolves.toBeUndefined();
    expect(call(f, 0)[0]).toBe("/api/connections/c1");
    expect(call(f, 0)[1]).toMatchObject({ method: "DELETE" });
  });

  it("reads the status", async () => {
    const f = respond(200, { runningAgents: 0 });
    await api.getStatus();
    expect(call(f, 0)[0]).toBe("/api/status");
  });

  it("starts a run with the selected connections and reads the failed connection's name", async () => {
    const f = respond(201, {});
    await api.startRun("p1", { adapter: "claude", prompt: "go", connectionIds: ["aws-1"] });
    expect(call(f, 0)[0]).toBe("/api/projects/p1/runs");
    expect(JSON.parse(call(f, 0)[1].body as string)).toEqual({ adapter: "claude", prompt: "go", connectionIds: ["aws-1"] });
    respond(502, { error: "cloud_credentials_failed", name: "AWS dev" });
    await expect(api.startRun("p1", { adapter: "claude", prompt: "go" })).rejects.toMatchObject({
      status: 502, code: "cloud_credentials_failed", detail: { name: "AWS dev" },
    });
  });

  it("surfaces the error code", async () => {
    respond(503, { error: "keychain_unavailable" });
    await expect(api.addConnection({ kind: "llm", provider: "claude", name: "Claude" })).rejects.toMatchObject({
      status: 503,
      code: "keychain_unavailable",
    });
  });
});

describe("override api", () => {
  it("posts a command and a discard to the run's override routes", async () => {
    const f = respond(201, { overrideId: "o1" });
    expect(await api.overrideCommand("r/1", { program: "git", args: ["status"], reason: "The agent broke the build" })).toEqual({ overrideId: "o1" });
    expect(call(f, 0)[0]).toBe("/api/runs/r%2F1/override/command");
    expect(call(f, 0)[1].method).toBe("POST");
    expect(JSON.parse(String(call(f, 0)[1].body))).toEqual({ program: "git", args: ["status"], reason: "The agent broke the build" });
    const g = respond(200, { overrideId: "o2", files: 2 });
    expect(await api.overrideDiscard("r1", "The agent broke the build")).toEqual({ overrideId: "o2", files: 2 });
    expect(call(g, 0)[0]).toBe("/api/runs/r1/override/discard");
    expect(JSON.parse(String(call(g, 0)[1].body))).toEqual({ reason: "The agent broke the build" });
  });

  it("words the override refusals", () => {
    expect(errorMessage(new ApiError(409, "run_active"))).toBe("Stop the agent first: it is still working in this run");
    expect(errorMessage(new ApiError(409, "override_busy"))).toBe("An override is already running for this run");
    expect(errorMessage(new ApiError(400, "program_not_found"))).toBe("That program was not found on this computer's PATH");
    expect(errorMessage(new ApiError(400, "program_not_allowed"))).toBe(
      "Programs inside the project folder, and Windows batch files, cannot be run as an override",
    );
    expect(errorMessage(new ApiError(400, "secret_in_text"))).toBe("That text looks like it contains a key or password. It was not saved.");
  });
});

describe("errorMessage", () => {
  it("maps the connection errors", () => {
    expect(errorMessage(new ApiError(409, "conflict"))).toBe("Already connected");
    expect(errorMessage(new ApiError(400, "secret_in_config"))).toBe("That field must not contain a key or token");
    expect(errorMessage(new ApiError(400, "connection_unsupported"))).toBe("This connection cannot be used that way");
    expect(errorMessage(new ApiError(503, "keychain_unavailable"))).toBe("Your keychain is unavailable. Nothing was saved.");
    expect(errorMessage(new ApiError(400, "invalid_input"))).toBe("That input was not accepted");
  });
  it("maps the run start refusals; a failed cloud grant names the connection", () => {
    expect(errorMessage(new ApiError(400, "connection_unsupported"), "run")).toBe("That connection cannot be given to a run");
    expect(errorMessage(new ApiError(400, "connection_disabled"), "run")).toBe("That connection is disabled");
    expect(errorMessage(new ApiError(400, "duplicate_cloud_provider"), "run")).toBe(
      "A run can be given only one connection per cloud provider. Untick the extra one.",
    );
    expect(errorMessage(new ApiError(400, "mcp_unsupported"), "run")).toBe(
      "Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.",
    );
    expect(errorMessage(new ApiError(400, "mcp_unsupported", { adapter: "gemini" }), "run")).toBe(
      "Gemini cannot use MCP servers in The Terminal yet: Gemini only starts MCP servers in a trusted folder, and The Terminal never trusts agent worktrees.",
    );
    expect(errorMessage(new ApiError(400, "duplicate_mcp_server"), "run")).toBe(
      "Two of the selected MCP servers would get the same name in this run. Untick one of them.",
    );
    expect(errorMessage(new ApiError(502, "cloud_credentials_failed", { name: "AWS dev" }), "run")).toBe(
      'Could not get credentials from "AWS dev". The run did not start.',
    );
  });
  it("maps the sign-in refusals", () => {
    expect(errorMessage(new ApiError(422, "terminal_required"))).toBe(
      "This provider signs in inside its own terminal. Run the command shown, then check again.",
    );
    expect(errorMessage(new ApiError(422, "invalid_cli_home"))).toBe("The CLI home folder must be an absolute path");
    expect(errorMessage(new ApiError(422, "not_installed"))).toBe("Something went wrong");
  });
});

describe("sign-in api", () => {
  it("starts, reads and cancels a sign-in, and reads the sign-in status", async () => {
    const f = respond(200, {});
    await api.startSignIn("codex");
    expect(call(f, 0)[0]).toBe("/api/connections/signin/codex");
    expect(call(f, 0)[1]).toMatchObject({ method: "POST" });
    expect(call(f, 0)[1].body).toBeUndefined();
    await api.getSignIn("s 1");
    expect(call(f, 1)[0]).toBe("/api/connections/signin/s%201");
    await api.cancelSignIn("s1");
    expect(call(f, 2)[0]).toBe("/api/connections/signin/s1");
    expect(call(f, 2)[1]).toMatchObject({ method: "DELETE" });
    await api.getSignInStatus();
    expect(call(f, 3)[0]).toBe("/api/connections/signin-status");
  });
});

describe("intake api", () => {
  it("reads a project's intake, and null when it has none", async () => {
    let f = respond(200, { step: "answer" });
    expect(await api.getIntake("p/1")).toEqual({ step: "answer" });
    expect(call(f, 0)[0]).toBe("/api/projects/p%2F1/intake");
    f = respond(404, { error: "no_intake" });
    expect(await api.getIntake("p1")).toBeNull();
    respond(404, { error: "not_found" });
    const gone = await api.getIntake("p1").catch((e: unknown) => e);
    expect(gone).toMatchObject({ status: 404, code: "not_found" });
    // A project that no longer exists is said plainly, not left loading.
    expect(errorMessage(gone, "intake")).toBe("This project no longer exists");
  });

  it("starts, answers, decides, completes and reopens on the intake routes", async () => {
    const f = respond(200, {});
    await api.startIntake("p1", "a reading list");
    await api.answerIntake("p1", "payments", "yes");
    await api.decideIntake("p1", "first_version", "full", "");
    await api.decideIntake("p1", "hosting", "local");
    await api.completeIntake("p1");
    await api.reopenIntake("p1", "We will take payments");
    const sent = (f.mock.calls as [string, RequestInit][]).map(([url, init]) => [
      url, init.method, init.body === undefined ? undefined : JSON.parse(String(init.body)),
    ]);
    expect(sent).toEqual([
      ["/api/projects/p1/intake", "POST", { idea: "a reading list" }],
      ["/api/projects/p1/intake/answers", "POST", { questionId: "payments", answer: "yes" }],
      ["/api/projects/p1/intake/decisions", "POST", { decisionId: "first_version", chosen: "full", rationale: "" }],
      ["/api/projects/p1/intake/decisions", "POST", { decisionId: "hosting", chosen: "local" }],
      ["/api/projects/p1/intake/complete", "POST", undefined],
      ["/api/projects/p1/intake/reopen", "POST", { reason: "We will take payments" }],
    ]);
    expect(call(f, 4)[1].headers).toBeUndefined();
  });

  it("words the intake refusals", () => {
    expect(errorMessage(new ApiError(409, "intake_incomplete", { missing: { questions: [], decisions: ["hosting"] } }))).toBe(
      "Answer every question and make every decision first",
    );
    expect(errorMessage(new ApiError(400, "secret_in_text"))).toBe("That text looks like it contains a key or password. It was not saved.");
    expect(errorMessage(new ApiError(409, "intake_completed"))).toBe("This plan is approved. Reopen it to change answers.");
    expect(errorMessage(new ApiError(409, "conflict"), "intake")).toBe("This project already has a plan intake");
    expect(errorMessage(new ApiError(409, "conflict"), "reopen")).toBe("This plan is already open for changes.");
    expect(errorMessage(new ApiError(409, "decision_not_applicable"))).toBe("That decision no longer applies to your answers");
  });
});

describe("gates and stories api", () => {
  it("reads a move's gates, moves with or without decisions, and reads a card's story", async () => {
    const f = respond(200, []);
    await api.getCardGates("c/1", "ship");
    expect(call(f, 0)[0]).toBe("/api/cards/c%2F1/gates?to=ship");
    await api.moveCard("c1", "design");
    expect(JSON.parse(String(call(f, 1)[1].body))).toEqual({ to: "design" });
    const decision = { gateId: "ready_to_ship", decision: "sign_off", acknowledgement: "I agree." } as const;
    await api.moveCard("c1", "ship", [decision]);
    expect(call(f, 2)[0]).toBe("/api/cards/c1/move");
    expect(JSON.parse(String(call(f, 2)[1].body))).toEqual({ to: "ship", gates: [decision] });
    await api.getCardStory("c1");
    expect(call(f, 3)[0]).toBe("/api/cards/c1/story");
  });

  it("reads the gates of a blocked move from the error, and nothing from any other error", () => {
    const gates = [{ id: "payments" }];
    expect(blockedGates(new ApiError(409, "gate_blocked", { gates }))).toEqual(gates);
    expect(blockedGates(new ApiError(409, "gate_blocked", { gates: "x" }))).toBeNull();
    expect(blockedGates(new ApiError(409, "gate_not_met", { gates }))).toBeNull();
    expect(blockedGates(new Error("x"))).toBeNull();
  });

  it("shows the server's message for a card added straight into a gated stage", () => {
    expect(errorMessage(new ApiError(409, "stage_gated", { message: "Add the card to an earlier stage, then move it." }))).toBe(
      "Add the card to an earlier stage, then move it.",
    );
    expect(errorMessage(new ApiError(409, "stage_gated"))).toBe("Add the card to an earlier stage, then move it, so its readiness checks run.");
    expect(errorMessage(new ApiError(400, "secret_in_text"))).toBe("That text looks like it contains a key or password. It was not saved.");
  });
});

describe("runExists", () => {
  it("is false only when the server answers 404 for the run", async () => {
    let f = respond(200, { run: { id: "r/1" }, actions: [] });
    expect(await api.runExists("r/1")).toBe(true);
    expect(call(f, 0)[0]).toBe("/api/runs/r%2F1");
    f = respond(404, { error: "not_found" });
    expect(await api.runExists("r1")).toBe(false);
    respond(500, { error: "internal" });
    expect(await api.runExists("r1")).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await api.runExists("r1")).toBe(true);
  });
});

describe("run changes", () => {
  it("reads the changes, a diff, a directory and a file, with the path encoded", async () => {
    const f = respond(200, {});
    await api.getRunChanges("run 1");
    await api.getRunDiff("run1", "src/a b.ts");
    await api.listRunDir("run1", "");
    await api.getRunFile("run1", "src/a&b.ts");
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      "/api/runs/run%201/changes",
      "/api/runs/run1/diff?path=src%2Fa%20b.ts",
      "/api/runs/run1/files?path=",
      "/api/runs/run1/file?path=src%2Fa%26b.ts",
    ]);
  });

  it("words a missing working copy and an unknown starting point", () => {
    expect(errorMessage(new ApiError(404, "worktree_missing"))).toBe("This run's working copy no longer exists on this computer");
    expect(errorMessage(new ApiError(409, "no_base"))).toBe(
      "What this run changed cannot be shown: it was recorded before The Terminal kept the commit it started from, or that commit is gone. Its files can still be browsed under Files in the Changes view.",
    );
    expect(errorMessage(new ApiError(409, "no_base"), "changes")).toBe(
      "What this run changed cannot be shown: it was recorded before The Terminal kept the commit it started from, or that commit is gone. Its files can still be browsed under Files in the Changes view.",
    );
  });

  it("words the workspace's own git pins having been tampered with, for the changes views and the override alike", () => {
    for (const context of [undefined, "changes"] as const) {
      expect(errorMessage(new ApiError(409, "gitconfig_modified", { message: "x" }), context)).toBe(
        "The Terminal's shared git configuration was modified, so git was not run. Restart The Terminal to repair it.",
      );
      expect(errorMessage(new ApiError(409, "hooks_modified", { message: "x" }), context)).toBe(
        "The Terminal's empty hooks folder was modified, so git was not run. Empty it and try again.",
      );
    }
  });

  it("words a live run and an unsafe repository for the changes views", () => {
    expect(errorMessage(new ApiError(409, "run_active", { message: "x" }), "changes")).toBe("Changes show when the run is stopped or finished.");
    expect(errorMessage(new ApiError(409, "unsafe_repository"), "changes")).toBe(
      "This repository's git setup includes settings The Terminal does not allow, so its changes cannot be shown.",
    );
    expect(errorMessage(new ApiError(409, "unsafe_repository"))).toBe(
      "This repository's git setup includes settings The Terminal does not allow, so its changes cannot be shown.",
    );
    // An override refused for a live run keeps its own wording.
    expect(errorMessage(new ApiError(409, "run_active"))).toBe("Stop the agent first: it is still working in this run");
  });
});

describe("ledger pages", () => {
  it("asks for a page after, or the newest page before, a seq, for one project or every project", async () => {
    const f = respond(200, []);
    await api.listLedger("p 1", { beforeSeq: 8, limit: 500 });
    await api.listLedger(null, { afterSeq: 3 });
    await api.listLedger(null, {});
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      "/api/ledger?projectId=p%201&beforeSeq=8&limit=500",
      "/api/ledger?afterSeq=3",
      "/api/ledger",
    ]);
  });
});

describe("share api", () => {
  it("previews with the options and confirms with the preview's id and hash", async () => {
    const f = respond(200, {});
    await api.previewShare("p 1", { includePrompts: true, includeHardware: false, digestDays: 14 });
    expect(call(f, 0)[0]).toBe("/api/projects/p%201/share/preview");
    expect(call(f, 0)[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(call(f, 0)[1].body as string)).toEqual({ includePrompts: true, includeHardware: false, digestDays: 14 });
    await api.confirmShare("p 1", "pv1", "ab".repeat(32));
    expect(call(f, 1)[0]).toBe("/api/projects/p%201/share/confirm");
    expect(JSON.parse(call(f, 1)[1].body as string)).toEqual({ previewId: "pv1", contentHash: "ab".repeat(32) });
  });

  it("lists snapshots, addresses, links and digests", async () => {
    const f = respond(200, []);
    await api.listShareSnapshots("p1");
    await api.listShareAddresses();
    await api.listShareLinks();
    await api.listShareLinks("p 1");
    await api.getDigests("p1", 30);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      "/api/projects/p1/share/snapshots",
      "/api/share/addresses",
      "/api/share/links",
      "/api/share/links?projectId=p%201",
      "/api/projects/p1/digests?days=30",
    ]);
  });

  it("creates a link with POST and revokes it with DELETE", async () => {
    const f = respond(201, { link: {}, url: "http://127.0.0.1:1/t" });
    await api.createShareLink("s/1", "127.0.0.1", 1440);
    expect(call(f, 0)[0]).toBe("/api/share/snapshots/s%2F1/links");
    expect(JSON.parse(call(f, 0)[1].body as string)).toEqual({ address: "127.0.0.1", ttlMinutes: 1440 });
    const g = respond(204);
    await expect(api.revokeShareLink("l1")).resolves.toBeUndefined();
    expect(call(g, 0)[0]).toBe("/api/share/links/l1");
    expect(call(g, 0)[1]).toMatchObject({ method: "DELETE" });
  });

  it("names the saved page's inline and download urls", () => {
    expect(shareSnapshotUrl("s1")).toBe("/api/share/snapshots/s1");
    expect(shareDownloadUrl("s1")).toBe("/api/share/snapshots/s1/download");
  });

  it("words the share refusals before the generic ones", () => {
    expect(errorMessage(new ApiError(409, "preview_stale"))).toBe("The preview has changed or expired. Preview again before confirming.");
    expect(errorMessage(new ApiError(404, "preview_not_found"))).toBe("The preview has changed or expired. Preview again before confirming.");
    expect(errorMessage(new ApiError(409, "share_not_clean"))).toBe("The page could not be cleaned of sensitive text and was not generated.");
    expect(errorMessage(new ApiError(409, "share_too_large"))).toBe("The page is too large to share. Choose fewer digest days.");
    expect(errorMessage(new ApiError(409, "share_link_active"))).toBe("A link is already live for this project. Revoke it first.");
    expect(errorMessage(new ApiError(409, "snapshot_tampered"))).toBe("This snapshot's file no longer matches the ledger. It will not be shared.");
    expect(errorMessage(new ApiError(404, "snapshot_missing"))).toBe("This snapshot's file is missing.");
    expect(errorMessage(new ApiError(409, "link_not_active"))).toBe("That link is no longer live.");
  });
});
