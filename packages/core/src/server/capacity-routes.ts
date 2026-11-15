import type { FastifyInstance } from "fastify";
import type { AuthMode, CapacityReport, HardwareInfo, Provider } from "@theterminal/shared";
import { capacityReport } from "../capacity/report.js";
import type { ConnectionService } from "../connections/service.js";
import type { Db } from "../db.js";

export type CapacityRouteDeps = {
  db: Db;
  connections: ConnectionService;
  modes: (p: Provider) => AuthMode;
  /** Detects this computer's hardware; never throws. */
  hardware: () => Promise<HardwareInfo>;
};

const actor = { kind: "human", id: "owner" } as const;

/** Capacity: usage per provider, budgets, observed rate limits and this computer. Errors are mapped in routes.ts. */
export function registerCapacityRoutes(app: FastifyInstance, deps: CapacityRouteDeps): void {
  const { db, connections, modes, hardware } = deps;

  app.get("/api/capacity", async (): Promise<CapacityReport> =>
    capacityReport(db, { budgets: () => connections.budgets(), modes, hardware: () => connections.hardware() }),
  );

  // The UI sends this with no body and no content-type.
  app.post("/api/capacity/detect", async (): Promise<HardwareInfo> => {
    const info = await hardware();
    await connections.writeHardware(actor, info);
    return info;
  });
}
