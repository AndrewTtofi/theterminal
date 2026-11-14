import { ProjectList } from "../components/ProjectList";
import { useShell } from "../shell/model";

export function ProjectsSideBar() {
  const { model } = useShell();
  return (
    <ProjectList
      projects={model.projects}
      selectedId={model.selectedId}
      onSelect={model.onSelectProject}
      onCreate={model.onCreateProject}
    />
  );
}
