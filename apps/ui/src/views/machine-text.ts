import { visibleControls } from "@theterminal/shared";
import type { HardwareInfo, MachineCapacity } from "@theterminal/shared";

/** A name another machine chose (or this one, as recorded): plain text with hidden characters made visible. */
export const shownName = (name: string) => visibleControls(name);

export const gb = (n: number) => `${n} GB`;

/** A machine's hardware on one line: `cpu · memory · gpu`. */
export const hardwareSummary = (hw: HardwareInfo) =>
  `${hw.cpu ?? "CPU not detected"} · ${hw.memoryGb === null ? "memory not detected" : gb(hw.memoryGb)} · ${hw.gpu ?? "GPU not detected"}`;

/** A linked machine's state as the Capacity views say it. */
export const machineState = (m: MachineCapacity) => (m.problem === "key_mismatch" ? "key changed" : m.online ? "online" : "offline");

/** Shown in place of a machine's figures when the machine at its address presented another key. */
export const KEY_CHANGED = "This machine's key has changed. Unlink it and pair again.";
