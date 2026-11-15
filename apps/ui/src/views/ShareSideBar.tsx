import { useEffect, useId, useState } from "react";
import { DIGEST_DAYS } from "@theterminal/shared";
import type { DigestDays, ShareScope, ShareSnapshotRecord } from "@theterminal/shared";
import { errorMessage, shareDownloadUrl, shareSnapshotUrl } from "../api";
import { ShareLinkForm } from "../components/ShareLinkForm";
import { useShell } from "../shell/model";

export const SCOPE_LABELS: Record<ShareScope, string> = { this_computer: "This computer only", local_network: "Local network" };

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const day = (iso: string) => new Date(iso).toLocaleDateString();
const when = (iso: string) => new Date(iso).toLocaleString();

function SnapshotRow({ s }: { s: ShareSnapshotRecord }) {
  const { model } = useShell();
  const [sharing, setSharing] = useState(false);
  const formId = useId();
  return (
    <li>
      <span className="share-row-text">{`${day(s.confirmedAt)} · ${kb(s.bytes)} · #${s.id.slice(0, 8)}`}</span>
      <span className="share-row-actions">
        <button type="button" onClick={() => window.open(shareSnapshotUrl(s.id), "_blank", "noopener")}>
          Open
        </button>
        <a download href={shareDownloadUrl(s.id)}>
          Download
        </a>
        <button type="button" aria-expanded={sharing} aria-controls={formId} onClick={() => setSharing((v) => !v)}>
          Share on your network…
        </button>
      </span>
      {sharing && (
        <div id={formId}>
          <ShareLinkForm shareId={s.id} addresses={model.share.addresses} onCreateLink={model.share.onCreateLink} />
        </div>
      )}
    </li>
  );
}

/**
 * The Share view: what the share page includes, the preview that must be read before anything is saved, the saved
 * snapshots (open, download, serve on the network), the live links, and the daily digest.
 */
export function ShareSideBar() {
  const { model, dock } = useShell();
  const share = model.share;
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const { loadAddresses } = share;
  useEffect(() => loadAddresses(), [loadAddresses]);

  if (model.selectedId === null) return <p className="empty">Select or create a project.</p>;

  const preview = async () => {
    setError(null);
    try {
      if (await share.onPreview()) dock()?.focus("share");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const revoke = async (id: string) => {
    setError(null);
    try {
      await share.onRevokeLink(id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const live = share.links.filter((l) => l.state === "active");

  return (
    <div className="share-side">
      <section aria-labelledby={`${uid}-share`}>
        <h3 id={`${uid}-share`}>Share this project</h3>
        <fieldset>
          <legend>Include</legend>
          <label>
            <input
              type="checkbox"
              checked={share.options.includePrompts}
              onChange={(e) => share.onOptionsChange({ ...share.options, includePrompts: e.target.checked })}
            />
            Include my prompts to agents
          </label>
          <label>
            <input
              type="checkbox"
              checked={share.options.includeHardware}
              onChange={(e) => share.onOptionsChange({ ...share.options, includeHardware: e.target.checked })}
            />
            Include this computer's hardware
          </label>
        </fieldset>
        <select
          aria-label="Digest days"
          value={share.options.digestDays}
          onChange={(e) => share.onOptionsChange({ ...share.options, digestDays: Number(e.target.value) as DigestDays })}
        >
          {DIGEST_DAYS.map((d) => (
            <option key={d} value={d}>{`Last ${d} days`}</option>
          ))}
        </select>
        <p className="note">Everything else that is private stays out: secrets, file contents, raw agent output, account details.</p>
        <button type="button" onClick={() => void preview()} disabled={share.previewing}>
          Preview share page
        </button>
        {error !== null && (
          <p className="share-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby={`${uid}-snapshots`}>
        <h3 id={`${uid}-snapshots`}>Saved snapshots</h3>
        {share.snapshots.length === 0 ? (
          <p className="empty">No snapshots yet. Preview and confirm one.</p>
        ) : (
          <ul aria-label="Saved snapshots">
            {share.snapshots.map((s) => (
              <SnapshotRow key={s.id} s={s} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${uid}-links`}>
        <h3 id={`${uid}-links`}>Live links</h3>
        {live.length === 0 ? (
          <p className="empty">No live links.</p>
        ) : (
          <ul aria-label="Live links">
            {live.map((l) => (
              <li key={l.id}>
                <span className="share-row-text">{`${SCOPE_LABELS[l.scope]} · until ${when(l.expiresAt)} · port ${l.port}`}</span>
                <button type="button" onClick={() => void revoke(l.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="note">Links work only while The Terminal is running on this computer.</p>
      </section>

      <section aria-labelledby={`${uid}-digest`}>
        <h3 id={`${uid}-digest`}>Daily digest</h3>
        <button type="button" onClick={() => dock()?.focus("digest")}>
          Open daily digest
        </button>
      </section>
    </div>
  );
}
