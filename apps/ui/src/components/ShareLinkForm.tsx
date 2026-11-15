import { useId, useState } from "react";
import type { FormEvent } from "react";
import { TTL_MINUTES, visibleControls } from "@theterminal/shared";
import { errorMessage } from "../api";
import type { ShareAddress } from "../api";

const TTL_LABELS: Record<(typeof TTL_MINUTES)[number], string> = { 60: "1 hour", 480: "8 hours", 1440: "24 hours", 10080: "7 days" };
const DEFAULT_TTL = 1440;

type Props = {
  shareId: string;
  addresses: ShareAddress[];
  onCreateLink(shareId: string, address: string, ttlMinutes: number): Promise<{ url: string } | null>;
};

/**
 * Serves one saved snapshot behind a one-time link: the address it listens on and how long it lives. The url is
 * held only here, in this form's state, and shown once.
 */
export function ShareLinkForm({ shareId, addresses, onCreateLink }: Props) {
  const uid = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [ttl, setTtl] = useState<number>(DEFAULT_TTL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The first address offered until the Owner picks one (the list loads after the form can open).
  const address = chosen !== null && addresses.some((a) => a.address === chosen) ? chosen : (addresses[0]?.address ?? "");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || address === "") return;
    setBusy(true);
    setError(null);
    try {
      const made = await onCreateLink(shareId, address, ttl);
      if (made) setUrl(made.url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard here (or permission refused): the url stays selectable in the field.
      setCopied(false);
    }
  };

  return (
    <form className="share-link-form" aria-label="Share on your network" onSubmit={(e) => void create(e)}>
      <label htmlFor={`${uid}-address`}>Address</label>
      <select id={`${uid}-address`} aria-label="Address" value={address} onChange={(e) => setChosen(e.target.value)}>
        {addresses.map((a) => (
          <option key={a.address} value={a.address}>
            {visibleControls(a.label)}
          </option>
        ))}
      </select>
      <label htmlFor={`${uid}-ttl`}>Valid for</label>
      <select id={`${uid}-ttl`} aria-label="Valid for" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
        {TTL_MINUTES.map((m) => (
          <option key={m} value={m}>
            {TTL_LABELS[m]}
          </option>
        ))}
      </select>
      <p className="note">
        {"Anyone with the link can read this snapshot, and nothing else, until it expires or you revoke it. It works only while The Terminal is running."}
      </p>
      <button type="submit" disabled={busy || address === ""}>
        Create link
      </button>
      {error !== null && (
        <p className="share-error" role="alert">
          {error}
        </p>
      )}
      {url !== null && (
        <div className="share-link-made">
          <input readOnly aria-label="Share link" value={url} onFocus={(e) => e.target.select()} />
          <button type="button" onClick={() => void copy()}>
            Copy
          </button>
          <p className="note">This link is shown once. Copy it now.</p>
          <p className="sr-only" aria-live="polite">
            {copied ? "Copied" : ""}
          </p>
        </div>
      )}
    </form>
  );
}
