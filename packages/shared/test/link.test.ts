import { describe, expect, it } from "vitest";
import {
  FINGERPRINT,
  LINKING_ACK,
  LINK_DEFAULT_PORT,
  LINK_PROTOCOL_VERSION,
  MACHINE_ID,
  MIRRORABLE_TYPES,
  PAIRING_ALPHABET,
  PAIRING_CODE_TTL_MS,
  PAIRING_LABEL,
  PAIRING_MAX_ATTEMPTS,
  encodePairingCode,
  eventPayloadSchemas,
  helloResponseSchema,
  linkPayloadSchemas,
  machineAddressSchema,
  machineCapacitySchema,
  machineNameSchema,
  mirrorFrameSchema,
  mirroredOriginSchema,
  pairRequestSchema,
  pairResponseSchema,
  parsePairingCode,
  remoteDecisionSchema,
  remoteStartSchema,
  innerEntry,
  runIdOf,
  type LedgerEntry,
} from "../src/index.js";

const ok = (type: keyof typeof eventPayloadSchemas, payload: unknown) =>
  expect(eventPayloadSchemas[type]!.safeParse(payload).success).toBe(true);
const bad = (type: keyof typeof eventPayloadSchemas, payload: unknown) =>
  expect(eventPayloadSchemas[type]!.safeParse(payload).success).toBe(false);

const fp = "0123456789abcdef".repeat(4);
const machineId = "ab".repeat(16);
const publicKey = "MCowBQYDK2VwAyEA" + "A".repeat(43) + "=";
const CODE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

describe("link constants", () => {
  it("has the agreed values", () => {
    expect(LINK_PROTOCOL_VERSION).toBe(1);
    expect(LINK_DEFAULT_PORT).toBe(4418);
    expect(PAIRING_CODE_TTL_MS).toBe(600_000);
    expect(PAIRING_MAX_ATTEMPTS).toBe(5);
    expect(PAIRING_LABEL).toBe("theterminal-pairing");
    expect(PAIRING_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(LINKING_ACK).toBe(
      "I understand that enabling linking lets other computers on my local network reach this computer, that only computers I pair with a code can use it, and that agents they start run here with this computer's own connections. I choose to enable it.",
    );
    expect(MACHINE_ID.test(machineId)).toBe(true);
    expect(MACHINE_ID.test("AB".repeat(16))).toBe(false);
    expect(FINGERPRINT.test(fp)).toBe(true);
    expect(FINGERPRINT.test(fp.slice(1))).toBe(false);
    expect(publicKey).toHaveLength(60);
  });

  it("lists the mirrorable types", () => {
    expect([...MIRRORABLE_TYPES]).toEqual([
      "agent.started", "agent.message", "agent.action.requested", "agent.action.decided", "agent.action.completed",
      "agent.finished", "agent.rate_limited", "connection.used",
    ]);
  });
});

describe("pairing code", () => {
  const secret = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

  it("encodes 8 bytes of the fingerprint and 4 bytes of secret as 20 symbols in four groups", () => {
    const code = encodePairingCode(fp, secret);
    expect(code).toHaveLength(23);
    expect(code).toMatch(CODE);
  });

  it("round-trips the fingerprint prefix and the secret", () => {
    for (const s of [secret, new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 255, 255, 255])]) {
      for (const f of [fp, "f".repeat(64), "0".repeat(64)]) {
        const parsed = parsePairingCode(encodePairingCode(f, s));
        expect(parsed).not.toBeNull();
        expect(parsed!.fingerprintPrefix).toBe(f.slice(0, 16));
        expect([...parsed!.secret]).toEqual([...s]);
      }
    }
  });

  it("normalises what was typed: case, separators, O as 0 and I or L as 1", () => {
    const zeros = parsePairingCode("xxxxx-xxxxx-xxxxx-xxxxx".replace(/x/g, "o"));
    expect(zeros).not.toBeNull();
    expect(zeros!.fingerprintPrefix).toBe("0".repeat(16));
    expect([...zeros!.secret]).toEqual([0, 0, 0, 0]);
    const code = encodePairingCode(fp, secret);
    expect(parsePairingCode(code.toLowerCase())).toEqual(parsePairingCode(code));
    expect(parsePairingCode(` ${code.replace(/-/g, " ")} `)).toEqual(parsePairingCode(code));
    expect(parsePairingCode(code.replace(/-/g, ""))).toEqual(parsePairingCode(code));
    const ones = parsePairingCode("11111-11111-11111-11110");
    expect(parsePairingCode("iiiii-LLLLL-lllll-IIII0")).toEqual(ones);
  });

  it("refuses anything that is not 20 symbols of the alphabet", () => {
    const code = encodePairingCode(fp, secret).replace(/-/g, "");
    expect(parsePairingCode(code.slice(0, 19))).toBeNull();
    expect(parsePairingCode(`${code}0`)).toBeNull();
    expect(parsePairingCode("")).toBeNull();
    expect(parsePairingCode(`${code.slice(0, 19)}U`)).toBeNull();
    expect(parsePairingCode(`${code.slice(0, 19)}!`)).toBeNull();
  });

  it("refuses a bad fingerprint or secret when encoding", () => {
    expect(() => encodePairingCode("xyz", secret)).toThrow();
    expect(() => encodePairingCode(fp, new Uint8Array(3))).toThrow();
  });
});

describe("machine name and address", () => {
  it("bounds the name", () => {
    expect(machineNameSchema.safeParse("").success).toBe(false);
    expect(machineNameSchema.safeParse("x".repeat(41)).success).toBe(false);
    expect(machineNameSchema.safeParse("GPU box").success).toBe(true);
  });

  it("accepts host:port and nothing else", () => {
    for (const a of ["192.168.1.10:4418", "gpu-box.local:4418", "localhost:1"]) {
      expect(machineAddressSchema.safeParse(a).success, a).toBe(true);
    }
    for (const a of ["user@host:1", "host:1/path", "http://host:1", "host", "host:", "host:123456", "[::1]:4418", ""]) {
      expect(machineAddressSchema.safeParse(a).success, a).toBe(false);
    }
  });
});

describe("machine.* events", () => {
  it("accepts identity, name, opt-in and pairing payloads", () => {
    ok("machine.identity_created", { machineId, publicKey, fingerprint: fp });
    ok("machine.named", { name: "Mac" });
    ok("machine.linking_enabled", { port: 4418, acknowledgement: LINKING_ACK });
    ok("machine.linking_disabled", {});
    ok("machine.paired", { machineId, name: "GPU box", publicKey, fingerprint: fp, address: "192.168.1.10:4418", role: "showed_code" });
    ok("machine.unpaired", { machineId, name: "GPU box" });
  });

  it("refuses an acknowledgement with one character changed", () => {
    bad("machine.linking_enabled", { port: 4418, acknowledgement: LINKING_ACK.replace("I choose", "I chose") });
    bad("machine.linking_enabled", { port: 4418, acknowledgement: `${LINKING_ACK.slice(0, -1)}!` });
    bad("machine.linking_enabled", { port: 0, acknowledgement: LINKING_ACK });
    bad("machine.linking_enabled", { port: 65536, acknowledgement: LINKING_ACK });
  });

  it("refuses bad ids, keys, roles and extra keys", () => {
    bad("machine.identity_created", { machineId: "x", publicKey, fingerprint: fp });
    bad("machine.identity_created", { machineId, publicKey: publicKey.slice(1), fingerprint: fp });
    bad("machine.identity_created", { machineId, publicKey: "!".repeat(60), fingerprint: fp });
    bad("machine.identity_created", { machineId, publicKey, fingerprint: fp.toUpperCase() });
    bad("machine.paired", { machineId, name: "GPU box", publicKey, fingerprint: fp, address: "192.168.1.10:4418", role: "owner" });
    bad("machine.paired", { machineId, name: "GPU box", publicKey, fingerprint: fp, address: "user@h:1", role: "showed_code" });
    bad("machine.linking_disabled", { extra: 1 });
    bad("machine.named", { name: "x".repeat(41) });
  });
});

const requested = {
  runId: "r1",
  actionId: "a1",
  kind: "shell",
  tool: "Bash",
  summary: "Run npm test",
  input: { command: "npm test" },
};
const origin = (over: Record<string, unknown> = {}) => ({
  seq: 3,
  id: "e3",
  ts: "2026-11-15T10:00:00.000Z",
  projectId: "p1",
  actor: { kind: "agent", id: "r1" },
  type: "agent.action.requested",
  payload: requested,
  prevHash: "a".repeat(64),
  hash: "b".repeat(64),
  ...over,
});

describe("mirroredOriginSchema", () => {
  it("accepts a valid agent.action.requested", () => {
    expect(mirroredOriginSchema.safeParse(origin()).success).toBe(true);
    expect(mirroredOriginSchema.safeParse(origin({
      type: "connection.used", projectId: null, payload: { connectionId: "c1", name: "n", runId: "r1", purpose: "local_model" },
    })).success).toBe(true);
  });

  it("refuses a type that is not mirrorable", () => {
    expect(mirroredOriginSchema.safeParse(origin({ type: "card.moved", payload: { cardId: "c1", from: "plan", to: "build" } })).success).toBe(false);
  });

  it("checks the inner payload against the worker-side bounds", () => {
    const result = mirroredOriginSchema.safeParse(origin({ type: "agent.message", payload: { runId: "r1", text: "x".repeat(4001) } }));
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === "payload")).toBe(true);
    expect(mirroredOriginSchema.safeParse(origin({ type: "agent.message", payload: { runId: "r1", text: "x".repeat(4000) } })).success).toBe(true);
  });

  it("refuses bad hashes, sequence numbers, actors and extra keys", () => {
    expect(mirroredOriginSchema.safeParse(origin({ hash: "b".repeat(63) })).success).toBe(false);
    expect(mirroredOriginSchema.safeParse(origin({ prevHash: "B".repeat(64) })).success).toBe(false);
    expect(mirroredOriginSchema.safeParse(origin({ seq: 0 })).success).toBe(false);
    expect(mirroredOriginSchema.safeParse(origin({ actor: { kind: "robot", id: "x" } })).success).toBe(false);
    expect(mirroredOriginSchema.safeParse(origin({ actor: { kind: "agent", id: "r1", extra: 1 } })).success).toBe(false);
    expect(mirroredOriginSchema.safeParse(origin({ ts: "yesterday" })).success).toBe(false);
    expect(mirroredOriginSchema.safeParse({ ...origin(), extra: 1 }).success).toBe(false);
  });
});

describe("link.* events", () => {
  it("accepts valid payloads", () => {
    ok("link.run_requested", { runId: "r1", machineId, adapter: "codex", prompt: "go", cardId: null, connectionIds: ["c1"] });
    ok("link.run_failed", { runId: "r1", machineId, error: "boom" });
    ok("link.project_received", { projectId: "p1", machineId, name: "Book club" });
    ok("link.run_accepted", { runId: "r1", machineId, projectId: "p1" });
    ok("link.decision_received", { runId: "r1", actionId: "a1", machineId, decision: "allow" });
    ok("link.mirrored", { machineId, origin: origin(), signature: "c".repeat(128) });
    ok("link.changes_imported", { runId: "r1", machineId, commit: "d".repeat(40) });
  });

  it("refuses a short signature, eleven connections, a bad decision and extra keys", () => {
    bad("link.mirrored", { machineId, origin: origin(), signature: "c".repeat(127) });
    bad("link.mirrored", { machineId, origin: origin({ type: "card.moved" }), signature: "c".repeat(128) });
    bad("link.run_requested", { runId: "r1", machineId, adapter: "codex", prompt: "go", cardId: null, connectionIds: Array(11).fill("c") });
    bad("link.run_requested", { runId: "r1", machineId, adapter: "other", prompt: "go", cardId: null, connectionIds: [] });
    bad("link.decision_received", { runId: "r1", actionId: "a1", machineId, decision: "maybe" });
    bad("link.run_failed", { runId: "r1", machineId, error: "x".repeat(501) });
    bad("link.changes_imported", { runId: "r1", machineId, commit: "d".repeat(39) });
    bad("link.run_accepted", { runId: "r1", machineId, projectId: "p1", extra: 1 });
  });

  it("puts every link payload schema into eventPayloadSchemas", () => {
    for (const type of Object.keys(linkPayloadSchemas)) expect(eventPayloadSchemas).toHaveProperty([type]);
    expect(Object.keys(linkPayloadSchemas)).toHaveLength(13);
  });
});

describe("wire schemas", () => {
  const proof = "e".repeat(64);
  it("accepts version 1 and refuses any other", () => {
    const pair = { v: 1, machineId, name: "Mac", port: 4418, proof };
    expect(pairRequestSchema.safeParse(pair).success).toBe(true);
    expect(pairRequestSchema.safeParse({ ...pair, v: 2 }).success).toBe(false);
    expect(pairRequestSchema.safeParse({ ...pair, proof: "e".repeat(63) }).success).toBe(false);
    expect(pairResponseSchema.safeParse(pair).success).toBe(true);
    expect(pairResponseSchema.safeParse({ ...pair, extra: 1 }).success).toBe(false);
    expect(helloResponseSchema.safeParse({ v: 1, machineId, name: "Mac", linking: true }).success).toBe(true);
    expect(helloResponseSchema.safeParse({ v: 1, machineId, name: "Mac", linking: false }).success).toBe(false);
  });

  it("bounds a remote start and a remote decision", () => {
    const start = { v: 1, projectId: "p1", projectName: "Book club", adapter: "codex", prompt: "go", cardId: null, connectionIds: [] };
    expect(remoteStartSchema.safeParse(start).success).toBe(true);
    expect(remoteStartSchema.safeParse({ ...start, prompt: "" }).success).toBe(false);
    expect(remoteStartSchema.safeParse({ ...start, connectionIds: Array(11).fill("c") }).success).toBe(false);
    expect(remoteDecisionSchema.safeParse({ v: 1, decision: "deny", reason: "no" }).success).toBe(true);
    expect(remoteDecisionSchema.safeParse({ v: 1, decision: "deny", reason: "x".repeat(501) }).success).toBe(false);
  });

  it("checks a mirror frame's origin and signature", () => {
    expect(mirrorFrameSchema.safeParse({ origin: origin(), signature: "c".repeat(128) }).success).toBe(true);
    expect(mirrorFrameSchema.safeParse({ origin: origin(), signature: "c".repeat(127) }).success).toBe(false);
  });

  it("validates a machine's capacity and drops the worker's own hardware switch", () => {
    const capacity = {
      machineId, name: "GPU box", online: true, checkedAt: "2026-11-15T10:00:00.000Z",
      hardware: {
        cpu: "Ryzen", cores: 16, memoryGb: 64, gpu: "RTX 4090", gpuMemoryGb: 24, platform: "linux", wsl: false,
        detectedAt: "2026-11-15T09:00:00.000Z", enabled: true,
      },
      localModels: [{
        engine: "ollama", baseUrl: "http://127.0.0.1:11434/v1", version: "0.5.0", detectedAt: "2026-11-15T09:00:00.000Z",
        models: [{ id: "qwen2.5-coder:14b", sizeBytes: 9_000_000_000, parameters: "14B", quantization: "Q4_K_M" }],
      }],
      sources: [],
      adapters: ["codex"],
      connections: [{ id: "c1", kind: "llm", provider: "local_model", name: "Qwen" }],
    };
    const parsed = machineCapacitySchema.safeParse(capacity);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.hardware).not.toHaveProperty("enabled");
    expect(machineCapacitySchema.safeParse({ ...capacity, hardware: null }).success).toBe(true);
    expect(machineCapacitySchema.safeParse({ ...capacity, adapters: ["other"] }).success).toBe(false);
    expect(machineCapacitySchema.safeParse({ ...capacity, connections: [{ id: "c1", kind: "llm", provider: "x", name: "n" }] }).success).toBe(false);
    expect(machineCapacitySchema.safeParse({ ...capacity, localModels: [{ ...capacity.localModels[0], engine: "vllm" }] }).success).toBe(false);
  });
});

describe("innerEntry and runIdOf", () => {
  const H = "a".repeat(64);
  const entry = (type: string, payload: unknown, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    seq: 7, id: "e7", ts: "2026-11-15T00:00:00.000Z", projectId: "p1", actor: { kind: "system", id: "link" },
    type: type as LedgerEntry["type"], payload, prevHash: H, hash: H, ...over,
  });
  const origin = {
    seq: 3, id: "w3", ts: "2026-11-14T00:00:00.000Z", projectId: "p1", actor: { kind: "agent", id: "r1" },
    type: "agent.message", payload: { runId: "r1", text: "hi" }, prevHash: H, hash: H,
  };

  it("returns any other entry as it is, and its payload's runId", () => {
    const e = entry("agent.message", { runId: "r1", text: "hi" });
    expect(innerEntry(e)).toBe(e);
    expect(runIdOf(e)).toBe("r1");
    expect(runIdOf(entry("card.moved", { cardId: "c1", from: "idea", to: "build" }))).toBeUndefined();
    expect(runIdOf(entry("agent.message", { runId: 5 }))).toBeUndefined();
    expect(runIdOf(entry("agent.message", null))).toBeUndefined();
  });

  it("unwraps a link.mirrored entry to the worker's own entry, and reads its run", () => {
    const e = entry("link.mirrored", { machineId: "b".repeat(32), origin, signature: "c".repeat(128) });
    expect(innerEntry(e)).toEqual(origin);
    expect(runIdOf(e)).toBe("r1");
  });

  it("leaves a link.mirrored entry whose origin is unreadable as it is", () => {
    for (const bad of [null, "x", { ...origin, type: "card.moved" }, { ...origin, payload: [] }, { ...origin, actor: null }]) {
      const e = entry("link.mirrored", { machineId: "b".repeat(32), origin: bad, signature: "c".repeat(128) });
      expect(innerEntry(e)).toBe(e);
    }
    expect(runIdOf(entry("link.mirrored", { origin: { ...origin, type: "card.moved" } }))).toBeUndefined();
  });
});
