import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

/** The app's own command-line flags. Everything else on the command line (Chromium, Playwright) is ignored. */
export type DesktopArgs = { dataDir?: string; port?: number; headless: boolean; readyFile?: string };

/** A malformed app flag. Its message is fixed and safe to print. */
export class DesktopArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopArgsError";
  }
}

const PORT_ERROR = "--port must be an integer from 0 to 65535";

function absolutePath(value: string | boolean | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAbsolute(value)) throw new DesktopArgsError(`${flag} must be an absolute path`);
  return value;
}

function port(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) throw new DesktopArgsError(PORT_ERROR);
  const n = Number(value);
  if (n > 65535) throw new DesktopArgsError(PORT_ERROR);
  return n;
}

/**
 * Reads `--data-dir <abs>`, `--port <n>`, `--headless` and `--ready-file <abs>`. Unknown switches and positionals
 * are ignored, because Electron, Chromium and Playwright add their own.
 */
export function parseDesktopArgs(argv: string[]): DesktopArgs {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string" },
      headless: { type: "boolean" },
      "ready-file": { type: "string" },
    },
  });
  const result: DesktopArgs = { headless: values.headless === true };
  const dataDir = absolutePath(values["data-dir"], "--data-dir");
  if (dataDir !== undefined) result.dataDir = dataDir;
  const p = port(values.port);
  if (p !== undefined) result.port = p;
  const readyFile = absolutePath(values["ready-file"], "--ready-file");
  if (readyFile !== undefined) result.readyFile = readyFile;
  return result;
}
