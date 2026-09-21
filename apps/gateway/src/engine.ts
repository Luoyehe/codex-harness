import path from "node:path";
import os from "node:os";
import { CodexSupervisor } from "./codex/process.js";
import { ProjectRegistry } from "./projects.js";
import { DisplayPrefsStore } from "./display-prefs.js";
import { AttachmentStore } from "./attachments.js";
import { ProviderInfoReader } from "./provider-info.js";
import { AutoCompaction } from "./auto-compaction.js";
import { Hub, type BrowserClient, type ServerMessage } from "./hub.js";
import { makeDispatcher } from "./api.js";
import { DYNAMIC_TOOL_LIMITS, isProxyableToolCall, handleDynamicToolCall } from "./mcp-proxy.js";
import { shouldAutoApproveMcpElicitation } from "./mcp-approval.js";
import { ActiveTurns } from "./active-turns.js";
import { TurnDefaults } from "./turn-defaults.js";
import { Terminals } from "./terminals.js";
import { observedNotification } from "./protocol.js";
import type { CommandExecutionRequestApprovalResponse } from "../../../protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "../../../protocol/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "../../../protocol/v2/PermissionsRequestApprovalResponse.js";
import type { DynamicToolCallParams } from "../../../protocol/v2/DynamicToolCallParams.js";
import type { ServerRequest } from "../../../protocol/ServerRequest.js";

const GATEWAY_VERSION = "1.2.0";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const WORKSPACE_ROOT = process.env.CODEX_WORKSPACE ?? process.cwd();

/** Server-initiated requests that gate destructive actions; declined when no browser answers. */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const BROWSER_HANDLED: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request",
] satisfies ServerRequest["method"][]);
const isGatewayReservedNotification = (method: string): boolean =>
  method === "appServer/stateChanged"
  || method.startsWith("terminal/")
  || method.startsWith("harness/")
  || method.startsWith("gateway/")
  || method.startsWith("management/")
  || method.startsWith("thread/autoCompact");

/**
 * Protocol-correct "decline" payloads per approval method. Each request type
 * expects a DIFFERENT response shape — a wrong shape is a protocol error that
 * kills the turn, so these must match the generated protocol types.
 */
const DECLINE_PAYLOADS = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  // GrantedPermissionProfile with nothing granted = denial.
  "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
} satisfies {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponse;
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponse;
  "item/permissions/requestApproval": PermissionsRequestApprovalResponse;
};

export function createEngine(send: (clientId: string, message: ServerMessage) => void, options: { onFatalConnectionLoss?: (error: Error) => void; requestAutoCompaction?: (threadId: string) => Promise<unknown> } = {}) {
const hub = new Hub({ serverRequestTimeoutMs: 600_000 });
const notify = (method: string, params: unknown) => {
  // Control observes lifecycle even while every browser is disconnected.
  // One bounded IPC frame, regardless of the number of tabs. The control
  // plane observes once and fans out with per-socket backpressure.
  send("*", { kind: "notification", method, params });
};
const toolRequests = new Map<number | string, AbortController>();
const cancelTools = () => { for (const controller of toolRequests.values()) controller.abort(); toolRequests.clear(); };

// Distinguishes "first boot" from "crash-restart" in onStateChange — only a
// restart needs the terminal/allExited broadcast (first boot has no terminals).
let appServerIsReady = false;

// Active turn per thread, seen on the notification tap — lets turn/interrupt
// work even when the browser (e.g. after a refresh) doesn't know the turn id.
const activeTurns = new ActiveTurns();

// Auto-compaction must exist BEFORE the supervisor so it can tap notifications.
// The supervisor constructor needs it, so we create a mutable reference.
let autoCompaction: Pick<AutoCompaction, "observe" | "forget" | "reset"> | null = null;
let turnDefaults: TurnDefaults | null = null;
let terminals: Terminals | null = null;
const providerInfoReader = new ProviderInfoReader(CODEX_HOME);

const supervisor = new CodexSupervisor(CODEX_BIN, ["app-server"], { CODEX_HOME }, {
  onFatalConnectionLoss: options.onFatalConnectionLoss,
  onNotification: (method, params) => {
    // These lifecycle messages are synthesized by fixed gateway code. An
    // app-server frame with the same name must never reach the outer control
    // state machine as though it came from that trusted source.
    if (isGatewayReservedNotification(method)) {
      process.stderr.write(`[gateway] ignored upstream collision with reserved notification ${method.slice(0, 128)}\n`);
      return;
    }
    if (method === "account/updated") turnDefaults?.invalidateCache();
    if (turnDefaults?.hideNotification(method, params)) return;
    const event = observedNotification(method, params);
    if (event?.method === "serverRequest/resolved") {
      toolRequests.get(event.params.requestId)?.abort();
      toolRequests.delete(event.params.requestId);
      hub.cancelServerRequest(event.params.requestId);
      // Hub translates upstream IDs to generation-safe browser IDs.
      return;
    }
    // Track the active turn per thread so turn/interrupt can fall back to it
    // when a browser lost the id (page refresh mid-turn).
    if (event) activeTurns.observe(event);
    notify(method, params);
    // Publish the completed normal turn BEFORE asking control to admit an
    // automatic compaction, so both messages preserve their causal order.
    if (autoCompaction) {
      try { autoCompaction.observe(method, params); } catch { /* never block broadcast */ }
    }
  },
  onServerRequest: async (id, method, params) => {
    // The mcp_2026_07_28 client gates every MCP tool call behind an
    // elicitation "form" with _meta.codex_approval_kind = "mcp_tool_call".
    // These are our own configured MCP servers, so auto-accept the gate;
    // genuine elicitation forms still fall through to the browser.
    if (method === "mcpServer/elicitation/request" && shouldAutoApproveMcpElicitation(
      params,
      (serverName) => providerInfoReader.isManagedZhipuMcpServer(serverName),
    )) {
      return { action: "accept", content: {}, _meta: null };
    }
    // The mcp_2026_07_28 client delegates MCP tool EXECUTION to us via
    // dynamic tool calls — answer those here instead of asking browsers.
    if (method === "item/tool/call") {
      const toolParams = params as DynamicToolCallParams | null;
      const namespace = toolParams?.namespace;
      if (toolParams && typeof toolParams.tool === "string" && typeof namespace === "string" && isProxyableToolCall(namespace)) {
        if (!providerInfoReader.isManagedZhipuMcpServer(namespace)) {
          throw new Error("dynamic MCP execution requires the active managed Zhipu server configuration");
        }
        if (toolRequests.has(id)) throw new Error("duplicate active dynamic MCP request id");
        if (toolRequests.size >= DYNAMIC_TOOL_LIMITS.concurrent) {
          throw new Error("dynamic MCP tool concurrency limit reached");
        }
        const controller = new AbortController();
        toolRequests.set(id, controller);
        try {
          return await handleDynamicToolCall(toolParams, { signal: controller.signal });
        } catch (err: any) {
          process.stderr.write(`[gateway] dynamic tool call failed: ${err?.message}\n`);
          throw new Error(`tool execution failed: ${err?.message}`);
        } finally {
          if (toolRequests.get(id) === controller) toolRequests.delete(id);
        }
      }
    }
    // The WebUI renders approval, user-input and elicitation prompts. Any other
    // server request would sit in front of browsers for 10 minutes and
    // time out — fail fast with a clear error instead so the turn ends
    // immediately with an actionable message.
    if (!BROWSER_HANDLED.has(method)) {
      throw new Error(
        `server request type not supported by this WebUI: ${method} (please report — the turn was aborted instead of hanging)`,
      );
    }
    const answer = await hub.waitForBrowserAnswer(id, method, params);
    if (answer.answered) {
      if (answer.error) throw new Error(answer.error);
      return answer.payload;
    }
    // Nobody home: fail safely. Approvals are declined, other requests error out.
    if (APPROVAL_METHODS.has(method)) {
      process.stderr.write(`[gateway] auto-declining ${method} (request ${id}): ${answer.error}\n`);
      return DECLINE_PAYLOADS[method as keyof typeof DECLINE_PAYLOADS];
    }
    throw new Error(answer.error ?? "no browser client answered");
  },
  onStateChange: (state) => {
    // This callback is where appServer/stateChanged is SYNTHESIZED — it never
    // arrives via onNotification, so restart side-effects belong here.
    if (state === "ready") {
      appServerIsReady = true;
      attachments.reconcileGeneration();
      void attachments.recoverCleanup().catch(() => { /* uncertain cleanup remains protected */ });
    } else if (appServerIsReady || state === "restarting" || state === "stopped") {
      // Everything below is scoped to one app-server generation.  Clear it
      // as soon as the ready connection is lost, not after a replacement
      // happens to initialize successfully.
      appServerIsReady = false;
      activeTurns.clear();
      cancelTools();
      turnDefaults?.reset();
      terminals?.reset();
      hub.resetPendingAnswers("app-server connection was replaced");
      autoCompaction?.reset();
      notify("terminal/allExited", {
        reason: "app-server disconnected; all terminal sessions have ended",
      });
    }
    notify("appServer/stateChanged", { state });
  },
});

const displayPrefs = new DisplayPrefsStore(CODEX_HOME);

// Auto-compaction: watches token usage and triggers thread/compact/start when
// the conversation approaches the model's context window. Threshold is
// user-configurable via displayPrefs (settings → 通用), default 90%.
autoCompaction = new AutoCompaction(
  { supervisor, notify, requestCompact: options.requestAutoCompaction },
  () => displayPrefs.get().autoCompactThreshold,
);

const projectRegistry = new ProjectRegistry(
  CODEX_HOME,
  WORKSPACE_ROOT,
  // Optional persistence allowlist; unset on the supported bare-metal install.
  // Legacy container environments also retain the registry's volume guard.
  (process.env.CODEX_PERSISTENT_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const attachments = new AttachmentStore(CODEX_HOME);
const recoveryTimer = setInterval(() => {
  if (supervisor.state === "ready") void attachments.recoverCleanup().catch(() => { /* retry bounded pass later */ });
}, 300_000);
recoveryTimer.unref();
turnDefaults = new TurnDefaults(supervisor);
terminals = new Terminals((processId) => supervisor.request("command/exec/terminate", { processId }));

const dispatch = makeDispatcher({
  supervisor,
  workspaceRoot: WORKSPACE_ROOT,
  gatewayVersion: GATEWAY_VERSION,
  projects: projectRegistry,
  displayPrefs,
  attachments,
  turnDefaults,
  terminals,
  providerInfo: () => providerInfoReader.read(),
  providerReader: providerInfoReader,
  activeTurnFor: (threadId) => activeTurns.get(threadId) ?? null,
  clientCount: () => hub.clientCount,
  onThreadDeleted: (threadId) => {
    activeTurns.delete(threadId);
    autoCompaction?.forget(threadId);
  },
  notify,
});


const clients = new Map<string, BrowserClient>();
return {
  start: () => supervisor.start(),
  stop: () => { clearInterval(recoveryTimer); cancelTools(); return supervisor.stop(); },
  dispatch,
  connect(clientId: string) {
    if (clients.has(clientId)) return;
    if (clients.size >= 32) throw new Error("too many browser clients");
    const client: BrowserClient = { send: (message) => send(clientId, message) };
    clients.set(clientId, client);
    terminals!.connect(clientId);
    hub.addClient(client);
  },
  disconnect(clientId: string) {
    const client = clients.get(clientId);
    if (!client) return;
    clients.delete(clientId);
    terminals!.disconnect(clientId);
    hub.removeClient(client);
  },
  answer(requestId: string, payload: unknown, error?: string) {
    return hub.resolveBrowserAnswer(requestId, payload, error);
  },
};
}
