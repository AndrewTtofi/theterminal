import type { MachinePresence } from "@theterminal/shared";
import type { LinkOverview, LinkSelf } from "../src/api";

export const SELF_FP = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
export const PEER_FP = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

export function self(over: Partial<LinkSelf> = {}): LinkSelf {
  return { machineId: "11".repeat(16), fingerprint: SELF_FP, name: "Mac", linking: { enabled: false, port: null }, ...over };
}

export function machine(over: Partial<MachinePresence> = {}): MachinePresence {
  return {
    id: "22".repeat(16),
    name: "GPU box",
    publicKey: "A".repeat(60),
    fingerprint: PEER_FP,
    address: "192.168.1.20:4418",
    role: "entered_code",
    pairedAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
    online: true,
    checkedAt: "2026-11-15T10:01:00.000Z",
    problem: null,
    ...over,
  };
}

export function overview(over: Partial<LinkOverview> = {}): LinkOverview {
  return { identity: "ok", self: self(), machines: [], discovered: [], ...over };
}
