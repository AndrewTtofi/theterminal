import { useId, useRef, useState } from "react";
import { adapterLabel } from "@theterminal/shared";
import type { AdapterId } from "@theterminal/shared";
import { atLeast } from "@theterminal/shared";
import { UploadStatus, useUpload } from "../components/AddFiles";
import { useShell, useViewerRole } from "../shell/model";
import { filesFromInput } from "../upload";
import type { PickedFile } from "../upload";

/**
 * "Tell an agent what you want…": starts a run exactly as the Agents view does (same call, same rules). Not shown
 * below maintainer. Add files picks files and adds them to the selected project at once, with a progress bar.
 */
export function AskBox() {
  const { model } = useShell();
  const role = useViewerRole();
  const [prompt, setPrompt] = useState("");
  const [adapter, setAdapter] = useState<AdapterId | "">("");
  const [focused, setFocused] = useState(false);
  const [starting, setStarting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const agentId = useId();
  const refreshFiles = model.projectFiles?.refresh;
  const upload = useUpload(() => refreshFiles?.());
  if (!atLeast(role, "maintainer")) return null;

  const projectId = model.selectedId;
  const sending = upload.state.phase === "sending";
  const send = (files: PickedFile[], includeSecrets = false) => {
    if (projectId !== null) void upload.start(projectId, files, includeSecrets);
  };

  const info = model.agentsInfo;
  const adapters = info?.adapters ?? [];
  const available = (a: AdapterId) => {
    const p = a === "fake" ? undefined : info?.providers?.[a];
    return !p || p.available !== false;
  };
  const chosen = adapter && available(adapter) ? adapter : (adapters.find(available) ?? "");
  const canGo = chosen !== "" && prompt.trim() !== "" && !starting;

  const go = () => {
    if (!canGo) return;
    setStarting(true);
    void model
      .onStartRun(chosen, prompt.trim(), [], null)
      .then((ok) => {
        if (ok === false) return;
        setPrompt("");
        boxRef.current?.focus();
      })
      .catch(() => {})
      .finally(() => setStarting(false));
  };

  return (
    <section className="home-block home-ask" aria-label="Ask box">
      <form
        className={`ask-box${focused ? " focused" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <span className="ask-input">
          <textarea
            ref={boxRef}
            aria-label="Tell an agent what you want"
            placeholder="Tell an agent what you want…"
            value={prompt}
            rows={1}
            maxLength={20000}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter starts a new line.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go();
              }
            }}
          />
          {focused && prompt === "" && <span className="cursor" aria-hidden="true" />}
        </span>
        <button
          type="button"
          className="chip"
          disabled={projectId === null || sending}
          title={projectId === null ? "Choose a project first" : undefined}
          onClick={() => fileRef.current?.click()}
        >
          Add files
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const input = e.currentTarget;
            if (input.files && input.files.length > 0) send(filesFromInput(input.files));
            input.value = "";
          }}
        />
        {/* "Ask with", not "Agent": the Agents view's run form keeps its own "Agent" picker unambiguous. */}
        <label className="visually-hidden" htmlFor={agentId}>
          Ask with
        </label>
        <select id={agentId} className="chip" value={chosen} onChange={(e) => setAdapter(e.target.value as AdapterId)}>
          {adapters.map((a) => (
            <option key={a} value={a} disabled={!available(a)}>
              {adapterLabel(a)}
              {available(a) ? "" : " (unavailable)"}
            </option>
          ))}
        </select>
        <button type="submit" className="go" disabled={!canGo}>
          Go
        </button>
      </form>
      {upload.state.phase !== "idle" && (
        <div className="ask-upload">
          <UploadStatus upload={upload} onRetry={send} />
        </div>
      )}
    </section>
  );
}
