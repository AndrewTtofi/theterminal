import { z } from "zod";
import type { Connection, ConnectionProvider } from "@theterminal/shared";

/** The name an MCP server is given in a run: unique per connection, never the Owner's own name for it. */
export const MCP_SERVER_NAME = /^tt-[a-z0-9]{8}$/;

const PAIR_NAME = { env: /^[A-Za-z_][A-Za-z0-9_]*$/, headers: /^[A-Za-z0-9-]+$/ } as const;

export type McpServerSpec = { serverName: string; connectionId: string; name: string } & (
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http"; url: string; headers: Record<string, string> }
);

/** Which name rule a provider's "pairs" field follows: HTTP header names for a remote server, variable names otherwise. */
export function pairsKind(provider: ConnectionProvider): "env" | "headers" {
  return provider === "mcp_http" ? "headers" : "env";
}

/** "tt-" and the first 8 letters or digits of the connection id, lower case. */
export function mcpServerName(connectionId: string): string {
  const plain = connectionId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (plain.length < 8) throw new RangeError("connection id is too short for an MCP server name");
  return `tt-${plain.slice(0, 8)}`;
}

/**
 * Parses NAME=value lines. Blank lines are skipped; the value is everything after the first "=". A bad line throws a
 * ZodError at [kind, lineNumber] (1-based) that never contains the line itself.
 */
export function parsePairs(text: string, kind: "env" | "headers"): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") return;
    const eq = line.indexOf("=");
    const name = eq === -1 ? "" : line.slice(0, eq);
    if (!PAIR_NAME[kind].test(name)) {
      const expected = kind === "env" ? "NAME=value with a variable name" : "Name=value with a header name";
      throw new z.ZodError([{ code: "custom", path: [kind, i + 1], message: `must be ${expected}` }]);
    }
    out[name] = line.slice(eq + 1);
  });
  return out;
}

/** The spec handed to the agent's program for an MCP connection, from its stored values. */
export function toMcpSpec(conn: Connection, values: Record<string, string>): McpServerSpec {
  const base = { serverName: mcpServerName(conn.id), connectionId: conn.id, name: conn.name };
  if (conn.provider === "mcp_http") {
    return { ...base, transport: "http", url: conn.config.url ?? "", headers: values.headers ? parsePairs(values.headers, "headers") : {} };
  }
  if (conn.provider === "mcp_stdio") {
    const args = (values.args ?? "").split("\n").map((a) => a.replace(/\r$/, "")).filter((a) => a.trim() !== "");
    return { ...base, transport: "stdio", command: values.command ?? "", args, env: values.env ? parsePairs(values.env, "env") : {} };
  }
  throw new TypeError("not an MCP server connection");
}
