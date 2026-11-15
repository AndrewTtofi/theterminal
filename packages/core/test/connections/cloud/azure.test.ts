import { describe, expect, it, vi } from "vitest";
import { AZURE_SCOPE, fetchAzureToken } from "../../../src/connections/cloud/azure.js";
import { fakeSts } from "../../../src/connections/cloud/aws.js";
import { cloudTesters } from "../../../src/connections/testers.js";

const TENANT = "00000000-0000-0000-0000-00000000aaaa";
const CLIENT = "00000000-0000-0000-0000-00000000bbbb";
const SUB = "00000000-0000-0000-0000-00000000cccc";
const SECRET = "TESTKEY-azure-secret-0000000000";
const signal = new AbortController().signal;
const NOW = new Date("2026-11-15T12:00:00.000Z");

type Call = { url: string; init: RequestInit };
function routedFetch(routes: { token?: Response | Error; sub?: Response | Error }) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = url.startsWith("https://login.microsoftonline.com/") ? routes.token : routes.sub;
    if (!r) throw new Error(`unexpected request ${url}`);
    if (r instanceof Error) throw r;
    return r.clone();
  });
  return { f: f as unknown as typeof fetch, calls };
}
const tokenOk = () => new Response(JSON.stringify({ access_token: "TESTKEY-access-token-0000000000", expires_in: 3600, token_type: "Bearer" }), { status: 200 });

describe("fetchAzureToken", () => {
  it("POSTs a client_credentials grant to the tenant's token URL", async () => {
    const { f, calls } = routedFetch({ token: tokenOk() });
    const t = await fetchAzureToken({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET }, { fetch: f, signal, now: () => NOW });
    expect(t).toEqual({ accessToken: "TESTKEY-access-token-0000000000", expiresAt: "2026-11-15T13:00:00.000Z" });
    const [call] = calls;
    expect(call!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(call!.init.method).toBe("POST");
    expect(call!.init.signal).toBe(signal);
    expect(new Headers(call!.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(call!.init.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "client_credentials", client_id: CLIENT, client_secret: SECRET, scope: AZURE_SCOPE });
  });
});

describe("azure tester", () => {
  const config = { tenantId: TENANT, clientId: CLIENT, subscriptionId: SUB };
  const run = (f: typeof fetch, secrets: Record<string, string> = { clientSecret: SECRET }) =>
    cloudTesters(fakeSts).azure!({ config, private: {}, secrets }, { fetch: f, signal });

  it("gets a token, then reads the subscription with the Bearer token", async () => {
    const { f, calls } = routedFetch({ token: tokenOk(), sub: new Response("{}", { status: 200 }) });
    expect(await run(f)).toEqual({ ok: true, message: "Connected" });
    expect(calls[1]!.url).toBe(`https://management.azure.com/subscriptions/${SUB}?api-version=2022-12-01`);
    expect(calls[1]!.init.method).toBe("GET");
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer TESTKEY-access-token-0000000000");
  });

  it("reports a 401 at the token step as a rejection, without the subscription GET", async () => {
    const { f, calls } = routedFetch({ token: new Response("{}", { status: 401 }) });
    expect(await run(f)).toEqual({ ok: false, message: "Rejected by the provider (HTTP 401)" });
    expect(calls).toHaveLength(1);
  });

  it.each([403, 404])("reports a %i from the subscription GET as an unseen subscription", async (status) => {
    const { f } = routedFetch({ token: tokenOk(), sub: new Response("{}", { status }) });
    expect(await run(f)).toEqual({ ok: false, message: `The service principal cannot see subscription ${SUB} (HTTP ${status})` });
  });

  it("reports other failures as 5A does", async () => {
    expect(await run(routedFetch({ token: tokenOk(), sub: new Response("{}", { status: 500 }) }).f)).toEqual({ ok: false, message: "Unexpected response (HTTP 500)" });
    expect(await run(routedFetch({ token: new TypeError("fetch failed") }).f)).toEqual({ ok: false, message: "Could not reach the provider" });
  });

  it("reports a missing secret", async () => {
    expect(await run(routedFetch({}).f, {})).toEqual({ ok: false, message: "No credentials stored" });
  });
});
