import { useEffect, useState } from "react";
import { DEVICES } from "@theterminal/shared";
import type { PreviewView } from "@theterminal/shared";
import { api } from "../api";
import { DeviceStage } from "./DeviceStage";
import { normalizeDevices } from "./preview-store";
import "./preview.css";

/** Exactly the sandbox the spec allows: the site's scripts and forms run on its own origin, nothing more. */
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-same-origin";

function readQuery(search: string) {
  const q = new URLSearchParams(search);
  const list = (k: string) => (q.get(k) ?? "").split(",").filter((s) => s.length > 0);
  const devices = normalizeDevices(list("d"));
  const r = new Set(list("r"));
  const k = Number.parseInt(q.get("k") ?? "0", 10);
  return { devices, rotated: devices.filter((d) => r.has(d)), reload: Number.isFinite(k) ? k : 0 };
}

function OpenLink({ origin }: { origin: string }) {
  return (
    <a className="preview-open" href={origin} target="_blank" rel="noreferrer noopener">
      Open in my browser ↗
    </a>
  );
}

/**
 * The `/preview/:id` page, framed by the Preview tab in a browser: one sandboxed frame of the site per device, at the
 * device's own size and scaled to fit. Its own CSP allows framing only this preview's origin.
 */
export function PreviewPage({ id, search = typeof location === "undefined" ? "" : location.search }: { id: string; search?: string }) {
  const [view, setView] = useState<PreviewView | null | "missing">(null);
  const { devices, rotated, reload } = readQuery(search);

  useEffect(() => {
    let live = true;
    api.getPreview(id).then(
      (v) => live && setView(v),
      () => live && setView("missing"),
    );
    return () => {
      live = false;
    };
  }, [id, reload]);

  if (view === null) return <main className="preview-page" aria-busy="true" />;
  const origin = view !== "missing" && view.state === "ready" ? view.origin : null;
  if (origin === null) {
    return (
      <main className="preview-page">
        <p className="preview-note">This preview is not running.</p>
      </main>
    );
  }
  const refused = view !== "missing" && view.frameable === false;
  return (
    <main className="preview-page">
      <DeviceStage
        devices={devices}
        rotated={rotated}
        screen={(device, vp, scale) =>
          refused ? (
            <div className="device-refused">
              <p>This site can't be shown inside another page</p>
              <OpenLink origin={origin} />
            </div>
          ) : (
            <iframe
              key={`${device}-${reload}`}
              className="device-site"
              title={`The site on ${DEVICES[device].label}`}
              sandbox={PREVIEW_SANDBOX}
              src={origin}
              width={vp.width}
              height={vp.height}
              style={{ transform: `scale(${scale})` }}
            />
          )
        }
      />
    </main>
  );
}
