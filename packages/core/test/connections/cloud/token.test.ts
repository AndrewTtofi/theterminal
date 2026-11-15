import { describe, expect, it, vi } from "vitest";
import { MAX_TOKEN_RESPONSE_BYTES, TokenEndpointError, postTokenForm } from "../../../src/connections/cloud/token.js";
import { fakeSts } from "../../../src/connections/cloud/aws.js";
import { cloudTesters } from "../../../src/connections/testers.js";

const signal = new AbortController().signal;
const TOKEN = JSON.stringify({ access_token: "TESTKEY-access-token-0000000000", expires_in: 3600 });
const answer = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) =>
  vi.fn(async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;
const post = (f: typeof fetch) => postTokenForm("https://login.microsoftonline.com/t/oauth2/v2.0/token", { grant_type: "x" }, { fetch: f, signal });

/** A body that keeps producing bytes; the reader must stop at the cap instead of draining it. */
function endless(): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let bytes = 0;
  const chunk = new TextEncoder().encode(`{"access_token":"${"A".repeat(16 * 1024)}`);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { body, pulled: () => bytes };
}

describe("postTokenForm", () => {
  it("accepts a JSON token answer", async () => {
    expect((await post(answer(TOKEN))).accessToken).toBe("TESTKEY-access-token-0000000000");
  });

  it.each([
    ["no content-type", {}],
    ["a non-JSON content-type", { "content-type": "text/html" }],
  ])("refuses an answer with %s", async (_name, headers) => {
    const err = await post(answer(TOKEN, headers)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenEndpointError);
    expect((err as TokenEndpointError).status).toBe(200);
  });

  it("refuses a body over the cap without reading it all", async () => {
    expect(MAX_TOKEN_RESPONSE_BYTES).toBe(64 * 1024);
    const { body, pulled } = endless();
    await expect(post(answer(body))).rejects.toBeInstanceOf(TokenEndpointError);
    expect(pulled()).toBeLessThan(MAX_TOKEN_RESPONSE_BYTES + 64 * 1024);
  });

  it("refuses an empty body and malformed JSON", async () => {
    await expect(post(answer(null))).rejects.toBeInstanceOf(TokenEndpointError);
    await expect(post(answer("{not json"))).rejects.toBeInstanceOf(TokenEndpointError);
  });

  it("gives the tester's fixed Unexpected response message, never the body", async () => {
    const azure = cloudTesters(fakeSts).azure!;
    const input = {
      config: { tenantId: "00000000-0000-0000-0000-00000000aaaa", clientId: "00000000-0000-0000-0000-00000000bbbb", subscriptionId: "00000000-0000-0000-0000-00000000cccc" },
      private: {}, secrets: { clientSecret: "TESTKEY-azure-secret-0000000000" },
    };
    for (const f of [answer("<html>TESTKEY-leak</html>", { "content-type": "text/html" }), answer(endless().body)]) {
      expect(await azure(input, { fetch: f, signal })).toEqual({ ok: false, message: "Unexpected response (HTTP 200)" });
    }
  });
});
