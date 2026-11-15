import { describe, expect, it } from "vitest";
import {
  CONNECTION_CATALOG,
  CONNECTION_KINDS,
  CONNECTION_PROVIDERS,
  KIND_LABELS,
  connectionConfigSchema,
  connectionNameSchema,
  connectionSummary,
  eventPayloadSchemas,
  hasConnectionDetails,
  isConnectionSummary,
  type Connection,
} from "../src/index.js";

const ok = (type: keyof typeof eventPayloadSchemas, payload: unknown) =>
  expect(eventPayloadSchemas[type]!.safeParse(payload).success).toBe(true);
const bad = (type: keyof typeof eventPayloadSchemas, payload: unknown) =>
  expect(eventPayloadSchemas[type]!.safeParse(payload).success).toBe(false);

describe("connection catalog", () => {
  it("lists every provider once, each under a known kind", () => {
    expect(CONNECTION_CATALOG.map((e) => e.provider).sort()).toEqual([...CONNECTION_PROVIDERS].sort());
    for (const e of CONNECTION_CATALOG) expect(CONNECTION_KINDS).toContain(e.kind);
  });

  it("files each provider under its kind", () => {
    const kindOf = Object.fromEntries(CONNECTION_CATALOG.map((e) => [e.provider, e.kind]));
    expect(kindOf).toEqual({
      claude: "llm", codex: "llm", gemini: "llm", github: "github", aws: "cloud", gcp: "cloud", azure: "cloud",
      mcp_stdio: "mcp", mcp_http: "mcp", local_hardware: "hardware", local_model: "llm",
    });
  });

  it("makes every provider available; only the model providers, GitHub and This computer are single", () => {
    for (const e of CONNECTION_CATALOG) expect(e.available).toBe(true);
    const single = CONNECTION_CATALOG.filter((e) => e.single).map((e) => e.provider);
    expect(single).toEqual(["claude", "codex", "gemini", "github", "local_hardware"]);
  });

  it("keeps every field name unique within its provider and every pattern a valid RegExp source", () => {
    for (const e of CONNECTION_CATALOG) {
      const names = e.fields.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
      for (const f of e.fields) {
        if (f.pattern !== undefined) expect(() => new RegExp(f.pattern!)).not.toThrow();
        if (f.format === "pairs") expect([f.storage, f.input]).toEqual(["secret", "multiline"]);
        if (f.storage === "config") expect(connectionConfigSchema.safeParse({ [f.name]: "x" }).success).toBe(true);
      }
    }
  });

  it("declares the fields of each available provider", () => {
    const fields = (p: string) =>
      CONNECTION_CATALOG.find((e) => e.provider === p)!.fields.map((f) => [f.name, f.storage, f.required, f.input]);
    const budget = [["plan", "config", false, "text"], ["monthlyBudgetUsd", "config", false, "number"]];
    expect(fields("claude")).toEqual([["apiKey", "secret", false, "password"], ...budget]);
    expect(fields("codex")).toEqual([["apiKey", "secret", false, "password"], ["cliHome", "private", false, "path"], ...budget]);
    expect(fields("gemini")).toEqual([
      ["apiKey", "secret", false, "password"],
      ["googleCloudProject", "config", false, "text"],
      ["cliHome", "private", false, "path"],
      ...budget,
    ]);
    expect(fields("github")).toEqual([["token", "secret", true, "password"], ["repo", "config", false, "text"]]);
    const github = CONNECTION_CATALOG.find((e) => e.provider === "github")!;
    expect(github.fields[0]!.help).toBe("A fine-grained personal access token with read access to the repositories you want to see.");
    const codexHome = CONNECTION_CATALOG.find((e) => e.provider === "codex")!.fields[1]!;
    expect(codexHome.help).toBe('Only for "My own ChatGPT plan": the folder where your Codex login lives (CODEX_HOME). Leave empty for the default.');
    const geminiHome = CONNECTION_CATALOG.find((e) => e.provider === "gemini")!.fields[2]!;
    expect(geminiHome.help).toContain("(GEMINI_CLI_HOME)");
  });

  it("declares the fields of the cloud, MCP and hardware providers, each belonging to its kind", () => {
    const entry = (p: string) => CONNECTION_CATALOG.find((e) => e.provider === p)!;
    const fields = (p: string) => entry(p).fields.map((f) => [f.name, f.storage, f.required, f.input]);
    expect(fields("aws")).toEqual([
      ["accessKeyId", "secret", true, "password"],
      ["secretAccessKey", "secret", true, "password"],
      ["region", "config", true, "text"],
    ]);
    expect(fields("gcp")).toEqual([["serviceAccountJson", "secret", true, "multiline"], ["project", "config", true, "text"]]);
    expect(fields("azure")).toEqual([
      ["tenantId", "config", true, "text"],
      ["clientId", "config", true, "text"],
      ["subscriptionId", "config", true, "text"],
      ["clientSecret", "secret", true, "password"],
    ]);
    expect(fields("mcp_stdio")).toEqual([
      ["command", "private", true, "text"],
      ["args", "private", false, "multiline"],
      ["env", "secret", false, "multiline"],
    ]);
    expect(fields("mcp_http")).toEqual([["url", "config", true, "url"], ["headers", "secret", false, "multiline"]]);
    expect(fields("local_hardware")).toEqual(
      ["cpu", "cores", "memoryGb", "gpu", "gpuMemoryGb", "platform", "wsl", "detectedAt"].map((n) => [n, "config", false, "text"]),
    );
    expect(fields("local_model")).toEqual([
      ["baseUrl", "config", true, "url"],
      ["model", "config", true, "text"],
      ["wireApi", "config", false, "text"],
      ["apiKey", "secret", false, "password"],
    ]);
    expect(entry("local_model")).toMatchObject({
      kind: "llm", single: false, available: true, label: "Local model (Ollama or llama.cpp)",
      description: "An open-weight model served on this computer through an OpenAI-compatible endpoint.",
    });
    expect(entry("local_model").fields.map((f) => [f.label, f.help])).toEqual([
      [
        "Server URL",
        "http://127.0.0.1:11434/v1 for Ollama, http://127.0.0.1:8080/v1 for llama.cpp server. Only this computer: to use another computer's model, run the agent there.",
      ],
      ["Model", "The model name the server lists, for example qwen2.5-coder:14b."],
      ["API style", "responses works with Ollama and llama.cpp server; the bundled Codex no longer accepts chat. Default responses."],
      ["API key (if the server wants one)", undefined],
    ]);
    expect(entry("mcp_stdio").fields[2]!.format).toBe("pairs");
    expect(entry("mcp_stdio").fields[2]!.help).toBe(
      "NAME=value, one per line. Stored in your keychain. Values of 8 or more characters are also redacted from agent output, so avoid common words as values.",
    );
    expect(entry("mcp_http").fields[1]!.format).toBe("pairs");
    expect([entry("aws").kind, entry("gcp").kind, entry("azure").kind]).toEqual(["cloud", "cloud", "cloud"]);
    expect([entry("mcp_stdio").kind, entry("mcp_http").kind, entry("local_hardware").kind]).toEqual(["mcp", "mcp", "hardware"]);
    expect(entry("aws").description).toBe("Amazon Web Services account, through an IAM access key.");
    expect(entry("azure").label).toBe("Azure");
    expect(entry("mcp_http").label).toBe("MCP server (remote)");
    expect(entry("claude").fields.find((f) => f.name === "monthlyBudgetUsd")!.label).toBe("Monthly budget (USD)");
  });

  it("checks catalog patterns against example values", () => {
    const pattern = (p: string, f: string) => {
      const source = CONNECTION_CATALOG.find((e) => e.provider === p)!.fields.find((x) => x.name === f)!.pattern!;
      return new RegExp(source);
    };
    expect(pattern("aws", "region").test("us-east-1")).toBe(true);
    expect(pattern("aws", "region").test("nowhere")).toBe(false);
    expect(pattern("gcp", "project").test("demo-project-1")).toBe(true);
    expect(pattern("gcp", "project").test("Demo")).toBe(false);
    expect(pattern("github", "repo").test("octo/example")).toBe(true);
    expect(pattern("github", "repo").test("octo")).toBe(false);
    const uuid = pattern("azure", "tenantId");
    expect(uuid.flags).toBe("");
    expect(uuid.test("00000000-0000-4000-8000-00000000ABCD")).toBe(true);
    expect(uuid.test("00000000-0000-4000-8000-00000000abcd")).toBe(true);
    expect(uuid.test("not-a-uuid")).toBe(false);
    expect(pattern("local_model", "model").test("qwen2.5-coder:14b")).toBe(true);
    expect(pattern("local_model", "model").test("library/llama3.1:8b-instruct-q4_K_M")).toBe(true);
    expect(pattern("local_model", "model").test("-rm")).toBe(false);
    expect(pattern("local_model", "model").test("a b")).toBe(false);
    expect(pattern("local_model", "wireApi").test("chat")).toBe(true);
    expect(pattern("local_model", "wireApi").test("responses")).toBe(true);
    expect(pattern("local_model", "wireApi").test("grpc")).toBe(false);
  });

  it("labels every kind", () => {
    expect(KIND_LABELS).toEqual({ llm: "AI model", cloud: "cloud account", github: "GitHub", mcp: "MCP server", hardware: "hardware" });
  });
});

describe("connectionConfigSchema", () => {
  it("rejects credential-like keys", () => {
    expect(connectionConfigSchema.safeParse({ apiKey: "x" }).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ authToken: "x" }).success).toBe(false);
  });
  it("accepts googleCloudProject", () => {
    expect(connectionConfigSchema.safeParse({ googleCloudProject: "demo-project" }).success).toBe(true);
  });
  it("accepts the 5B config keys", () => {
    for (const key of ["tenantId", "clientId", "subscriptionId", "region", "project", "repo", "plan", "monthlyBudgetUsd"]) {
      expect(connectionConfigSchema.safeParse({ [key]: "x" }).success).toBe(true);
    }
  });
  it("rejects badly shaped keys and long values", () => {
    expect(connectionConfigSchema.safeParse({ Upper: "x" }).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ "a-b": "x" }).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ ["a" + "b".repeat(41)]: "x" }).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ region: "x".repeat(2001) }).success).toBe(false);
    expect(connectionConfigSchema.safeParse({ region: 1 }).success).toBe(false);
  });
});

describe("connectionNameSchema", () => {
  it("bounds the length", () => {
    expect(connectionNameSchema.safeParse("").success).toBe(false);
    expect(connectionNameSchema.safeParse("x".repeat(121)).success).toBe(false);
    expect(connectionNameSchema.safeParse("My Claude").success).toBe(true);
  });
});

const added = {
  connectionId: "c1", kind: "llm", provider: "gemini", name: "Gemini", config: { googleCloudProject: "demo" },
  secretFields: ["apiKey"], privateFields: ["cliHome"],
};

describe("connection.added", () => {
  it("accepts a valid payload", () => ok("connection.added", added));
  it("files a local model under the llm kind", () => {
    const local = { ...added, provider: "local_model", config: { baseUrl: "http://127.0.0.1:11434/v1", model: "m" }, privateFields: [] };
    ok("connection.added", local);
    bad("connection.added", { ...local, kind: "hardware" });
  });
  it("rejects a provider outside its kind", () => {
    bad("connection.added", { ...added, kind: "cloud" });
    bad("connection.added", { ...added, kind: "github", provider: "claude" });
  });
  it("rejects unknown providers, extra keys, secret-looking config and empty names", () => {
    bad("connection.added", { ...added, provider: "other" });
    bad("connection.added", { ...added, extra: 1 });
    bad("connection.added", { ...added, config: { apiKey: "x" } });
    bad("connection.added", { ...added, name: "" });
    bad("connection.added", { ...added, secretFields: [42] });
  });
});

describe("connection.updated", () => {
  const base = { connectionId: "c1", name: "Gemini" };
  it("accepts each change", () => {
    ok("connection.updated", { ...base, changes: { name: "New" } });
    ok("connection.updated", { ...base, changes: { config: { googleCloudProject: "p" } } });
    ok("connection.updated", { ...base, changes: { enabled: false } });
    ok("connection.updated", { ...base, changes: { secretsSet: ["apiKey"], secretsRemoved: [] } });
    ok("connection.updated", { ...base, changes: { privateSet: ["cliHome"], privateRemoved: ["cliHome"] } });
  });
  it("rejects empty changes, unknown change keys and secret-looking config", () => {
    bad("connection.updated", { ...base, changes: {} });
    bad("connection.updated", { ...base, changes: { secrets: { apiKey: "x" } } });
    bad("connection.updated", { ...base, changes: { config: { authToken: "x" } } });
    bad("connection.updated", { ...base, changes: { enabled: "yes" } });
    bad("connection.updated", { ...base });
  });
});

describe("connection.signin", () => {
  it("carries only the provider and whether it worked", () => {
    ok("connection.signin", { provider: "codex", ok: true });
    ok("connection.signin", { provider: "claude", ok: false });
    bad("connection.signin", { provider: "github", ok: true });
    bad("connection.signin", { provider: "codex", ok: true, lines: ["x"] });
    bad("connection.signin", { provider: "codex", ok: true, account: "someone@example.com" });
    bad("connection.signin", { provider: "codex" });
  });
});

describe("connection.removed, connection.tested, connection.used", () => {
  it("accepts valid payloads", () => {
    ok("connection.removed", { connectionId: "c1", name: "n" });
    ok("connection.tested", { connectionId: "c1", name: "n", ok: true, message: "Connected" });
    ok("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "api_key" });
    ok("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "cli_home" });
    ok("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "cloud_credentials" });
    ok("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "mcp_server" });
    ok("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "local_model" });
    ok("connection.used", {
      connectionId: "c1", name: "n", runId: "r1", purpose: "cloud_credentials",
      credential: "aws_session_token", expiresAt: "2026-11-15T12:00:00.000Z",
    });
    ok("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "cloud_credentials", credential: "azure_client_secret", expiresAt: null });
  });
  it("rejects invalid payloads", () => {
    bad("connection.removed", { connectionId: "", name: "n" });
    bad("connection.removed", { connectionId: "c1", name: "n", extra: true });
    bad("connection.tested", { connectionId: "c1", name: "n", ok: true, message: "x".repeat(501) });
    bad("connection.tested", { connectionId: "c1", name: "n", ok: "yes", message: "" });
    bad("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "other" });
    bad("connection.used", { connectionId: "c1", name: "n", purpose: "api_key" });
    bad("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "cloud_credentials", credential: "password" });
    bad("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "cloud_credentials", expiresAt: "tomorrow" });
  });
});

describe("agent.rate_limited", () => {
  it("accepts a retry delay in whole seconds or null", () => {
    ok("agent.rate_limited", { runId: "r1", retryAfterS: null });
    ok("agent.rate_limited", { runId: "r1", retryAfterS: 30 });
  });
  it("rejects negative or fractional delays and extra keys", () => {
    bad("agent.rate_limited", { runId: "r1", retryAfterS: -1 });
    bad("agent.rate_limited", { runId: "r1", retryAfterS: 1.5 });
    bad("agent.rate_limited", { runId: "r1", retryAfterS: null, text: "x" });
    bad("agent.rate_limited", { runId: "r1" });
  });
});

describe("connectionSummary", () => {
  const full: Connection = {
    id: "c1", kind: "github", provider: "github", name: "GitHub", enabled: true,
    config: { repo: "club/site" }, private: { note: "x" }, secretFields: ["token"],
    status: { state: "failed", message: "Cannot see repository club/site (HTTP 404)", testedAt: "2026-01-01T00:00:00Z" },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };

  it("keeps what a connection is and whether it works, and drops config, private values, secret names and the test message", () => {
    const summary = connectionSummary(full);
    expect(summary).toEqual({
      id: "c1", kind: "github", provider: "github", name: "GitHub", enabled: true,
      status: { state: "failed", message: "", testedAt: "2026-01-01T00:00:00Z" },
    });
    expect(JSON.stringify(summary)).not.toMatch(/config|private|secretFields|club\/site|token/);
  });

  it("tells a summary from the full record", () => {
    expect(hasConnectionDetails(full)).toBe(true);
    expect(isConnectionSummary(full)).toBe(false);
    const summary = connectionSummary(full);
    expect(hasConnectionDetails(summary)).toBe(false);
    expect(isConnectionSummary(summary)).toBe(true);
  });
});
