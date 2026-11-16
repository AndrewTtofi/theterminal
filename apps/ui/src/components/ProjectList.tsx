import { useState } from "react";
import type { Project } from "@theterminal/shared";
import { gateFor, useViewerRole } from "../shell/model";
import { NewProjectDialog } from "./NewProjectDialog";
import "./sources.css";

type Props = {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Starts an empty project from the name typed in the list. */
  onCreate: (name: string) => void;
  /** A project the New project dialog made (from files, GitHub, a folder, or empty): the caller selects it. */
  onCreated?: (p: Project) => void;
};

export function ProjectList({ projects, selectedId, onSelect, onCreate, onCreated }: Props) {
  const [name, setName] = useState("");
  const [dialog, setDialog] = useState(false);
  const may = gateFor(useViewerRole(), "maintainer");
  return (
    <nav className="projects" aria-label="Projects">
      <h2>Projects</h2>
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <button className={p.id === selectedId ? "selected" : ""} onClick={() => onSelect(p.id)}>
              {p.name}
            </button>
          </li>
        ))}
      </ul>
      {onCreated && (
        <button type="button" className="new-project" disabled={may.disabled} title={may.title} onClick={() => setDialog(true)}>
          <span aria-hidden="true">+ </span>New project…
        </button>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          onCreate(n);
          setName("");
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={onCreated ? "Or start empty: a name" : "+ New project"}
          aria-label="New project name"
          disabled={may.disabled}
          title={may.title}
        />
      </form>
      {dialog && onCreated && <NewProjectDialog onClose={() => setDialog(false)} onCreated={onCreated} />}
    </nav>
  );
}
