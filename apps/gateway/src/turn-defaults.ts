import { createHash } from "node:crypto";
import type { CodexSupervisor } from "./codex/process.js";
import type { ConfigReadResponse } from "../../../protocol/v2/ConfigReadResponse.js";
import type { ThreadStartResponse } from "../../../protocol/v2/ThreadStartResponse.js";

export type EffectiveTurnDefaults = Pick<ThreadStartResponse, "model" | "approvalPolicy" | "sandbox" | "reasoningEffort">;

/** Resolve defaults with the pinned server, not guesses about trust/profile rules.
 * A no-turn ephemeral thread has no rollout or inference. MCP startup is disabled
 * in that lookup only. Cache by effective config and cwd, never by sticky thread
 * settings; null in the browser API means these project/provider defaults. */
export class TurnDefaults {
  private generation = 0;
  private cache = new Map<string, Promise<EffectiveTurnDefaults>>();
  private hidden = new Set<string>();
  private probing = 0;

  constructor(private readonly supervisor: Pick<CodexSupervisor, "request">) {}

  reset(): void { this.generation++; this.cache.clear(); this.hidden.clear(); }

  hideNotification(method: string, params: any): boolean {
    if (method === "thread/started" && params?.thread?.ephemeral === true) {
      this.rememberHidden(params.thread.id);
      return true;
    }
    return typeof params?.threadId === "string" && this.hidden.has(params.threadId);
  }

  private rememberHidden(id: string): void {
    this.hidden.add(id);
    if (this.hidden.size > 1024) this.hidden.delete(this.hidden.values().next().value!);
  }

  async resolve(threadId: string, model?: string): Promise<EffectiveTurnDefaults> {
    const generation = this.generation;
    const { thread } = await this.supervisor.request("thread/read", { threadId, includeTurns: false });
    if (!thread?.cwd) throw new Error("无法读取会话工作目录，未恢复默认设置");
    const { config } = await this.supervisor.request("config/read", { cwd: thread.cwd, includeLayers: false }) as ConfigReadResponse;
    if (!config || generation !== this.generation) throw new Error("默认配置读取失败或服务已重启，请重试");
    const key = createHash("sha256").update(JSON.stringify([thread.cwd, model ?? null, config])).digest("hex");
    let result = this.cache.get(key);
    if (!result) {
      if (this.probing >= 4) throw new Error("正在解析默认配置，请稍后重试");
      const mcp = config.mcp_servers;
      const disabled = mcp && typeof mcp === "object" && !Array.isArray(mcp)
        ? Object.fromEntries(Object.entries(mcp).map(([name, value]) => [name, {
          ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}), enabled: false,
        }])) : {};
      result = this.probe(thread.cwd, model, disabled, generation);
      this.cache.set(key, result);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
      void result.catch(() => { if (this.cache.get(key) === result) this.cache.delete(key); });
    }
    const defaults = await result;
    if (generation !== this.generation) throw new Error("服务已重启，未应用过期默认配置");
    return defaults;
  }

  private async probe(cwd: string, model: string | undefined, mcp: Record<string, any>, generation: number): Promise<EffectiveTurnDefaults> {
    this.probing++;
    let id: string | undefined;
    try {
      const baseline = await this.supervisor.request("thread/start", {
        cwd, ...(model ? { model } : {}), ephemeral: true, config: { mcp_servers: mcp },
      });
      id = baseline.thread?.id;
      if (!id || !baseline.model || !baseline.approvalPolicy || !baseline.sandbox?.type) {
        throw new Error("app-server 未返回完整默认配置，已停止发送");
      }
      this.rememberHidden(id);
      let effort = baseline.reasoningEffort;
      if (effort == null) {
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const models = await this.supervisor.request("model/list", { includeHidden: true, limit: 200, ...(cursor ? { cursor } : {}) });
          effort = models.data.find((item) => item.model === baseline.model || item.id === baseline.model)?.defaultReasoningEffort ?? null;
          if (effort != null || !models.nextCursor) break;
          if (seen.has(models.nextCursor)) throw new Error("模型目录游标循环，无法解析默认推理强度");
          seen.add(models.nextCursor);
          cursor = models.nextCursor;
        }
      }
      return { model: baseline.model, approvalPolicy: baseline.approvalPolicy, sandbox: baseline.sandbox, reasoningEffort: effort };
    } finally {
      this.probing--;
      // A reset has already destroyed the old connection. Never unsubscribe an
      // old lookup on a replacement connection, or retain failed lookup cache.
      if (id && generation === this.generation) await this.supervisor.request("thread/unsubscribe", { threadId: id });
    }
  }
}
