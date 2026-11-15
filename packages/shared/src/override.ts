import { z } from "zod";

/**
 * The emergency override: the Owner acting directly on one run's working copy, outside the agent gate. Two
 * actions exist, `command` (run a program the Owner names) and `discard` (drop the run's uncommitted changes);
 * each records its request before it starts and `override.completed` after it ends.
 */

/** Why the Owner is overriding: 10 to 500 characters, recorded with the entry. */
export const OVERRIDE_REASON = z.string().min(10).max(500);
/** A bare program name; absolute paths are also accepted by the service. */
export const OVERRIDE_PROGRAM = /^[A-Za-z0-9_.+-]{1,100}$/;

const id = z.string().min(1).max(200);

export const overridePayloadSchemas = {
  "override.command": z
    .object({
      overrideId: id,
      runId: id,
      program: z.string().min(1).max(260),
      args: z.array(z.string().max(1000)).max(64),
      cwd: z.string().min(1).max(500),
      reason: OVERRIDE_REASON,
    })
    .strict(),
  "override.discard": z
    .object({ overrideId: id, runId: id, reason: OVERRIDE_REASON, files: z.number().int().nonnegative() })
    .strict(),
  "override.completed": z
    .object({
      overrideId: id,
      runId: id,
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      signal: z.string().max(20).nullable(),
      timedOut: z.boolean(),
      durationMs: z.number().int().nonnegative(),
      output: z.string().max(16000),
    })
    .strict(),
};
export type OverrideEventType = keyof typeof overridePayloadSchemas;

export const OVERRIDE_MEANS =
  "An emergency override is you acting directly on the project instead of asking an agent. It is recorded in red in the ledger as an exception, with your reason.";
