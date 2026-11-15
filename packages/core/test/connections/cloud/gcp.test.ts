import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GCP_SCOPE_FULL, GCP_SCOPE_READ, fetchGcpToken, serviceAccountSchema, signJwt, type ServiceAccount,
} from "../../../src/connections/cloud/gcp.js";
import { cloudTesters } from "../../../src/connections/testers.js";
import { fakeSts } from "../../../src/connections/cloud/aws.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA: ServiceAccount = serviceAccountSchema.parse({
  type: "service_account",
  project_id: "tt-test-project",
  private_key_id: "0000000000000000000000000000000000testkey",
  private_key: PEM,
  client_email: "tester@tt-test-project.iam.gserviceaccount.com",
  client_id: "000000000000000000000",
  token_uri: "https://oauth2.googleapis.com/token",
});
const SA_JSON = JSON.stringify(SA);
const signal = new AbortController().signal;
const NOW = new Date("2026-11-15T12:00:00.000Z");

const b64json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

type Call = { url: string; init: RequestInit };
function routedFetch(routes: { token?: Response | Error; project?: Response | Error }) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = url.startsWith("https://oauth2.googleapis.com/") ? routes.token : routes.project;
    if (!r) throw new Error(`unexpected request ${url}`);
    if (r instanceof Error) throw r;
    return r.clone();
  });
  return { f: f as unknown as typeof fetch, calls };
}
const tokenOk = () => new Response(JSON.stringify({ access_token: "TESTKEY-access-token-0000000000", expires_in: 3599, token_type: "Bearer" }), { status: 200 });

describe("serviceAccountSchema", () => {
  it("accepts a service account key and keeps unknown fields", () => {
    expect(serviceAccountSchema.parse(JSON.parse(SA_JSON))).toMatchObject({ client_id: "000000000000000000000" });
  });

  it.each([
    ["a missing private_key", { private_key: undefined }],
    ["a non-PEM private_key", { private_key: "not a key" }],
    ["another type", { type: "authorized_user" }],
    ["a client_email outside the service account domain", { client_email: "someone@example.com" }],
    ["another token_uri", { token_uri: "https://example.invalid/token" }],
  ])("refuses %s", (_name, patch) => {
    expect(serviceAccountSchema.safeParse({ ...JSON.parse(SA_JSON), ...patch }).success).toBe(false);
  });
});

describe("signJwt", () => {
  it("signs an RS256 JWT that verifies with the public key and carries the exact claims", () => {
    const jwt = signJwt(SA, GCP_SCOPE_READ, NOW);
    const [h, c, s] = jwt.split(".");
    expect(b64json(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(b64json(c!)).toEqual({ iss: SA.client_email, scope: GCP_SCOPE_READ, aud: SA.token_uri, iat, exp: iat + 3600 });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${h}.${c}`);
    expect(verify.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("fetchGcpToken", () => {
  it("POSTs a form-encoded jwt-bearer grant to the token URI and computes the expiry", async () => {
    const { f, calls } = routedFetch({ token: tokenOk() });
    const t = await fetchGcpToken(SA, GCP_SCOPE_FULL, { fetch: f, signal, now: () => NOW });
    expect(t).toEqual({ accessToken: "TESTKEY-access-token-0000000000", expiresAt: "2026-11-15T12:59:59.000Z" });
    const [call] = calls;
    expect(call!.url).toBe("https://oauth2.googleapis.com/token");
    expect(call!.init.method).toBe("POST");
    expect(call!.init.signal).toBe(signal);
    expect(new Headers(call!.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(call!.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion")!;
    expect(b64json(assertion.split(".")[1]!)).toMatchObject({ scope: GCP_SCOPE_FULL, iss: SA.client_email });
  });
});

describe("gcp tester", () => {
  const run = (f: typeof fetch, secrets: Record<string, string> = { serviceAccountJson: SA_JSON }) =>
    cloudTesters(fakeSts).gcp!({ config: { project: "tt-test-project" }, private: {}, secrets }, { fetch: f, signal });

  it("gets a read-only token, then reads the project with the Bearer token", async () => {
    const { f, calls } = routedFetch({ token: tokenOk(), project: new Response("{}", { status: 200 }) });
    expect(await run(f)).toEqual({ ok: true, message: "Connected" });
    expect(calls).toHaveLength(2);
    const jwt = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
    expect(b64json(jwt.split(".")[1]!).scope).toBe(GCP_SCOPE_READ);
    expect(calls[1]!.url).toBe("https://cloudresourcemanager.googleapis.com/v1/projects/tt-test-project");
    expect(calls[1]!.init.method).toBe("GET");
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer TESTKEY-access-token-0000000000");
  });

  it("refuses a JSON without private_key with the exact message and no request", async () => {
    const { f, calls } = routedFetch({});
    const { private_key: _drop, ...rest } = SA;
    expect(await run(f, { serviceAccountJson: JSON.stringify(rest) })).toEqual({ ok: false, message: "The key is not a service account JSON" });
    expect(await run(f, { serviceAccountJson: "{not json" })).toEqual({ ok: false, message: "The key is not a service account JSON" });
    expect(calls).toHaveLength(0);
  });

  it("reports missing credentials", async () => {
    expect(await run(routedFetch({}).f, {})).toEqual({ ok: false, message: "No credentials stored" });
  });

  it.each([400, 401])("reports a %i from the token endpoint as a rejection", async (status) => {
    const { f } = routedFetch({ token: new Response("{}", { status }) });
    expect(await run(f)).toEqual({ ok: false, message: `Rejected by the provider (HTTP ${status})` });
  });

  it.each([403, 404])("reports a %i from the project GET as an unseen project", async (status) => {
    const { f } = routedFetch({ token: tokenOk(), project: new Response("{}", { status }) });
    expect(await run(f)).toEqual({ ok: false, message: `The service account cannot see project tt-test-project (HTTP ${status})` });
  });

  it("reports a 500 from the project GET as unexpected", async () => {
    const { f } = routedFetch({ token: tokenOk(), project: new Response("{}", { status: 500 }) });
    expect(await run(f)).toEqual({ ok: false, message: "Unexpected response (HTTP 500)" });
  });

  it("reports a 500 from the token endpoint as unexpected and a network error as unreachable", async () => {
    expect(await run(routedFetch({ token: new Response("{}", { status: 500 }) }).f)).toEqual({ ok: false, message: "Unexpected response (HTTP 500)" });
    expect(await run(routedFetch({ token: new TypeError("fetch failed") }).f)).toEqual({ ok: false, message: "Could not reach the provider" });
    expect(await run(routedFetch({ token: tokenOk(), project: new TypeError("fetch failed") }).f)).toEqual({ ok: false, message: "Could not reach the provider" });
  });
});
