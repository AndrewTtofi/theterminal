import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OWNER_ID, type NewLedgerEntry, type Role } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvents } from "../../src/events/commit.js";
import { SessionStore } from "../../src/people/sessions.js";
import { SESSION_COOKIE } from "../../src/server/auth.js";

export type SeededPerson = { id: string; name: string; role: Role };

/** A viewer, a reviewer and a maintainer, as most role tests want them. */
export const COLLABORATORS: SeededPerson[] = [
  { id: "p-viewer", name: "Viewer One", role: "viewer" },
  { id: "p-reviewer", name: "Reviewer One", role: "reviewer" },
  { id: "p-maintainer", name: "Maintainer One", role: "maintainer" },
];

/**
 * Writes people into a data folder's ledger, with a signed-in local session each, before a server opens it. The
 * server rebuilds its projections from these entries at start and finds the sessions in place. Returns the Cookie
 * header for each person, by id. Only for a data folder no server has open.
 */
export function seedPeople(dataDir: string, people: SeededPerson[] = COLLABORATORS): Record<string, string> {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "ledger.db"));
  try {
    const ledger = new Ledger(db);
    const owner = { kind: "human", id: OWNER_ID } as const;
    commitEvents(db, ledger, () => ({
      events: people.flatMap((p): NewLedgerEntry[] => [
        {
          projectId: null, actor: owner, type: "person.invited",
          payload: { inviteId: `invite-${p.id}`, role: p.role, codeHash: createHash("sha256").update(`invite-${p.id}`).digest("hex"), expiresAt: "2099-01-01T00:00:00.000Z" },
        },
        {
          projectId: null, actor: { kind: "human", id: p.id }, type: "person.joined",
          payload: {
            personId: p.id, inviteId: `invite-${p.id}`, name: p.name, role: p.role,
            credential: { kind: "key", credentialId: `key-${p.id}`, publicKey: `TESTKEY-${p.id}`, label: "CLI" },
          },
        },
      ]),
      result: () => undefined,
    }));
    const sessions = new SessionStore(db);
    return Object.fromEntries(people.map((p) => [p.id, `${SESSION_COOKIE}=${sessions.create(p.id, "local", "passkey").id}`]));
  } finally {
    db.close();
  }
}
