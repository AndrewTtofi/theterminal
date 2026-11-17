import { useId, useState } from "react";
import { TOOL_HELP } from "@theterminal/shared";
import type { NativeTools, ToolId } from "@theterminal/shared";
import { ApiError, errorMessage } from "../api";
import { useViewerRole } from "../shell/model";

/** The tools each kind of app needs, in the order they are set up. */
export const NEEDED_TOOLS: Record<"ios" | "android", readonly ToolId[]> = {
  ios: ["xcode", "xcode_cli", "simulator"],
  android: ["android_sdk", "adb", "emulator", "avd", "gradle_wrapper"],
};

function ToolRow({ tool, missing }: { tool: ToolId; missing: boolean }) {
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  const help = TOOL_HELP[tool];
  return (
    <li className={`tool-row${missing ? " missing" : ""}`}>
      <div className="tool-line">
        {missing ? (
          <span className="tool-mark tool-missing" aria-label="missing">
            !
          </span>
        ) : (
          <span className="tool-mark tool-ok" aria-label="installed">
            ✓
          </span>
        )}
        <span className="tool-name">
          {help.title}
          {missing ? " — not installed" : ""}
        </span>
        {missing && (
          <button type="button" className="quiet" aria-expanded={open} aria-controls={stepsId} onClick={() => setOpen((o) => !o)}>
            How to install
          </button>
        )}
      </div>
      {missing && open && (
        <div className="tool-help" id={stepsId}>
          <ol>
            {help.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <a href={help.url} target="_blank" rel="noreferrer">
            The official download page ↗
          </a>
        </div>
      )}
    </li>
  );
}

/**
 * What you need on this computer: one row per tool the app needs, ✓ or "!" with How to install. Detection is the
 * Owner's, so anyone else is told who sets the tools up.
 */
export function ToolsBox({ kind, tools, error }: { kind: "ios" | "android"; tools: NativeTools | null; error: string | null }) {
  const role = useViewerRole();
  const headingId = useId();
  const side = tools?.[kind] ?? null;
  return (
    <section className="tools-box" aria-labelledby={headingId}>
      <h3 id={headingId}>What you need on this computer</h3>
      {role !== "owner" ? (
        <p className="preview-note">The Owner sets up the tools on this computer.</p>
      ) : error !== null ? (
        <p className="preview-note">{error}</p>
      ) : side === null ? (
        <p className="preview-note">Checking this computer…</p>
      ) : !side.supported ? (
        <p className="preview-note">{errorMessage(new ApiError(409, "platform_unsupported", { kind }))}</p>
      ) : (
        <ul className="tool-list">
          {NEEDED_TOOLS[kind].map((t) => (
            <ToolRow key={t} tool={t} missing={side.missing.includes(t)} />
          ))}
        </ul>
      )}
    </section>
  );
}
