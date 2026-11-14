import { useState } from "react";
import type { Project } from "@theterminal/shared";

type Props = {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
};

export function ProjectList({ projects, selectedId, onSelect, onCreate }: Props) {
  const [name, setName] = useState("");
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          onCreate(n);
          setName("");
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="+ New project" aria-label="New project name" />
      </form>
    </nav>
  );
}
