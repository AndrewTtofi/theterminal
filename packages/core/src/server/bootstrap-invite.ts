import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_ID, type Actor } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { listInvites } from "../events/projections.js";
import type { PeopleService } from "../people/service.js";

/** `<dataDir>/bootstrap-invite`: the bootstrap link for an operator who keeps out of the logs. Mode 0600. */
export const BOOTSTRAP_INVITE_FILE = "bootstrap-invite";

/** The line the CLI prints, once per start, while nobody has claimed the Owner identity. */
export const BOOTSTRAP_LINE = "Open this link once to claim the Owner identity:";

/** The bootstrap invite is the Owner's own: the invite service takes human actors only. */
const OWNER_ACTOR: Actor = { kind: "human", id: OWNER_ID };

/** Removes the bootstrap file. Never throws: a file left behind holds a link that is dead once the Owner joined. */
export function removeBootstrapInvite(dataDir: string): void {
  try {
    rmSync(join(dataDir, BOOTSTRAP_INVITE_FILE), { force: true });
  } catch {
    // Best effort.
  }
}

/** Writes the file through a 0600 temp file renamed into place, so it never exists with a looser mode. */
function writeBootstrapFile(dataDir: string, url: string): void {
  const file = join(dataDir, BOOTSTRAP_INVITE_FILE);
  const temp = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temp, `${url}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600); // a umask cannot loosen it, and a stricter one does not hide it from the server itself
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The Owner bootstrap invite for a server nobody has claimed yet. While the Owner has no credential: every pending
 * owner invite is revoked (so a link in an older log is dead), a new one is issued for an hour (PeopleService caps
 * owner invites there), and its link is written to `<dataDir>/bootstrap-invite`; the link is returned for the CLI to
 * print once. Once the Owner has a credential: the file is removed and null is returned, every start after that.
 */
export function issueBootstrapInvite(deps: {
  db: Db;
  people: Pick<PeopleService, "invite" | "revokeInvite" | "hasOwnerCredential">;
  dataDir: string;
  /** The join link for a code: `https://<address>:<port>/join/<code>#fp=<fingerprint>`. */
  urlFor: (code: string) => string;
  now?: () => Date;
}): string | null {
  if (deps.people.hasOwnerCredential()) {
    removeBootstrapInvite(deps.dataDir);
    return null;
  }
  const now = deps.now ?? (() => new Date());
  for (const invite of listInvites(deps.db, now())) {
    if (invite.role === "owner" && invite.status === "pending") deps.people.revokeInvite(OWNER_ACTOR, invite.id);
  }
  const { code } = deps.people.invite(OWNER_ACTOR, "owner");
  const url = deps.urlFor(code);
  writeBootstrapFile(deps.dataDir, url);
  return url;
}

/** Removes the bootstrap file as soon as the Owner's first credential is recorded. Returns the unsubscribe. */
export function watchBootstrapInvite(ledger: Pick<Ledger, "onAppend">, dataDir: string): () => void {
  return ledger.onAppend((e) => {
    if (e.type === "person.credential_added" && (e.payload as { personId?: unknown }).personId === OWNER_ID) {
      removeBootstrapInvite(dataDir);
    }
  });
}
