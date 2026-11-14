import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Connection } from "@theterminal/shared";
import { MCP_SERVER_NAME, mcpServerName, parsePairs, toMcpSpec } from "../../src/connections/mcp.js";

const conn = (over: Partial<Connection>): Connection => ({
  id: "3f9a2c1e-0000-4000-8000-000000000000", kind: "mcp", provider: "mcp_http", name: "Docs", enabled: true,
  config: {}, private: {}, secretFields: [], status: { state: "untested", message: "", testedAt: null },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

const issuePath = (fn: () => unknown): (string | number)[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ZodError);
    return (e as ZodError).issues[0]!.path as (string | number)[];
  }
  throw new Error("did not throw");
};

describe("mcpServerName", () => {
  it("is tt- and the first 8 letters or digits of the id, lower case", () => {
    expect(mcpServerName("3f9a2c1e-0000-4000-8000-000000000000")).toBe("tt-3f9a2c1e");
    expect(MCP_SERVER_NAME.test(mcpServerName("3f9a2c1e-0000-4000-8000-000000000000"))).toBe(true);
    expect(mcpServerName("AB-CD_ef12345678")).toBe("tt-abcdef12");
  });
  it("throws a RangeError when fewer than 8 remain", () => {
    expect(() => mcpServerName("conn1")).toThrow(RangeError);
    expect(() => mcpServerName("--__--ab")).toThrow(RangeError);
  });
});

describe("parsePairs", () => {
  it("skips blank lines and keeps everything after the first =", () => {
    expect(parsePairs("A=1\n\nB=x=y", "env")).toEqual({ A: "1", B: "x=y" });
    expect(parsePairs("A=1\r\nB=2\r\n", "env")).toEqual({ A: "1", B: "2" });
  });
  it("refuses a line without = or with a bad name, at [kind, lineNumber], without echoing the line", () => {
    expect(issuePath(() => parsePairs("bad line", "env"))).toEqual(["env", 1]);
    expect(issuePath(() => parsePairs("A=1\n\n1BAD=TESTKEY-value-000", "env"))).toEqual(["env", 3]);
    try {
      parsePairs("A=1\n1BAD=TESTKEY-value-000", "env");
    } catch (e) {
      expect(JSON.stringify((e as ZodError).issues)).not.toContain("TESTKEY");
    }
  });
  it("accepts header names with dashes and refuses spaces", () => {
    expect(parsePairs("X-Token=abc", "headers")).toEqual({ "X-Token": "abc" });
    expect(issuePath(() => parsePairs("Bad Name=1", "headers"))).toEqual(["headers", 1]);
    expect(() => parsePairs("X-Token=abc", "env")).toThrow(ZodError);
  });
});

describe("toMcpSpec", () => {
  it("builds an http spec with parsed headers", () => {
    const c = conn({ config: { url: "https://mcp.example.com/mcp" }, secretFields: ["headers"] });
    expect(toMcpSpec(c, { headers: "Authorization=Bearer TESTKEY-hdr-0000000000" })).toEqual({
      serverName: "tt-3f9a2c1e", connectionId: c.id, name: "Docs", transport: "http",
      url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer TESTKEY-hdr-0000000000" },
    });
    expect(toMcpSpec(c, {})).toMatchObject({ transport: "http", headers: {} });
  });
  it("builds a stdio spec, splitting args on new lines and dropping blank ones", () => {
    const c = conn({ provider: "mcp_stdio", name: "Files" });
    expect(toMcpSpec(c, { command: "npx", args: "-y\n\nexample-server\n", env: "ROOT_DIR=/tmp/x" })).toEqual({
      serverName: "tt-3f9a2c1e", connectionId: c.id, name: "Files", transport: "stdio",
      command: "npx", args: ["-y", "example-server"], env: { ROOT_DIR: "/tmp/x" },
    });
    expect(toMcpSpec(c, { command: "npx" })).toMatchObject({ args: [], env: {} });
  });
  it("refuses a connection that is not an MCP server", () => {
    expect(() => toMcpSpec(conn({ provider: "aws", kind: "cloud" }), {})).toThrow();
  });
});
