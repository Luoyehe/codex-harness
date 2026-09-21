import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";
import { readBoundedRegularTextFileSync } from "./bounded-file.js";

export type ManagementState = "idle" | "running" | "restart_pending" | "unknown";
export interface ManagementOperation {
  operationId: string;
  operation: string;
  outcome: "running" | "restart_pending" | "succeeded" | "failed" | "unknown" | "recovered";
  startedAt: number;
  updatedAt: number;
  changed?: boolean;
  restartRequired?: boolean;
  error?: string;
}
export interface ManagementSnapshot {
  state: ManagementState;
  operation?: string;
  operationId?: string;
  error?: string;
  lastOperation?: ManagementOperation;
}
interface ManagementResult { ok?: boolean; code?: number; changed?: boolean; restartRequired?: boolean; executionPending?: boolean }
const JOURNAL_CAP = 8192;
const UNKNOWN = "管理操作结果未知，可能仍在运行；确认后台进程停止前不会开始新任务或自动重试。";
const INTERRUPTED = "后台进程已停止或替换；上次配置操作结果仍未知，请核对当前配置，不会自动重试。";
const FAILED = "配置操作未成功完成；请检查当前配置和受控服务日志。";
const RESTART_FAILED = "服务重启未确认成功；请检查服务状态和受控服务日志。";
function failure(message: string) { return Object.assign(new Error(message), { errorCode: "MANAGEMENT_UNKNOWN" }); }

/** One control-plane gate plus a bounded, private latest-operation journal.
 * This is observation, not automatic replay: only one record is retained and
 * no credential, configuration payload or arbitrary worker output is stored.
 * A confirmed script result is distinct from a new backend being ready. */
export class ManagementGate {
  private state: ManagementState = "idle";
  private lastOperation: ManagementOperation | undefined;
  private admissions = 0;
  private backendEpoch = 0;
  private startupRecovery = false;
  private readonly journal?: string;
  constructor(private readonly hasJobs: () => boolean, private readonly notify: (value: ManagementSnapshot) => void, controlHome?: string) {
    if (!controlHome) return; // Pure unit fixtures may omit persistence.
    mkdirSync(controlHome, { recursive: true, mode: 0o700 });
    this.journal = path.join(controlHome, "management-operation.json");
    try {
      const value = JSON.parse(readBoundedRegularTextFileSync(this.journal, JOURNAL_CAP));
      const record = value?.lastOperation;
      const stateOutcomeValid = value?.state === "idle"
        ? ["succeeded", "failed", "unknown", "recovered"].includes(record?.outcome)
        : value?.state === "running" ? record?.outcome === "running"
          : value?.state === "restart_pending" ? record?.outcome === "restart_pending"
            : value?.state === "unknown" && record?.outcome === "unknown";
      if (value?.version !== 1 || !["idle", "running", "restart_pending", "unknown"].includes(value?.state)
          || !record || typeof record.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(record.operationId)
          || typeof record.operation !== "string" || !/^[a-zA-Z0-9/_-]{1,80}$/.test(record.operation)
          || !["running", "restart_pending", "succeeded", "failed", "unknown", "recovered"].includes(record.outcome)
          || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0
          || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.startedAt
          || !stateOutcomeValid
          || (record.error !== undefined && (typeof record.error !== "string" || record.error.length > 512))
          || ["changed", "restartRequired"].some((key) => record[key] !== undefined && typeof record[key] !== "boolean")) {
        throw new Error("invalid management journal content");
      }
      this.lastOperation = { operationId: record.operationId, operation: record.operation, outcome: record.outcome,
        startedAt: record.startedAt, updatedAt: record.updatedAt,
        ...(record.changed !== undefined ? { changed: record.changed } : {}),
        ...(record.restartRequired !== undefined ? { restartRequired: record.restartRequired } : {}),
        ...(record.error !== undefined ? { error: record.error } : {}) };
      this.state = value.state;
      if (this.state !== "idle") {
        this.startupRecovery = true;
        if (this.state !== "restart_pending") this.publish("unknown", { ...this.lastOperation, outcome: "unknown", error: INTERRUPTED });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw failure("管理操作记录无法可靠读取；请管理员检查控制目录，服务拒绝绕过记录启动。");
    }
  }
  snapshot(): ManagementSnapshot {
    return { state: this.state,
      ...(this.state !== "idle" && this.lastOperation ? { operation: this.lastOperation.operation } : {}),
      ...(this.lastOperation ? { operationId: this.lastOperation.operationId, lastOperation: { ...this.lastOperation } } : {}),
      ...(this.lastOperation?.error ? { error: this.lastOperation.error } : {}) };
  }
  private publish(state: ManagementState, record: ManagementOperation) {
    // Wall clocks can move backwards (NTP/manual correction). Journals must
    // remain reloadable and preserve their monotonic operation invariant.
    const next = { ...record, updatedAt: Math.max(record.startedAt, record.updatedAt, Date.now()) };
    if (this.journal) {
      try {
        const json = JSON.stringify({ version: 1, state, lastOperation: next });
        if (Buffer.byteLength(json) > JOURNAL_CAP) throw new Error("management journal exceeds limit");
        atomicWriteFileSync(this.journal, json);
      } catch {
        this.state = "unknown";
        this.lastOperation = { ...next, outcome: "unknown", error: "管理操作记录写入失败；为避免重叠执行，已暂停新任务。" };
        this.notify(this.snapshot());
        throw failure(this.lastOperation.error!);
      }
    }
    this.state = state; this.lastOperation = next;
    this.notify(this.snapshot());
  }
  /** Only the OUTER worker supervisor may call this, after the fixed launcher
   * has confirmed every worker/script descendant stopped. An inner Codex
   * app-server restart is not evidence that provider scripts have finished. */
  backendTerminated() {
    this.backendEpoch++;
    if ((this.state === "running" || this.state === "unknown") && this.lastOperation) {
      this.publish("idle", { ...this.lastOperation, outcome: "unknown", error: INTERRUPTED });
    }
  }
  /** Called after a freshly launched worker's actual Codex backend is ready.
   * Recovery confirms availability, never vendor inference/business success. */
  backendReady() {
    if (!this.startupRecovery || !this.lastOperation) return;
    this.startupRecovery = false;
    if (this.state === "restart_pending") {
      const { error: _error, ...record } = this.lastOperation;
      this.publish("idle", { ...record, outcome: "recovered" });
    } else if (this.state === "unknown") {
      this.publish("idle", { ...this.lastOperation, outcome: "unknown", error: INTERRUPTED });
    }
  }
  async admit<T>(work: () => Promise<T>, exclusive = false): Promise<T> {
    if (this.state !== "idle" || (exclusive && this.admissions > 0)) throw Object.assign(new Error("服务器配置、任务启动或重启正在进行，或结果尚未确认；请完成后再开始新任务。"), { errorCode: "BUSY" });
    this.admissions++;
    try { return await work(); } finally { this.admissions--; }
  }
  async run<T extends ManagementResult>(operation: string, work: () => Promise<T>, restart: () => Promise<void>, definitelyFinished: (error: unknown) => boolean = () => false): Promise<T & { operationId: string; management: ManagementSnapshot }> {
    if (this.state !== "idle" || this.admissions > 0 || this.hasJobs()) {
      throw Object.assign(new Error("仍有运行中的任务、终端或配置操作；请先结束它们，再更改服务器配置。"), { errorCode: "BUSY" });
    }
    if (!/^[a-zA-Z0-9/_-]{1,80}$/.test(operation)) throw new Error("invalid management operation");
    const record: ManagementOperation = { operationId: randomUUID(), operation, outcome: "running", startedAt: Date.now(), updatedAt: Date.now() };
    const epoch = this.backendEpoch;
    // Journal intent BEFORE a worker can mutate its configuration.
    this.publish("running", record);
    let result: T;
    try { result = await work(); }
    catch (error) {
      const finished = definitelyFinished(error);
      if (epoch === this.backendEpoch && this.lastOperation?.operationId === record.operationId) {
        this.publish(finished ? "idle" : "unknown", { ...record, outcome: finished ? "failed" : "unknown", error: finished ? FAILED : UNKNOWN });
      }
      throw Object.assign(finished && error instanceof Error ? error : failure(UNKNOWN), { operationId: record.operationId });
    }
    // A late reply from a replaced worker cannot schedule a new restart.
    if (epoch !== this.backendEpoch || this.lastOperation?.operationId !== record.operationId) throw failure(INTERRUPTED);
    const confirmed = { ...record,
      ...(typeof result.changed === "boolean" ? { changed: result.changed } : {}),
      ...(typeof result.restartRequired === "boolean" ? { restartRequired: result.restartRequired } : {}) };
    if (result.executionPending) {
      // A timeout/busy wrapper is not confirmation that configuration stayed
      // unchanged, even if its provisional result uses changed:false.
      this.publish("unknown", { ...record, outcome: "unknown", error: UNKNOWN });
    } else if (result.ok === false || (typeof result.code === "number" && result.code !== 0)) {
      this.publish("idle", { ...confirmed, outcome: "failed", error: FAILED });
    } else if (result.restartRequired) {
      // This survives the gateway being killed by its own systemd restart.
      this.publish("restart_pending", { ...confirmed, outcome: "restart_pending" });
      void Promise.resolve().then(restart).then(() => {
        if (this.lastOperation?.operationId === record.operationId && this.state === "restart_pending") {
          this.publish("idle", { ...confirmed, outcome: "succeeded" });
        }
      }, (error) => {
        if (this.lastOperation?.operationId !== record.operationId || this.state !== "restart_pending") return;
        // A timed-out systemctl helper may still have enqueued a restart.
        const unknown = error?.killed || /timeout|timed out/i.test(String(error?.message ?? ""));
        this.publish(unknown ? "unknown" : "idle", { ...confirmed, outcome: unknown ? "unknown" : "failed", error: RESTART_FAILED });
      }).catch(() => { /* publish already retained an in-memory fail-closed state */ });
    } else this.publish("idle", { ...confirmed, outcome: "succeeded" });
    return { ...result, operationId: record.operationId, management: this.snapshot() };
  }
}
