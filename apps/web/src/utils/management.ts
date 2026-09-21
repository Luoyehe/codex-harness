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
  state: "idle" | "running" | "restart_pending" | "unknown";
  operation?: string;
  operationId?: string;
  error?: string;
  lastOperation?: ManagementOperation;
}

const bounded = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : undefined;

/** Only a small status record crosses into UI state, never script payloads. */
export function normalizeManagement(value: unknown): ManagementSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unknown", error: "尚未获得服务器管理状态，请核对状态后继续。" };
  const source = value as Record<string, unknown>;
  if (typeof source.state !== "string" || !["idle", "running", "restart_pending", "unknown"].includes(source.state)) return { state: "unknown", error: "服务器返回了无法识别的管理状态，请核对状态。" };
  let lastOperation: ManagementOperation | undefined;
  const last = source.lastOperation as Record<string, unknown> | undefined;
  if (last && typeof last === "object" && typeof last.operationId === "string" && typeof last.operation === "string" &&
    typeof last.outcome === "string" && ["running", "restart_pending", "succeeded", "failed", "unknown", "recovered"].includes(last.outcome)) {
    lastOperation = {
      operationId: last.operationId.slice(0, 128), operation: last.operation.slice(0, 128), outcome: last.outcome as ManagementOperation["outcome"],
      startedAt: typeof last.startedAt === "number" && Number.isFinite(last.startedAt) ? last.startedAt : 0,
      updatedAt: typeof last.updatedAt === "number" && Number.isFinite(last.updatedAt) ? last.updatedAt : 0,
      ...(typeof last.changed === "boolean" ? { changed: last.changed } : {}),
      ...(typeof last.restartRequired === "boolean" ? { restartRequired: last.restartRequired } : {}),
      ...(typeof last.error === "string" ? { error: last.error.slice(0, 2000) } : {}),
    };
  }
  return {
    state: source.state as ManagementSnapshot["state"],
    operation: bounded(source.operation, 128), operationId: bounded(source.operationId, 128), error: bounded(source.error, 2000),
    ...(lastOperation ? { lastOperation } : {}),
  };
}

export function managementOutcomeText(operation: ManagementOperation): string {
  switch (operation.outcome) {
    case "running": return "服务器配置操作正在进行，结果尚未确定。";
    case "restart_pending": return "配置步骤已完成，服务重启结果待确认；这不是完整成功结果。";
    case "succeeded": return operation.restartRequired
      ? "重启辅助程序已返回成功；这不代表模型调用或外部供应商业务验证通过。"
      : operation.changed === false ? "操作已完成，配置没有变化，无需重启。" : "配置操作已完成，无需重启。";
    case "failed": return "管理操作失败；请核对下面的错误与服务器状态，未自动重试。";
    case "unknown": return "原管理操作的结果仍未知。不能据此认定成功或失败；请核对配置和服务状态，未自动重试。";
    case "recovered": return "已确认新后端就绪，先前配置步骤已完成；这不代表模型调用或外部供应商业务验证通过。";
  }
}

export function managementOperationLabel(method: string): string {
  return ({ "admin/catalog/sync": "同步模型目录", "admin/provider/switch": "更新模型源", "admin/service/restart": "重启服务", "admin/edge/config": "远程入口管理" } as Record<string, string>)[method] ?? method;
}
