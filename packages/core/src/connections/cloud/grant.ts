import type { CloudSource } from "../service.js";
import { keyRejection, type StaticKeys, type StsCaller } from "./aws.js";
import { GCP_SCOPE_FULL, fetchGcpToken, parseServiceAccount, privateKeySecrets } from "./gcp.js";
import { TokenEndpointError } from "./token.js";

export { CLOUD_ENV_ALLOWLIST } from "./env.js";

export type CredentialKind = "aws_session_token" | "aws_static_keys" | "gcp_access_token" | "azure_client_secret";

/**
 * What a run is given for one cloud connection: the variables to add to its environment, which kind of credential
 * they hold, when that expires (null: it does not), and every secret value in them, for redaction.
 */
export type CloudGrant = { env: Record<string, string>; credential: CredentialKind; expiresAt: string | null; secrets: string[] };

/** Credentials for a cloud connection could not be minted. The message names the connection and holds no secret. */
export class CloudCredentialError extends Error {
  constructor(
    public readonly connectionName: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudCredentialError";
  }
}

/** How long a minted AWS session token lasts: 12 hours. */
export const AWS_SESSION_SECONDS = 43200;

/** How long minting may take when the caller gives no signal of its own. */
export const GRANT_TIMEOUT_MS = 10_000;

/** `signal` is optional: without one, minting is cut off after GRANT_TIMEOUT_MS. */
export type GrantDeps = { sts: StsCaller; fetch: typeof fetch; signal?: AbortSignal; now?: () => Date };
type ResolvedDeps = GrantDeps & { signal: AbortSignal };

/** STS refusals that mean "try again later", not "this principal may not": never a reason to hand over static keys. */
const THROTTLED = new Set(["Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException"]);

/** STS refusals of a malformed request: a fault on our side, not a permission, so never a reason to hand over static keys. */
const MALFORMED = new Set(["ValidationError", "InvalidParameterValue"]);

const fail = (source: CloudSource, reason: string) =>
  new CloudCredentialError(source.name, `Could not get credentials for the connection "${source.name}": ${reason}`);

/** A 4xx from STS: the request was refused, but not necessarily because of the keys. */
function isClientError(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

async function mintAws(source: CloudSource, deps: ResolvedDeps): Promise<CloudGrant> {
  const { accessKeyId, secretAccessKey } = source.secrets;
  const region = source.config.region;
  if (!accessKeyId || !secretAccessKey || !region) throw fail(source, "the access key or region is missing");
  const keys: StaticKeys = { accessKeyId, secretAccessKey, region };
  const regionEnv = { AWS_REGION: region, AWS_DEFAULT_REGION: region };
  try {
    const t = await deps.sts.sessionToken(keys, AWS_SESSION_SECONDS, deps.signal);
    return {
      env: { AWS_ACCESS_KEY_ID: t.accessKeyId, AWS_SECRET_ACCESS_KEY: t.secretAccessKey, AWS_SESSION_TOKEN: t.sessionToken, ...regionEnv },
      credential: "aws_session_token",
      expiresAt: t.expiration,
      // The static keys are listed too: a tool might still print them (from its own config, say).
      secrets: [t.accessKeyId, t.secretAccessKey, t.sessionToken, accessKeyId, secretAccessKey],
    };
  } catch (err) {
    const rejected = keyRejection(err);
    if (rejected) throw fail(source, `AWS rejected the access keys (${rejected})`);
    // Some principals may not call GetSessionToken (AccessDenied, or another permission-shaped refusal that is not
    // about the keys). The run then gets the static keys, and the grant says so (aws_static_keys) for the ledger.
    // Throttling and malformed-request errors fail the run start instead.
    const name = (err as Error | null)?.name ?? "";
    if (!deps.signal.aborted && !THROTTLED.has(name) && !MALFORMED.has(name) && (name === "AccessDenied" || isClientError(err))) {
      return {
        env: { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, ...regionEnv },
        credential: "aws_static_keys",
        expiresAt: null,
        secrets: [accessKeyId, secretAccessKey],
      };
    }
    throw fail(source, "AWS could not be reached");
  }
}

async function mintGcp(source: CloudSource, deps: ResolvedDeps): Promise<CloudGrant> {
  const json = source.secrets.serviceAccountJson;
  const project = source.config.project;
  const sa = json ? parseServiceAccount(json) : null;
  if (!sa || !project) throw fail(source, "the key is not a service account JSON, or the project is missing");
  let token;
  try {
    token = await fetchGcpToken(sa, GCP_SCOPE_FULL, deps);
  } catch (err) {
    if (err instanceof TokenEndpointError) throw fail(source, `Google refused the token request (HTTP ${err.status})`);
    throw fail(source, "Google Cloud could not be reached");
  }
  const keyId = typeof sa.private_key_id === "string" ? [sa.private_key_id] : [];
  return {
    // No GOOGLE_APPLICATION_CREDENTIALS: that would need the key written to a file, and no file is ever written.
    env: {
      CLOUDSDK_AUTH_ACCESS_TOKEN: token.accessToken,
      GOOGLE_OAUTH_ACCESS_TOKEN: token.accessToken, // read by Terraform's Google provider
      CLOUDSDK_CORE_PROJECT: project,
      GOOGLE_CLOUD_PROJECT: project,
    },
    credential: "gcp_access_token",
    expiresAt: token.expiresAt,
    secrets: [token.accessToken, ...privateKeySecrets(sa.private_key), ...keyId],
  };
}

function mintAzure(source: CloudSource): CloudGrant {
  const { tenantId, clientId, subscriptionId } = source.config;
  const clientSecret = source.secrets.clientSecret;
  if (!tenantId || !clientId || !subscriptionId || !clientSecret) throw fail(source, "the service principal is incomplete");
  // The client secret is passed as it is, with no exchange: the azurerm Terraform provider and the Azure SDKs need
  // the secret itself, not an access token. The grant records it as azure_client_secret, which does not expire here.
  return {
    env: {
      AZURE_TENANT_ID: tenantId, AZURE_CLIENT_ID: clientId, AZURE_CLIENT_SECRET: clientSecret, AZURE_SUBSCRIPTION_ID: subscriptionId,
      ARM_TENANT_ID: tenantId, ARM_CLIENT_ID: clientId, ARM_CLIENT_SECRET: clientSecret, ARM_SUBSCRIPTION_ID: subscriptionId,
    },
    credential: "azure_client_secret",
    expiresAt: null,
    secrets: [clientSecret],
  };
}

/**
 * Mints the credentials a run gets for one cloud connection. Rejects with CloudCredentialError when they cannot be
 * had (bad keys, provider unreachable or throttling, or `signal` already aborted), so the run does not start. Without
 * a signal, minting times out after GRANT_TIMEOUT_MS. Nothing is written to disk.
 */
export async function mintCloudGrant(source: CloudSource, deps: GrantDeps): Promise<CloudGrant> {
  const resolved: ResolvedDeps = { ...deps, signal: deps.signal ?? AbortSignal.timeout(GRANT_TIMEOUT_MS) };
  if (resolved.signal.aborted) throw fail(source, "the run start was cancelled");
  switch (source.provider) {
    case "aws":
      return mintAws(source, resolved);
    case "gcp":
      return mintGcp(source, resolved);
    case "azure":
      return mintAzure(source);
  }
}
