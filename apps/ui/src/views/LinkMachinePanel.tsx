import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { parsePairingCode } from "@theterminal/shared";
import { api, errorMessage } from "../api";
import type { PairingCode } from "../api";
import { useShell } from "../shell/model";
import { NO_IDENTITY, fingerprintGroups, shownName, useMachinesRefresh } from "./MachinesSideBar";

/** How often the Enter a code tab asks again, so machines found on the network appear while it is open. */
const DISCOVERY_MS = 5_000;

type Tab = "show" | "enter";
const TABS: { id: Tab; label: string }[] = [
  { id: "show", label: "Show a code" },
  { id: "enter", label: "Enter a code" },
];

/** What a pairing came to. The fingerprint is for the Owner to compare with the other computer; nothing here compares it. */
type Linked = { name: string; fingerprint: string };

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Said after a pairing on either side. It never says the machines match: only the Owner, looking at both screens,
 * can tell whether the fingerprint below is the one the other computer shows for itself.
 */
function LinkedNote({ linked }: { linked: Linked }) {
  const name = shownName(linked.name);
  return (
    <>
      <strong>{`Linked "${name}".`}</strong>{" "}
      {`Its fingerprint here is ${fingerprintGroups(linked.fingerprint)}. Now compare it with the fingerprint "${name}" shows under This computer in its Machines view. If the two differ, unlink it.`}
    </>
  );
}

function ShowCode({ fingerprint, enabled, onLinked }: { fingerprint: string; enabled: boolean; onLinked: (l: Linked) => void }) {
  const { model, showView } = useShell();
  const [shown, setShown] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /** False once the tab has closed: a code that arrives after that is withdrawn at once, never left open unseen. */
  const mountedRef = useRef(true);

  // Tick once a second while a code is shown; drop it once it has expired.
  useEffect(() => {
    if (shown === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown]);
  const left = shown === null ? 0 : Date.parse(shown.expiresAt) - now;
  useEffect(() => {
    if (shown !== null && left <= 0) {
      setShown(null);
      setExpired(true);
    }
  }, [shown, left]);

  // The other computer entered the code: this one records machine.paired as the side that showed it.
  const { subscribeEntries, machines } = model;
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;
  useEffect(
    () =>
      subscribeEntries((e) => {
        if (e.type !== "machine.paired" || shownRef.current === null) return;
        const p = e.payload as { name?: unknown; fingerprint?: unknown; role?: unknown };
        if (p.role !== "showed_code" || typeof p.name !== "string" || typeof p.fingerprint !== "string") return;
        setShown(null);
        onLinkedRef.current({ name: p.name, fingerprint: p.fingerprint });
        machines.refresh();
      }),
    [subscribeEntries, machines],
  );

  // Closing the tab withdraws a code still shown, so no window stays open unseen.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (shownRef.current !== null) void api.cancelPairingCode().catch(() => {});
    };
  }, []);

  const show = async () => {
    setBusy(true);
    setError(null);
    setExpired(false);
    try {
      const code = await api.showPairingCode();
      if (!mountedRef.current) {
        void api.cancelPairingCode().catch(() => {});
        return;
      }
      setNow(Date.now());
      setShown(code);
    } catch (e) {
      setError(errorMessage(e, "pair"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancelPairingCode();
      setShown(null);
    } catch (e) {
      setError(errorMessage(e, "pair"));
    } finally {
      setBusy(false);
    }
  };

  if (!enabled && shown === null) {
    return (
      <div className="link-note">
        <p>Linking must be on to show a code. Turn on Allow linking in the Machines view.</p>
        <button type="button" onClick={() => showView("machines")}>
          Open the Machines view
        </button>
      </div>
    );
  }

  return (
    <div className="link-show">
      {shown === null ? (
        <>
          <p>Show a one-time code here, then type it on the other computer under Enter a code.</p>
          {expired && <p className="empty">The code expired.</p>}
          <button type="button" disabled={busy} onClick={() => void show()}>
            {expired ? "Show a new code" : "Show a code"}
          </button>
        </>
      ) : (
        <>
          <p className="pairing-code" aria-label="Pairing code">
            {shown.code}
          </p>
          <p>{`Expires in ${mmss(left)}`}</p>
          <p className="machine-fingerprint">
            This computer&apos;s fingerprint <code>{fingerprintGroups(fingerprint)}</code>. The code begins with it.
          </p>
          {shown.addresses.length > 0 && (
            <>
              <p>If the other computer does not find this one, enter one of these addresses there:</p>
              <ul className="link-addresses">
                {shown.addresses.map((a) => (
                  <li key={a}>
                    <code>{a}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
        </>
      )}
      {error !== null && (
        <p className="capacity-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function EnterCode({ onLinked }: { onLinked: (l: Linked) => void }) {
  const { model } = useShell();
  const { overview, refresh } = model.machines;
  const uid = useId();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useMachinesRefresh(refresh, DISCOVERY_MS);
  const found = overview?.discovered ?? [];
  const ready = address.trim() !== "" && parsePairingCode(code) !== null;
  /** Roving tab stop: the one option in the tab order; the arrow keys, Home and End move it. */
  const [active, setActive] = useState(0);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const current = Math.min(active, Math.max(0, found.length - 1));
  const moveTo = (i: number) => {
    setActive(i);
    optionRefs.current[i]?.focus();
  };
  const onOptionKey = (e: KeyboardEvent<HTMLLIElement>, i: number, address: string) => {
    const last = found.length - 1;
    if (e.key === "ArrowDown") moveTo(Math.min(last, i + 1));
    else if (e.key === "ArrowUp") moveTo(Math.max(0, i - 1));
    else if (e.key === "Home") moveTo(0);
    else if (e.key === "End") moveTo(last);
    else if (e.key === "Enter" || e.key === " ") setAddress(address);
    else return;
    e.preventDefault();
  };

  const link = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const m = await api.pairMachine(address.trim(), code);
      setCode("");
      onLinked({ name: m.name, fingerprint: m.fingerprint });
      refresh();
    } catch (err) {
      setError(errorMessage(err, "pair"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="link-enter" onSubmit={(e) => void link(e)}>
      <p id={`${uid}-found`}>Machines found on your network</p>
      {found.length === 0 ? (
        <p className="empty">None found yet. Turn on linking on the other computer, or type its address.</p>
      ) : (
        <ul role="listbox" aria-labelledby={`${uid}-found`} className="link-found">
          {found.map((d, i) => {
            const selected = d.address === address;
            return (
              <li
                key={d.machineId}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                role="option"
                aria-selected={selected}
                tabIndex={i === current ? 0 : -1}
                className={selected ? "selected" : undefined}
                onClick={() => {
                  setActive(i);
                  setAddress(d.address);
                }}
                onKeyDown={(e) => onOptionKey(e, i, d.address)}
              >
                {`${shownName(d.name)} · ${shownName(d.address)}`}
              </li>
            );
          })}
        </ul>
      )}
      <label htmlFor={`${uid}-address`}>Address</label>
      <input
        id={`${uid}-address`}
        value={address}
        placeholder="192.168.1.10:4418"
        maxLength={259}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setAddress(e.target.value)}
      />
      <label htmlFor={`${uid}-code`}>Code</label>
      <input
        id={`${uid}-code`}
        className="pairing-code-input"
        value={code}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
      />
      <button type="submit" disabled={!ready || busy}>
        Link
      </button>
      {error !== null && (
        <p className="capacity-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The Link a machine tab: show a one-time code here, or enter the one another computer shows. */
export function LinkMachinePanel(_props: { id: string }) {
  const { model } = useShell();
  const { overview, error, refresh } = model.machines;
  const uid = useId();
  const [tab, setTab] = useState<Tab>("show");
  const [linked, setLinked] = useState<Linked | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  useMachinesRefresh(refresh);

  const select = (t: Tab) => {
    setTab(t);
    setLinked(null);
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Tab = tab === "show" ? "enter" : "show";
    select(next);
    tabRefs.current[next]?.focus();
  };

  let body;
  if (overview === null) body = <p className="empty">{error !== null ? "Could not load machines" : "Loading…"}</p>;
  else if (overview.identity === "unavailable" || overview.self === null) body = <p className="empty">{NO_IDENTITY}</p>;
  else if (tab === "show") body = <ShowCode fingerprint={overview.self.fingerprint} enabled={overview.self.linking.enabled} onLinked={setLinked} />;
  else body = <EnterCode onLinked={setLinked} />;

  return (
    <section className="link-machine" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>Link a machine</h2>
      <div role="tablist" aria-label="How to link" className="link-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${uid}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`}>
        {body}
      </div>
      <p role="status" className="link-result">
        {linked !== null && <LinkedNote linked={linked} />}
      </p>
    </section>
  );
}
