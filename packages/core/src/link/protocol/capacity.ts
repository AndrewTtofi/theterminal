import type { FastifyInstance } from "fastify";
import {
  ADAPTERS, machineCapacityBodySchema, type AdapterId, type CapacityReport, type MachineCapacityBody,
} from "@theterminal/shared";
import type { ConnectionService } from "../../connections/service.js";
import type { LinkProtocolDeps } from "../protocol-routes.js";

/** What this computer tells a paired machine about itself. */
export type CapacityProtocolDeps = {
  /** This computer's own capacity report (its sources, hardware and local model servers). */
  report: () => Promise<CapacityReport>;
  /** The registered adapters whose program is available here. */
  adapters: () => AdapterId[];
  connections: Pick<ConnectionService, "publicConnections" | "publicText">;
};

const MAX_ENGINES = 10;
const MAX_MODELS = 500;
const MAX_MODEL_ID = 200;
const MAX_CONNECTIONS = 200;

/**
 * This computer's capacity as it leaves the computer: built only from fields chosen here, never by copying a stored
 * object. Hardware without its `enabled` switch (none while the Owner has This computer turned off), the local model
 * servers, each source with its name and plan cleaned like a public connection name, the available adapters, and the
 * public connections (ids, kinds, providers and cleaned names). Checked with the schema the requester uses.
 */
export async function capacityBody(deps: CapacityProtocolDeps): Promise<MachineCapacityBody> {
  const report = await deps.report();
  const hw = report.hardware;
  const { connections } = deps;
  const available = deps.adapters();
  return machineCapacityBodySchema.parse({
    hardware:
      hw === null || !hw.enabled
        ? null
        : { cpu: hw.cpu, cores: hw.cores, memoryGb: hw.memoryGb, gpu: hw.gpu, gpuMemoryGb: hw.gpuMemoryGb, platform: hw.platform, wsl: hw.wsl, detectedAt: hw.detectedAt },
    localModels: report.localModels.slice(0, MAX_ENGINES).map((e) => ({
      engine: e.engine,
      baseUrl: e.baseUrl,
      version: e.version,
      models: e.models
        .filter((m) => m.id.length <= MAX_MODEL_ID)
        .slice(0, MAX_MODELS)
        .map((m) => ({ id: m.id, sizeBytes: m.sizeBytes, parameters: m.parameters, quantization: m.quantization })),
      detectedAt: e.detectedAt,
    })),
    sources: report.sources.map((s) => {
      const plan = s.plan === null ? "" : connections.publicText(s.plan);
      return {
        provider: s.provider,
        connectionId: s.connectionId,
        name: connections.publicText(s.name) || s.provider,
        mode: s.mode,
        plan: plan === "" ? null : plan,
        monthlyBudgetUsd: s.monthlyBudgetUsd,
        today: s.today,
        month: s.month,
        rateLimits: s.rateLimits,
      };
    }),
    adapters: ADAPTERS.filter((id) => available.includes(id)),
    connections: connections.publicConnections().slice(0, MAX_CONNECTIONS),
  });
}

/** `GET /link/v1/capacity`: this computer's hardware, local models, sources, adapters and connections, to a paired machine only. */
export function registerCapacity(app: FastifyInstance, deps: LinkProtocolDeps): void {
  const capacity = deps.capacity;
  if (!capacity) return;
  app.get("/link/v1/capacity", async (request, reply) => {
    // The listener's hook already refused an unknown key; checked again so this route never answers one.
    if (request.linkPeer === null) return reply.code(403).send({ error: "unknown_machine" });
    return capacityBody(capacity);
  });
}
