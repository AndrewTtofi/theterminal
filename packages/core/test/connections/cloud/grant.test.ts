import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeSts, type StsCaller } from "../../../src/connections/cloud/aws.js";
import {
  AWS_SESSION_SECONDS, CLOUD_ENV_ALLOWLIST, CloudCredentialError, GRANT_TIMEOUT_MS, mintCloudGrant, type CloudGrant,
} from "../../../src/connections/cloud/grant.js";
import { CLOUD_ENV_ALLOWLIST as FROM_ENV_MODULE } from "../../../src/connections/cloud/env.js";
import type { CloudSource } from "../../../src/connections/service.js";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SA = {
  type: "service_account", project_id: "tt-test-project", private_key_id: "0000000000000000000000000000000000testkey",
  private_key: PEM, client_email: "tester@tt-test-project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token",
};
const AWS: CloudSource = {
  connectionId: "c-aws", name: "Prod AWS", provider: "aws", config: { region: "eu-west-1" },
  secrets: { accessKeyId: "AKIATESTKEY000000000", secretAccessKey: "TESTKEY-secret-access-key-0000000000" },
};
const GCP: CloudSource = {
  connectionId: "c-gcp", name: "Data GCP", provider: "gcp", config: { project: "tt-test-project" },
  secrets: { serviceAccountJson: JSON.stringify(SA) },
};
const AZURE: CloudSource = {
  connectionId: "c-az", name: "Ops Azure", provider: "azure",
  config: { tenantId: "00000000-0000-0000-0000-00000000aaaa", clientId: "00000000-0000-0000-0000-00000000bbbb", subscriptionId: "00000000-0000-0000-0000-00000000cccc" },
  secrets: { clientSecret: "TESTKEY-azure-secret-0000000000" },
};
const NOW = new Date("2026-11-15T12:00:00.000Z");
const signal = () => new AbortController().signal;
const tokenFetch = () =>
  vi.fn(async () => new Response(JSON.stringify({ access_token: "TESTKEY-access-token-0000000000", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
const noFetch = () => vi.fn(async () => { throw new Error("no request expected"); });
const deps = (o: { sts?: StsCaller; fetch?: ReturnType<typeof vi.fn>; signal?: AbortSignal } = {}) => ({
  sts: o.sts ?? fakeSts, fetch: (o.fetch ?? noFetch()) as unknown as typeof fetch, signal: o.signal ?? signal(), now: () => NOW,
});
const sdkError = (name: string, status?: number) =>
  Object.assign(new Error(name), { name, ...(status !== undefined && { $metadata: { httpStatusCode: status } }) });
const stsThrowing = (err: Error): StsCaller => ({ ...fakeSts, sessionToken: vi.fn(async () => { throw err; }) });

describe("CLOUD_ENV_ALLOWLIST", () => {
  it("lives in a module without imports, re-exported by grant.ts", () => {
    expect(CLOUD_ENV_ALLOWLIST).toBe(FROM_ENV_MODULE);
    const source = readFileSync(new URL("../../../src/connections/cloud/env.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});

describe("mintCloudGrant: AWS", () => {
  it("mints a 12-hour session token and lists the temporary and static values as secrets", async () => {
    const sts: StsCaller = { ...fakeSts, sessionToken: vi.fn(fakeSts.sessionToken) };
    const g = await mintCloudGrant(AWS, deps({ sts }));
    expect(sts.sessionToken).toHaveBeenCalledWith(
      { accessKeyId: AWS.secrets.accessKeyId, secretAccessKey: AWS.secrets.secretAccessKey, region: "eu-west-1" }, AWS_SESSION_SECONDS, expect.any(AbortSignal),
    );
    expect(AWS_SESSION_SECONDS).toBe(43200);
    expect(g.credential).toBe("aws_session_token");
    expect(Object.keys(g.env).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
    expect(g.env.AWS_SESSION_TOKEN).toBe("FQoGZXIvYXdzTESTKEY-session-0000000000");
    expect(g.env.AWS_ACCESS_KEY_ID).not.toBe(AWS.secrets.accessKeyId);
    expect(g.env.AWS_REGION).toBe("eu-west-1");
    expect(g.env.AWS_DEFAULT_REGION).toBe("eu-west-1");
    expect(g.expiresAt).not.toBeNull();
    expect(g.secrets).toHaveLength(5);
    expect(g.secrets).toEqual(expect.arrayContaining([
      g.env.AWS_ACCESS_KEY_ID, g.env.AWS_SECRET_ACCESS_KEY, g.env.AWS_SESSION_TOKEN, AWS.secrets.accessKeyId, AWS.secrets.secretAccessKey,
    ]));
  });

  it.each([
    ["AccessDenied", sdkError("AccessDenied", 403)],
    ["another 4xx that is not about the keys", sdkError("ValidationError", 400)],
  ])("falls back to the static keys on %s from GetSessionToken", async (_name, err) => {
    const g = await mintCloudGrant(AWS, deps({ sts: stsThrowing(err) }));
    expect(g.credential).toBe("aws_static_keys");
    expect(g.expiresAt).toBeNull();
    expect(g.env).toEqual({
      AWS_ACCESS_KEY_ID: AWS.secrets.accessKeyId, AWS_SECRET_ACCESS_KEY: AWS.secrets.secretAccessKey,
      AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1",
    });
    expect(g.secrets.sort()).toEqual([AWS.secrets.accessKeyId, AWS.secrets.secretAccessKey].sort());
  });

  it("refuses bad keys with a CloudCredentialError naming the connection, without the key", async () => {
    const err = await mintCloudGrant({ ...AWS, secrets: { ...AWS.secrets, accessKeyId: "AKIAOTHER00000000000" } }, deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudCredentialError);
    expect((err as CloudCredentialError).connectionName).toBe("Prod AWS");
    expect((err as Error).message).toContain("Prod AWS");
    expect((err as Error).message).toContain("InvalidClientTokenId");
    expect((err as Error).message).not.toContain("AKIAOTHER");
  });

  it.each([
    ["a key rejection thrown as a raw SDK error", sdkError("SignatureDoesNotMatch", 403)],
    ["a network error", sdkError("Error")],
    ["a timeout", sdkError("TimeoutError")],
    ["a 5xx", sdkError("InternalFailure", 500)],
    ["Throttling (a 400)", sdkError("Throttling", 400)],
    ["ThrottlingException (a 400)", sdkError("ThrottlingException", 400)],
  ])("turns %s into a CloudCredentialError", async (_name, err) => {
    await expect(mintCloudGrant(AWS, deps({ sts: stsThrowing(err) }))).rejects.toBeInstanceOf(CloudCredentialError);
  });

  it("refuses missing keys", async () => {
    await expect(mintCloudGrant({ ...AWS, secrets: {} }, deps())).rejects.toBeInstanceOf(CloudCredentialError);
  });
});

describe("mintCloudGrant: Google Cloud", () => {
  it("mints a full-scope access token and lists it, the private key and its id as secrets", async () => {
    const f = tokenFetch();
    const g = await mintCloudGrant(GCP, deps({ fetch: f }));
    expect(f).toHaveBeenCalledOnce();
    expect(g.credential).toBe("gcp_access_token");
    expect(g.env).toEqual({
      CLOUDSDK_AUTH_ACCESS_TOKEN: "TESTKEY-access-token-0000000000", GOOGLE_OAUTH_ACCESS_TOKEN: "TESTKEY-access-token-0000000000",
      CLOUDSDK_CORE_PROJECT: "tt-test-project", GOOGLE_CLOUD_PROJECT: "tt-test-project",
    });
    expect(g.expiresAt).toBe("2026-11-15T13:00:00.000Z");
    expect(g.secrets).toEqual(expect.arrayContaining(["TESTKEY-access-token-0000000000", PEM, SA.private_key_id, JSON.stringify(PEM).slice(1, -1)]));
    const bodyLines = PEM.split("\n").filter((l) => l.length >= 40 && !l.startsWith("-----"));
    expect(bodyLines.length).toBeGreaterThan(10);
    expect(g.secrets).toEqual(expect.arrayContaining(bodyLines));
    expect(g.env).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("refuses a key that is not a service account JSON, and a rejected token request", async () => {
    await expect(mintCloudGrant({ ...GCP, secrets: { serviceAccountJson: "{}" } }, deps())).rejects.toBeInstanceOf(CloudCredentialError);
    const denied = vi.fn(async () => new Response("{}", { status: 401 }));
    const err = await mintCloudGrant(GCP, deps({ fetch: denied })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudCredentialError);
    expect((err as Error).message).toContain("Data GCP");
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(mintCloudGrant(GCP, deps({ fetch: down }))).rejects.toBeInstanceOf(CloudCredentialError);
  });
});

describe("mintCloudGrant: Azure", () => {
  it("hands over the client secret with the ARM copies, with no exchange", async () => {
    const f = noFetch();
    const g = await mintCloudGrant(AZURE, deps({ fetch: f }));
    expect(f).not.toHaveBeenCalled();
    expect(g).toEqual({
      env: {
        AZURE_TENANT_ID: AZURE.config.tenantId, AZURE_CLIENT_ID: AZURE.config.clientId,
        AZURE_CLIENT_SECRET: AZURE.secrets.clientSecret, AZURE_SUBSCRIPTION_ID: AZURE.config.subscriptionId,
        ARM_TENANT_ID: AZURE.config.tenantId, ARM_CLIENT_ID: AZURE.config.clientId,
        ARM_CLIENT_SECRET: AZURE.secrets.clientSecret, ARM_SUBSCRIPTION_ID: AZURE.config.subscriptionId,
      },
      credential: "azure_client_secret", expiresAt: null, secrets: [AZURE.secrets.clientSecret],
    } satisfies CloudGrant);
  });
});

describe("mintCloudGrant: every provider", () => {
  it("only ever sets allowlisted variables", async () => {
    const grants = [
      await mintCloudGrant(AWS, deps()),
      await mintCloudGrant(AWS, deps({ sts: stsThrowing(sdkError("AccessDenied", 403)) })),
      await mintCloudGrant(GCP, deps({ fetch: tokenFetch() })),
      await mintCloudGrant(AZURE, deps()),
    ];
    for (const g of grants) {
      for (const k of Object.keys(g.env)) expect(CLOUD_ENV_ALLOWLIST).toContain(k);
    }
  });

  it("applies a 10 s timeout when the caller passes no signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const sts: StsCaller = { ...fakeSts, sessionToken: vi.fn(fakeSts.sessionToken) };
      await mintCloudGrant(AWS, { sts, fetch: noFetch() as unknown as typeof fetch });
      expect(timeout).toHaveBeenCalledWith(GRANT_TIMEOUT_MS);
      expect(GRANT_TIMEOUT_MS).toBe(10_000);
      expect(vi.mocked(sts.sessionToken).mock.calls[0]![2]).toBe(timeout.mock.results[0]!.value);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([AWS, GCP, AZURE])("refuses an already aborted signal without a request ($provider)", async (source) => {
    const ac = new AbortController();
    ac.abort();
    const sts: StsCaller = { callerIdentity: vi.fn(fakeSts.callerIdentity), sessionToken: vi.fn(fakeSts.sessionToken) };
    const f = noFetch();
    const err = await mintCloudGrant(source, deps({ sts, fetch: f, signal: ac.signal })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudCredentialError);
    expect(sts.sessionToken).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});
