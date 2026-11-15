import { machineCapacityBodySchema, type MachineCapacity, type MachineCapacityBody } from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import { MachineKeyMismatchError } from "./client.js";
import type { LinkService } from "./service.js";

export type LinkCapacityDeps = {
  link: LinkService;
  now?: () => Date;
  /** How long an answer (or a failure) is reused. Default 30 s. */
  ttlMs?: number;
  /** How long one machine may take to answer before it counts as offline. Default 3 s. */
  timeoutMs?: number;
};

const TTL_MS = 30_000;
const TIMEOUT_MS = 3_000;
const NOTHING: MachineCapacityBody = { hardware: null, localModels: [], sources: [], adapters: [], connections: [] };

/**
 * The linked machines' capacity, as this computer asks for it over the link (`GET /link/v1/capacity`, mTLS with the
 * paired key pinned). What a worker sends is untrusted: it is checked with the schema (bounded lengths and counts,
 * unknown fields dropped) and the machine's id and name are this computer's own records, never the worker's say.
 * A machine that does not answer, refuses or sends something unreadable is offline, with the last values it sent (kept
 * in memory only) and when it last answered; nothing from a refusal is kept. One whose address presents another key
 * is never just offline: capacityOf throws MachineKeyMismatchError (409 `machine_key_mismatch`) and all() flags it.
 */
export class LinkCapacity {
  private readonly link: LinkService;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly cached = new Map<string, { at: number; value: MachineCapacity }>();
  private readonly inFlight = new Map<string, Promise<MachineCapacity>>();
  private readonly lastGood = new Map<string, { body: MachineCapacityBody; at: string }>();

  constructor(deps: LinkCapacityDeps) {
    this.link = deps.link;
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * One paired machine's capacity; reused for 30 s unless `fresh`. Concurrent asks share one request. NotFoundError
   * for a machine that is not paired, MachineKeyMismatchError for one presenting another key; never throws for a
   * machine that does not answer.
   */
  async capacityOf(machineId: string, opts: { fresh?: boolean } = {}): Promise<MachineCapacity> {
    const machine = this.link.machines().find((m) => m.id === machineId);
    if (!machine) throw new NotFoundError("machine", machineId);
    if (!opts.fresh) {
      const hit = this.cached.get(machineId);
      if (hit && this.now().getTime() - hit.at < this.ttlMs) return { ...hit.value, name: machine.name };
      const pending = this.inFlight.get(machineId);
      if (pending) return pending;
    }
    const check = this.fetch(machineId, machine.name);
    this.inFlight.set(machineId, check);
    try {
      return await check;
    } finally {
      if (this.inFlight.get(machineId) === check) this.inFlight.delete(machineId);
    }
  }

  /** Every paired machine at once, each within the timeout (one that takes longer is offline this time). */
  all(): Promise<MachineCapacity[]> {
    return Promise.all(
      this.link.machines().map(async (m) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<MachineCapacity>((resolve) => {
          timer = setTimeout(() => resolve(this.offline(m.id, m.name)), this.timeoutMs);
        });
        try {
          const asked = this.capacityOf(m.id).catch((err: unknown) =>
            err instanceof MachineKeyMismatchError ? this.keyMismatch(m.id, m.name) : this.offline(m.id, m.name),
          );
          return await Promise.race([asked, late]);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }

  private async fetch(machineId: string, name: string): Promise<MachineCapacity> {
    let value: MachineCapacity;
    try {
      const client = this.link.newClient(this.timeoutMs);
      const body = await client.request(this.link.peerFor(machineId), "GET", "/link/v1/capacity", undefined, machineCapacityBodySchema);
      const at = this.now().toISOString();
      this.lastGood.set(machineId, { body, at });
      value = { ...body, machineId, name, online: true, checkedAt: at, lastSeenAt: at, problem: null };
    } catch (err) {
      if (err instanceof NotFoundError) throw err; // unpaired while asking
      // Another key at the paired address is not "offline": the caller says so, the machine's presence says so, and
      // nothing is cached or kept.
      if (err instanceof MachineKeyMismatchError) {
        this.link.observed(machineId, false, "key_mismatch");
        throw err;
      }
      // Unreachable, refused, an unreadable reply, no identity: all the same to the reader, offline.
      value = this.offline(machineId, name);
    }
    this.cached.set(machineId, { at: this.now().getTime(), value });
    return value;
  }

  private offline(machineId: string, name: string): MachineCapacity {
    const last = this.lastGood.get(machineId);
    return {
      ...(last?.body ?? NOTHING), machineId, name, online: false, checkedAt: this.now().toISOString(), lastSeenAt: last?.at ?? null, problem: null,
    };
  }

  /** A machine whose paired address presented another key: flagged, with none of the values the paired key sent. */
  private keyMismatch(machineId: string, name: string): MachineCapacity {
    return { ...NOTHING, machineId, name, online: false, checkedAt: this.now().toISOString(), lastSeenAt: null, problem: "key_mismatch" };
  }
}
