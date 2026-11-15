import { GetCallerIdentityCommand, GetSessionTokenCommand, STSClient, type STSClientConfig } from "@aws-sdk/client-sts";

export type StaticKeys = { accessKeyId: string; secretAccessKey: string; region: string };
export type SessionCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string };
export type StsCaller = {
  callerIdentity(keys: StaticKeys, signal: AbortSignal): Promise<{ arn: string }>;
  sessionToken(keys: StaticKeys, durationS: number, signal: AbortSignal): Promise<SessionCredentials>;
};

/** SDK error names that mean the keys themselves were refused (not that the principal lacks a permission). */
const KEY_REJECTIONS = new Set(["InvalidClientTokenId", "SignatureDoesNotMatch", "UnrecognizedClientException", "ExpiredToken"]);

/** AWS refused the access keys. `name` is the SDK error name, for example InvalidClientTokenId. */
export class AwsRejectedError extends Error {
  constructor(code: string) {
    super(`AWS rejected the access keys (${code})`);
    this.name = code;
  }
}

/** The key-rejection name of `err`, or null when it is something else (a denied action, a network failure). */
export function keyRejection(err: unknown): string | null {
  if (err instanceof AwsRejectedError) return err.name;
  const name = err instanceof Error ? err.name : undefined;
  return name !== undefined && KEY_REJECTIONS.has(name) ? name : null;
}

/** The catalog's region shape; the region becomes part of the pinned endpoint's host name. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

type StsClientLike = Pick<STSClient, "send" | "destroy">;
export type StsClientConstructor = new (config: STSClientConfig) => StsClientLike;

/**
 * An STS caller over the AWS SDK. Every client gets the stored keys and region explicitly, and the default credential
 * provider is replaced by one that refuses, so the SDK never takes credentials from `~/.aws` or the environment.
 * The endpoint is pinned to the region's STS host. (The SDK may still read other settings, such as retry mode.)
 */
export function createRealSts(Client: StsClientConstructor = STSClient): StsCaller {
  async function call<T>(keys: StaticKeys, run: (client: StsClientLike) => Promise<T>): Promise<T> {
    if (!REGION.test(keys.region)) throw new Error("not an AWS region");
    const client = new Client({
      region: keys.region,
      // Pinned: an endpoint URL from AWS_ENDPOINT_URL(_STS) or the AWS config file must never receive the keys.
      endpoint: `https://sts.${keys.region}.amazonaws.com`,
      credentials: { accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey },
      credentialDefaultProvider: () => async () => {
        throw new Error("the default AWS credential chain is disabled");
      },
    });
    try {
      return await run(client);
    } catch (err) {
      const rejected = keyRejection(err);
      throw rejected ? new AwsRejectedError(rejected) : err;
    } finally {
      client.destroy();
    }
  }
  return {
    callerIdentity: (keys, signal) =>
      call(keys, async (client) => {
        const out = await client.send(new GetCallerIdentityCommand({}), { abortSignal: signal });
        if (!out.Arn) throw new Error("STS returned no identity");
        return { arn: out.Arn };
      }),
    sessionToken: (keys, durationS, signal) =>
      call(keys, async (client) => {
        const out = await client.send(new GetSessionTokenCommand({ DurationSeconds: durationS }), { abortSignal: signal });
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error("STS returned no credentials");
        return {
          accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken,
          expiration: new Date(c.Expiration).toISOString(),
        };
      }),
  };
}

export const realSts: StsCaller = createRealSts();

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Tests only: accepts keys whose access key id contains TESTKEY. Never performs network I/O. */
export const fakeSts: StsCaller = {
  async callerIdentity(keys, signal) {
    abortIfNeeded(signal);
    if (!keys.accessKeyId.includes("TESTKEY")) throw new AwsRejectedError("InvalidClientTokenId");
    return { arn: "arn:aws:iam::000000000000:user/fake" };
  },
  async sessionToken(keys, durationS, signal) {
    abortIfNeeded(signal);
    if (!keys.accessKeyId.includes("TESTKEY")) throw new AwsRejectedError("InvalidClientTokenId");
    return {
      accessKeyId: "ASIATESTKEY000000000",
      secretAccessKey: "TESTKEY-session-secret-0000000000",
      sessionToken: "FQoGZXIvYXdzTESTKEY-session-0000000000",
      expiration: new Date(Date.now() + durationS * 1000).toISOString(),
    };
  },
};
