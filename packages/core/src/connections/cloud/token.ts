import { z } from "zod";

export type TokenDeps = { fetch: typeof fetch; signal: AbortSignal; now?: () => Date };
export type AccessToken = { accessToken: string; expiresAt: string };

/** A token endpoint answered, but not with a token. `status` is its HTTP status. */
export class TokenEndpointError extends Error {
  constructor(public readonly status: number) {
    super(`the token endpoint answered HTTP ${status}`);
    this.name = "TokenEndpointError";
  }
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().int().positive() });

/**
 * POSTs an OAuth form to a token endpoint and returns the access token with its expiry time. A failed request
 * rejects with the fetch error; any answer that is not a token rejects with TokenEndpointError. The response body is
 * never put in an error message.
 */
export async function postTokenForm(url: string, form: Record<string, string>, deps: TokenDeps): Promise<AccessToken> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: deps.signal,
  });
  if (!res.ok) throw new TokenEndpointError(res.status);
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new TokenEndpointError(res.status);
  const now = (deps.now ?? (() => new Date()))();
  return { accessToken: parsed.data.access_token, expiresAt: new Date(now.getTime() + parsed.data.expires_in * 1000).toISOString() };
}
