import type { ConnectionProvider } from "@theterminal/shared";
import type { ConnectionTester } from "./service.js";

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
};
