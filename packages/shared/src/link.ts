import { z } from "zod";
import { ADAPTERS, PROVIDERS, agentPayloadSchemas } from "./agents.js";
import { CONNECTION_KINDS, CONNECTION_PROVIDERS, connectionPayloadSchemas } from "./connections.js";
import type { LedgerEntry } from "./domain.js";

/**
 * Linked machines: two Terminals on one local network, paired once with a code, after which a run started on one
 * can execute on the other. This module holds what both ends and the ledger agree on: constants, the pairing code,
 * the `machine.*` and `link.*` entries, and the bodies of the link protocol.
 *
 * It imports the agent and connection payload schemas directly (never `events.ts`, which imports this module) to
 * check a mirrored entry's payload, and declares its own actor schema of the same shape as `actorSchema`.
 */

export const LINK_PROTOCOL_VERSION = 1;
export const LINK_DEFAULT_PORT = 4418;
export const LINKING_ACK =
  "I understand that enabling linking lets other computers on my local network reach this computer, that only computers I pair with a code can use it, and that agents they start run here with this computer's own connections. I choose to enable it.";
export const PAIRING_CODE_TTL_MS = 600_000;
export const PAIRING_MAX_ATTEMPTS = 5;
/** The `exportKeyingMaterial` label both sides bind their pairing proof to. */
export const PAIRING_LABEL = "theterminal-pairing";
/** A machine id: 32 lower-case hex characters. */
export const MACHINE_ID = /^[0-9a-f]{32}$/;
/** A machine's fingerprint: the SHA-256 of its public key, 64 lower-case hex characters. */
export const FINGERPRINT = /^[0-9a-f]{64}$/;

export const machineNameSchema = z.string().min(1).max(40);
/** `host:port`: no scheme, no userinfo, no path, no IPv6 literal. */
export const machineAddressSchema = z.string().regex(/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/);

export type MachineRole = "showed_code" | "entered_code";
export type Machine = {
  id: string;
  name: string;
  /** Base64 of the SPKI DER of the machine's Ed25519 key. */
  publicKey: string;
  fingerprint: string;
  address: string;
  role: MachineRole;
  pairedAt: string;
  updatedAt: string;
};
/** What a presence check found wrong, beyond not answering: another key at the machine's address (a security signal). */
export type MachineProblem = "key_mismatch";
/**
 * `online` and `checkedAt` are what the last check said and when; null when the machine was never checked. `problem`
 * is `key_mismatch` when that check met another key at the paired address: never shown as merely offline.
 */
export type MachinePresence = Machine & { online: boolean | null; checkedAt: string | null; problem: MachineProblem | null };
export type LinkRunState = "requested" | "running" | "finished" | "imported" | "failed";
export type LinkRun = {
  runId: string;
  machineId: string;
  direction: "requested" | "accepted";
  projectId: string;
  state: LinkRunState;
  lastSeq: number;
  error: string | null;
  updatedAt: string;
};

/** The entry types a worker sends back for a run it executes, each signed with its key. */
export const MIRRORABLE_TYPES = [
  "agent.started",
  "agent.message",
  "agent.action.requested",
  "agent.action.decided",
  "agent.action.completed",
  "agent.finished",
  "agent.rate_limited",
  "connection.used",
] as const;
export type MirrorableType = (typeof MIRRORABLE_TYPES)[number];

const id = z.string().min(1).max(200);
const machineId = z.string().regex(MACHINE_ID);
const fingerprint = z.string().regex(FINGERPRINT);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** A 44-byte Ed25519 SPKI DER is 60 base64 characters. */
const publicKey = z.base64().length(60);
const port = z.number().int().min(1).max(65535);
const signature = z.string().regex(/^[0-9a-f]{128}$/);
const decision = z.enum(["allow", "deny"]);
const prompt = z.string().min(1).max(20000);
const cardId = z.string().max(200).nullable();
const connectionIds = z.array(z.string().min(1).max(200)).max(10);
const projectName = z.string().min(1).max(120);

/** The same shape as `actorSchema` in `events.ts`, strict. */
const originActorSchema = z.object({ kind: z.enum(["human", "agent", "system"]), id: z.string().min(1) }).strict();

const MIRRORED_PAYLOADS: Record<MirrorableType, z.ZodType> = {
  "agent.started": agentPayloadSchemas["agent.started"],
  "agent.message": agentPayloadSchemas["agent.message"],
  "agent.action.requested": agentPayloadSchemas["agent.action.requested"],
  "agent.action.decided": agentPayloadSchemas["agent.action.decided"],
  "agent.action.completed": agentPayloadSchemas["agent.action.completed"],
  "agent.finished": agentPayloadSchemas["agent.finished"],
  "agent.rate_limited": agentPayloadSchemas["agent.rate_limited"],
  "connection.used": connectionPayloadSchemas["connection.used"],
};

/** The worker's own ledger entry, all nine fields, as it signed it. Its payload must pass the worker-side schema. */
export const mirroredOriginSchema = z
  .object({
    seq: z.number().int().positive(),
    id: z.string().min(1).max(200),
    ts: z.iso.datetime(),
    projectId: z.string().min(1).nullable(),
    actor: originActorSchema,
    type: z.enum(MIRRORABLE_TYPES),
    payload: z.unknown(),
    prevHash: hex64,
    hash: hex64,
  })
  .strict()
  .superRefine((o, ctx) => {
    const result = MIRRORED_PAYLOADS[o.type].safeParse(o.payload);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: ["payload", ...issue.path] });
      }
    }
  });
export type MirroredOrigin = z.infer<typeof mirroredOriginSchema>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LISTED: readonly string[] = MIRRORABLE_TYPES;

/**
 * The worker's own entry that a `link.mirrored` entry carries (its own seq, id, ts and actor), so a mirrored entry is
 * filtered and shown as the entry it reports; any other entry, and a mirrored one whose origin is unreadable, as it is.
 * A shape check only: it trusts nothing (the requester checked the signature before committing) and never throws.
 */
export function innerEntry(e: LedgerEntry): LedgerEntry {
  if (e.type !== "link.mirrored" || !isObject(e.payload)) return e;
  const o = e.payload.origin;
  if (!isObject(o) || typeof o.type !== "string" || !LISTED.includes(o.type) || !isObject(o.payload) || !isObject(o.actor)) return e;
  return o as unknown as LedgerEntry;
}

/** The run an entry names in its payload (a mirrored entry's: the worker entry's), or undefined. */
export function runIdOf(e: LedgerEntry): string | undefined {
  const p = innerEntry(e).payload;
  return isObject(p) && typeof p.runId === "string" ? p.runId : undefined;
}

/** Why this computer refused a remote run's returned changes (`link.changes_refused`). */
export const CHANGES_REFUSED_REASONS = ["bad_bundle", "conflict", "not_from_base", "wrong_path", "machine_refused"] as const;
export type ChangesRefusedReason = (typeof CHANGES_REFUSED_REASONS)[number];
/** The fixed words for each reason, wherever a refusal is shown. */
export const CHANGES_REFUSED_PHRASES: Record<ChangesRefusedReason, string> = {
  bad_bundle: "what it sent could not be read",
  conflict: "they clash with records here",
  not_from_base: "they do not start from the project as it was sent",
  wrong_path: "they name the wrong working copy",
  machine_refused: "the machine no longer has them",
};

export const linkPayloadSchemas = {
  "machine.identity_created": z.object({ machineId, publicKey, fingerprint }).strict(),
  "machine.named": z.object({ name: machineNameSchema }).strict(),
  "machine.linking_enabled": z.object({ port, acknowledgement: z.literal(LINKING_ACK) }).strict(),
  "machine.linking_disabled": z.object({}).strict(),
  "machine.paired": z
    .object({
      machineId,
      name: machineNameSchema,
      publicKey,
      fingerprint,
      address: machineAddressSchema,
      role: z.enum(["showed_code", "entered_code"]),
    })
    .strict(),
  "machine.unpaired": z.object({ machineId, name: machineNameSchema }).strict(),
  "link.run_requested": z
    .object({
      runId: id, machineId, adapter: z.enum(ADAPTERS), prompt, cardId, connectionIds,
      /** The project's commit this computer sent (its HEAD when the repository was exported); the changes must descend from it. */
      base: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    })
    .strict(),
  "link.run_failed": z.object({ runId: id, machineId, error: z.string().max(500) }).strict(),
  "link.project_received": z.object({ projectId: id, machineId, name: projectName }).strict(),
  "link.run_accepted": z.object({ runId: id, machineId, projectId: id }).strict(),
  "link.decision_received": z.object({ runId: id, actionId: id, machineId, decision }).strict(),
  "link.mirrored": z.object({ machineId, origin: mirroredOriginSchema, signature }).strict(),
  "link.changes_imported": z
    .object({ runId: id, machineId, commit: z.string().regex(/^[0-9a-f]{40}$/) })
    .strict(),
  "link.changes_refused": z.object({ runId: id, machineId, reason: z.enum(CHANGES_REFUSED_REASONS) }).strict(),
} satisfies Record<string, z.ZodType>;
export type LinkEventType = keyof typeof linkPayloadSchemas;

// The link protocol's bodies. Every request and response carries `v: LINK_PROTOCOL_VERSION`, except a mirror frame,
// which travels inside a versioned stream.
const v = z.literal(LINK_PROTOCOL_VERSION);
const proof = hex64;

export const helloResponseSchema = z.object({ v, machineId, name: machineNameSchema, linking: z.literal(true) }).strict();
export const pairRequestSchema = z.object({ v, machineId, name: machineNameSchema, port, proof }).strict();
export const pairResponseSchema = z.object({ v, machineId, name: machineNameSchema, port, proof }).strict();
export const remoteStartSchema = z
  .object({ v, projectId: id, projectName, adapter: z.enum(ADAPTERS), prompt, cardId, connectionIds })
  .strict();
export const remoteDecisionSchema = z.object({ v, decision, reason: z.string().max(500) }).strict();
export const mirrorFrameSchema = z.object({ origin: mirroredOriginSchema, signature }).strict();

const figure = z.object({ value: z.number().nullable(), basis: z.enum(["reported", "estimate", "not_reported"]) });
const usageWindow = z.object({ runs: z.number().int().nonnegative(), costUsd: figure, inputTokens: figure, outputTokens: figure });
const capacitySourceSchema = z.object({
  provider: z.enum(PROVIDERS),
  connectionId: z.string().max(200).nullable(),
  name: z.string().max(200),
  mode: z.enum(["api_key", "subscription", "chatgpt", "google", "none"]),
  plan: z.string().max(2000).nullable(),
  monthlyBudgetUsd: z.number().nullable(),
  today: usageWindow,
  month: usageWindow,
  rateLimits: z.object({
    last24h: z.number().int().nonnegative(),
    lastAt: z.iso.datetime().nullable(),
    basis: z.literal("estimate"),
  }),
});
const text = (max: number) => z.string().max(max).nullable();
/** The worker's hardware; its own `enabled` switch, if sent, is dropped (unknown keys are stripped). */
const hardwareSchema = z.object({
  cpu: text(200),
  cores: z.number().int().nonnegative().nullable(),
  memoryGb: z.number().nonnegative().nullable(),
  gpu: text(200),
  gpuMemoryGb: z.number().nonnegative().nullable(),
  platform: z.enum(["darwin", "win32", "linux"]),
  wsl: z.boolean(),
  detectedAt: z.iso.datetime(),
});
const localEngineSchema = z.object({
  engine: z.enum(["ollama", "llamacpp"]),
  baseUrl: z.string().max(2000),
  version: text(100),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        sizeBytes: z.number().nonnegative().nullable(),
        parameters: text(50),
        quantization: text(50),
      }),
    )
    .max(500),
  detectedAt: z.iso.datetime(),
});

/** A `MachineCapacity` as a worker sent it, checked by the requester before it is shown. */
export const machineCapacitySchema = z.object({
  machineId,
  name: machineNameSchema,
  online: z.boolean(),
  checkedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  problem: z.enum(["key_mismatch"]).nullable(),
  hardware: hardwareSchema.nullable(),
  localModels: z.array(localEngineSchema).max(10),
  sources: z.array(capacitySourceSchema).max(100),
  adapters: z.array(z.enum(ADAPTERS)).max(ADAPTERS.length),
  connections: z
    .array(
      z.object({
        id,
        kind: z.enum(CONNECTION_KINDS),
        provider: z.enum(CONNECTION_PROVIDERS),
        name: z.string().min(1).max(120),
      }),
    )
    .max(200),
});

/**
 * What a worker sends about itself (`GET /link/v1/capacity`): a `MachineCapacity` without the fields only the
 * requester knows (the machine's id and the name it recorded, whether and when it answered, and any problem it found).
 * Unknown keys are dropped.
 */
export const machineCapacityBodySchema = machineCapacitySchema.omit({
  machineId: true, name: true, online: true, checkedAt: true, lastSeenAt: true, problem: true,
});
export type MachineCapacityBody = z.infer<typeof machineCapacityBodySchema>;

// The pairing code: Crockford base32 of 12 bytes (8 bytes of the showing machine's fingerprint, then 4 bytes of
// one-time secret), 20 symbols written as four groups of five.
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_SYMBOLS = 20;
const PREFIX_BYTES = 8;
const SECRET_BYTES = 4;

export function encodePairingCode(fingerprintHex: string, secret: Uint8Array): string {
  if (!FINGERPRINT.test(fingerprintHex)) throw new TypeError("fingerprint must be 64 lower-case hex characters");
  if (secret.length !== SECRET_BYTES) throw new TypeError(`secret must be ${SECRET_BYTES} bytes`);
  const bytes = [...hexBytes(fingerprintHex.slice(0, PREFIX_BYTES * 2)), ...secret];
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += PAIRING_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += PAIRING_ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{5}/g)!.join("-");
}

/**
 * What the Owner typed, normalised (upper case, `O` as `0`, `I` and `L` as `1`, spaces and hyphens dropped). Null
 * unless it is exactly 20 symbols of the alphabet whose four padding bits are zero.
 */
export function parsePairingCode(typed: string): { fingerprintPrefix: string; secret: Uint8Array } | null {
  const symbols = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (symbols.length !== CODE_SYMBOLS) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of symbols) {
    const digit = PAIRING_ALPHABET.indexOf(c);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  if (bytes.length !== PREFIX_BYTES + SECRET_BYTES || value !== 0) return null;
  const prefix = bytes.slice(0, PREFIX_BYTES).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { fingerprintPrefix: prefix, secret: Uint8Array.from(bytes.slice(PREFIX_BYTES)) };
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}
