import { createSign } from "node:crypto";
import { z } from "zod";
import { postTokenForm, type AccessToken, type TokenDeps } from "./token.js";

export const serviceAccountSchema = z
  .object({
    type: z.literal("service_account"),
    project_id: z.string().min(1),
    client_email: z.string().email().endsWith(".iam.gserviceaccount.com"),
    private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
    token_uri: z.literal("https://oauth2.googleapis.com/token"),
  })
  .passthrough();
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export const GCP_SCOPE_READ = "https://www.googleapis.com/auth/cloud-platform.read-only";
export const GCP_SCOPE_FULL = "https://www.googleapis.com/auth/cloud-platform";

/** The service account in a stored key, or null when the text is not a service account JSON. */
export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const parsed = serviceAccountSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A self-signed RS256 JWT asking the token endpoint for `scope`, valid for one hour from `now`. */
export function signJwt(sa: ServiceAccount, scope: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: sa.client_email, scope, aud: sa.token_uri, iat, exp: iat + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** Exchanges a signed JWT for an access token (the OAuth jwt-bearer grant). */
export function fetchGcpToken(sa: ServiceAccount, scope: string, deps: TokenDeps): Promise<AccessToken> {
  const now = (deps.now ?? (() => new Date()))();
  return postTokenForm(
    sa.token_uri,
    { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(sa, scope, now) },
    { ...deps, now: () => now },
  );
}
