import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PickFolderMessage, PickedFolderMessage } from "../host.js";

/** A pick was asked for while another one is still open. */
export class PickerBusyError extends Error {
  constructor() {
    super("A folder pick is already open");
    this.name = "PickerBusyError";
  }
}

/** The part of the host IPC channel the picker uses (`process.send` and `process.on("message")` under a host). */
export type FolderPickerIo = {
  send(message: PickFolderMessage): void;
  on(listener: (message: unknown) => void): void;
};

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_PATH = 4096;

/** A usable answer path: a string of 1–4096 characters, absolute by `node:path`. */
function validPath(p: unknown): p is string {
  return typeof p === "string" && p.length >= 1 && p.length <= MAX_PATH && isAbsolute(p);
}

/**
 * Asks the host (the desktop app's main process) to show the system folder picker, over the server child's existing
 * IPC channel. One pick runs at a time: a call while one is open rejects with PickerBusyError. A pick resolves with the
 * chosen absolute path, or null when the person canceled, the answer's path is not a valid absolute path, sending
 * fails, or `timeoutMs` (default 10 minutes) passes. Answers with any other id, and anything that is not a
 * `picked_folder`, are ignored.
 */
export function createFolderPicker(
  io: FolderPickerIo,
  opts: { timeoutMs?: number; newId?: () => string } = {},
): () => Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const newId = opts.newId ?? randomUUID;
  let open: { id: string; finish(path: string | null): void } | null = null;

  io.on((message) => {
    const m = message as Partial<PickedFolderMessage> | null;
    if (open === null || typeof m !== "object" || m === null || m.type !== "picked_folder" || m.id !== open.id) return;
    open.finish(validPath(m.path) ? m.path : null);
  });

  return () => {
    if (open !== null) return Promise.reject(new PickerBusyError());
    const id = newId();
    return new Promise<string | null>((resolve) => {
      const finish = (path: string | null) => {
        if (open?.id !== id) return;
        clearTimeout(timer);
        open = null;
        resolve(path);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      open = { id, finish };
      try {
        io.send({ type: "pick_folder", id });
      } catch {
        finish(null);
      }
    });
  };
}
