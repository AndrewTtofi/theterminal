import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ROLE_LABELS, domainSchema, visibleControls } from "@theterminal/shared";
import type { Me, Person, Role, TlsMode } from "@theterminal/shared";
import { ApiError, api, errorMessage } from "../api";
import type { RemoteInput } from "../api";
import { InviteDialog } from "../components/InviteDialog";
import { clip } from "../components/text";
import { addBrowserKey, addPasskey, passkeysAvailable } from "../identity";
import { roleOf, useShell } from "../shell/model";

const ASSIGNABLE: Role[] = ["viewer", "reviewer", "maintainer"];
const TLS: { value: TlsMode; label: string }[] = [
  { value: "self_signed", label: "Self-signed certificate" },
  { value: "acme", label: "Certificate from Let's Encrypt (needs the domain and port 80)" },
  { value: "provided", label: "My own certificate files" },
];
const SELF_SIGNED_NOTE =
  "Browsers cannot verify a self-signed certificate: people will see a warning the first time, and the join page asks them to compare this fingerprint with the one their browser shows. Set a domain to get a certificate browsers trust. Programs that connect to this workspace check the fingerprint instead.";

const name = (s: string) => clip(visibleControls(s), 60);
const when = (iso: string | null) => (iso === null ? "never" : new Date(iso).toLocaleString());
const said = (e: unknown) => (e instanceof ApiError ? errorMessage(e) : "That did not work. Try again.");

/** Runs one change and keeps its error, worded, for the section that made it. */
function useAction(after?: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (change: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await change();
      after?.();
      return true;
    } catch (e) {
      setError(said(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** One person's row: what anyone may read, and for the Owner the role, sign-out and removal. */
function PersonRow({ person, online, manage, after }: { person: Person; online: boolean; manage: boolean; after?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const { error, busy, run } = useAction(after);
  const shown = name(person.name);
  return (
    <tr>
      <td>{shown}</td>
      <td>
        {manage ? (
          <select
            aria-label={`Role of ${shown}`}
            value={person.role}
            disabled={busy}
            onChange={(e) => void run(() => api.changeRole(person.id, e.target.value as Role))}
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        ) : (
          ROLE_LABELS[person.role]
        )}
      </td>
      <td>{person.credentials}</td>
      <td>{when(person.lastSeenAt)}</td>
      <td>{online ? "Online" : "Offline"}</td>
      {manage ? (
        <td>
          <button type="button" disabled={busy} onClick={() => void run(() => api.signOutPerson(person.id))}>
            Sign out everywhere
          </button>
          {confirming ? (
            <>
              <button type="button" className="danger" disabled={busy} onClick={() => void run(() => api.removePerson(person.id))}>
                {`Remove ${shown}`}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
          {error !== null && <span role="alert">{error}</span>}
        </td>
      ) : (
        <td />
      )}
    </tr>
  );
}

/** The Owner's remote access form: the switch, port, domain, certificate, and while on the fingerprint and addresses. */
function RemoteForm() {
  const { model } = useShell();
  const uid = useId();
  const remote = model.remote ?? null;
  const [port, setPort] = useState(String(remote?.port ?? 4318));
  const [domain, setDomain] = useState(remote?.domain ?? "");
  const [tls, setTls] = useState<TlsMode>(remote?.tls ?? "self_signed");
  const [certFile, setCertFile] = useState("");
  const [keyFile, setKeyFile] = useState("");
  const [copied, setCopied] = useState(false);
  const { error, busy, run } = useAction(model.refreshPeople);
  const on = remote?.enabled === true;
  const [inputError, setInputError] = useState<string | null>(null);

  const toggle = () => {
    setInputError(null);
    if (on) return void run(() => api.setRemote({ enabled: false }));
    const input: RemoteInput = { enabled: true, tls };
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setInputError("The port must be a number from 1 to 65535.");
    if (p !== (remote?.port ?? 4318)) input.port = p;
    const d = domain.trim();
    if (d !== "") {
      if (!domainSchema.safeParse(d).success) return setInputError("The domain must be a name such as workspace.example.com, never an address.");
      input.domain = d;
    }
    if (tls === "acme" && d === "") return setInputError("Let's Encrypt needs a domain.");
    if (tls === "provided") {
      if (certFile.trim() === "" || keyFile.trim() === "") return setInputError("Give both certificate files.");
      input.certFile = certFile.trim();
      input.keyFile = keyFile.trim();
    }
    void run(() => api.setRemote(input));
  };

  const copy = async () => {
    if (!remote?.fingerprint) return;
    try {
      await navigator.clipboard.writeText(remote.fingerprint);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <form className="remote-form" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <p className="switch-row">
        <button type="button" role="switch" aria-checked={on} aria-label="Remote access" aria-describedby={`${uid}-what`} disabled={busy} onClick={toggle}>
          {on ? "On" : "Off"}
        </button>{" "}
        <span id={`${uid}-what`}>Allow people on the network to reach this workspace</span>
      </p>
      <label>
        Port
        <input type="number" min={1} max={65535} value={port} disabled={on} onChange={(e) => setPort(e.target.value)} />
      </label>
      <label>
        Domain (optional)
        <input value={domain} maxLength={253} disabled={on} onChange={(e) => setDomain(e.target.value)} />
      </label>
      <fieldset disabled={on}>
        <legend>Certificate</legend>
        {TLS.map((t) => (
          <label key={t.value}>
            <input type="radio" name={`${uid}-tls`} value={t.value} checked={tls === t.value} onChange={() => setTls(t.value)} />
            {t.label}
          </label>
        ))}
        {tls === "provided" && (
          <>
            <label>
              Certificate file
              <input value={certFile} onChange={(e) => setCertFile(e.target.value)} />
            </label>
            <label>
              Key file
              <input value={keyFile} onChange={(e) => setKeyFile(e.target.value)} />
            </label>
          </>
        )}
      </fieldset>
      {on && remote?.fingerprint && (
        <p>
          <label htmlFor={`${uid}-fp`}>Certificate fingerprint</label>
          <input id={`${uid}-fp`} readOnly value={remote.fingerprint} className="fingerprint" />
          <button type="button" onClick={() => void copy()}>
            Copy
          </button>
          <span role="status">{copied ? "Copied." : ""}</span>
        </p>
      )}
      {on && (remote?.addresses?.length ?? 0) > 0 && (
        <>
          <h4>This machine&apos;s addresses</h4>
          <ul>
            {remote!.addresses!.map((a) => (
              <li key={a}>{visibleControls(a)}</li>
            ))}
          </ul>
        </>
      )}
      <p className="note">{SELF_SIGNED_NOTE}</p>
      {(inputError ?? error) !== null && <p role="alert">{inputError ?? error}</p>}
    </form>
  );
}

/** Every role: the person's own passkeys and keys. */
function Credentials({ me }: { me: Me }) {
  const { model } = useShell();
  const uid = useId();
  const [passkeys, setPasskeys] = useState(false);
  const { error, busy, run } = useAction(model.refreshPeople);
  useEffect(() => {
    let live = true;
    void passkeysAvailable().then((v) => live && setPasskeys(v), () => {});
    return () => {
      live = false;
    };
  }, []);
  const adopt = async (add: () => Promise<Me>) => {
    const next = await add();
    model.onMeChange?.(next);
  };
  return (
    <section aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Your credentials</h3>
      {me.credentials.length === 0 ? (
        <p className="empty">None yet.</p>
      ) : (
        <ul>
          {me.credentials.map((c) => (
            <li key={c.credentialId}>
              {name(c.label)} <span className="muted">{c.kind === "passkey" ? "Passkey" : "Key in a browser"}</span>{" "}
              <button
                type="button"
                aria-label={`Remove ${name(c.label)}`}
                disabled={busy}
                onClick={() => void run(() => api.removeMyCredential(c.credentialId))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy || !passkeys} onClick={() => void run(() => adopt(addPasskey))}>
        Add a passkey
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => void run(() => adopt(addBrowserKey))}>
        Add a key for this browser
      </button>
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
}

/** Every role: the person's sessions, each signed out on its own, and this one. */
function Sessions({ me }: { me: Me }) {
  const { model } = useShell();
  const uid = useId();
  const { error, busy, run } = useAction(model.refreshPeople);
  const where = (l: "local" | "remote") => (l === "local" ? "This computer" : "Over the network");
  return (
    <section aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Your sessions</h3>
      {me.sessions.length === 0 ? (
        <p className="empty">Signed in with this computer&apos;s own sign-in.</p>
      ) : (
        <ul>
          {me.sessions.map((s) => (
            <li key={s.id}>
              {`${where(s.listener)} · since ${when(s.createdAt)} · last seen ${when(s.lastSeenAt)}`}
              {s.current && <strong> · this one</strong>}{" "}
              <button type="button" disabled={busy} onClick={() => void run(() => api.revokeMySession(s.id))}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await api.signOut();
            location.assign("/sign-in");
          })
        }
      >
        Sign out of this session
      </button>
      {error !== null && <p role="alert">{error}</p>}
    </section>
  );
}

/** The People panel: everyone, and for the Owner their roles, the invitations and remote access; your own account. */
export function PeoplePanel() {
  const { model } = useShell();
  const uid = useId();
  const role = roleOf(model);
  const owner = role === "owner";
  const me = model.me;
  const online = new Set((model.presence ?? []).map((p) => p.personId));
  const [inviting, setInviting] = useState(false);
  const inviteButton = useRef<HTMLButtonElement>(null);
  const invites = useAction(model.refreshPeople);

  return (
    <section className="people-panel" aria-label="People">
      <h2>People</h2>
      <table aria-label="Everyone">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">Credentials</th>
            <th scope="col">Last seen</th>
            <th scope="col">Online</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(model.people ?? []).map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              online={online.has(p.id)}
              manage={owner && p.role !== "owner" && p.id !== me?.personId}
              {...(model.refreshPeople !== undefined && { after: model.refreshPeople })}
            />
          ))}
        </tbody>
      </table>
      {owner && (
        <section aria-labelledby={`${uid}-inv`}>
          <h3 id={`${uid}-inv`}>Invitations</h3>
          {(model.invites ?? []).length === 0 ? (
            <p className="empty">No pending invitations.</p>
          ) : (
            <ul>
              {(model.invites ?? []).map((i) => (
                <li key={i.id}>
                  {`${ROLE_LABELS[i.role]} · expires ${when(i.expiresAt)}`}{" "}
                  <button type="button" disabled={invites.busy} onClick={() => void invites.run(() => api.revokeInvite(i.id))}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" ref={inviteButton} onClick={() => setInviting(true)}>
            Invite someone
          </button>
          {invites.error !== null && <p role="alert">{invites.error}</p>}
        </section>
      )}
      <section aria-labelledby={`${uid}-remote`}>
        <h3 id={`${uid}-remote`}>Remote access</h3>
        {owner ? <RemoteForm /> : <p>{model.remote?.enabled ? "On" : "Off"}</p>}
      </section>
      {me && <Credentials me={me} />}
      {me && <Sessions me={me} />}
      {inviting && (
        <InviteDialog
          remoteOn={model.remote?.enabled === true}
          onClose={() => {
            setInviting(false);
            inviteButton.current?.focus();
          }}
          {...(model.refreshPeople !== undefined && { onCreated: model.refreshPeople })}
        />
      )}
    </section>
  );
}
