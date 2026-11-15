import { useContext, useEffect, useId, useRef, useState } from "react";
import { plural, visibleControls } from "@theterminal/shared";
import type { GitHubRepoChoice, ImportResult, Project } from "@theterminal/shared";
import { ApiError, api } from "../api";
import { ShellContext, useViewerRole } from "../shell/model";
import { formatBytes, isAbort, onLocalListener, precheck, sourcesMessage, uploadFiles } from "../upload";
import type { PickedFile } from "../upload";
import { DropArea, FilePickers, ImportSummary, SecretsTick, SendProgress } from "./AddFiles";
import { Modal } from "./Modal";
import { clip } from "./text";

type Choice = "files" | "github" | "folder" | "empty";

const CHOICES: { id: Choice; icon: string; title: string; text: string }[] = [
  { id: "files", icon: "⎘", title: "Add files", text: "Drag in documents, spreadsheets, photos or a whole folder. They're copied into the project." },
  { id: "github", icon: "⎇", title: "From GitHub", text: "Pick one of your repositories. Agents work on their own copy; nothing is pushed without your approval." },
  { id: "folder", icon: "▤", title: "A folder on this computer", text: "Point at an existing folder. Agents work on a copy, so your original stays untouched until you approve." },
];

type Repos = { state: "idle" | "loading" | "ready" } | { state: "error"; message: string; notConnected: boolean };
type Done = { project: Project; result: ImportResult | null; note: string | null };

/**
 * "New project": a name and where its first files come from: files you add, one of your GitHub repositories, a folder
 * on this computer (the Owner, on this computer only), or nothing. A project made from a source is selected at once
 * (`onCreated`); the dialog then shows what was copied in and what was left out.
 */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const role = useViewerRole();
  const shell = useContext(ShellContext);
  const ids = useId();
  const folderAllowed = role === "owner" && onLocalListener(shell?.model.me?.listener);
  const [choice, setChoice] = useState<Choice>("files");
  const [name, setName] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [repos, setRepos] = useState<Repos>({ state: "idle" });
  const [repoList, setRepoList] = useState<GitHubRepoChoice[]>([]);
  const [repo, setRepo] = useState("");
  const [folder, setFolder] = useState("");
  const [typed, setTyped] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  useEffect(() => {
    if (choice !== "github" || repos.state !== "idle") return;
    setRepos({ state: "loading" });
    api.githubRepos().then(
      (r) => {
        setRepoList(r.repos);
        setRepo((cur) => cur || (r.repos[0]?.fullName ?? ""));
        setRepos({ state: "ready" });
      },
      (e: unknown) => {
        const notConnected = e instanceof ApiError && e.code === "github_not_connected";
        setRepos({ state: "error", notConnected, message: sourcesMessage(e) });
      },
    );
  }, [choice, repos.state]);
  useEffect(() => {
    if (typed) pathRef.current?.focus();
  }, [typed]);
  // A refusal belongs to the choice it was made for.
  useEffect(() => setError(null), [choice]);

  const pick = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const r = await api.pickFolder();
      if (r.path !== null) setFolder(r.path);
    } catch (e) {
      if (e instanceof ApiError && e.code === "folder_picker_unavailable") setTyped(true);
      else setError(sourcesMessage(e));
    } finally {
      setPicking(false);
    }
  };

  const trimmed = name.trim();
  const named = trimmed === "" ? {} : { name: trimmed };
  const ready =
    choice === "empty" ? trimmed !== "" :
    choice === "files" ? trimmed !== "" && files.length > 0 :
    choice === "github" ? repos.state === "ready" && repo !== "" :
    folder.trim() !== "";
  const bytes = files.reduce((n, f) => n + f.file.size, 0);

  const create = async () => {
    if (!ready || busy) return;
    setError(null);
    if (choice === "files") {
      const checked = precheck(files, includeSecrets);
      if (!checked.ok) return setError(checked.message);
    }
    setBusy(true);
    try {
      if (choice === "empty") {
        const p = await api.createProject({ name: trimmed });
        onCreated(p);
        onClose();
        return;
      }
      if (choice === "github" || choice === "folder") {
        const r = choice === "github"
          ? await api.createFromGitHub({ repo, ...named, includeSecrets })
          : await api.createFromFolder({ path: folder.trim(), ...named, includeSecrets });
        onCreated(r.project);
        setDone({ project: r.project, result: r.result, note: null });
        return;
      }
      const p = await api.createProject({ name: trimmed });
      onCreated(p);
      const c = new AbortController();
      ctl.current = c;
      setSent({ sent: 0, total: files.length });
      try {
        const result = await uploadFiles(p.id, files, includeSecrets, (s, t) => setSent({ sent: s, total: t }), c.signal);
        setDone({ project: p, result, note: null });
      } catch (e) {
        const note = isAbort(e) || c.signal.aborted
          ? "The project was made. No files were added; you can add them on Home."
          : `The project was made, but its files were not added: ${sourcesMessage(e)}`;
        setDone({ project: p, result: null, note });
      } finally {
        ctl.current = null;
        setSent(null);
      }
    } catch (e) {
      setError(sourcesMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const titleId = `${ids}-title`;
  const working = busy && choice !== "empty";
  const imports = choice !== "empty";
  const shown = CHOICES.filter((c) => c.id !== "folder" || folderAllowed);

  if (done !== null) {
    return (
      <Modal labelledBy={titleId} onClose={onClose} className="new-project-dialog">
        <header className="modal-head">
          <h2 id={titleId}>New project</h2>
        </header>
        <div className="modal-body">
          <p className="np-ready">{`${visibleControls(done.project.name)} is ready.`}</p>
          {done.result !== null && <ImportSummary result={done.result} verb="Copied in" />}
          {done.note !== null && <p className="modal-notice" role="status">{done.note}</p>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} locked={working && sent === null} className="new-project-dialog">
      <header className="modal-head">
        <h2 id={titleId}>New project</h2>
        <p className="modal-sub">Pick where its information comes from. You can always add more files later.</p>
      </header>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="np-field">
          <label htmlFor={`${ids}-name`}>Name</label>
          <input
            id={`${ids}-name`}
            data-autofocus
            value={name}
            maxLength={200}
            disabled={busy}
            placeholder={choice === "github" ? "Leave empty to use the repository's name" : choice === "folder" ? "Leave empty to use the folder's name" : "Website, Taxes 2026…"}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <fieldset className="np-choices" disabled={busy}>
          <legend className="visually-hidden">Where its files come from</legend>
          <div className="np-cards" style={{ ["--np-cards" as string]: shown.length }}>
            {shown.map((c) => (
              <label key={c.id} className={`np-card${choice === c.id ? " selected" : ""}`}>
                <input type="radio" className="visually-hidden" name={`${ids}-choice`} value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} />
                <span className="np-icon" aria-hidden="true">{c.icon}</span>
                <span className="np-title">{c.title}</span>
                <span className="np-text">{c.text}</span>
              </label>
            ))}
          </div>
          <label className={`np-empty${choice === "empty" ? " selected" : ""}`}>
            <input type="radio" className="visually-hidden" name={`${ids}-choice`} value="empty" checked={choice === "empty"} onChange={() => setChoice("empty")} />
            <span className="np-title">Start empty</span>
            <span className="np-text">and let an agent build from scratch.</span>
          </label>
        </fieldset>

        <div className="np-detail">
          {choice === "files" && (
            sent !== null ? (
              <SendProgress sent={sent.sent} total={sent.total} onCancel={() => ctl.current?.abort()} />
            ) : (
              <DropArea onDropped={setFiles} disabled={busy} hint="Drop files or a folder here">
                <FilePickers onPicked={setFiles} disabled={busy} />
                {files.length > 0 && (
                  <p className="np-chosen">
                    {`${plural(files.length, "file")} chosen · ${formatBytes(bytes)}`}{" "}
                    <button type="button" className="link" onClick={() => setFiles([])} disabled={busy}>
                      Clear
                    </button>
                  </p>
                )}
              </DropArea>
            )
          )}

          {choice === "github" && (
            repos.state === "error" ? (
              <div className="np-note">
                <p>{repos.message}</p>
                {repos.notConnected && shell && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      onClose();
                      shell.showView("connections");
                    }}
                  >
                    Open Connections
                  </button>
                )}
              </div>
            ) : repos.state !== "ready" ? (
              <p className="np-note" role="status">Loading your repositories…</p>
            ) : repoList.length === 0 ? (
              <p className="np-note">GitHub lists no repositories for this connection.</p>
            ) : (
              <div className="np-field">
                <label htmlFor={`${ids}-repo`}>Repository</label>
                <select id={`${ids}-repo`} value={repo} disabled={busy} onChange={(e) => setRepo(e.target.value)}>
                  {repoList.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {visibleControls(r.fullName)}
                      {r.private ? " · private" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )
          )}

          {choice === "folder" && (
            <div className="np-folder">
              {typed ? (
                <div className="np-field">
                  <label htmlFor={`${ids}-path`}>Folder path</label>
                  <input
                    id={`${ids}-path`}
                    ref={pathRef}
                    className="mono"
                    value={folder}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="The full path of the folder"
                    onChange={(e) => setFolder(e.target.value)}
                  />
                  <span className="np-hint">The folder picker isn't available here, so type the folder's full path.</span>
                </div>
              ) : (
                <div className="np-pick">
                  <button type="button" className="quiet" disabled={busy || picking} onClick={() => void pick()}>
                    Choose folder…
                  </button>
                  {folder !== "" ? <code className="np-path">{clip(visibleControls(folder), 200)}</code> : <span className="np-hint">Nothing chosen yet.</span>}
                </div>
              )}
              <span className="np-hint">The folder is copied in. Its .git folder is skipped and its .gitignore is respected.</span>
            </div>
          )}

          {imports && <SecretsTick checked={includeSecrets} onChange={setIncludeSecrets} />}
        </div>

        {error !== null && (
          <p className="modal-notice" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="quiet" onClick={onClose} disabled={working && sent === null}>
            Cancel
          </button>
          <button type="submit" disabled={!ready || busy}>
            {working ? (choice === "files" ? "Adding…" : "Copying in…") : choice === "files" && files.length > 0 ? `Create and add ${plural(files.length, "file")}` : "Create project"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
