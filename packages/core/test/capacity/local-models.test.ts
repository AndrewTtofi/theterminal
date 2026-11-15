import { describe, expect, it, vi } from "vitest";
import {
  LLAMACPP_URL, LOCAL_MODEL_ENV_ALLOWLIST, OLLAMA_URL, detectLocalEngines, isLoopbackUrl, localModelTester,
} from "../../src/capacity/local-models.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const NOW = new Date("2026-11-15T10:00:00.000Z");

const OLLAMA_TAGS = {
  models: [
    { name: "qwen2.5-coder:14b", size: 9_000_000_000, details: { parameter_size: "14.8B", quantization_level: "Q4_K_M" } },
    { name: "llama3.2:3b", size: 2_019_393_189, details: {} },
  ],
};

/** Answers the Ollama and llama.cpp fixtures; `down` lists the base URLs that refuse the connection. */
function fixtureFetch(down: string[] = []) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (down.some((d) => url.startsWith(d))) throw refused();
    switch (url) {
      case `${OLLAMA_URL}/api/version`: return json(200, { version: "0.12.3" });
      case `${OLLAMA_URL}/api/tags`: return json(200, OLLAMA_TAGS);
      case `${LLAMACPP_URL}/health`: return json(200, { status: "ok" });
      case `${LLAMACPP_URL}/v1/models`: return json(200, { data: [{ id: "gpt-oss-20b" }] });
      default: return json(404, {});
    }
  }) as unknown as typeof fetch;
}

describe("detectLocalEngines", () => {
  it("finds Ollama and llama.cpp server with their OpenAI-compatible base URLs and models", async () => {
    const engines = await detectLocalEngines({ fetch: fixtureFetch(), now: () => NOW });
    expect(engines).toEqual([
      {
        engine: "ollama", baseUrl: "http://127.0.0.1:11434/v1", version: "0.12.3", detectedAt: NOW.toISOString(),
        models: [
          { id: "qwen2.5-coder:14b", sizeBytes: 9_000_000_000, parameters: "14.8B", quantization: "Q4_K_M" },
          { id: "llama3.2:3b", sizeBytes: 2_019_393_189, parameters: null, quantization: null },
        ],
      },
      {
        engine: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1", version: null, detectedAt: NOW.toISOString(),
        models: [{ id: "gpt-oss-20b", sizeBytes: null, parameters: null, quantization: null }],
      },
    ]);
  });

  it("omits an engine whose probe fails", async () => {
    const engines = await detectLocalEngines({ fetch: fixtureFetch([LLAMACPP_URL]), now: () => NOW });
    expect(engines.map((e) => e.engine)).toEqual(["ollama"]);
  });

  it("returns no engine and never throws when nothing answers", async () => {
    await expect(detectLocalEngines({ fetch: fixtureFetch([OLLAMA_URL, LLAMACPP_URL]) })).resolves.toEqual([]);
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(detectLocalEngines({ fetch: throwing })).resolves.toEqual([]);
  });

  it("omits an engine that answers something else than its API", async () => {
    const f = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/version")) return json(200, { version: 7 });
      if (url.endsWith("/api/tags")) return json(200, { models: "x" });
      if (url.endsWith("/health")) return json(503, { status: "loading model" });
      return json(200, { data: [{ id: "m" }] });
    }) as unknown as typeof fetch;
    expect(await detectLocalEngines({ fetch: f })).toEqual([]);
  });

  it("probes only this computer, with a timeout signal", async () => {
    const f = fixtureFetch();
    await detectLocalEngines({ fetch: f, timeoutMs: 50 });
    const calls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    for (const [url, init] of calls) {
      expect(isLoopbackUrl(url)).toBe(true);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("gives up on a server that never answers", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(detectLocalEngines({ fetch: hang, timeoutMs: 20 })).resolves.toEqual([]);
  });
});

describe("isLoopbackUrl", () => {
  it.each(["http://127.0.0.1:11434/v1", "http://localhost:8080/v1", "http://[::1]:11434/v1"])("accepts %s", (u) => {
    expect(isLoopbackUrl(u)).toBe(true);
  });
  it.each(["http://192.168.1.5:11434/v1", "http://user@127.0.0.1/", "http://u:p@localhost/", "https://localhost/", "ftp://127.0.0.1/", "not a url", "http://127.0.0.1.example.com/"])(
    "rejects %s",
    (u) => {
      expect(isLoopbackUrl(u)).toBe(false);
    },
  );
});

describe("LOCAL_MODEL_ENV_ALLOWLIST", () => {
  it("is exactly the key variable", () => {
    expect(LOCAL_MODEL_ENV_ALLOWLIST).toEqual(["LOCAL_MODEL_API_KEY"]);
  });
});

describe("localModelTester", () => {
  const signal = new AbortController().signal;
  const config = { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:14b" };
  const models = (ids: string[]) => vi.fn(async () => json(200, { object: "list", data: ids.map((id) => ({ id })) })) as unknown as typeof fetch;

  it("is connected when the server lists the model", async () => {
    const f = models(["llama3.2:3b", "qwen2.5-coder:14b"]);
    expect(await localModelTester({ config, private: {}, secrets: {} }, { fetch: f, signal })).toEqual({
      ok: true, message: "Connected (model available)",
    });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/v1/models");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("says when the model is not installed", async () => {
    expect(await localModelTester({ config, private: {}, secrets: {} }, { fetch: models(["llama3.2:3b"]), signal })).toEqual({
      ok: false, message: "Model qwen2.5-coder:14b is not installed on this server",
    });
  });

  it("says when the server cannot be reached", async () => {
    const f = vi.fn(async () => {
      throw refused();
    }) as unknown as typeof fetch;
    expect(await localModelTester({ config, private: {}, secrets: {} }, { fetch: f, signal })).toEqual({
      ok: false, message: "Could not reach the local model server",
    });
  });

  it("reports any other status", async () => {
    const f = vi.fn(async () => json(401, {})) as unknown as typeof fetch;
    expect(await localModelTester({ config, private: {}, secrets: {} }, { fetch: f, signal })).toEqual({
      ok: false, message: "Unexpected response (HTTP 401)",
    });
  });

  it("puts a stored key in the Authorization header, never in the URL", async () => {
    const key = "TESTKEY-local-000000";
    const f = models(["qwen2.5-coder:14b"]);
    await localModelTester({ config: { ...config, baseUrl: "http://localhost:8080/v1/" }, private: {}, secrets: { apiKey: key } }, { fetch: f, signal });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://localhost:8080/v1/models");
    expect(url).not.toContain(key);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
  });

  it("never sends anything to an address that is not this computer", async () => {
    const f = models(["qwen2.5-coder:14b"]);
    const result = await localModelTester(
      { config: { ...config, baseUrl: "http://192.168.1.5:11434/v1" }, private: {}, secrets: { apiKey: "TESTKEY-local-000000" } },
      { fetch: f, signal },
    );
    expect(result).toEqual({ ok: false, message: "Only this computer's own address is allowed" });
    expect(f).not.toHaveBeenCalled();
  });
});
