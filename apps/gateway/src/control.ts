import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSupervisor } from "./codex/process.js";
import { AppServerConnection, AppServerRequestError, isDefiniteAppServerRejection } from "./codex/rpc.js";
import type { ServerMessage } from "./hub.js";
import { OperationLedger } from "./operations.js";
import { ThreadStartLedger } from "./thread-start-operations.js";
import { ManagementGate } from "./management.js";
import { FLOW_LIMITS, encodeBounded } from "./flow-control.js";
import { recentLogs, scheduleServiceRestart, serviceStatus } from "./admin.js";
import { observedNotification } from "./protocol.js";

interface Client { send(message: ServerMessage): void; close(code: number, reason: string): void }
const COMPACTION_CONFLICTS = new Set(["thread/start", "thread/resume", "turn/start", "terminal/exec", "thread/compact/start", "account/login/start"]);
/** Fail closed for future browser RPCs: only this explicit set may overlap a
 * provider/catalog transaction. Everything else is admitted as stateful or
 * non-idempotent work. Interrupt/terminate remain available as emergency
 * convergence controls even if activity tracking itself became stale. */
const SAFE_CONCURRENT = new Set([
  "turn/operation", "thread/start/operation", "management/status", "admin/logs", "app/status", "admin/status",
  "projects/list", "displayPrefs/get", "attachment/read", "fs/readDirectory",
  "model/list", "account/read", "thread/list", "thread/read", "mcpServerStatus/list",
  "admin/edge/config", "turn/interrupt", "terminal/terminate",
]);
const MANAGEMENT = new Set(["admin/catalog/sync", "admin/provider/switch"]);
interface ActiveDeviceLogin {
  type: "chatgptDeviceCode";
  loginId: string;
  userCode: string;
  verificationUrl: string;
}
const MAX_ACTIVE_TURNS = 256;
const MAX_ACTIVE_TERMINALS = 64;
const MAX_EARLY_COMPLETIONS = 64;
const MAX_PENDING_SERVER_REQUESTS = 64;
const MAX_PENDING_DISCONNECTS = 64;
const MAX_RETIRED_LOGIN_IDS = 1024;
const validActivityId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
function canonicalControlParams(method: string, params: Record<string, any>): Record<string, unknown> {
  const reject = (field: string): never => {
    throw Object.assign(new Error(`${field} 无效，本次控制请求未派发。`), {
      errorCode: "INVALID_REQUEST", delivery: "rejected",
    });
  };
  if (method === "turn/interrupt") {
    if (!validActivityId(params.threadId)) reject("threadId");
    if (params.turnId !== undefined && params.turnId !== null && params.turnId !== "" && !validActivityId(params.turnId)) reject("turnId");
    return { threadId: params.threadId, ...(validActivityId(params.turnId) ? { turnId: params.turnId } : {}) };
  }
  if (method === "terminal/terminate" || method === "terminal/resize") {
    if (!validActivityId(params.processId)) reject("processId");
    return { processId: params.processId,
      ...(method === "terminal/resize" && typeof params.rows === "number" && Number.isFinite(params.rows) ? { rows: params.rows } : {}),
      ...(method === "terminal/resize" && typeof params.cols === "number" && Number.isFinite(params.cols) ? { cols: params.cols } : {}),
    };
  }
  if (method === "account/login/cancel") {
    if (!validActivityId(params.loginId)) reject("loginId");
    return { loginId: params.loginId };
  }
  return params;
}
function validatedManagementResult(value: any): {
  ok: boolean; changed: boolean; restartRequired: boolean; restarting?: boolean; executionPending?: boolean; output?: string; mode?: "openai" | "zhipu" | "custom";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.ok !== "boolean" || typeof value.changed !== "boolean"
      || typeof value.restartRequired !== "boolean"
      || value.restarting !== undefined && typeof value.restarting !== "boolean"
      || value.executionPending !== undefined && typeof value.executionPending !== "boolean"
      || value.output !== undefined && (typeof value.output !== "string" || value.output.length > 8000)
      || value.mode !== undefined && !["openai", "zhipu", "custom"].includes(value.mode)
      || value.restarting !== undefined && value.restarting !== value.restartRequired
      || value.executionPending && value.ok
      || !value.ok && (value.changed || value.restartRequired)) {
    throw Object.assign(new Error("worker returned an invalid management result; configuration outcome is unknown"), {
      delivery: "unknown", operationState: "unknown",
    });
  }
  // Worker replies are untrusted data. Project the validated protocol fields
  // instead of retaining arbitrary additions in the management gate or
  // reflecting them to the browser.
  return {
    ok: value.ok,
    changed: value.changed,
    restartRequired: value.restartRequired,
    ...(value.restarting !== undefined ? { restarting: value.restarting } : {}),
    ...(value.executionPending !== undefined ? { executionPending: value.executionPending } : {}),
    ...(value.output !== undefined ? { output: value.output } : {}),
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  };
}

/** Only this OS identity owns the listener, auth secret, admission ledger and
 * instance-scoped administrator grant. Worker output is data, never an
 * instruction to invoke a privileged control operation. */
export class GatewayController {
  codexState = "starting";
  private readonly clients = new Map<string, Client>();
  private readonly activeTurns = new Map<string, string>();
  private readonly activeStatusThreads = new Set<string>();
  private readonly activeTerminals = new Set<string>();
  private readonly pendingTurnStarts = new Set<{ threadId: string; ended: Set<string>; invalidated: boolean }>();
  private readonly compactions = new Map<string, { turnId?: string; uncertain: boolean; acknowledged: boolean; completed: boolean }>();
  private readonly pendingLoginStarts = new Set<{ completed: Set<string>; invalidated: boolean }>();
  private readonly activeLogins = new Map<string, ActiveDeviceLogin>();
  private readonly retiredLoginIds = new Set<string>();
  private retiredLoginIdsSaturated = false;
  private uncertainLogin = false;
  private uncertainTurnStart = false;
  private activityUnknown = false;
  private readonly pendingServerRequests = new Set<string>();
  private readonly answeringServerRequests = new Set<string>();
  private readonly pendingDisconnects = new Map<string, { epoch: number }>();
  private backendEpoch = 0;
  private readonly ledger: OperationLedger;
  private readonly threadStarts: ThreadStartLedger;
  private readonly management: ManagementGate;
  private readonly backend: CodexSupervisor;
  constructor(controlHome: string) {
    const launcher = process.env.CODEX_WORKER_LAUNCHER;
    const unsafe = process.env.GATEWAY_UNSAFE_SINGLE_USER === "1";
    if (!launcher && !unsafe) throw new Error("Isolated worker launcher required. Use the installer. Development requires explicit GATEWAY_UNSAFE_SINGLE_USER=1 and has NO Agent/control isolation.");
    if (launcher) {
      if (!path.isAbsolute(launcher) || process.platform !== "linux") throw new Error("worker launcher requires an absolute managed Linux path");
      for (let current = launcher;; current = path.dirname(current)) {
        const info = lstatSync(current);
        if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error("worker launcher and ancestors must be root-owned and not group/world writable");
        if (path.dirname(current) === current) break;
      }
    }
    if (unsafe) process.stderr.write("[gateway] UNSAFE single-user development: Agent and gateway share an OS identity. Do not use with untrusted tasks.\n");
    this.ledger = new OperationLedger(controlHome);
    this.threadStarts = new ThreadStartLedger(controlHome);
    this.management = new ManagementGate(() => this.hasJobs(), (state) => this.broadcast("management/stateChanged", state), controlHome);
    const command = launcher ? "sudo" : process.execPath;
    const args = launcher ? ["-n", launcher, "worker-backend"] : [
      ...(import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : []),
      fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)),
    ];
    const env = { CODEX_HARNESS_WORKER: "1" };
    this.backend = new CodexSupervisor(command, args, env, {
      onNotification: (method, raw) => {
        if (method !== "gateway/clientMessage") return;
        const p = raw as any;
        if (p?.clientId === "*" && p?.message?.kind === "notification") {
          const message = this.observe(p.message);
          for (const client of this.clients.values()) {
            try { client.send(message); } catch { client.close(1013, "oversized response; resynchronize"); }
          }
          return;
        }
        const client = this.clients.get(p?.clientId);
        if (!client || !p?.message || !["notification", "serverRequest"].includes(p.message.kind)) return;
        try { client.send(this.observe(p.message)); } catch { client.close(1013, "oversized response; resynchronize"); }
      },
      onServerRequest: async (_id, method, params) => {
        // This narrow request only admits unprivileged compaction. It cannot
        // select a method, command, path, user or any privileged operation.
        if (method !== "gateway/autoCompact") throw new Error("private worker cannot invoke control-plane requests");
        return this.startCompaction(params, "auto-compaction");
      },
      onStateChange: (state) => {
        if (state === "ready") return;
        if (state === "blocked") {
          this.codexState = state;
          // Preserve activity and the management journal: an owner dying is
          // not proof its worker or a configuration script has stopped.
          this.broadcast("management/stateChanged", this.managementStatus());
          for (const client of this.clients.values()) client.close(1012, "worker cleanup unconfirmed; restart managed service");
          return;
        }
        // The outer supervisor reports exit only after the fixed launcher has
        // reaped the complete worker/script tree. Inner Codex state messages
        // below cannot unlock an uncertain provider configuration operation.
        if (state === "restarting" || state === "stopped") {
          this.backendEpoch += 1;
          this.uncertainTurnStart = false;
          this.pendingDisconnects.clear();
          try { this.management.backendTerminated(); }
          catch (error: any) {
            // Journal persistence already moved the management gate to its
            // in-memory fail-closed state. It must not prevent cleanup after
            // the outer supervisor has actually reaped the worker tree.
            process.stderr.write(`[gateway] failed to persist backend termination state: ${error?.message ?? String(error)}\n`);
          }
        }
        this.codexState = state;
        this.activeTurns.clear(); this.activeStatusThreads.clear(); this.activeTerminals.clear(); this.activeLogins.clear(); this.retiredLoginIds.clear();
        this.retiredLoginIdsSaturated = false; this.uncertainLogin = false; this.activityUnknown = false;
        this.pendingServerRequests.clear(); this.answeringServerRequests.clear();
        for (const start of this.pendingTurnStarts) start.invalidated = true;
        for (const start of this.pendingLoginStarts) start.invalidated = true;
        this.compactions.clear();
        for (const client of this.clients.values()) client.close(1012, "backend replaced; reconnect and resynchronize");
      },
    }, (handlers) => new AppServerConnection(command, args, env, handlers, {
      terminateGraceMs: 10_000, requestTimeoutMs: 330_000,
      ...(launcher ? { cleanExitCode: 0 } : {}),
    }));
  }
  get clientCount() { return this.clients.size; }
  start() { this.backend.start(); }
  async stop() {
    for (const client of this.clients.values()) client.close(1001, "gateway stopping");
    await this.backend.stop();
  }
  private request(method: string, params: unknown): Promise<any> { return this.backend.request(method as any, params as any); }
  private worker(method: string, params: unknown, clientId: string): Promise<any> { return this.request("gateway/dispatch", { method, params, clientId }); }
  private hasJobs(): boolean {
    return this.activeTurns.size > 0 || this.activeStatusThreads.size > 0
      || this.activeTerminals.size > 0 || this.compactions.size > 0
      || this.pendingLoginStarts.size > 0 || this.activeLogins.size > 0 || this.uncertainLogin || this.uncertainTurnStart || this.activityUnknown
      || this.pendingServerRequests.size > 0 || this.answeringServerRequests.size > 0 || this.pendingDisconnects.size > 0;
  }
  private markActivityUnknown(): void {
    if (this.activityUnknown) return;
    this.activityUnknown = true;
    this.broadcast("management/stateChanged", this.managementStatus());
  }
  private rememberEarlyTurnCompletion(threadId: string, turnId: string): void {
    for (const start of this.pendingTurnStarts) {
      if (start.threadId !== threadId) continue;
      if (start.ended.size >= MAX_EARLY_COMPLETIONS && !start.ended.has(turnId)) {
        start.invalidated = true;
        this.markActivityUnknown();
      } else start.ended.add(turnId);
    }
  }
  private loginStatus(): { state: "idle" | "starting" | "unknown" } | { state: "active"; login: ActiveDeviceLogin } {
    const active = this.activeLogins.values().next().value as ActiveDeviceLogin | undefined;
    if (active) return { state: "active", login: { ...active } };
    if (this.pendingLoginStarts.size > 0) return { state: "starting" };
    if (this.uncertainLogin) return { state: "unknown" };
    return { state: "idle" };
  }
  private retireLoginId(loginId: string): boolean {
    if (this.retiredLoginIds.has(loginId)) return true;
    if (this.retiredLoginIds.size >= MAX_RETIRED_LOGIN_IDS) {
      // Do not evict history and later mistake a stale completion for a newer
      // unknown login. This exceptional churn needs a confirmed generation
      // replacement before another device flow is admitted.
      this.retiredLoginIdsSaturated = true;
      this.uncertainLogin = true;
      return false;
    }
    this.retiredLoginIds.add(loginId);
    return true;
  }
  private async startCompaction(params: unknown, clientId: string): Promise<unknown> {
    const reject = (message: string) => Object.assign(new Error(message), { errorCode: "BUSY", delivery: "rejected" });
    if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1
        || typeof (params as any).threadId !== "string" || !(params as any).threadId.length
        || (params as any).threadId.length > 256 || (params as any).threadId.includes("\0")) throw reject("invalid compaction request");
    if (this.codexState !== "ready" || this.hasJobs()) throw reject("compaction requires an idle, ready backend");
    const threadId = (params as { threadId: string }).threadId;
    // Register synchronously in the control process BEFORE dispatching any
    // native work; notification-only tracking leaves a cross-process window.
    try {
      return await this.management.admit(async () => {
        const entry = { uncertain: false, acknowledged: false, completed: false };
        this.compactions.set(threadId, entry);
        try {
          const result = await this.worker("thread/compact/start", { threadId }, clientId);
          entry.acknowledged = true;
          if (entry.completed && !entry.uncertain && this.compactions.get(threadId) === entry) this.compactions.delete(threadId);
          return result;
        }
        catch (error: any) {
          const definite = isDefiniteAppServerRejection(error);
          if (this.compactions.get(threadId) === entry) {
            if (definite && !entry.uncertain) this.compactions.delete(threadId);
            else { entry.uncertain = true; this.broadcast("management/stateChanged", this.managementStatus()); }
          }
          throw Object.assign(error instanceof Error ? error : new Error("compaction result unavailable"), { delivery: definite ? "rejected" : "unknown" });
        }
      }, true);
    } catch (error: any) {
      // ManagementGate rejects before executing its callback.
      if (error?.errorCode === "BUSY" && !error.delivery) error.delivery = "rejected";
      throw error;
    }
  }
  private finishCompaction(threadId: string, turnId?: string): void {
    const entry = this.compactions.get(threadId);
    if (entry && !entry.uncertain && (!turnId || !entry.turnId || entry.turnId === turnId)) {
      entry.completed = true;
      if (entry.acknowledged) this.compactions.delete(threadId);
    }
  }
  async connect(clientId: string, client: Client) {
    if (this.activityUnknown) {
      client.close(1013, "worker client activity is unconfirmed; restart managed service");
      throw Object.assign(new Error("worker client activity is unconfirmed"), { errorCode: "ACTIVITY_UNKNOWN" });
    }
    if (this.clients.size >= FLOW_LIMITS.clients) { client.close(1013, "browser connection limit"); throw new Error("browser connection limit"); }
    this.clients.set(clientId, client);
    // Authenticated diagnostics must remain readable even when no worker can
    // be attached. dispatch() still rejects every worker operation.
    if (this.codexState === "blocked") return;
    const epoch = this.backendEpoch;
    let workerConnected = false;
    try {
      await this.request("gateway/connect", { clientId });
      workerConnected = true;
      if (!this.clients.has(clientId)) await this.request("gateway/disconnect", { clientId });
    }
    catch (error) {
      if (this.codexState === "blocked") return;
      this.clients.delete(clientId);
      if (workerConnected || !isDefiniteAppServerRejection(error)) this.scheduleDisconnect(clientId, epoch);
      throw error;
    }
  }
  async disconnect(clientId: string) {
    if (!this.clients.delete(clientId)) return;
    if (this.codexState === "blocked") return;
    const epoch = this.backendEpoch;
    try { await this.request("gateway/disconnect", { clientId }); }
    catch (error) {
      this.scheduleDisconnect(clientId, epoch);
      throw error;
    }
  }
  private scheduleDisconnect(clientId: string, epoch: number): void {
    if (!validActivityId(clientId) || epoch !== this.backendEpoch || this.codexState === "blocked") return;
    if (this.pendingDisconnects.has(clientId)) return;
    if (this.pendingDisconnects.size >= MAX_PENDING_DISCONNECTS) {
      this.markActivityUnknown();
      return;
    }
    const entry = { epoch };
    this.pendingDisconnects.set(clientId, entry);
    void (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (entry.epoch !== this.backendEpoch || this.pendingDisconnects.get(clientId) !== entry) return;
        try {
          await this.request("gateway/disconnect", { clientId });
          if (this.pendingDisconnects.get(clientId) === entry) this.pendingDisconnects.delete(clientId);
          return;
        } catch {
          if (entry.epoch !== this.backendEpoch) return;
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
      if (this.pendingDisconnects.get(clientId) === entry) {
        this.pendingDisconnects.delete(clientId);
        this.markActivityUnknown();
      }
    })();
  }
  async answer(requestId: string, payload: unknown, error?: string) {
    if (!validActivityId(requestId) || !this.pendingServerRequests.has(requestId)) {
      throw Object.assign(new Error("服务器请求已结束、无效或不属于当前后台代次"), { errorCode: "ANSWER_REJECTED", delivery: "rejected" });
    }
    if (this.answeringServerRequests.has(requestId)) {
      throw Object.assign(new Error("该服务器请求已有回答正在提交"), { errorCode: "BUSY", delivery: "rejected" });
    }
    this.answeringServerRequests.add(requestId);
    try {
      const result = await this.request("gateway/answer", { requestId, payload, error });
      if (result === true) {
        this.pendingServerRequests.delete(requestId);
        this.answeringServerRequests.delete(requestId);
        return result;
      }
      if (result === false) {
        this.answeringServerRequests.delete(requestId);
        return result;
      }
      throw Object.assign(new Error("服务器回答回执无法确认；不会自动重试。"), {
        errorCode: "ANSWER_OUTCOME_UNKNOWN", delivery: "unknown", operationState: "unknown",
      });
    } catch (caught) {
      if (isDefiniteAppServerRejection(caught)) this.answeringServerRequests.delete(requestId);
      // Unknown delivery remains reserved until serverRequest/resolved or a
      // confirmed backend replacement proves the waiter no longer exists.
      throw caught;
    }
  }
  private broadcast(method: string, params: unknown) {
    for (const client of this.clients.values()) {
      try { client.send({ kind: "notification", method, params }); } catch { /* disconnected */ }
    }
  }
  private managementStatus() {
    const snapshot = this.management.snapshot();
    if (this.codexState === "blocked") return { ...snapshot, state: "unknown" as const,
      error: "后台清理未得到确认。请通过服务器终端重启整个受管 systemd 服务；不会自动替换后端或重试操作。" };
    if (this.activityUnknown) return { ...snapshot, state: "unknown" as const,
      error: "后台任务活动通知无效或超过容量，当前活动状态无法确认；请重启完整受管服务后再更改配置。" };
    if (this.uncertainTurnStart) return { ...snapshot, state: "unknown" as const,
      error: "任务启动结果未知，可能已执行；请先核对历史，不要重复发送。恢复配置操作前，请在服务器终端重启完整受管服务以确认旧后台已停止。" };
    return [...this.compactions.values()].some((entry) => entry.uncertain) ? { ...snapshot, state: "unknown" as const,
      error: "压缩操作结果未知；不会自动重试。请重启完整受管服务以确认旧后台已停止。" } : snapshot;
  }
  private observe(message: ServerMessage): ServerMessage {
    if (message.kind === "serverRequest") {
      if (!validActivityId(message.requestId)) this.markActivityUnknown();
      else if (!this.pendingServerRequests.has(message.requestId)
          && this.pendingServerRequests.size >= MAX_PENDING_SERVER_REQUESTS) this.markActivityUnknown();
      else this.pendingServerRequests.add(message.requestId);
      return message;
    }
    if (message.kind !== "notification") return message;
    const p: any = message.params;
    switch (message.method) {
      case "turn/started":
        if (validActivityId(p?.threadId) && validActivityId(p?.turn?.id)) {
          const current = this.activeTurns.get(p.threadId);
          if (current && current !== p.turn.id) {
            this.markActivityUnknown();
            break;
          }
          if (!this.activeTurns.has(p.threadId) && this.activeTurns.size >= MAX_ACTIVE_TURNS) {
            this.markActivityUnknown();
            break;
          }
          this.activeTurns.set(p.threadId, p.turn.id);
          const compact = this.compactions.get(p.threadId);
          if (compact && !compact.turnId) compact.turnId = p.turn.id;
        } else this.markActivityUnknown();
        break;
      case "turn/completed":
        if (!validActivityId(p?.threadId) || !validActivityId(p?.turn?.id)) { this.markActivityUnknown(); break; }
        this.rememberEarlyTurnCompletion(p.threadId, p.turn.id);
        if (this.activeTurns.get(p.threadId) === p.turn.id) this.activeTurns.delete(p.threadId);
        if (this.compactions.get(p.threadId)?.turnId === p.turn.id) this.finishCompaction(p.threadId, p.turn.id);
        break;
      case "thread/status/changed": {
        const statusEvent = observedNotification(message.method, message.params);
        if (!statusEvent || statusEvent.method !== "thread/status/changed") {
          this.markActivityUnknown();
          break;
        }
        const threadId = statusEvent.params.threadId;
        if (statusEvent.params.status.type === "active") {
          if (!this.activeStatusThreads.has(threadId) && this.activeStatusThreads.size >= MAX_ACTIVE_TURNS) {
            this.markActivityUnknown();
          } else this.activeStatusThreads.add(threadId);
        } else {
          // These are the protocol's three non-active states. They release
          // only the status reservation; an exact turn/compaction reservation
          // remains authoritative across reordered notifications.
          this.activeStatusThreads.delete(threadId);
        }
        break;
      }
      case "error":
        if (p?.willRetry === false) {
          if (!validActivityId(p?.threadId) || !validActivityId(p?.turnId)) { this.markActivityUnknown(); break; }
          this.rememberEarlyTurnCompletion(p.threadId, p.turnId);
          if (this.activeTurns.get(p.threadId) === p.turnId) this.activeTurns.delete(p.threadId);
          if (this.compactions.get(p.threadId)?.turnId === p.turnId) this.finishCompaction(p.threadId, p.turnId);
        }
        break;
      case "item/completed":
        if (p?.item?.type === "contextCompaction") {
          if (validActivityId(p?.threadId) && validActivityId(p?.turnId)) this.finishCompaction(p.threadId, p.turnId);
          else this.markActivityUnknown();
        }
        break;
      case "thread/compacted":
        if (validActivityId(p?.threadId)) this.finishCompaction(p.threadId);
        else this.markActivityUnknown();
        break;
      case "thread/autoCompactFailed":
        if (p?.outcome === "unknown") { const entry = this.compactions.get(p.threadId); if (entry) { entry.uncertain = true; this.broadcast("management/stateChanged", this.managementStatus()); } }
        break;
      case "thread/deleted": case "thread/archived": case "thread/closed":
        if (!validActivityId(p?.threadId)) { this.markActivityUnknown(); break; }
        for (const start of this.pendingTurnStarts) if (start.threadId === p.threadId) start.invalidated = true;
        this.activeTurns.delete(p.threadId); this.activeStatusThreads.delete(p.threadId); this.finishCompaction(p.threadId); break;
      case "terminal/exited":
        if (validActivityId(p?.processId)) this.activeTerminals.delete(p.processId);
        else this.markActivityUnknown();
        break;
      case "terminal/started":
        if (!validActivityId(p?.processId)) this.markActivityUnknown();
        else if (!this.activeTerminals.has(p.processId) && this.activeTerminals.size >= MAX_ACTIVE_TERMINALS) this.markActivityUnknown();
        else this.activeTerminals.add(p.processId);
        break;
      case "terminal/allExited": this.activeTerminals.clear(); break;
      case "serverRequest/resolved": {
        const requestId = validActivityId(p?.serverRequestId) ? p.serverRequestId
          : validActivityId(p?.requestId) ? p.requestId : null;
        if (requestId) {
          this.pendingServerRequests.delete(requestId);
          this.answeringServerRequests.delete(requestId);
        } else this.markActivityUnknown();
        break;
      }
      case "account/login/completed": {
        const loginId = typeof p?.loginId === "string" && p.loginId.length > 0 && p.loginId.length <= 256 && !p.loginId.includes("\0")
          ? p.loginId : null;
        if (!loginId) {
          this.uncertainLogin = true;
        } else if (!this.retiredLoginIds.has(loginId)) {
          const wasActive = this.activeLogins.delete(loginId);
          let matchedPending = false;
          let pendingInvalid = false;
          for (const start of this.pendingLoginStarts) {
            if (start.completed.size >= 8 && !start.completed.has(loginId)) {
              start.invalidated = true;
              pendingInvalid = true;
              this.uncertainLogin = true;
            } else {
              start.completed.add(loginId);
              matchedPending = true;
            }
          }
          // The gateway admits at most one start. A novel completion can
          // reconcile a response-lost attempt only when bounded retirement
          // history is complete; a late event for a canceled/completed flow
          // is ignored above and cannot unlock a newer unknown attempt.
          const reconcilesUnknown = this.uncertainLogin && !this.retiredLoginIdsSaturated
            && !wasActive && !matchedPending && this.pendingLoginStarts.size === 0;
          if (wasActive || matchedPending || reconcilesUnknown) {
            const retired = this.retireLoginId(loginId);
            if (retired && !pendingInvalid && (wasActive || reconcilesUnknown)) this.uncertainLogin = false;
          }
        }
        break;
      }
      case "appServer/stateChanged":
        if (!["starting", "ready", "restarting", "stopped", "blocked"].includes(p?.state)) {
          this.codexState = "stopped";
          this.markActivityUnknown();
          break;
        }
        this.codexState = p.state;
        if (this.codexState === "blocked") {
          // An inner cleanup failure does not prove turns, terminals, prompts
          // or configuration work stopped. Preserve all reservations until
          // the outer launcher owner is reaped by a managed service restart.
          this.markActivityUnknown();
          break;
        }
        if (this.codexState === "ready") {
          try { this.management.backendReady(); }
          catch (error: any) {
            process.stderr.write(`[gateway] failed to persist backend readiness state: ${error?.message ?? String(error)}\n`);
          }
        }
        if (this.codexState !== "ready") {
          this.activeTurns.clear(); this.activeStatusThreads.clear(); this.activeTerminals.clear(); this.activeLogins.clear(); this.retiredLoginIds.clear();
          this.retiredLoginIdsSaturated = false; this.uncertainLogin = false;
          this.pendingServerRequests.clear(); this.answeringServerRequests.clear();
          for (const start of this.pendingTurnStarts) start.invalidated = true;
          for (const start of this.pendingLoginStarts) start.invalidated = true;
          // Inner restart is not proof that a lost compaction stopped. Keep
          // the reservation until the outer cleanup owner confirms termination.
          for (const entry of this.compactions.values()) entry.uncertain = true;
          if (this.compactions.size) this.broadcast("management/stateChanged", this.managementStatus());
        }
        break;
    }
    if (p?.item && validActivityId(p?.threadId) && validActivityId(p?.turnId)) return { ...message, params: { ...p, item: this.ledger.decorateItem(p.threadId, p.turnId, p.item) } };
    if (Array.isArray(p?.turn?.items) && validActivityId(p?.threadId) && validActivityId(p?.turn?.id)) {
      return { ...message, params: { ...p, turn: { ...p.turn,
        items: this.ledger.decorateNotificationItems(p.threadId, p.turn.id, p.turn.items),
      } } };
    }
    return message;
  }
  async dispatch(method: string, params: any, clientId: string, attached?: Promise<void>): Promise<any> {
    if (params != null && (typeof params !== "object" || Array.isArray(params))) throw new Error("RPC params must be an object");
    params ??= {};
    if (method === "turn/operation") return this.ledger.status(params.clientOperationId);
    if (method === "thread/start/operation") return this.threadStarts.status(params.clientOperationId);
    if (method === "management/status") return this.managementStatus();
    if (method === "account/login/status") return this.loginStatus();
    if (method === "admin/logs") return { logs: await recentLogs(Number(params.lines) || 80) };
    params = canonicalControlParams(method, params);
    if (this.codexState === "blocked") throw Object.assign(new Error("worker cleanup is unconfirmed; restart the complete managed systemd service"), { errorCode: "BACKEND_CLEANUP_UNCONFIRMED" });
    // Existing turn receipts must keep their original accepted/unknown meaning.
    // Fresh turn dispatch is checked inside the ledger callback below instead.
    if (this.uncertainTurnStart && method !== "turn/start" && !SAFE_CONCURRENT.has(method)) throw Object.assign(new Error("任务启动结果未知；请核对历史，并通过服务器终端重启完整受管服务后再进行新操作。"), { errorCode: "BUSY", delivery: "rejected" });
    if (method === "thread/compact/start") return this.startCompaction(params, clientId);
    if (this.compactions.size && COMPACTION_CONFLICTS.has(method)) throw Object.assign(new Error("compaction is running or its outcome is unknown"), { errorCode: "BUSY" });
    if (method === "admin/status") {
      const status = await this.worker(method, params, clientId);
      return { ...status, ...await serviceStatus(this.codexState, this.clients.size), management: this.managementStatus() };
    }
    if (method === "app/status") return { ...await this.worker(method, params, clientId), management: this.managementStatus() };
    if (method === "admin/service/restart") return this.management.run(method, async () => ({
      ok: true, changed: false, restartRequired: true, restarting: true, note: "服务将在约 1 秒后重启，页面会自动重连",
    }), scheduleServiceRestart);
    if (MANAGEMENT.has(method)) {
      return this.management.run(method, async () => validatedManagementResult(await this.worker(method, params, clientId)), scheduleServiceRestart, (error) =>
        isDefiniteAppServerRejection(error) && !/timeout|timed out/i.test(error.message));
    }
    const run = async () => {
      if (method === "thread/start") {
        const operation = this.threadStarts.run(params.clientOperationId, params, async (request) => {
          try { await attached; }
          catch { throw new AppServerRequestError("worker attachment failed before creating thread", { code: -32000, data: { delivery: "rejected" } }); }
          return this.worker(method, request, clientId);
        }, isDefiniteAppServerRejection);
        params = null;
        return operation;
      }
      if (method === "turn/start") {
        const clientOperationId = params.clientOperationId;
        const threadId = params.threadId;
        const operation = this.ledger.run(clientOperationId, params, async (request) => {
          // Persist the operation before readiness can stall it. A failed
          // attachment proves this callback never dispatched a turn.
          try { await attached; }
          catch { throw new AppServerRequestError("worker attachment failed before sending turn", { code: -32000, data: { delivery: "rejected" } }); }
          if (this.uncertainTurnStart) throw new AppServerRequestError("任务启动结果未知；本次新发送未派发。请先核对历史，并通过服务器终端重启完整受管服务。", { code: -32000, data: { delivery: "rejected" } });
          const start = { threadId: request.threadId as string, ended: new Set<string>(), invalidated: false };
          const epoch = this.backendEpoch;
          this.pendingTurnStarts.add(start);
          try {
            const accepted = await this.worker(method, request, clientId);
            // The response can precede turn/started. Conversely completion can
            // precede the response: never revive that turn or another generation.
            const turn = accepted?.turn;
            if (!validActivityId(turn?.id)) throw Object.assign(new Error("turn/start returned no valid turn identity; execution outcome is unknown"), { delivery: "unknown" });
            const current = this.activeTurns.get(start.threadId);
            // An omitted/unrecognized status is not terminal evidence. Keep
            // the exact turn reserved until a matching completion arrives.
            if (!["completed", "interrupted", "failed"].includes(turn.status) && !start.invalidated) {
              if (!start.ended.has(turn.id)) {
                if (current && current !== turn.id) this.markActivityUnknown();
                else if (!current && this.activeTurns.size >= MAX_ACTIVE_TURNS) this.markActivityUnknown();
                else this.activeTurns.set(start.threadId, turn.id);
              }
            }
            return accepted;
          } catch (error) {
            // Neither a timeout nor an unrelated/late completion proves that
            // this dispatched request cannot still start. Only confirmed outer
            // worker termination releases this bounded reservation. Its epoch
            // also prevents an old rejection from relocking a new backend.
            if (!isDefiniteAppServerRejection(error) && epoch === this.backendEpoch) {
              this.uncertainTurnStart = true;
              this.broadcast("management/stateChanged", this.managementStatus());
            }
            throw error;
          } finally { this.pendingTurnStarts.delete(start); }
        }, isDefiniteAppServerRejection);
        // ledger.run() has already synchronously projected the request. Drop
        // the outer 36 MiB-capable object before waiting for the paid turn.
        params = null;
        const result = await operation;
        // Only fresh acceptance can describe an active turn. Replaying an old
        // operation must not revive a completed turn in the management gate.
        this.broadcast("harness/turnAccepted", { clientOperationId, threadId, turnId: result.turn.id, attachments: result.harnessAttachments ?? [] });
        return result;
      }
      if (method === "account/login/start") {
        if (this.activeLogins.size > 0 || this.uncertainLogin || this.pendingLoginStarts.size > 0) {
          throw Object.assign(new Error("已有登录流程正在等待完成，或其结果尚未确认"), { errorCode: "BUSY", delivery: "rejected" });
        }
        const start = { completed: new Set<string>(), invalidated: false };
        this.pendingLoginStarts.add(start);
        try {
          const result = await this.worker(method, params, clientId);
          const loginId = result?.type === "chatgptDeviceCode" && typeof result?.loginId === "string"
              && result.loginId.length > 0 && result.loginId.length <= 256 && !result.loginId.includes("\0")
            ? result.loginId : null;
          const userCode = typeof result?.userCode === "string" && result.userCode.length > 0 && result.userCode.length <= 128 && !result.userCode.includes("\0")
            ? result.userCode : null;
          const verificationUrl = typeof result?.verificationUrl === "string" && result.verificationUrl.length > 0
              && result.verificationUrl.length <= 2048 && !result.verificationUrl.includes("\0")
            ? result.verificationUrl : null;
          let validVerificationUrl = false;
          if (verificationUrl) {
            try { validVerificationUrl = ["http:", "https:"].includes(new URL(verificationUrl).protocol); }
            catch { /* malformed response is outcome uncertainty */ }
          }
          if (!loginId || !userCode || !verificationUrl || !validVerificationUrl
              || this.retiredLoginIds.has(loginId) && !start.completed.has(loginId)) {
            if (!start.invalidated && start.completed.size === 0) this.uncertainLogin = true;
            throw Object.assign(new Error("登录启动响应缺少有效设备码信息；结果未知，不会自动重试。"), {
              errorCode: "LOGIN_OUTCOME_UNKNOWN", delivery: "unknown", operationState: "unknown",
            });
          }
          if (!start.invalidated && !start.completed.has(loginId)) {
            this.activeLogins.set(loginId, { type: "chatgptDeviceCode", loginId, userCode, verificationUrl });
          }
          return result;
        } catch (error) {
          if (!isDefiniteAppServerRejection(error) && !start.invalidated && start.completed.size === 0) this.uncertainLogin = true;
          throw error;
        } finally { this.pendingLoginStarts.delete(start); }
      }
      if (method === "account/login/cancel") {
        const loginId = typeof params.loginId === "string" ? params.loginId : "";
        const wasActive = this.activeLogins.has(loginId);
        const result = await this.worker(method, params, clientId);
        if (!result || !["canceled", "notFound"].includes(result.status)) {
          this.uncertainLogin = true;
          throw Object.assign(new Error("登录取消响应无法确认；保留活动预约且不会自动重试。"), {
            errorCode: "LOGIN_OUTCOME_UNKNOWN", delivery: "unknown", operationState: "unknown",
          });
        }
        if (wasActive) {
          this.activeLogins.delete(loginId);
          this.retireLoginId(loginId);
        }
        return result;
      }
      let result = await this.worker(method, params, clientId);
      if (method === "thread/read" || method === "thread/resume") {
        result = this.ledger.decorateThreadResult(result);
        encodeBounded(result, FLOW_LIMITS.historyBytes);
      }
      return result;
    };
    return SAFE_CONCURRENT.has(method) ? run() : this.management.admit(run);
  }
}
