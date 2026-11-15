#!/usr/bin/env node
// A scripted fake of `gemini --acp`: an ACP agent over NDJSON JSON-RPC on stdio, with no dependencies.
//
// Fidelity notes (gemini-cli 0.68.0):
// - It models the ACP agent only, not the npm `bundle/gemini.js` wrapper that relaunches the CLI as a child
//   (the adapter disables that relaunch with GEMINI_CLI_NO_RELAUNCH).
// - A read_file whose client read was denied is still reported as a `completed` tool call, never `failed`.
// - Edits ask through session/request_permission (with the diff) and then write through fs/write_text_file; with
//   the stock CLI that depends on the adapter's `--policy` file, which makes every kept tool call ask.
// - The real CLI never calls terminal/*; the terminal steps here exercise the adapter's implementation.
//
// THETERMINAL_FAKE_GEMINI_SCRIPT: JSON, either an array of steps or { config, steps }.
//   config: { protocolVersion?, modes?: SessionModeState | null, exitAt?: <method>, failAt?: <method>, startDelayMs? }
//           startDelayMs: read nothing for this long after starting, as a slow start (Windows CI) would
//   steps (run in order when the prompt arrives):
//     { type: "message", text }
//     { type: "read", path, line?, limit?, toolCall?: boolean }        // toolCall: wrap in tool_call in_progress/completed
//     { type: "write", path, content, permission?: boolean, writeContent?: string }
//                                                    // permission: ask first (edit kind, diff newText = content), as gemini does;
//                                                    // writeContent: what fs/write_text_file then carries (default content)
//     { type: "terminal", command, args?, cwd?, env?, outputByteLimit?, skipWait?: boolean }
//     { type: "requestPermission", toolCall, options, result?: string }  // result: text content on completion
//     { type: "ungatedTool", toolCallId?, kind, title, locations?, status? } // in_progress then completed, no gate
//     { type: "mcpTool", server?, tool, permission?: boolean } // a tool_call named mcp_<server>_<tool> of kind other: asks
//                                                    // through session/request_permission when permission is true, else runs
//                                                    // ungated; server defaults to the first session/new mcpServers[].name,
//                                                    // and the step is skipped when there is none
//     { type: "update", update, sessionId? }                         // any raw session/update
//     { type: "request", method, params }                            // any raw client request
//     { type: "sleep", ms }
//     { type: "hang" }                                               // never finish the prompt
//     { type: "exit", code }
//     { type: "fail", message }                                      // prompt fails with a JSON-RPC error
//     { type: "stop", reason }                                       // stopReason for the prompt
// THETERMINAL_FAKE_LOG: NDJSON file; every message received and every step outcome is appended.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const raw = JSON.parse(process.env.THETERMINAL_FAKE_GEMINI_SCRIPT ?? "[]");
const config = Array.isArray(raw) ? {} : (raw.config ?? {});
const steps = Array.isArray(raw) ? raw : (raw.steps ?? []);
const logPath = process.env.THETERMINAL_FAKE_LOG;
const SESSION = "fake-session";
const DEFAULT_MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default", description: "Prompts for approval" },
    { id: "autoEdit", name: "Auto Edit", description: "Auto-approves edit tools" },
    { id: "yolo", name: "YOLO", description: "Auto-approves all tools" },
  ],
};

function log(entry) {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let nextId = 1;
/** The session/new params (logged with every received message), for the mcpTool step. */
let sessionParams = null;
const pending = new Map();
/** A client request; resolves { result } or { error }. */
function request(method, params) {
  const id = `fake-${nextId++}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function update(update, sessionId = SESSION) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envSnapshot() {
  const picked = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GEMINI_|GOOGLE_|VERTEX|GIT_|NO_BROWSER$)/i.test(k)) picked[k] = v;
  }
  // What the real CLI would read: user-scope settings from GEMINI_CLI_HOME, policies from the --policy argument.
  let settings = null;
  const home = process.env.GEMINI_CLI_HOME;
  if (home) {
    try {
      settings = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    } catch (e) {
      settings = { error: String(e) };
    }
  }
  const policies = {};
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--policy");
  if (at >= 0 && argv[at + 1]) {
    for (const f of readdirSync(argv[at + 1])) policies[f] = readFileSync(join(argv[at + 1], f), "utf8");
  }
  return { env: picked, settings, policies, argv, cwd: process.cwd() };
}

async function runStep(step) {
  switch (step.type) {
    case "message":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } });
      return;
    case "read": {
      const id = `call-${nextId++}`;
      if (step.toolCall) {
        update({ sessionUpdate: "tool_call", toolCallId: id, status: "in_progress", title: `Read ${step.path}`, kind: "read", locations: [{ path: step.path }], content: [] });
      }
      const r = await request("fs/read_text_file", { sessionId: SESSION, path: step.path, ...(step.line !== undefined && { line: step.line }), ...(step.limit !== undefined && { limit: step.limit }) });
      log({ step: "read", path: step.path, ...r });
      if (step.toolCall) {
        update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", kind: "read", content: [] });
      }
      return;
    }
    case "write": {
      const id = `call-${nextId++}`;
      if (step.permission) {
        const toolCall = { toolCallId: id, status: "pending", title: `Write ${step.path}`, kind: "edit", locations: [{ path: step.path }], content: [{ type: "diff", path: step.path, oldText: null, newText: step.content }] };
        update({ sessionUpdate: "tool_call", ...toolCall });
        const options = [
          { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" },
          { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
          { optionId: "cancel", name: "Reject", kind: "reject_once" },
        ];
        const p = await request("session/request_permission", { sessionId: SESSION, toolCall, options });
        log({ step: "permission", path: step.path, ...p });
        const optionId = p.result?.outcome?.outcome === "selected" ? p.result.outcome.optionId : "cancel";
        if (optionId === "cancel") {
          update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", kind: "edit", content: [{ type: "content", content: { type: "text", text: "canceled by the user" } }] });
          return;
        }
      }
      const r = await request("fs/write_text_file", { sessionId: SESSION, path: step.path, content: step.writeContent ?? step.content });
      log({ step: "write", path: step.path, ...r });
      if (step.permission) {
        update({ sessionUpdate: "tool_call_update", toolCallId: id, status: r.error ? "failed" : "completed", kind: "edit", content: [{ type: "content", content: { type: "text", text: r.error ? "write failed" : "written" } }] });
      }
      return;
    }
    case "terminal": {
      const params = { sessionId: SESSION, command: step.command, args: step.args ?? [] };
      if (step.cwd !== undefined) params.cwd = step.cwd;
      if (step.env !== undefined) params.env = step.env;
      if (step.outputByteLimit !== undefined) params.outputByteLimit = step.outputByteLimit;
      const created = await request("terminal/create", params);
      log({ step: "terminal/create", command: step.command, ...created });
      if (created.error) return;
      const terminalId = created.result.terminalId;
      if (!step.skipWait) {
        const exit = await request("terminal/wait_for_exit", { sessionId: SESSION, terminalId });
        log({ step: "terminal/wait_for_exit", ...exit });
      }
      const out = await request("terminal/output", { sessionId: SESSION, terminalId });
      log({ step: "terminal/output", ...out });
      const released = await request("terminal/release", { sessionId: SESSION, terminalId });
      log({ step: "terminal/release", ...released });
      return;
    }
    case "requestPermission": {
      const toolCall = step.toolCall;
      update({ sessionUpdate: "tool_call", ...toolCall, status: "pending" });
      const p = await request("session/request_permission", { sessionId: SESSION, toolCall, options: step.options });
      log({ step: "requestPermission", toolCallId: toolCall.toolCallId, ...p });
      const chosen = p.result?.outcome?.outcome === "selected" ? step.options.find((o) => o.optionId === p.result.outcome.optionId) : undefined;
      const allowed = chosen !== undefined && (chosen.kind === "allow_once" || chosen.kind === "allow_always");
      update({
        sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: allowed ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: allowed ? (step.result ?? "done") : "canceled" } }],
      });
      return;
    }
    case "ungatedTool": {
      const id = step.toolCallId ?? `call-${nextId++}`;
      update({ sessionUpdate: "tool_call", toolCallId: id, status: step.status ?? "in_progress", title: step.title, kind: step.kind, locations: step.locations ?? [], content: [] });
      await sleep(20);
      update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: "ran" } }] });
      return;
    }
    case "mcpTool": {
      const server = step.server ?? sessionParams?.mcpServers?.[0]?.name;
      if (server === undefined) return;
      const name = `mcp_${server}_${step.tool}`;
      const id = `${name}-${nextId++}`;
      const toolCall = { toolCallId: id, title: name, kind: "other", locations: [], content: [] };
      let allowed = true;
      if (step.permission) {
        update({ sessionUpdate: "tool_call", ...toolCall, status: "pending" });
        const options = [
          { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" },
          { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
          { optionId: "cancel", name: "Reject", kind: "reject_once" },
        ];
        const p = await request("session/request_permission", { sessionId: SESSION, toolCall, options });
        allowed = p.result?.outcome?.outcome === "selected" && p.result.outcome.optionId !== "cancel";
      } else {
        update({ sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
        await sleep(20);
      }
      log({ step: "mcpTool", name, allowed });
      update({
        sessionUpdate: "tool_call_update", toolCallId: id, status: allowed ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: allowed ? "done" : "canceled" } }],
      });
      return;
    }
    case "update":
      update(step.update, step.sessionId ?? SESSION);
      return;
    case "request": {
      const r = await request(step.method, step.params);
      log({ step: "request", method: step.method, ...r });
      return;
    }
    case "sleep":
      await sleep(step.ms);
      return;
    case "hang":
      await new Promise(() => undefined);
      return;
    case "exit":
      log({ step: "exit", code: step.code });
      process.exit(step.code);
      return;
    default:
      return;
  }
}

async function prompt(id) {
  let stopReason = "end_turn";
  for (const step of steps) {
    if (step.type === "fail") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: step.message } });
      return;
    }
    if (step.type === "stop") {
      stopReason = step.reason;
      continue;
    }
    await runStep(step);
  }
  log({ step: "prompt-done" });
  send({ jsonrpc: "2.0", id, result: { stopReason } });
}

function onMessage(msg) {
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve("error" in msg ? { error: msg.error } : { result: msg.result });
    return;
  }
  log({ method: msg.method, params: msg.params });
  if (config.exitAt === msg.method) {
    process.stderr.write("fake gemini: exiting at " + msg.method + "\n");
    process.exit(1);
  }
  if (config.failAt === msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required." } });
    return;
  }
  switch (msg.method) {
    case "initialize":
      log({ initialize: envSnapshot() });
      send({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: config.protocolVersion ?? msg.params.protocolVersion,
          agentInfo: { name: "fake-gemini", title: "Fake Gemini", version: "0.0.0" },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true } },
          authMethods: [
            { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
            { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
          ],
        },
      });
      return;
    case "authenticate":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/new":
      sessionParams = msg.params;
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SESSION, ...(config.modes !== null && { modes: config.modes ?? DEFAULT_MODES }) } });
      return;
    case "session/set_mode":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/prompt":
      void prompt(msg.id);
      return;
    case "session/cancel":
      return;
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}

function listen() {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "") return;
    onMessage(JSON.parse(line));
  });
  process.stdin.on("end", () => process.exit(0));
}
if (config.startDelayMs) setTimeout(listen, config.startDelayMs);
else listen();
