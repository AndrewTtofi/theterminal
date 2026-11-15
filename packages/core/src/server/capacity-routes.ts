import type { FastifyInstance } from "fastify";
import type { AuthMode, CapacityReport, HardwareInfo, LocalEngine, MachineCapacity, Provider } from "@theterminal/shared";
import { capacityReport } from "../capacity/report.js";
import type { ConnectionService } from "../connections/service.js";
import type { Db } from "../db.js";
import { actorOf, needs } from "./auth.js";

export type CapacityRouteDeps = {
  db: Db;
  connections: ConnectionService;
  modes: (p: Provider) => AuthMode;
  /** Detects this computer's hardware; never throws. */
  hardware: () => Promise<HardwareInfo>;
  /** Detects the model servers on this computer (see detectLocalEngines). A failure counts as none found. */
  localEngines: () => Promise<LocalEngine[]>;
  /** The paired machines as they answer (each within 3 s, all at once; see LinkCapacity.all). Default: none. */
  machines?: () => Promise<MachineCapacity[]>;
  /** How long a local model detection is reused. Default 30 s. */
  localEnginesTtlMs?: number;
  now?: () => number;
};

const LOCAL_ENGINES_TTL_MS = 30_000;

/** Capacity: usage per provider, budgets, observed rate limits and this computer. Errors are mapped in routes.ts. */
export function registerCapacityRoutes(app: FastifyInstance, deps: CapacityRouteDeps): { report: () => Promise<CapacityReport> } {
  const { db, connections, modes, hardware } = deps;
  const ttl = deps.localEnginesTtlMs ?? LOCAL_ENGINES_TTL_MS;
  const now = deps.now ?? Date.now;
  // One detection at a time; a GET within the TTL reuses the last one.
  let cached: { at: number; engines: Promise<LocalEngine[]> } | null = null;
  const detect = (): Promise<LocalEngine[]> => {
    const engines = deps.localEngines().catch(() => []);
    cached = { at: now(), engines };
    return engines;
  };
  const localEngines = (): Promise<LocalEngine[]> =>
    cached !== null && now() - cached.at < ttl ? cached.engines : detect();

  /** This computer's own report: what `/link/v1/capacity` tells a paired machine is built from it. */
  const local = async (machines: MachineCapacity[] = [], found?: LocalEngine[]): Promise<CapacityReport> => {
    const engines = found ?? (await localEngines());
    return capacityReport(db, {
      budgets: () => connections.budgets(), modes, hardware: () => connections.hardware(), localModels: () => engines,
      machines: () => machines,
    });
  };

  // Usage, budgets, this computer and the linked machines; connections appear by id, kind, provider and name only.
  app.get("/api/capacity", needs("viewer"), async (): Promise<CapacityReport> => {
    const [machines, engines] = await Promise.all([deps.machines?.() ?? Promise.resolve([]), localEngines()]);
    return local(machines, engines);
  });

  // The UI sends this with no body and no content-type. It detects the model servers again too.
  app.post("/api/capacity/detect", needs("owner"), async (req): Promise<HardwareInfo> => {
    const [info] = await Promise.all([hardware(), detect()]);
    await connections.writeHardware(actorOf(req), info);
    return info;
  });

  return { report: () => local() };
}
