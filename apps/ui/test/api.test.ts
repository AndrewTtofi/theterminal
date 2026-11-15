import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorMessage, exportLedgerUrl } from "../src/api";

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
