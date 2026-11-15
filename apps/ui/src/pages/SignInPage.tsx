import { useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "../api";
import { hasBrowserKey, passkeysAvailable, signInWithKey, signInWithPasskey } from "../identity";

type Props = {
  /** Where to go once signed in; `location.assign` by default. */
  navigate?: (url: string) => void;
};

const LINE = "The Owner signs in on this computer without a password; everyone else uses the passkey or key they created when they joined.";
const NO_PASSKEYS = "This browser cannot use passkeys here (the address is an IP, or passkeys are unsupported).";
const FAILED = "That did not work. Try again.";

/** Where a person who is not signed in lands: a passkey, or the key this browser made when they joined. */
export function SignInPage({ navigate = (url) => location.assign(url) }: Props) {
  const [passkeys, setPasskeys] = useState(true);
  const [key, setKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    heading.current?.focus();
    void passkeysAvailable().then((v) => !cancelled && setPasskeys(v), () => !cancelled && setPasskeys(false));
    void hasBrowserKey().then((v) => !cancelled && setKey(v), () => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const attempt = async (signIn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn();
      navigate("/");
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : FAILED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="standalone-page" aria-label="Sign in">
      <h1 ref={heading} tabIndex={-1}>
        Sign in
      </h1>
      <p className="note">{LINE}</p>
      <div className="actions">
        <button type="button" disabled={busy || !passkeys} onClick={() => void attempt(signInWithPasskey)}>
          Sign in with a passkey
        </button>
        {key && (
          <button type="button" disabled={busy} onClick={() => void attempt(signInWithKey)}>
            Sign in with this browser&apos;s key
          </button>
        )}
      </div>
      {!passkeys && <p className="note">{NO_PASSKEYS}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </main>
  );
}
