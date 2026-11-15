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

/** The largest token response read; a longer one is refused without reading the rest. */
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/** The body as text, or null when it is missing or longer than the cap (the stream is then cancelled). */
async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TOKEN_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POSTs an OAuth form to a token endpoint and returns the access token with its expiry time. A failed request
 * rejects with the fetch error; any answer that is not a JSON token (wrong status, not JSON, over 64 KB, malformed)
 * rejects with TokenEndpointError. The response body is never put in an error message.
 */
export async function postTokenForm(url: string, form: Record<string, string>, deps: TokenDeps): Promise<AccessToken> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: deps.signal,
  });
  if (!res.ok || !JSON_TYPE.test(res.headers.get("content-type") ?? "")) {
    // Not awaited: the body is unread and unwanted; waiting on its cancellation must not hold up the answer.
    void res.body?.cancel().catch(() => undefined);
    throw new TokenEndpointError(res.status);
  }
  const text = await readCapped(res);
  let json: unknown = null;
  try {
    json = text === null ? null : JSON.parse(text);
  } catch {
    // falls through to the schema check below
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new TokenEndpointError(res.status);
  const now = (deps.now ?? (() => new Date()))();
  return { accessToken: parsed.data.access_token, expiresAt: new Date(now.getTime() + parsed.data.expires_in * 1000).toISOString() };
}
