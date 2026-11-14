import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorMessage } from "../src/api";

function respond(status: number, body?: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const call = (f: ReturnType<typeof vi.fn>, i: number) => f.mock.calls[i] as [string, RequestInit];

afterEach(() => vi.unstubAllGlobals());

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
    expect(errorMessage(new ApiError(503, "keychain_unavailable"))).toBe("Your keychain is unavailable. Nothing was saved.");
    expect(errorMessage(new ApiError(400, "invalid_input"))).toBe("That input was not accepted");
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
