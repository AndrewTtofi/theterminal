import { OWNER_ID, type LedgerEntry, type Principal } from "@theterminal/shared";

/** What only the Owner sees of any `connection.*` payload: the config values, and the names of the secret and private fields. */
const CONNECTION_FIELDS = ["config", "secretFields", "privateFields"] as const;
/** What only the Owner sees of a `connection.updated`'s `changes`: the config, and which secret or private fields changed. */
const CHANGE_FIELDS = ["config", "secretsSet", "secretsRemoved", "privateSet", "privateRemoved"] as const;
/**
 * Payload keys only the Owner sees, by entry type: a tester's message may name what it looked for; a paired machine's
 * address and the remote listener's interface are the Owner's LAN.
 */
const FIELDS_BY_TYPE: Record<string, readonly string[]> = {
  "connection.tested": ["message"],
  "machine.paired": ["address"],
  "remote.enabled": ["bind"],
};

/**
 * A ledger entry as `principal` may see it. The Owner sees every entry whole. Anyone else (and nobody, failing
 * closed) sees a connection entry without its config, its secret field names and its private field names, a
 * `connection.updated` without `changes.config` or the names of the secret and private fields that changed, a
 * `connection.tested` without its message, a `machine.paired` without the machine's address and a `remote.enabled`
 * without its bind: those are the Owner's business, as the connection details and the Owner's network are.
 * Every other entry is returned as it is. The given entry is never changed.
 */
export function trimForRole(e: LedgerEntry, principal: Pick<Principal, "personId"> | null): LedgerEntry {
  if (principal?.personId === OWNER_ID) return e;
  const fields = [...(e.type.startsWith("connection.") ? CONNECTION_FIELDS : []), ...(FIELDS_BY_TYPE[e.type] ?? [])];
  if (fields.length === 0) return e;
  const p = e.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return e;
  const payload: Record<string, unknown> = { ...(p as Record<string, unknown>) };
  let trimmed = false;
  for (const field of fields) {
    if (field in payload) {
      delete payload[field];
      trimmed = true;
    }
  }
  const changes = payload.changes;
  if (e.type === "connection.updated" && typeof changes === "object" && changes !== null && !Array.isArray(changes)) {
    const rest: Record<string, unknown> = { ...(changes as Record<string, unknown>) };
    for (const field of CHANGE_FIELDS) {
      if (field in rest) {
        delete rest[field];
        trimmed = true;
      }
    }
    if (trimmed) payload.changes = rest;
  }
  return trimmed ? { ...e, payload } : e;
}

/** `trimForRole` bound to one principal, to pass down beside `clean`. */
export const trimmerFor = (principal: Pick<Principal, "personId"> | null) => (e: LedgerEntry): LedgerEntry => trimForRole(e, principal);
