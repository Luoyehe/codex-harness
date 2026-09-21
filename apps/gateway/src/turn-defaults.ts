import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexSupervisor } from "./codex/process.js";
import type { ThreadStartResponse } from "../../../protocol/v2/ThreadStartResponse.js";
import type { AskForApproval } from "../../../protocol/v2/AskForApproval.js";
import type { SandboxPolicy } from "../../../protocol/v2/SandboxPolicy.js";

export type EffectiveTurnDefaults = Pick<ThreadStartResponse, "model" | "approvalPolicy" | "sandbox" | "reasoningEffort">;

const LIMITS = {
  idChars: 256,
  modelChars: 256,
  effortChars: 64,
  cwdChars: 4096,
  cursorChars: 4096,
  configBytes: 1024 * 1024,
  configNodes: 100_000,
  configDepth: 64,
  mcpServers: 256,
  writableRoots: 128,
  modelItems: 200,
  modelPages: 5,
} as const;

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new Error(`${label} 无效，未恢复默认设置`);
  }
  return value;
}

function modelName(value: unknown): string {
  return boundedString(value, "模型标识", LIMITS.modelChars);
}

function reasoningEffort(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  const effort = boundedString(value, "推理强度", LIMITS.effortChars);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(effort)) throw new Error("推理强度标识无效，未恢复默认设置");
  return effort;
}

function approvalPolicy(value: unknown): AskForApproval {
  if (value === "untrusted" || value === "on-request" || value === "never") return value;
  if (!plain(value) || !plain(value.granular)) throw new Error("审批策略无效，未恢复默认设置");
  const granular = value.granular;
  const keys = ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"] as const;
  if (keys.some((key) => typeof granular[key] !== "boolean")) throw new Error("审批策略无效，未恢复默认设置");
  return { granular: {
    sandbox_approval: granular.sandbox_approval as boolean,
    rules: granular.rules as boolean,
    skill_approval: granular.skill_approval as boolean,
    request_permissions: granular.request_permissions as boolean,
    mcp_elicitations: granular.mcp_elicitations as boolean,
  } };
}

function sandboxPolicy(value: unknown): SandboxPolicy {
  if (!plain(value)) throw new Error("沙箱策略无效，未恢复默认设置");
  if (value.type === "dangerFullAccess") return { type: "dangerFullAccess" };
  if (value.type === "readOnly" && typeof value.networkAccess === "boolean") {
    return { type: "readOnly", networkAccess: value.networkAccess };
  }
  if (value.type === "externalSandbox" && (value.networkAccess === "restricted" || value.networkAccess === "enabled")) {
    return { type: "externalSandbox", networkAccess: value.networkAccess };
  }
  if (value.type === "workspaceWrite" && Array.isArray(value.writableRoots)
      && value.writableRoots.length <= LIMITS.writableRoots
      && typeof value.networkAccess === "boolean"
      && typeof value.excludeTmpdirEnvVar === "boolean"
      && typeof value.excludeSlashTmp === "boolean") {
    const writableRoots = value.writableRoots.map((root) => {
      const text = boundedString(root, "可写根目录", LIMITS.cwdChars);
      if (!path.isAbsolute(text)) throw new Error("可写根目录不是当前平台的绝对路径，未恢复默认设置");
      return text;
    });
    return {
      type: "workspaceWrite", writableRoots,
      networkAccess: value.networkAccess,
      excludeTmpdirEnvVar: value.excludeTmpdirEnvVar,
      excludeSlashTmp: value.excludeSlashTmp,
    };
  }
  throw new Error("沙箱策略无效，未恢复默认设置");
}

function validatedConfig(value: unknown): { encoded: string; mcp: Record<string, any> } {
  if (!plain(value)) throw new Error("默认配置响应无效，未恢复默认设置");
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > LIMITS.configNodes || current.depth > LIMITS.configDepth) {
      throw new Error("默认配置过于复杂，未恢复默认设置");
    }
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("默认配置包含无效数值，未恢复默认设置");
      continue;
    }
    if (!item || typeof item !== "object" || (!Array.isArray(item) && !plain(item))) {
      throw new Error("默认配置包含非 JSON 值，未恢复默认设置");
    }
    if (seen.has(item)) throw new Error("默认配置包含循环引用，未恢复默认设置");
    seen.add(item);
    const children = Array.isArray(item) ? item : Object.values(item);
    if (nodes + children.length > LIMITS.configNodes) throw new Error("默认配置过于复杂，未恢复默认设置");
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > LIMITS.configBytes) throw new Error("默认配置超过 1MiB，未恢复默认设置");
  const rawMcp = value.mcp_servers;
  if (rawMcp !== undefined && rawMcp !== null && !plain(rawMcp)) throw new Error("MCP 默认配置无效，未恢复默认设置");
  const entries = rawMcp == null ? [] : Object.entries(rawMcp);
  if (entries.length > LIMITS.mcpServers) throw new Error("MCP 默认配置条目过多，未恢复默认设置");
  const mcp: Record<string, any> = Object.create(null);
  for (const [name, entry] of entries) {
    boundedString(name, "MCP 服务名", LIMITS.idChars);
    if (!plain(entry)) throw new Error("MCP 默认配置条目无效，未恢复默认设置");
    mcp[name] = { ...entry, enabled: false };
  }
  return { encoded, mcp };
}

/** Resolve defaults with the pinned server, not guesses about trust/profile rules.
 * A no-turn ephemeral thread has no rollout or inference. MCP startup is disabled
 * in that lookup only. Cache by effective config and cwd, never by sticky thread
 * settings; null in the browser API means these project/provider defaults. */
export class TurnDefaults {
  private generation = 0;
  private cacheEpoch = 0;
  private cache = new Map<string, Promise<EffectiveTurnDefaults>>();
  private hidden = new Set<string>();
  private probing = 0;

  constructor(private readonly supervisor: Pick<CodexSupervisor, "request">) {}

  reset(): void { this.generation++; this.cacheEpoch++; this.cache.clear(); this.hidden.clear(); }
  /** Account/catalog changes invalidate effective defaults without replacing
   * the connection. In-flight probes must still unsubscribe on that same
   * connection, so this epoch is deliberately separate from generation. */
  invalidateCache(): void { this.cacheEpoch++; this.cache.clear(); }

  hideNotification(method: string, params: any): boolean {
    if (method === "thread/started" && params?.thread?.ephemeral === true) {
      if (typeof params.thread.id === "string" && params.thread.id.length > 0
          && params.thread.id.length <= LIMITS.idChars && !params.thread.id.includes("\0")) {
        this.rememberHidden(params.thread.id);
      }
      return true;
    }
    return typeof params?.threadId === "string" && params.threadId.length <= LIMITS.idChars
      && !params.threadId.includes("\0") && this.hidden.has(params.threadId);
  }

  private rememberHidden(id: string): void {
    this.hidden.add(id);
    if (this.hidden.size > 1024) this.hidden.delete(this.hidden.values().next().value!);
  }

  async resolve(threadId: string, model?: string): Promise<EffectiveTurnDefaults> {
    const safeThreadId = boundedString(threadId, "会话标识", LIMITS.idChars);
    const safeModel = model === undefined ? undefined : modelName(model);
    const generation = this.generation;
    const cacheEpoch = this.cacheEpoch;
    const read = await this.supervisor.request("thread/read", { threadId: safeThreadId, includeTurns: false });
    if (!plain(read) || !plain(read.thread)) throw new Error("无法读取会话工作目录，未恢复默认设置");
    const cwd = boundedString(read.thread.cwd, "会话工作目录", LIMITS.cwdChars);
    if (!path.isAbsolute(cwd)) throw new Error("会话工作目录不是当前平台的绝对路径，未恢复默认设置");
    const configResponse = await this.supervisor.request("config/read", { cwd, includeLayers: false });
    if (!plain(configResponse) || generation !== this.generation || cacheEpoch !== this.cacheEpoch) throw new Error("默认配置读取失败或环境已变化，请重试");
    const config = validatedConfig(configResponse.config);
    const key = createHash("sha256").update(cwd).update("\0").update(safeModel ?? "").update("\0").update(config.encoded).digest("hex");
    let result = this.cache.get(key);
    if (!result) {
      if (this.probing >= 4) throw new Error("正在解析默认配置，请稍后重试");
      result = this.probe(cwd, safeModel, config.mcp, generation);
      this.cache.set(key, result);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
      void result.catch(() => { if (this.cache.get(key) === result) this.cache.delete(key); });
    }
    const defaults = await result;
    if (generation !== this.generation || cacheEpoch !== this.cacheEpoch) throw new Error("环境已变化，未应用过期默认配置");
    return defaults;
  }

  private async probe(cwd: string, model: string | undefined, mcp: Record<string, any>, generation: number): Promise<EffectiveTurnDefaults> {
    this.probing++;
    let id: string | undefined;
    try {
      const rawBaseline = await this.supervisor.request("thread/start", {
        cwd, ...(model ? { model } : {}), ephemeral: true, config: { mcp_servers: mcp },
      });
      if (!plain(rawBaseline) || !plain(rawBaseline.thread)) throw new Error("app-server 未返回完整默认配置，已停止发送");
      id = boundedString(rawBaseline.thread.id, "临时会话标识", LIMITS.idChars);
      this.rememberHidden(id);
      const baselineModel = modelName(rawBaseline.model);
      const approval = approvalPolicy(rawBaseline.approvalPolicy);
      const sandbox = sandboxPolicy(rawBaseline.sandbox);
      let effort = reasoningEffort(rawBaseline.reasoningEffort, true);
      if (effort == null) {
        const seen = new Set<string>();
        let cursor: string | undefined;
        let found = false;
        for (let page = 0; page < LIMITS.modelPages; page++) {
          const rawModels = await this.supervisor.request("model/list", { includeHidden: true, limit: LIMITS.modelItems, ...(cursor ? { cursor } : {}) });
          if (!plain(rawModels) || !Array.isArray(rawModels.data) || rawModels.data.length > LIMITS.modelItems) {
            throw new Error("模型目录响应无效，未恢复默认推理强度");
          }
          const nextCursor = rawModels.nextCursor == null
            ? undefined
            : boundedString(rawModels.nextCursor, "模型目录游标", LIMITS.cursorChars);
          for (const item of rawModels.data) {
            if (!plain(item)) throw new Error("模型目录条目无效，未恢复默认推理强度");
            const listedModel = modelName(item.model);
            const listedId = modelName(item.id);
            const listedEffort = reasoningEffort(item.defaultReasoningEffort, false)!;
            if (listedModel === baselineModel || listedId === baselineModel) {
              effort = listedEffort;
              found = true;
              break;
            }
          }
          if (found) break;
          if (!nextCursor) break;
          if (seen.has(nextCursor)) throw new Error("模型目录游标循环，无法解析默认推理强度");
          seen.add(nextCursor);
          cursor = nextCursor;
          if (page === LIMITS.modelPages - 1) throw new Error("模型目录分页过多，未恢复默认推理强度");
        }
        if (!found) throw new Error("模型目录中没有当前模型，未恢复默认推理强度");
      }
      return { model: baselineModel, approvalPolicy: approval, sandbox, reasoningEffort: effort };
    } finally {
      this.probing--;
      // A reset has already destroyed the old connection. Never unsubscribe an
      // old lookup on a replacement connection, or retain failed lookup cache.
      if (id && generation === this.generation) await this.supervisor.request("thread/unsubscribe", { threadId: id });
    }
  }
}
