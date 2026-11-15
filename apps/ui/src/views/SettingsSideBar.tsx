import { AppearanceSettings } from "./AppearanceSettings";

/** The Settings view, opened from the gear at the bottom of the activity bar. Appearance is its first section. */
export function SettingsSideBar() {
  return (
    <div className="settings-side">
      <AppearanceSettings />
    </div>
  );
}
