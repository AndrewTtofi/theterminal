import { z } from "zod";
import { PROVIDERS } from "./agents.js";

export const CONNECTION_KINDS = ["llm", "cloud", "github", "mcp", "hardware"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_PROVIDERS = [
  "claude", "codex", "gemini", "github", "aws", "gcp", "azure", "mcp_stdio", "mcp_http", "local_hardware",
] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/** config: ledger and API. private: keychain and API, never the ledger. secret: keychain only. */
export type FieldStorage = "config" | "private" | "secret";

export type ConnectionField = {
  name: string;
  label: string;
  storage: FieldStorage;
  required: boolean;
  input: "text" | "password" | "path" | "url" | "multiline" | "number";
  /** "pairs": NAME=value lines. Only with storage "secret" and input "multiline". */
  format?: "pairs";
  /** A RegExp source (no flags) the whole value must match. */
  pattern?: string;
  help?: string;
};

export type CatalogEntry = {
  provider: ConnectionProvider;
  kind: ConnectionKind;
  label: string;
  description: string;
  fields: ConnectionField[];
  /** At most one connection of this provider may exist. */
  single: boolean;
  available: boolean;
};

const apiKeyField: ConnectionField = { name: "apiKey", label: "API key", storage: "secret", required: false, input: "password" };
const cliHomeField = (mode: string, cli: string, variable: string): ConnectionField => ({
  name: "cliHome",
  label: "CLI home folder",
  storage: "private",
  required: false,
  input: "path",
  help: `Only for "${mode}": the folder where your ${cli} login lives (${variable}). Leave empty for the default.`,
});

/** What the Owner pays for and plans to spend, shown in Capacity. */
const budgetFields: ConnectionField[] = [
  {
    name: "plan", label: "Plan", storage: "config", required: false, input: "text",
    help: 'What you pay for, in your words: "Max 5x", "Plus", "pay per use". Shown in Capacity.',
  },
  {
    name: "monthlyBudgetUsd", label: "Monthly budget (USD)", storage: "config", required: false, input: "number",
    help: "Capacity shows this month's spend against it.",
  },
];

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const uuidField = (name: string, label: string): ConnectionField => ({
  name, label, storage: "config", required: true, input: "text", pattern: UUID,
});
const hardwareField = (name: string, label: string): ConnectionField => ({
  name, label, storage: "config", required: false, input: "text",
});

export const CONNECTION_CATALOG: readonly CatalogEntry[] = [
  {
    provider: "claude", kind: "llm", label: "Claude (Anthropic)",
    description: "Run Claude agents with an Anthropic API key.",
    fields: [apiKeyField, ...budgetFields], single: true, available: true,
  },
  {
    provider: "codex", kind: "llm", label: "Codex (OpenAI)",
    description: "Run Codex agents with an OpenAI API key or your own ChatGPT plan.",
    fields: [apiKeyField, cliHomeField("My own ChatGPT plan", "Codex", "CODEX_HOME"), ...budgetFields], single: true, available: true,
  },
  {
    provider: "gemini", kind: "llm", label: "Gemini (Google)",
    description: "Run Gemini agents with a Gemini API key or your own Google account.",
    fields: [
      apiKeyField,
      { name: "googleCloudProject", label: "Google Cloud project", storage: "config", required: false, input: "text" },
      cliHomeField("My own Google account", "Gemini CLI", "GEMINI_CLI_HOME"),
      ...budgetFields,
    ],
    single: true, available: true,
  },
  {
    provider: "github", kind: "github", label: "GitHub",
    description: "See your repositories, pull requests and checks.",
    fields: [
      {
        name: "token", label: "Personal access token", storage: "secret", required: true, input: "password",
        help: "A fine-grained personal access token with read access to the repositories you want to see.",
      },
      {
        name: "repo", label: "Repository", storage: "config", required: false, input: "text",
        help: "owner/name of the repository the GitHub view shows.",
        pattern: "^[A-Za-z0-9_.-]{1,100}\\/[A-Za-z0-9_.-]{1,100}$",
      },
    ],
    single: true, available: true,
  },
  {
    provider: "aws", kind: "cloud", label: "AWS",
    description: "Amazon Web Services account, through an IAM access key.",
    fields: [
      { name: "accessKeyId", label: "Access key ID", storage: "secret", required: true, input: "password" },
      { name: "secretAccessKey", label: "Secret access key", storage: "secret", required: true, input: "password" },
      {
        name: "region", label: "Region", storage: "config", required: true, input: "text",
        help: "For example us-east-1.", pattern: "^[a-z]{2}(-[a-z]+)+-\\d$",
      },
    ],
    single: false, available: true,
  },
  {
    provider: "gcp", kind: "cloud", label: "Google Cloud",
    description: "Google Cloud project, through a service account key.",
    fields: [
      {
        name: "serviceAccountJson", label: "Service account key (JSON)", storage: "secret", required: true, input: "multiline",
        help: "The JSON key file's contents. Stored in your keychain in pieces.",
      },
      { name: "project", label: "Project ID", storage: "config", required: true, input: "text", pattern: "^[a-z][a-z0-9-]{4,28}[a-z0-9]$" },
    ],
    single: false, available: true,
  },
  {
    provider: "azure", kind: "cloud", label: "Azure",
    description: "Microsoft Azure subscription, through a service principal.",
    fields: [
      uuidField("tenantId", "Tenant ID"),
      uuidField("clientId", "Client ID"),
      uuidField("subscriptionId", "Subscription ID"),
      { name: "clientSecret", label: "Client secret", storage: "secret", required: true, input: "password" },
    ],
    single: false, available: true,
  },
  {
    provider: "mcp_stdio", kind: "mcp", label: "MCP server (local)",
    description: "A local MCP server the agent's program starts for the run.",
    fields: [
      {
        name: "command", label: "Command", storage: "private", required: true, input: "text",
        help: "The program to start, for example npx or an absolute path. Never run through a shell.",
      },
      { name: "args", label: "Arguments", storage: "private", required: false, input: "multiline", help: "One argument per line." },
      {
        name: "env", label: "Environment variables", storage: "secret", required: false, input: "multiline", format: "pairs",
        help: "NAME=value, one per line. Stored in your keychain. Values of 8 or more characters are also redacted from agent output, so avoid common words as values.",
      },
    ],
    single: false, available: true,
  },
  {
    provider: "mcp_http", kind: "mcp", label: "MCP server (remote)",
    description: "A remote MCP server over HTTP.",
    fields: [
      { name: "url", label: "URL", storage: "config", required: true, input: "url" },
      {
        name: "headers", label: "Headers", storage: "secret", required: false, input: "multiline", format: "pairs",
        help: "Name=value, one per line, for example Authorization=Bearer …",
      },
    ],
    single: false, available: true,
  },
  {
    provider: "local_hardware", kind: "hardware", label: "This computer",
    description: "What this computer can run. Filled in by detection.",
    fields: [
      hardwareField("cpu", "CPU"),
      hardwareField("cores", "Cores"),
      hardwareField("memoryGb", "Memory (GB)"),
      hardwareField("gpu", "GPU"),
      hardwareField("gpuMemoryGb", "GPU memory (GB)"),
      hardwareField("platform", "Platform"),
      hardwareField("wsl", "WSL"),
      hardwareField("detectedAt", "Detected at"),
    ],
    single: true, available: true,
  },
];

export const KIND_LABELS: Record<ConnectionKind, string> = {
  llm: "AI model",
  cloud: "cloud account",
  github: "GitHub",
  mcp: "MCP server",
  hardware: "hardware",
};

export type ConnectionStatus = { state: "untested" | "ok" | "failed"; message: string; testedAt: string | null };

export type Connection = {
  id: string;
  kind: ConnectionKind;
  provider: ConnectionProvider;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  private: Record<string, string>;
  /** Names of the secret fields that hold a value; never the values. */
  secretFields: string[];
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
};

export function catalogEntry(provider: ConnectionProvider): CatalogEntry {
  return CONNECTION_CATALOG.find((e) => e.provider === provider)!;
}

/** Config keys that look like credential names are refused: those values belong in the keychain. */
export const FORBIDDEN_CONFIG_KEY = /key|secret|token|password|passwd|credential|auth/i;

const fieldName = z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/);

export const connectionConfigSchema = z.record(
  fieldName.refine((k) => !FORBIDDEN_CONFIG_KEY.test(k), "looks like a credential name; store it as a secret"),
  z.string().max(2000),
);

export const connectionNameSchema = z.string().min(1).max(120);

const id = z.string().min(1).max(200);
const fieldNames = z.array(fieldName).max(50);

export const connectionPayloadSchemas = {
  "connection.added": z
    .object({
      connectionId: id,
      kind: z.enum(CONNECTION_KINDS),
      provider: z.enum(CONNECTION_PROVIDERS),
      name: connectionNameSchema,
      config: connectionConfigSchema,
      secretFields: fieldNames,
      privateFields: fieldNames,
    })
    .strict()
    .refine((p) => catalogEntry(p.provider).kind === p.kind, {
      error: "provider does not belong to this kind",
      path: ["provider"],
    }),
  "connection.updated": z
    .object({
      connectionId: id,
      name: connectionNameSchema,
      changes: z
        .object({
          name: connectionNameSchema.optional(),
          config: connectionConfigSchema.optional(),
          enabled: z.boolean().optional(),
          secretsSet: fieldNames.optional(),
          secretsRemoved: fieldNames.optional(),
          privateSet: fieldNames.optional(),
          privateRemoved: fieldNames.optional(),
        })
        .strict()
        .refine((c) => Object.keys(c).length > 0, "at least one change is required"),
    })
    .strict(),
  "connection.removed": z.object({ connectionId: id, name: connectionNameSchema }).strict(),
  "connection.tested": z
    .object({ connectionId: id, name: connectionNameSchema, ok: z.boolean(), message: z.string().max(500) })
    .strict(),
  "connection.used": z
    .object({
      connectionId: id,
      name: connectionNameSchema,
      runId: id,
      purpose: z.enum(["api_key", "cli_home", "cloud_credentials", "mcp_server"]),
      /** Which kind of cloud credential the run was given; never its value. */
      credential: z.enum(["aws_session_token", "aws_static_keys", "gcp_access_token", "azure_client_secret"]).optional(),
      expiresAt: z.iso.datetime().nullable().optional(),
    })
    .strict(),
  /** A sign-in through the provider's own login command: never its output, account names or emails. */
  "connection.signin": z.object({ provider: z.enum(PROVIDERS), ok: z.boolean() }).strict(),
} satisfies Record<string, z.ZodType>;

export type ConnectionEventType = keyof typeof connectionPayloadSchemas;
