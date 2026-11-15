import type { ConnectionProvider } from "@theterminal/shared";
import type { ConnectionTester } from "./service.js";
import { keyRejection, type StsCaller } from "./cloud/aws.js";
import { fetchAzureToken } from "./cloud/azure.js";
import { GCP_SCOPE_READ, fetchGcpToken, parseServiceAccount } from "./cloud/gcp.js";
import { TokenEndpointError, type AccessToken } from "./cloud/token.js";
import { localModelTester } from "../capacity/local-models.js";

type Check = {
  url: string;
  secret: "apiKey" | "token";
  missing: string;
  headers: (secret: string) => Record<string, string>;
  connected?: (res: Response) => string;
};

/** A read-only GET that proves the stored secret works. The secret goes in a header, never in the URL. */
function httpTester(check: Check): ConnectionTester {
  return async (input, deps) => {
    const secret = input.secrets[check.secret];
    if (!secret) return { ok: false, message: check.missing };
    let res: Response;
    try {
      res = await deps.fetch(check.url, { method: "GET", headers: check.headers(secret), signal: deps.signal });
    } catch {
      return { ok: false, message: "Could not reach the provider" };
    }
    if (res.ok) return { ok: true, message: check.connected ? check.connected(res) : "Connected" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Rejected by the provider (HTTP ${res.status})` };
    return { ok: false, message: `Unexpected response (HTTP ${res.status})` };
  };
}

const NO_API_KEY = "No API key stored";

export const CONNECTION_TESTERS: Partial<Record<ConnectionProvider, ConnectionTester>> = {
  claude: httpTester({
    url: "https://api.anthropic.com/v1/models",
    secret: "apiKey",
    missing: NO_API_KEY,
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  }),
  codex: httpTester({
    url: "https://api.openai.com/v1/models",
    secret: "apiKey",
    missing: NO_API_KEY,
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  }),
  gemini: httpTester({
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    secret: "apiKey",
    missing: NO_API_KEY,
    headers: (key) => ({ "x-goog-api-key": key }),
  }),
  github: httpTester({
    url: "https://api.github.com/user",
    secret: "token",
    missing: "No token stored",
    headers: (token) => ({
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    }),
    // Classic tokens list their scopes; fine-grained tokens send no such header. The login name is not recorded.
    connected: (res) => `Connected (scopes: ${res.headers.get("x-oauth-scopes")?.trim() || "fine-grained"})`,
  }),
  // A model server on this computer: lists its models, never leaves the loopback address.
  local_model: localModelTester,
};

const NO_CREDENTIALS = "No credentials stored";
const UNREACHABLE = "Could not reach the provider";

type Outcome = { ok: boolean; message: string };

/**
 * Gets a token, then reads one resource with it. `target` names the resource in messages, for example
 * "project my-project". Messages never hold the token or the response body.
 */
async function tokenThenRead(
  getToken: () => Promise<AccessToken>, url: string, target: string, f: typeof fetch, signal: AbortSignal, cannotSee: string,
): Promise<Outcome> {
  let token: AccessToken;
  try {
    token = await getToken();
  } catch (err) {
    if (!(err instanceof TokenEndpointError)) return { ok: false, message: UNREACHABLE };
    if (err.status === 400 || err.status === 401) return { ok: false, message: `Rejected by the provider (HTTP ${err.status})` };
    return { ok: false, message: `Unexpected response (HTTP ${err.status})` };
  }
  let res: Response;
  try {
    res = await f(url, { method: "GET", headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" }, signal });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (res.ok) return { ok: true, message: "Connected" };
  if (res.status === 403 || res.status === 404) return { ok: false, message: `${cannotSee} ${target} (HTTP ${res.status})` };
  if (res.status === 401) return { ok: false, message: `Rejected by the provider (HTTP ${res.status})` };
  return { ok: false, message: `Unexpected response (HTTP ${res.status})` };
}

/** Testers for cloud accounts. AWS goes through `sts`; Google Cloud and Azure through the tester's fetch. */
export function cloudTesters(sts: StsCaller): Partial<Record<ConnectionProvider, ConnectionTester>> {
  return {
    // No ARN or account id is recorded: only that the identity was verified.
    aws: async (input, deps) => {
      const { accessKeyId, secretAccessKey } = input.secrets;
      const region = input.config.region;
      if (!accessKeyId || !secretAccessKey || !region) return { ok: false, message: NO_CREDENTIALS };
      try {
        await sts.callerIdentity({ accessKeyId, secretAccessKey, region }, deps.signal);
        return { ok: true, message: "Connected (identity verified)" };
      } catch (err) {
        const name = keyRejection(err) ?? ((err as Error | null)?.name === "AccessDenied" ? "AccessDenied" : null);
        return { ok: false, message: name ? `Rejected by the provider (${name})` : UNREACHABLE };
      }
    },
    gcp: async (input, deps) => {
      const json = input.secrets.serviceAccountJson;
      if (!json) return { ok: false, message: NO_CREDENTIALS };
      const sa = parseServiceAccount(json);
      if (!sa) return { ok: false, message: "The key is not a service account JSON" };
      const project = input.config.project ?? sa.project_id;
      return tokenThenRead(
        () => fetchGcpToken(sa, GCP_SCOPE_READ, deps),
        `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}`,
        `project ${project}`, deps.fetch, deps.signal, "The service account cannot see",
      );
    },
    azure: async (input, deps) => {
      const clientSecret = input.secrets.clientSecret;
      const { tenantId, clientId, subscriptionId } = input.config;
      if (!clientSecret || !tenantId || !clientId || !subscriptionId) return { ok: false, message: NO_CREDENTIALS };
      return tokenThenRead(
        () => fetchAzureToken({ tenantId, clientId, clientSecret }, deps),
        `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2022-12-01`,
        `subscription ${subscriptionId}`, deps.fetch, deps.signal, "The service principal cannot see",
      );
    },
  };
}
