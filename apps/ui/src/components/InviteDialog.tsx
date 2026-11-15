import { useEffect, useId, useRef, useState } from "react";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@theterminal/shared";
import type { Role } from "@theterminal/shared";
import { api, errorMessage } from "../api";
import type { NewInvite } from "../api";

type Props = {
  /** Whether remote access is on: an invitation made while it is off works on this computer only. */
  remoteOn: boolean;
  onClose: () => void;
  /** After an invitation was made: the caller reads the invitations again. */
  onCreated?: () => void;
};

const ROLES: Role[] = ["viewer", "reviewer", "maintainer"];
const LINE =
  "This link works once and expires in 7 days. Send it over a channel you trust, and tell the person the certificate fingerprint some other way too.";
const OFF = "Remote access is off: this link only works on this computer. Turn it on under Remote access to invite someone else.";

/**
 * The Owner's invitation: a role, then the link, shown here once (the server never returns its code again). Closing
 * the dialog forgets it.
 */
export function InviteDialog({ remoteOn, onClose, onCreated }: Props) {
  const name = useId();
  const [role, setRole] = useState<Role>("viewer");
  const [made, setMade] = useState<NewInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDialogElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    if (made) linkRef.current?.focus();
  }, [made]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setMade(await api.createInvite(role));
      onCreated?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      linkRef.current?.select();
    }
  };

  return (
    <dialog open className="invite-dialog" aria-label="Invite someone" aria-modal="false" ref={root}>
      <h2>Invite someone</h2>
      {made === null ? (
        <>
          <fieldset>
            <legend>Role</legend>
            {ROLES.map((r) => (
              <label key={r} className="role-choice">
                <input type="radio" name={name} value={r} checked={role === r} onChange={() => setRole(r)} />
                <span>
                  <strong>{ROLE_LABELS[r]}</strong>
                  <span className="note">{ROLE_DESCRIPTIONS[r]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={busy} onClick={() => void create()}>
            Create invitation
          </button>
        </>
      ) : (
        <>
          <label htmlFor={`${name}-link`}>Invitation link</label>
          <input id={`${name}-link`} ref={linkRef} readOnly value={made.url} onFocus={(e) => e.target.select()} />
          <button type="button" onClick={() => void copy()}>
            Copy link
          </button>
          <span role="status">{copied ? "Copied." : ""}</span>
          <p>{LINE}</p>
          {made.fingerprint !== null && (
            <p>
              Certificate fingerprint: <code>{made.fingerprint}</code>
            </p>
          )}
          {!remoteOn && <p className="note">{OFF}</p>}
        </>
      )}
      {error !== null && <p role="alert">{error}</p>}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
