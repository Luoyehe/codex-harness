import type { CodexSupervisor } from "./codex/process.js";

/** A provider name is not a capability. Validate against the exact model
 * returned by the running, pinned app-server, without borrowing its neighbor's
 * effort list or assuming a new protocol enum is universally supported. */
export async function validateModelEffort(supervisor: Pick<CodexSupervisor, "request">, threadId: string, model: string | undefined, effort: string): Promise<void> {
  const selected = model ?? (await supervisor.request("thread/resume", { threadId })).model;
  if (!selected) throw new Error("无法确定当前模型，未发送推理强度覆盖值");
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = await supervisor.request("model/list", { includeHidden: true, limit: 200, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response.data)) throw new Error("模型能力目录无效，未发送推理强度覆盖值");
    const entry = response.data.find((item) => item.model === selected || item.id === selected);
    if (entry) {
      if (!Array.isArray(entry.supportedReasoningEfforts) || !entry.supportedReasoningEfforts.some((level) => level.reasoningEffort === effort)) {
        throw new Error(`模型 ${selected} 未声明支持推理强度 ${effort}；请使用该模型列出的选项或默认设置`);
      }
      return;
    }
    if (!response.nextCursor) break;
    if (seen.has(response.nextCursor)) throw new Error("模型能力目录游标循环");
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error(`模型 ${selected} 的能力未知，未发送推理强度覆盖值`);
}
