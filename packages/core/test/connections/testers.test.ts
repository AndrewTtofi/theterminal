import { describe, expect, it, vi } from "vitest";
import { CONNECTION_TESTERS, cloudTesters } from "../../src/connections/testers.js";
import { fakeSts } from "../../src/connections/cloud/aws.js";
import { localModelTester } from "../../src/capacity/local-models.js";

const KEY = "sk-ant-TESTKEY-0000000000";
const signal = new AbortController().signal;

function fakeFetch(status = 200, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status, headers }));
}

const run = (provider: keyof typeof CONNECTION_TESTERS, f: typeof fetch, secrets: Record<string, string>) =>
  CONNECTION_TESTERS[provider]!({ config: {}, private: {}, secrets }, { fetch: f, signal });

const cases = [
  {
    provider: "claude", secret: "apiKey", url: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
  },
  { provider: "codex", secret: "apiKey", url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${KEY}` } },
  { provider: "gemini", secret: "apiKey", url: "https://generativelanguage.googleapis.com/v1beta/models", headers: { "x-goog-api-key": KEY } },
  {
    provider: "github", secret: "token", url: "https://api.github.com/user",
    headers: { authorization: `Bearer ${KEY}`, "x-github-api-version": "2022-11-28", accept: "application/vnd.github+json" },
  },
] as const;

describe.each(cases)("$provider tester", ({ provider, secret, url, headers }) => {
  it("sends a GET to the exact URL with the key only in a header", async () => {
    const f = fakeFetch();
    const r = await run(provider, f as unknown as typeof fetch, { [secret]: KEY });
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = f.mock.calls[0]!;
    expect(String(calledUrl)).toBe(url);
    expect(String(calledUrl)).not.toContain("TESTKEY");
    expect(init!.method).toBe("GET");
    expect(init!.signal).toBe(signal);
    const sent = new Headers(init!.headers);
    for (const [k, v] of Object.entries(headers)) expect(sent.get(k)).toBe(v);
  });

  it("reports a rejected key", async () => {
    for (const status of [401, 403]) {
      expect(await run(provider, fakeFetch(status) as unknown as typeof fetch, { [secret]: KEY })).toEqual({
        ok: false, message: `Rejected by the provider (HTTP ${status})`,
      });
    }
  });

  it("reports other responses", async () => {
    expect(await run(provider, fakeFetch(500) as unknown as typeof fetch, { [secret]: KEY })).toEqual({
      ok: false, message: "Unexpected response (HTTP 500)",
    });
  });

  it("reports a network failure", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await run(provider, f as unknown as typeof fetch, { [secret]: KEY })).toEqual({ ok: false, message: "Could not reach the provider" });
  });

  it("makes no request without a stored secret", async () => {
    const f = fakeFetch();
    const r = await run(provider, f as unknown as typeof fetch, {});
    expect(r).toEqual({ ok: false, message: provider === "github" ? "No token stored" : "No API key stored" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("success messages", () => {
  it("is exactly Connected for model providers", async () => {
    for (const p of ["claude", "codex", "gemini"] as const) {
      expect(await run(p, fakeFetch() as unknown as typeof fetch, { apiKey: KEY })).toEqual({ ok: true, message: "Connected" });
    }
  });

  it("names the GitHub token scopes, or fine-grained", async () => {
    const classic = fakeFetch(200, { "X-OAuth-Scopes": "repo, read:org" });
    expect(await run("github", classic as unknown as typeof fetch, { token: KEY })).toEqual({ ok: true, message: "Connected (scopes: repo, read:org)" });
    expect(await run("github", fakeFetch() as unknown as typeof fetch, { token: KEY })).toEqual({ ok: true, message: "Connected (scopes: fine-grained)" });
  });

  it("covers the 5A providers and the local model server", () => {
    expect(Object.keys(CONNECTION_TESTERS).sort()).toEqual(["claude", "codex", "gemini", "github", "local_model"]);
    expect(CONNECTION_TESTERS.local_model).toBe(localModelTester);
  });

  it("offers the cloud testers separately, bound to an STS caller", () => {
    expect(Object.keys(cloudTesters(fakeSts)).sort()).toEqual(["aws", "azure", "gcp"]);
  });
});
