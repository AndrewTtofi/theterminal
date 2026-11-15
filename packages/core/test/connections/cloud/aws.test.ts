import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { STSClient, type STSClientConfig } from "@aws-sdk/client-sts";
import { AwsRejectedError, createRealSts, fakeSts, type StaticKeys } from "../../../src/connections/cloud/aws.js";
import { cloudTesters } from "../../../src/connections/testers.js";

const KEYS: StaticKeys = { accessKeyId: "AKIATESTKEY000000000", secretAccessKey: "TESTKEY-secret-access-key-0000000000", region: "eu-west-1" };
const signal = new AbortController().signal;

const ENV_KEYS = ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_STS", "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Junk settings that the default credential chain would pick up (or fail on) if it ever ran. */
function poisonEnv() {
  process.env.AWS_PROFILE = "tt-profile-that-does-not-exist";
  process.env.AWS_ACCESS_KEY_ID = "AKIAJUNKJUNKJUNKJUNK";
  process.env.AWS_SECRET_ACCESS_KEY = "junk-secret-from-env";
  process.env.AWS_SESSION_TOKEN = "junk-session-from-env";
  process.env.AWS_REGION = "ap-southeast-2";
  process.env.AWS_CONFIG_FILE = "/nonexistent/tt-aws-config";
  process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/tt-aws-credentials";
}

const XML = (op: string, result: string) =>
  `<${op}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${op}Result>${result}</${op}Result>` +
  `<ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></${op}Response>`;

type Captured = { url: string; headers: Record<string, string>; body: string };

/** A real STSClient whose HTTP layer is replaced: nothing leaves the process. */
function recordingClient(status: number, body: string, seen: { configs: STSClientConfig[]; requests: Captured[] }) {
  return class extends STSClient {
    constructor(config: STSClientConfig) {
      seen.configs.push(config);
      super({
        ...config,
        maxAttempts: 1,
        requestHandler: {
          handle: async (req: { protocol: string; hostname: string; path: string; headers: Record<string, string>; body?: unknown }) => {
            seen.requests.push({ url: `${req.protocol}//${req.hostname}${req.path}`, headers: req.headers, body: String(req.body ?? "") });
            return { response: { statusCode: status, headers: { "content-type": "text/xml" }, body: Readable.from([Buffer.from(body)]) } };
          },
        },
      });
    }
  };
}

describe("realSts", () => {
  it.each([
    ["AWS_ENDPOINT_URL_STS", { AWS_ENDPOINT_URL_STS: "https://env-sts.example.invalid", AWS_ENDPOINT_URL: "https://env-endpoint.example.invalid" }],
    ["AWS_ENDPOINT_URL", { AWS_ENDPOINT_URL: "https://env-endpoint.example.invalid" }],
    ["the profile's endpoint_url", {}],
  ])("pins the regional STS endpoint, ignoring %s", async (_name, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "tt-aws-"));
    try {
      const config = join(dir, "config");
      writeFileSync(config, "[profile tt-endpoint]\nregion = ap-southeast-2\nendpoint_url = https://profile-endpoint.example.invalid\n");
      process.env.AWS_CONFIG_FILE = config;
      process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "credentials");
      process.env.AWS_PROFILE = "tt-endpoint";
      delete process.env.AWS_ENDPOINT_URL;
      delete process.env.AWS_ENDPOINT_URL_STS;
      Object.assign(process.env, env);
      const seen = { configs: [] as STSClientConfig[], requests: [] as Captured[] };
      const sts = createRealSts(recordingClient(200, XML("GetCallerIdentity", "<Arn>arn:aws:iam::000000000000:user/test</Arn>"), seen));
      await sts.callerIdentity(KEYS, signal);
      expect(seen.requests[0]!.url.startsWith("https://sts.eu-west-1.amazonaws.com/")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a region that is not a region before building a client", async () => {
    const seen = { configs: [] as STSClientConfig[], requests: [] as Captured[] };
    const sts = createRealSts(recordingClient(200, "", seen));
    await expect(sts.callerIdentity({ ...KEYS, region: "evil.example.invalid/x" }, signal)).rejects.toThrow("not an AWS region");
    expect(seen.configs).toHaveLength(0);
  });

  it("builds the client with the given region and explicit credentials, and signs with them, never the environment", async () => {
    poisonEnv();
    const seen = { configs: [] as STSClientConfig[], requests: [] as Captured[] };
    const sts = createRealSts(recordingClient(200, XML("GetCallerIdentity", "<Arn>arn:aws:iam::000000000000:user/test</Arn><UserId>AIDATEST</UserId><Account>000000000000</Account>"), seen));
    expect(await sts.callerIdentity(KEYS, signal)).toEqual({ arn: "arn:aws:iam::000000000000:user/test" });
    expect(seen.configs).toHaveLength(1);
    expect(seen.configs[0]!.region).toBe("eu-west-1");
    expect(seen.configs[0]!.credentials).toMatchObject({ accessKeyId: KEYS.accessKeyId, secretAccessKey: KEYS.secretAccessKey });
    // The default credential chain (which reads ~/.aws and the environment) is replaced by one that refuses.
    await expect(seen.configs[0]!.credentialDefaultProvider!({})()).rejects.toThrow("disabled");
    const [req] = seen.requests;
    expect(req!.url).toContain("sts.eu-west-1.amazonaws.com");
    expect(req!.body).toContain("Action=GetCallerIdentity");
    const authz = Object.entries(req!.headers).find(([k]) => k.toLowerCase() === "authorization")![1];
    expect(authz).toContain(`Credential=${KEYS.accessKeyId}/`);
    expect(authz).toContain("/eu-west-1/sts/");
    expect(JSON.stringify(req!.headers)).not.toContain("junk");
    expect(JSON.stringify(req!.headers)).not.toContain("AKIAJUNK");
  });

  it("asks GetSessionToken for the duration and returns the temporary keys", async () => {
    poisonEnv();
    const seen = { configs: [] as STSClientConfig[], requests: [] as Captured[] };
    const creds =
      "<Credentials><AccessKeyId>ASIATESTKEY000000000</AccessKeyId><SecretAccessKey>TESTKEY-temp-secret-0000000000</SecretAccessKey>" +
      "<SessionToken>FQoGZXIvYXdzTESTKEY-session-0000000000</SessionToken><Expiration>2026-11-16T00:00:00Z</Expiration></Credentials>";
    const sts = createRealSts(recordingClient(200, XML("GetSessionToken", creds), seen));
    expect(await sts.sessionToken(KEYS, 43200, signal)).toEqual({
      accessKeyId: "ASIATESTKEY000000000", secretAccessKey: "TESTKEY-temp-secret-0000000000",
      sessionToken: "FQoGZXIvYXdzTESTKEY-session-0000000000", expiration: "2026-11-16T00:00:00.000Z",
    });
    expect(seen.requests[0]!.body).toContain("DurationSeconds=43200");
    expect(seen.configs[0]!.credentials).toMatchObject({ accessKeyId: KEYS.accessKeyId, secretAccessKey: KEYS.secretAccessKey });
  });

  it("turns a rejection of the keys into AwsRejectedError named after the SDK error", async () => {
    const seen = { configs: [] as STSClientConfig[], requests: [] as Captured[] };
    const body = '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code>' +
      "<Message>The security token included in the request is invalid.</Message></Error><RequestId>0</RequestId></ErrorResponse>";
    const sts = createRealSts(recordingClient(403, body, seen));
    const err = await sts.callerIdentity(KEYS, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsRejectedError);
    expect((err as Error).name).toBe("InvalidClientTokenId");
  });

  it("leaves AccessDenied as the SDK error, not a rejection of the keys", async () => {
    const seen = { configs: [] as STSClientConfig[], requests: [] as Captured[] };
    const body = '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>AccessDenied</Code>' +
      "<Message>Cannot call GetSessionToken with session credentials</Message></Error><RequestId>0</RequestId></ErrorResponse>";
    const sts = createRealSts(recordingClient(403, body, seen));
    const err = await sts.sessionToken(KEYS, 43200, signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AwsRejectedError);
    expect((err as Error).name).toBe("AccessDenied");
  });
});

describe("fakeSts", () => {
  it("accepts TESTKEY keys and rejects others with InvalidClientTokenId", async () => {
    expect((await fakeSts.callerIdentity(KEYS, signal)).arn).toMatch(/^arn:aws:/);
    const err = await fakeSts.callerIdentity({ ...KEYS, accessKeyId: "AKIAOTHER00000000000" }, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsRejectedError);
    expect((err as Error).name).toBe("InvalidClientTokenId");
  });

  it("returns the fixed session token expiring after the duration", async () => {
    const before = Date.now();
    const t = await fakeSts.sessionToken(KEYS, 900, signal);
    expect(t.sessionToken).toBe("FQoGZXIvYXdzTESTKEY-session-0000000000");
    const exp = Date.parse(t.expiration);
    expect(exp).toBeGreaterThanOrEqual(before + 900_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 900_000);
    await expect(fakeSts.sessionToken({ ...KEYS, accessKeyId: "AKIAOTHER00000000000" }, 900, signal)).rejects.toBeInstanceOf(AwsRejectedError);
  });
});

describe("aws tester", () => {
  const run = (sts: Parameters<typeof cloudTesters>[0], secrets: Record<string, string>) =>
    cloudTesters(sts).aws!({ config: { region: KEYS.region }, private: {}, secrets }, { fetch: globalThis.fetch, signal });
  const secrets = { accessKeyId: KEYS.accessKeyId, secretAccessKey: KEYS.secretAccessKey };

  it("reports the identity as verified without recording the ARN", async () => {
    expect(await run(fakeSts, secrets)).toEqual({ ok: true, message: "Connected (identity verified)" });
  });

  it("maps a rejected key to the SDK error name", async () => {
    expect(await run(fakeSts, { ...secrets, accessKeyId: "AKIAOTHER00000000000" })).toEqual({
      ok: false, message: "Rejected by the provider (InvalidClientTokenId)",
    });
  });

  it("reports AccessDenied on GetCallerIdentity as a rejection", async () => {
    const denied = { ...fakeSts, callerIdentity: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); } };
    expect(await run(denied, secrets)).toEqual({ ok: false, message: "Rejected by the provider (AccessDenied)" });
  });

  it("reports any other failure as unreachable", async () => {
    const down = { ...fakeSts, callerIdentity: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "Error" }); } };
    expect(await run(down, secrets)).toEqual({ ok: false, message: "Could not reach the provider" });
  });

  it("reports missing keys", async () => {
    expect(await run(fakeSts, { accessKeyId: KEYS.accessKeyId })).toEqual({ ok: false, message: "No credentials stored" });
  });
});
