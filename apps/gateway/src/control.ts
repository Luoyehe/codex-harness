import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSupervisor } from "./codex/process.js";
import { AppServerConnection, AppServerRequestError } from "./codex/rpc.js";
import type { ServerMessage } from "./hub.js";
import { OperationLedger } from "./operations.js";
import { ManagementGate } from "./management.js";
import { FLOW_LIMITS, encodeBounded } from "./flow-control.js";
import { recentLogs, scheduleServiceRestart, serviceStatus } from "./admin.js";

interface Client { send(message: ServerMessage): void; close(code: number, reason: string): void }
const ADMISSIONS = new Set(["thread/start", "thread/resume", "turn/start", "terminal/exec", "thread/compact/start", "account/login/start"]);
const MANAGEMENT = new Set(["admin/catalog/sync", "admin/provider/switch"]);

/** Only this OS identity owns the listener, auth secret, admission ledger and
 * instance-scoped administrator grant. Worker output is data, never an
 * instruction to invoke a privileged control operation. */
export class GatewayController {
  codexState = "starting";
  private readonly clients = new Map<string, Client>();
  private readonly activeTurns = new Map<string, string>();
  private readonly activeTerminals = new Set<string>();
  private readonly ledger: OperationLedger;
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
    this.management = new ManagementGate(() => this.activeTurns.size > 0 || this.activeTerminals.size > 0, (state) => this.broadcast("management/stateChanged", state), controlHome);
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
      async onServerRequest() { throw new Error("private worker cannot invoke control-plane requests"); },
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
        if (state === "restarting" || state === "stopped") this.management.backendTerminated();
        this.codexState = state;
        this.activeTurns.clear(); this.activeTerminals.clear();
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
  async connect(clientId: string, client: Client) {
    if (this.clients.size >= FLOW_LIMITS.clients) { client.close(1013, "browser connection limit"); throw new Error("browser connection limit"); }
    this.clients.set(clientId, client);
    // Authenticated diagnostics must remain readable even when no worker can
    // be attached. dispatch() still rejects every worker operation.
    if (this.codexState === "blocked") return;
    try {
      await this.request("gateway/connect", { clientId });
      if (!this.clients.has(clientId)) await this.request("gateway/disconnect", { clientId });
    }
    catch (error) {
      if (this.codexState === "blocked") return;
      this.clients.delete(clientId); throw error;
    }
  }
  async disconnect(clientId: string) {
    if (!this.clients.delete(clientId)) return;
    if (this.codexState === "blocked") return;
    await this.request("gateway/disconnect", { clientId });
  }
  answer(requestId: string, payload: unknown, error?: string) { return this.request("gateway/answer", { requestId, payload, error }); }
  private broadcast(method: string, params: unknown) {
    for (const client of this.clients.values()) {
      try { client.send({ kind: "notification", method, params }); } catch { /* disconnected */ }
    }
  }
  private managementStatus() {
    const snapshot = this.management.snapshot();
    return this.codexState === "blocked" ? { ...snapshot, state: "unknown" as const,
      error: "后台清理未得到确认。请通过服务器终端重启整个受管 systemd 服务；不会自动替换后端或重试操作。" } : snapshot;
  }
  private observe(message: ServerMessage): ServerMessage {
    if (message.kind !== "notification") return message;
    const p: any = message.params;
    switch (message.method) {
      case "turn/started": if (p?.threadId && p?.turn?.id) this.activeTurns.set(p.threadId, p.turn.id); break;
      case "turn/completed": if (this.activeTurns.get(p?.threadId) === p?.turn?.id) this.activeTurns.delete(p.threadId); break;
      case "error": if (p?.willRetry === false && this.activeTurns.get(p?.threadId) === p?.turnId) this.activeTurns.delete(p.threadId); break;
      case "thread/deleted": case "thread/archived": case "thread/closed": this.activeTurns.delete(p?.threadId); break;
      case "terminal/exited": this.activeTerminals.delete(p?.processId); break;
      case "terminal/started": if (p?.processId) this.activeTerminals.add(p.processId); break;
      case "terminal/allExited": this.activeTerminals.clear(); break;
      case "appServer/stateChanged":
        this.codexState = p?.state ?? "stopped";
        if (this.codexState === "ready") this.management.backendReady();
        if (this.codexState !== "ready") { this.activeTurns.clear(); this.activeTerminals.clear(); }
        break;
    }
    if (p?.item && p?.threadId && p?.turnId) return { ...message, params: { ...p, item: this.ledger.decorateItem(p.threadId, p.turnId, p.item) } };
    if (p?.turn?.items && p?.threadId) return { ...message, params: { ...p, turn: { ...p.turn, items: p.turn.items.map((item: any) => this.ledger.decorateItem(p.threadId, p.turn.id, item)) } } };
    return message;
  }
  async dispatch(method: string, params: any, clientId: string): Promise<any> {
    if (params != null && (typeof params !== "object" || Array.isArray(params))) throw new Error("RPC params must be an object");
    params ??= {};
    if (method === "turn/operation") return this.ledger.status(params.clientOperationId);
    if (method === "management/status") return this.managementStatus();
    if (method === "admin/logs") return { logs: await recentLogs(Number(params.lines) || 80) };
    if (this.codexState === "blocked") throw Object.assign(new Error("worker cleanup is unconfirmed; restart the complete managed systemd service"), { errorCode: "BACKEND_CLEANUP_UNCONFIRMED" });
    if (method === "admin/status") {
      const status = await this.worker(method, params, clientId);
      return { ...status, ...await serviceStatus(this.codexState, this.clients.size), management: this.management.snapshot() };
    }
    if (method === "app/status") return { ...await this.worker(method, params, clientId), management: this.management.snapshot() };
    if (method === "admin/service/restart") return this.management.run(method, async () => ({
      ok: true, changed: false, restartRequired: true, restarting: true, note: "服务将在约 1 秒后重启，页面会自动重连",
    }), scheduleServiceRestart);
    if (MANAGEMENT.has(method)) {
      return this.management.run(method, () => this.worker(method, params, clientId), scheduleServiceRestart, (error) =>
        error instanceof AppServerRequestError && (error.rpcError?.data as any)?.delivery === "rejected"
        && !/timeout|timed out/i.test(error.message));
    }
    const run = async () => {
      if (method === "turn/start") {
        const result = await this.ledger.run(params.clientOperationId, params, () => this.worker(method, params, clientId), (error) =>
          error instanceof AppServerRequestError && (error.rpcError?.data as any)?.delivery === "rejected");
        // Only fresh acceptance can describe an active turn. Replaying an old
        // operation must not revive a completed turn in the management gate.
        this.broadcast("harness/turnAccepted", { clientOperationId: params.clientOperationId, threadId: params.threadId, turnId: result.turn.id, attachments: params.attachments ?? [] });
        return result;
      }
      let result = await this.worker(method, params, clientId);
      if (method === "thread/read" || method === "thread/resume") {
        result = this.ledger.decorateThreadResult(result);
        encodeBounded(result, FLOW_LIMITS.historyBytes);
      }
      return result;
    };
    return ADMISSIONS.has(method) ? this.management.admit(run) : run();
  }
}
