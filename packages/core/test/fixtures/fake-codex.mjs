// A script-driven stand-in for `codex app-server` (the subset the Codex adapter uses), for tests only.
// It speaks the same newline-delimited JSON-RPC shapes as @openai/codex 0.169.0: messages it sends carry no
// "jsonrpc" field, item ids link approvals to items, and a command's or file change's item/started precedes its
// approval request.
//
// THETERMINAL_FAKE_CODEX_SCRIPT: JSON, either an array of steps or { steps, loggedOut, threadStartPolicy,
//   threadStartError, ignoreSigterm, ignoreEof, codexHome, mcpServers: ["name"], mcpIgnoresDisable,
//   mcpAddedByThread: ["name"] (servers only the started thread sees, e.g. from a project layer) }. Steps:
//   {"approve":"command","command":"ls","cwd"?:"…","itemId":"i1","output"?:"…","exitCode"?:0,"nullCommand"?:true,
//    "network"?:{"host":"…","protocol":"https"}} (network: once running, ask for network access for the same item)
//   {"approve":"fileChange","itemId":"f1","changes":[{"path":"a.txt","kind":"add"|"update"|"delete","diff"?:"…"}]}
//   {"message":"text"}  {"unknownRequest":"x/y"}  {"fail":"reason"}
//   {"ungated":"commandExecution"|"mcpToolCall"|…} (a command also streams output, as one that really ran would)
//   {"exit":1,"stderr"?:"…"}  {"hang":true}
// THETERMINAL_FAKE_LOG: a file that receives one JSON line per event (start, requests, notifications, and the
//   answers to the fake's own server-requests), for test assertions.
import { appendFileSync } from "node:fs";

const raw = process.env.THETERMINAL_FAKE_CODEX_SCRIPT ?? "[]";
const parsed = JSON.parse(raw);
const script = Array.isArray(parsed) ? { steps: parsed } : parsed;
const steps = script.steps ?? [];
const logFile = process.env.THETERMINAL_FAKE_LOG;
const log = (entry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
};

if (script.ignoreSigterm) process.on("SIGTERM", () => log({ signal: "SIGTERM" }));
log({
  start: true,
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
  },
});

const THREAD = "thread-1";
const TURN = "turn-1";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });
let nextId = 1;
const waiting = new Map();
const serverRequest = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, (msg) => {
      log({ answered: method, ...("result" in msg ? { result: msg.result } : { error: msg.error }) });
      resolve(msg);
    });
    send({ id, method, params });
  });

const turn = (status, error = null) => ({
  id: TURN, rootTurnId: TURN, items: [], itemsView: "notLoaded", status, error, startedAt: 1, completedAt: null, durationMs: null,
});
const now = () => Date.now();
const started = (item) => notify("item/started", { item, threadId: THREAD, turnId: TURN, startedAtMs: now() });
const completed = (item) => notify("item/completed", { item, threadId: THREAD, turnId: TURN, completedAtMs: now() });
const commandItem = (s, status, extra = {}) => ({
  type: "commandExecution", id: s.itemId, pluginId: null, scriptPath: null, command: s.command ?? "ls", cwd: s.cwd ?? process.cwd(),
  processId: null, source: "agent", status, commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra,
});
const fileItem = (s, status) => ({
  type: "fileChange", id: s.itemId, status,
  changes: (s.changes ?? []).map((c) => ({
    path: c.path, diff: c.diff ?? "", kind: c.kind === "update" ? { type: "update", move_path: c.movePath ?? null } : { type: c.kind },
  })),
});
let interrupted = false;
let threadConfig = {};

async function runSteps() {
  notify("turn/started", { threadId: THREAD, turn: turn("inProgress") });
  for (const s of steps) {
    if (interrupted) return;
    if (s.approve === "command") {
      // The real server announces the command item before asking (bespoke_event_handling.rs).
      started(commandItem(s, "inProgress"));
      const r = await serverRequest("item/commandExecution/requestApproval", {
        kind: "command", threadId: THREAD, turnId: TURN, itemId: s.itemId, startedAtMs: now(), approvalId: null,
        environmentId: "local", reason: null, command: s.nullCommand ? null : s.command, cwd: s.nullCommand ? null : (s.cwd ?? null),
        commandActions: [], proposedExecpolicyAmendment: { command: [s.command] },
      });
      if (r.result?.decision !== "accept") {
        completed(commandItem(s, "declined"));
      } else {
        const output = s.output ?? `ran ${s.command}`;
        notify("item/commandExecution/outputDelta", { threadId: THREAD, turnId: TURN, itemId: s.itemId, delta: output });
        if (s.network) {
          await serverRequest("item/commandExecution/requestApproval", {
            kind: "command", threadId: THREAD, turnId: TURN, itemId: s.itemId, startedAtMs: now(), approvalId: "net-1",
            environmentId: "local", reason: "network access", networkApprovalContext: s.network, command: null, cwd: null,
            commandActions: null, proposedExecpolicyAmendment: null,
          });
        }
        const exitCode = s.exitCode ?? 0;
        completed(commandItem(s, exitCode === 0 ? "completed" : "failed", { aggregatedOutput: output, exitCode, durationMs: 5 }));
      }
    } else if (s.approve === "fileChange") {
      started(fileItem(s, "inProgress"));
      const r = await serverRequest("item/fileChange/requestApproval", {
        threadId: THREAD, turnId: TURN, itemId: s.itemId, startedAtMs: now(), reason: null, grantRoot: s.grantRoot ?? null,
      });
      completed(fileItem(s, r.result?.decision === "accept" ? "completed" : "declined"));
    } else if (typeof s.message === "string") {
      const id = s.itemId ?? `msg-${nextId++}`;
      const item = (text) => ({ type: "agentMessage", id, text, phase: null, moderation: null, memoryCitation: null, delivery: null, questions: null });
      started(item(""));
      const half = Math.ceil(s.message.length / 2);
      for (const delta of [s.message.slice(0, half), s.message.slice(half)]) {
        notify("item/agentMessage/delta", { threadId: THREAD, turnId: TURN, itemId: id, delta });
      }
      completed(item(s.message));
    } else if (typeof s.unknownRequest === "string") {
      await serverRequest(s.unknownRequest, { threadId: THREAD, turnId: TURN, itemId: "u1" });
    } else if (typeof s.ungated === "string") {
      const id = s.itemId ?? "ungated-1";
      if (s.ungated === "commandExecution") {
        started(commandItem({ itemId: id, command: s.command ?? "cat notes.txt" }, "inProgress"));
        notify("item/commandExecution/outputDelta", { threadId: THREAD, turnId: TURN, itemId: id, delta: "secret notes" });
      } else {
        started({ type: s.ungated, id, status: "inProgress" });
      }
    } else if (typeof s.fail === "string") {
      const error = { message: s.fail, codexErrorInfo: null, additionalDetails: null, misalignment: null };
      notify("error", { error, willRetry: false, threadId: THREAD, turnId: TURN });
      notify("turn/completed", { threadId: THREAD, turn: turn("failed", error) });
      return;
    } else if (typeof s.exit === "number") {
      if (s.stderr) process.stderr.write(s.stderr);
      process.exit(s.exit);
    } else if (s.hang) {
      return;
    }
  }
  notify("thread/tokenUsage/updated", {
    threadId: THREAD, turnId: TURN,
    tokenUsage: { total: { totalTokens: 10, inputTokens: 6, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 } },
  });
  notify("turn/completed", { threadId: THREAD, turn: turn("completed") });
}

function handleRequest(msg) {
  const reply = (result) => send({ id: msg.id, result });
  const fail = (message) => send({ id: msg.id, error: { code: -32600, message } });
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return reply({
        userAgent: "fake/0.169.0", codexHome: script.codexHome ?? process.env.CODEX_HOME ?? "/fake/codex-home",
        platformFamily: "unix", platformOs: "macos",
      });
    case "mcpServerStatus/list": {
      const names = [...(script.mcpServers ?? []), ...(p.threadId ? (script.mcpAddedByThread ?? []) : [])];
      const disabled = (n) => !script.mcpIgnoresDisable && threadConfig[`mcp_servers.${n}.enabled`] === false;
      return reply({
        data: names.map((name) => ({
          name, runtimeStatus: p.threadId ? (disabled(name) ? "disabled" : "connected") : null, pluginId: null, httpOrigin: null,
          serverInfo: null, serverCapabilities: null, toolListMeta: null, tools: {}, toolsError: null, resources: [],
          resourceTemplates: [], authStatus: "unsupported",
        })),
        nextCursor: null,
      });
    }
    case "account/read":
      return reply({
        account: script.loggedOut ? null : { type: "chatgpt", email: null, planType: "plus", workspaceName: null },
        userId: null, requiresOpenaiAuth: true,
      });
    case "account/login/start":
      return p.type === "apiKey" && p.apiKey ? reply({ type: "apiKey" }) : fail("bad login");
    case "thread/start": {
      if (script.threadStartError) return fail(script.threadStartError);
      const cfg = p.config ?? {};
      threadConfig = cfg;
      return reply({
        thread: { id: THREAD, cwd: p.cwd, turns: [] }, model: "fake-model", modelProvider: "openai", serviceTier: null,
        disabledPluginIds: [], cwd: p.cwd, instructionSources: [],
        approvalPolicy: script.threadStartPolicy ?? p.approvalPolicy ?? "on-request",
        approvalsReviewer: p.approvalsReviewer ?? "user",
        sandbox: p.sandbox === "workspace-write"
          ? {
              type: "workspaceWrite", writableRoots: [], networkAccess: cfg["sandbox_workspace_write.network_access"] ?? false,
              excludeTmpdirEnvVar: cfg["sandbox_workspace_write.exclude_tmpdir_env_var"] ?? false,
              excludeSlashTmp: cfg["sandbox_workspace_write.exclude_slash_tmp"] ?? false,
            }
          : { type: "dangerFullAccess" },
        reasoningEffort: null,
      });
    }
    case "turn/start":
      reply({ turn: turn("inProgress") });
      setImmediate(() => void runSteps());
      return;
    case "turn/interrupt":
      interrupted = true;
      reply({});
      notify("turn/completed", { threadId: THREAD, turn: turn("interrupted") });
      return;
    default:
      return fail(`unknown method ${msg.method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    if (msg.method !== undefined) {
      log({ received: msg.method, ...(msg.id === undefined ? {} : { id: msg.id }), params: msg.params ?? null });
      if (msg.id !== undefined) handleRequest(msg);
    } else {
      const done = waiting.get(msg.id);
      waiting.delete(msg.id);
      done?.(msg);
    }
  }
});
process.stdin.on("end", () => {
  log({ eof: true });
  if (script.ignoreEof) setInterval(() => {}, 1000);
  else process.exit(0);
});
