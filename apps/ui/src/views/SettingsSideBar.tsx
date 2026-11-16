import { AppearanceSettings } from "./AppearanceSettings";
import { WorkspaceSettings } from "./WorkspaceSettings";

/** The Settings view, opened from the gear at the bottom of the activity bar: Appearance, then Workspace. */
export function SettingsSideBar() {
  return (
    <div className="settings-side">
      <AppearanceSettings />
      <WorkspaceSettings />
    </div>
  );
}
