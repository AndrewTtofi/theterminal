import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CERT_FINGERPRINT, ROLE_DESCRIPTIONS, ROLE_LABELS, visibleControls } from "@theterminal/shared";
import { ApiError, api, errorMessage } from "../api";
import type { JoinInfo } from "../api";
import { joinWithKey, joinWithPasskey, passkeysAvailable } from "../identity";
import { clip } from "../components/text";

type Props = {
  code: string;
  /** Where to go once joined; `location.assign` by default. */
  navigate?: (url: string) => void;
};

const COMPARE =
  "Compare it with the fingerprint your browser shows for this site's certificate (click the lock icon). Continue only if they are the same.";
const MISMATCH = "They do not match. Do not continue: someone may be intercepting the connection.";
const KEY_NOTE =
  "This browser cannot use passkeys here (the address is an IP, or passkeys are unsupported). A key will be created and kept in this browser only.";
const NAME_NOTE = "Your name is recorded in this workspace's ledger next to everything you do.";
const FAILED = "That did not work. Try again.";

/** The `fp` of the page's fragment (`#fp=<fingerprint>`), as written, or null when the link has none. */
export function linkFingerprint(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const fp = params.get("fp");
  return fp === null || fp === "" ? null : fp;
}

const said = (e: unknown) => (e instanceof ApiError ? errorMessage(e) : FAILED);

/**
 * The page an invitation link opens. It shows what the invitation offers and, for a link to the remote listener, the
 * certificate fingerprint the link carries beside the one this connection reports. It never says the two match: a
 * page cannot see the certificate its browser accepted, and a fingerprint reported over this connection is what an
 * interceptor would forward unchanged. Only the person comparing the link with the browser's own certificate details
 * can tell. A difference still proves the link is wrong, so that branch stops the form.
 */
export function JoinPage({ code, navigate = (url) => location.assign(url) }: Props) {
  const nameId = useId();
  const noteId = useId();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const linkFp = linkFingerprint(location.hash);

  useEffect(() => {
    let cancelled = false;
    heading.current?.focus();
    void (async () => {
      try {
        const [i, browser] = await Promise.all([api.joinInfo(code), passkeysAvailable()]);
        if (cancelled) return;
        setInfo(i);
        setPasskeys(i.passkeys && browser);
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const linkFpValid = linkFp === null || CERT_FINGERPRINT.test(linkFp);
  const mismatch = linkFp !== null && linkFpValid && info?.fingerprint != null && info.fingerprint !== linkFp;
  const blocked = !linkFpValid || mismatch;
  const button = passkeys ? "Create a passkey and join" : "Create a key in this browser and join";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n === "" || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await (passkeys ? joinWithPasskey(code, n) : joinWithKey(code, n));
      navigate("/");
    } catch (err) {
      setError(said(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="standalone-page" aria-label="Join this workspace">
      <h1 ref={heading} tabIndex={-1}>
        Join this workspace
      </h1>
      {loadError !== null ? (
        <p role="alert">{loadError}</p>
      ) : info === null ? (
        <p className="empty" role="status">
          Loading the invitation…
        </p>
      ) : (
        <>
          <p>{`You have been invited as a ${ROLE_LABELS[info.role]}.`}</p>
          <p className="note">{ROLE_DESCRIPTIONS[info.role]}</p>
          {linkFp !== null && (
            <section className="fingerprints" aria-label="Certificate fingerprint">
              <h2>Certificate fingerprint</h2>
              {linkFpValid ? (
                <>
                  <dl>
                    <dt>Certificate fingerprint in your link:</dt>
                    <dd>
                      <code data-testid="link-fingerprint">{linkFp}</code>
                    </dd>
                    {info.fingerprint !== null && (
                      <>
                        <dt>Fingerprint reported over this connection:</dt>
                        <dd>
                          <code data-testid="served-fingerprint">{info.fingerprint}</code>
                        </dd>
                      </>
                    )}
                  </dl>
                  <p>{COMPARE}</p>
                  {info.fingerprint !== null && !mismatch && (
                    <p className="note">
                      This page cannot see the certificate your browser accepted, so the fingerprint reported over this
                      connection proves nothing on its own. Only your browser&apos;s certificate details can.
                    </p>
                  )}
                </>
              ) : (
                <p role="alert" className="attention">
                  {`"${clip(visibleControls(linkFp), 120)}" is not a certificate fingerprint. Do not continue: ask the Owner for the link again.`}
                </p>
              )}
              {mismatch && (
                <p role="alert">
                  <span className="attention">{MISMATCH}</span>
                </p>
              )}
            </section>
          )}
          <form onSubmit={(e) => void submit(e)} aria-describedby={error === null ? undefined : `${noteId}-error`}>
            <label htmlFor={nameId}>Your name</label>
            <input
              id={nameId}
              value={name}
              maxLength={60}
              autoComplete="name"
              disabled={blocked || busy}
              aria-describedby={noteId}
              onChange={(e) => setName(e.target.value)}
            />
            <p id={noteId} className="note">
              {NAME_NOTE}
            </p>
            {!passkeys && <p className="note">{KEY_NOTE}</p>}
            <button type="submit" disabled={blocked || busy || name.trim() === ""}>
              {button}
            </button>
            {error !== null && (
              <p id={`${noteId}-error`} role="alert">
                {error}
              </p>
            )}
          </form>
        </>
      )}
    </main>
  );
}
