import { DEVICES, visibleControls } from "@theterminal/shared";
import type { DeviceId, Screenshot } from "@theterminal/shared";
import { api } from "../api";
import "./screenshots.css";

/** A screenshot's device in words: a website device's label, else the simulator's own name as recorded. */
export function deviceLabel(device: string): string {
  return Object.prototype.hasOwnProperty.call(DEVICES, device) ? DEVICES[device as DeviceId].label : visibleControls(device);
}

/**
 * The first `max` screenshots as thumbnails in fixed 64×64 boxes (`object-fit: contain`), so loading never shifts the
 * layout. Each opens the full image. `captions` names the device under each.
 */
export function Screenshots({ shots, max, captions = false }: { shots: Screenshot[]; max: number; captions?: boolean }) {
  const shown = shots.slice(0, Math.max(0, max));
  if (shown.length === 0) return null;
  return (
    <ul className="shots" aria-label="Screenshots">
      {shown.map((s) => {
        const url = api.screenshotUrl(s);
        const label = deviceLabel(s.device);
        return (
          <li key={`${s.runId}:${s.sha256}`} className="shot">
            <a href={url} target="_blank" rel="noreferrer" className="shot-link">
              <img className="shot-img" src={url} alt={`Screenshot on ${label}`} loading="lazy" width={64} height={64} />
            </a>
            {captions && <span className="shot-caption">{label}</span>}
          </li>
        );
      })}
    </ul>
  );
}
