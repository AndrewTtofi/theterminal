import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LINKING_ACK } from "@theterminal/shared";
import type { MachineCapacity, MachinePresence } from "@theterminal/shared";
import { ApiError, api, errorMessage } from "../api";
import type { LinkSelf } from "../api";
import { useShell } from "../shell/model";
import { KEY_CHANGED, hardwareSummary, shownName } from "./machine-text";

export { shownName } from "./machine-text";

const REFRESH_MS = 30_000;
const NAME_HELP = 'Pick a short name such as "Mac" or "GPU desktop". It is recorded in the ledger of every machine you link.';
export const NO_IDENTITY = "Your keychain is unavailable, so this computer has no identity for linking.";

/** The first 16 hex characters of a fingerprint in groups of four, as the pairing code carries them. */
export function fingerprintGroups(fingerprint: string): string {
  return (fingerprint.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}


/** Asks for the overview at once and every `ms` while mounted. */
export function useMachinesRefresh(refresh: () => void, ms = REFRESH_MS): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    ref.current();
    const timer = setInterval(() => ref.current(), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

function presence(m: MachinePresence): "online" | "offline" | "not checked" {
  return m.online === null ? "not checked" : m.online ? "online" : "offline";
}

/** This computer: its name (renamed in place), its fingerprint, and the linking switch with its acknowledgement. */
function ThisComputer({ self, refresh }: { self: LinkSelf; refresh: () => void }) {
  const uid = useId();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(self.name);
  const [asking, setAsking] = useState(false);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (asking) checkboxRef.current?.focus();
  }, [asking]);

  const act = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const closeDialog = () => {
    setAsking(false);
    setRead(false);
    switchRef.current?.focus();
  };

  const toggle = () => {
    if (self.linking.enabled) void act(() => api.disableLinking());
    else setAsking(true);
  };

  const allow = async () => {
    if (!read) return;
    if (await act(() => api.enableLinking(LINKING_ACK))) closeDialog();
  };

  /** Set while a rename is being sent: a second Enter before the first answer sends nothing. */
  const renamingNow = useRef(false);
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (next === "" || renamingNow.current) return;
    renamingNow.current = true;
    try {
      if (await act(() => api.renameMachine(next))) setRenaming(false);
    } finally {
      renamingNow.current = false;
    }
  };

  return (
    <section aria-labelledby={`${uid}-this`}>
      <h3 id={`${uid}-this`}>This computer</h3>
      {renaming ? (
        <form className="machine-rename" onSubmit={(e) => void rename(e)}>
          <label htmlFor={`${uid}-name`}>Computer name</label>
          <input
            id={`${uid}-name`}
            value={name}
            maxLength={40}
            autoFocus
            aria-describedby={`${uid}-name-help`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(false);
            }}
          />
          <p id={`${uid}-name-help`} className="help">
            {NAME_HELP}
          </p>
          <div className="machine-actions">
            <button type="submit" disabled={busy || name.trim() === ""}>
              Save
            </button>
            <button type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="machine-name">
          <span>{shownName(self.name)}</span>{" "}
          <button
            type="button"
            onClick={() => {
              setName(self.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
        </p>
      )}
      <p className="machine-fingerprint">
        Fingerprint <code>{fingerprintGroups(self.fingerprint)}</code>
      </p>
      <p className="machine-switch">
        <button
          ref={switchRef}
          type="button"
          role="switch"
          aria-checked={self.linking.enabled}
          aria-label="Allow linking"
          className={`switch${self.linking.enabled ? " on" : ""}`}
          disabled={busy || asking}
          onClick={toggle}
        >
          <span aria-hidden="true" className="switch-knob" />
        </button>
        <span aria-hidden="true">Allow linking</span>
      </p>
      {self.linking.enabled && <p className="machine-linking">{`Linking on · port ${self.linking.port ?? "?"}`}</p>}
      {asking && (
        <div
          className="warning machine-ack"
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${uid}-ack-title`}
          aria-describedby={`${uid}-ack`}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeDialog();
          }}
        >
          <h4 id={`${uid}-ack-title`}>Allow linking</h4>
          <p id={`${uid}-ack`}>{LINKING_ACK}</p>
          <label>
            <input ref={checkboxRef} type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
            I have read this
          </label>
          <div className="machine-actions">
            <button type="button" disabled={!read || busy} onClick={() => void allow()}>
              Allow
            </button>
            <button type="button" onClick={closeDialog}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <p className="capacity-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * A linked machine's hardware on one line, as it last answered (asked when the row appears and whenever its presence
 * changes). Whatever went wrong, the row says one fixed sentence: nothing from a refusal is shown. Another key at its
 * address is an alert, never "unavailable".
 */
function MachineHardware({ id, online }: { id: string; online: boolean | null }) {
  const [capacity, setCapacity] = useState<MachineCapacity | "failed" | "key_changed" | null>(null);
  useEffect(() => {
    let live = true;
    // From the server's 30 s cache, sharing a request already in flight (the Capacity view may have asked).
    api.getMachineCapacity(id, true).then(
      (c) => live && setCapacity(c),
      (e: unknown) => live && setCapacity(e instanceof ApiError && e.code === "machine_key_mismatch" ? "key_changed" : "failed"),
    );
    return () => {
      live = false;
    };
  }, [id, online]);
  if (capacity === null) return null;
  if (capacity === "key_changed") {
    return (
      <p className="warning machine-key-changed" role="alert">
        {KEY_CHANGED}
      </p>
    );
  }
  const text =
    capacity === "failed" ? "Hardware unavailable" : capacity.hardware === null ? "Hardware not reported" : shownName(hardwareSummary(capacity.hardware));
  return <p className="machine-hardware">{text}</p>;
}

function MachineRow({ m, refresh }: { m: MachinePresence; refresh: () => void }) {
  const uid = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = shownName(m.name);
  const state = presence(m);
  const keepRef = useRef<HTMLButtonElement>(null);
  const unlinkRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes after the confirmation opens or closes; null leaves it alone (the first render). */
  const [focusTo, setFocusTo] = useState<"confirm" | "unlink" | null>(null);
  useEffect(() => {
    if (focusTo === "confirm") keepRef.current?.focus();
    else if (focusTo === "unlink") unlinkRef.current?.focus();
  }, [focusTo]);

  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.unpairMachine(m.id);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <li aria-labelledby={`${uid}-name`}>
      <h4 id={`${uid}-name`}>{name}</h4>
      <p>
        <span className={`machine-dot ${state.replace(" ", "-")}`}>{state}</span>
      </p>
      <MachineHardware id={m.id} online={m.online} />
      <p className="machine-fingerprint">
        Fingerprint <code>{fingerprintGroups(m.fingerprint)}</code>
      </p>
      {confirming ? (
        <div role="group" aria-label={`Unlink "${name}"?`} className="machine-confirm">
          <p>{`Unlink "${name}"? This computer stops accepting it until you pair them again.`}</p>
          <div className="machine-actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void unlink()}>
              Unlink
            </button>
            <button
              ref={keepRef}
              type="button"
              onClick={() => {
                setConfirming(false);
                setFocusTo("unlink");
              }}
            >
              Keep
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={unlinkRef}
          type="button"
          aria-label={`Unlink "${name}"`}
          onClick={() => {
            setConfirming(true);
            setFocusTo("confirm");
          }}
        >
          Unlink
        </button>
      )}
      {error !== null && (
        <p className="capacity-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The Machines view: this computer's identity and linking switch, the linked machines, and Link a machine. */
export function MachinesSideBar() {
  const { model, dock } = useShell();
  const { overview, error, refresh } = model.machines;
  const uid = useId();
  useMachinesRefresh(refresh);

  if (overview === null && error !== null) return <p className="empty">Could not load machines</p>;
  if (overview === null) return <p className="empty">Loading…</p>;
  if (overview.identity === "unavailable" || overview.self === null) return <p className="empty">{NO_IDENTITY}</p>;

  return (
    <div className="capacity-side machines-side">
      <ThisComputer key={overview.self.machineId} self={overview.self} refresh={refresh} />
      <section aria-labelledby={`${uid}-linked`}>
        <h3 id={`${uid}-linked`}>Linked machines</h3>
        {overview.machines.length === 0 ? (
          <p className="empty">No machines linked yet.</p>
        ) : (
          <ul aria-labelledby={`${uid}-linked`} className="machine-list">
            {overview.machines.map((m) => (
              <MachineRow key={m.id} m={m} refresh={refresh} />
            ))}
          </ul>
        )}
        <button type="button" onClick={() => dock()?.open("link_machine", "Link a machine", "main")}>
          Link a machine
        </button>
      </section>
    </div>
  );
}
