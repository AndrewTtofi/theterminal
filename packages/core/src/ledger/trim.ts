import { OWNER_ID, type LedgerEntry, type Principal } from "@theterminal/shared";

/** What only the Owner sees of a `connection.*` payload: the config values, and the names of the secret and private fields. */
const OWNER_ONLY_FIELDS = ["config", "secretFields", "privateFields"] as const;

/**
 * A ledger entry as `principal` may see it. The Owner sees every entry whole. Anyone else (and nobody, failing
 * closed) sees a connection entry without its config, its secret field names and its private field names, and a
 * `connection.updated` without `changes.config`: those are the Owner's business, as the connection details are.
 * Every other entry is returned as it is. The given entry is never changed.
 */
export function trimForRole(e: LedgerEntry, principal: Pick<Principal, "personId"> | null): LedgerEntry {
  if (principal?.personId === OWNER_ID) return e;
  if (!e.type.startsWith("connection.")) return e;
  const p = e.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return e;
  const payload: Record<string, unknown> = { ...(p as Record<string, unknown>) };
  let trimmed = false;
  for (const field of OWNER_ONLY_FIELDS) {
    if (field in payload) {
      delete payload[field];
      trimmed = true;
    }
  }
  const changes = payload.changes;
  if (typeof changes === "object" && changes !== null && !Array.isArray(changes) && "config" in changes) {
    const { config: _config, ...rest } = changes as Record<string, unknown>;
    payload.changes = rest;
    trimmed = true;
  }
  return trimmed ? { ...e, payload } : e;
}

/** `trimForRole` bound to one principal, to pass down beside `clean`. */
export const trimmerFor = (principal: Pick<Principal, "personId"> | null) => (e: LedgerEntry): LedgerEntry => trimForRole(e, principal);
