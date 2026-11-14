import { describe, expect, it } from "vitest";
import {
  CONNECTION_CATALOG,
  CONNECTION_KINDS,
  CONNECTION_PROVIDERS,
  KIND_LABELS,
  connectionConfigSchema,
  connectionNameSchema,
  eventPayloadSchemas,
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
      mcp_stdio: "mcp", mcp_http: "mcp", local_hardware: "hardware",
    });
  });

  it("makes only the four 5A providers available, all single", () => {
    const available = CONNECTION_CATALOG.filter((e) => e.available);
    expect(available.map((e) => e.provider)).toEqual(["claude", "codex", "gemini", "github"]);
    for (const e of available) expect(e.single).toBe(true);
    for (const e of CONNECTION_CATALOG.filter((x) => !x.available)) expect(e.fields).toEqual([]);
  });

  it("declares the fields of each available provider", () => {
    const fields = (p: string) =>
      CONNECTION_CATALOG.find((e) => e.provider === p)!.fields.map((f) => [f.name, f.storage, f.required, f.input]);
    expect(fields("claude")).toEqual([["apiKey", "secret", false, "password"]]);
    expect(fields("codex")).toEqual([["apiKey", "secret", false, "password"], ["cliHome", "private", false, "path"]]);
    expect(fields("gemini")).toEqual([
      ["apiKey", "secret", false, "password"],
      ["googleCloudProject", "config", false, "text"],
      ["cliHome", "private", false, "path"],
    ]);
    expect(fields("github")).toEqual([["token", "secret", true, "password"]]);
    const github = CONNECTION_CATALOG.find((e) => e.provider === "github")!;
    expect(github.fields[0]!.help).toBe("A fine-grained personal access token with read access to the repositories you want to see.");
    const codexHome = CONNECTION_CATALOG.find((e) => e.provider === "codex")!.fields[1]!;
    expect(codexHome.help).toBe('Only for "My own ChatGPT plan": the folder where your Codex login lives (CODEX_HOME). Leave empty for the default.');
    const geminiHome = CONNECTION_CATALOG.find((e) => e.provider === "gemini")!.fields[2]!;
    expect(geminiHome.help).toContain("(GEMINI_CLI_HOME)");
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
  });
  it("rejects invalid payloads", () => {
    bad("connection.removed", { connectionId: "", name: "n" });
    bad("connection.removed", { connectionId: "c1", name: "n", extra: true });
    bad("connection.tested", { connectionId: "c1", name: "n", ok: true, message: "x".repeat(501) });
    bad("connection.tested", { connectionId: "c1", name: "n", ok: "yes", message: "" });
    bad("connection.used", { connectionId: "c1", name: "n", runId: "r1", purpose: "other" });
    bad("connection.used", { connectionId: "c1", name: "n", purpose: "api_key" });
  });
});
