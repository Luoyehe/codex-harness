import type { CodexSupervisor } from "./codex/process.js";

const MAX_MODEL_PAGES = 5;

const validIdentifier = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** A provider name is not a capability. Validate against the exact model
 * returned by the running, pinned app-server, without borrowing its neighbor's
 * effort list or assuming a new protocol enum is universally supported. */
export async function validateModelEffort(supervisor: Pick<CodexSupervisor, "request">, threadId: string, model: string | undefined, effort: string): Promise<void> {
  const selected = model ?? (await supervisor.request("thread/resume", { threadId })).model;
  if (!validIdentifier(selected)) throw new Error("无法确定当前模型，未发送推理强度覆盖值");
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const response = await supervisor.request("model/list", { includeHidden: true, limit: 200, ...(cursor ? { cursor } : {}) });
    if (!plain(response) || !Array.isArray(response.data) || response.data.length > 200) {
      throw new Error("模型能力目录无效，未发送推理强度覆盖值");
    }
    for (const item of response.data) {
      if (!plain(item) || !validIdentifier(item.model) || !validIdentifier(item.id)
          || !Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length > 64
          || item.supportedReasoningEfforts.some((option) => !plain(option) || !validIdentifier(option.reasoningEffort, 64))) {
        throw new Error("模型能力目录无效，未发送推理强度覆盖值");
      }
    }
    const entry = response.data.find((item) => item.model === selected || item.id === selected);
    if (entry) {
      if (!Array.isArray(entry.supportedReasoningEfforts) || !entry.supportedReasoningEfforts.some((level) => level.reasoningEffort === effort)) {
        throw new Error(`模型 ${selected} 未声明支持推理强度 ${effort}；请使用该模型列出的选项或默认设置`);
      }
      return;
    }
    if (response.nextCursor == null) break;
    if (!validIdentifier(response.nextCursor, 4096)) throw new Error("模型能力目录游标无效");
    if (seen.has(response.nextCursor)) throw new Error("模型能力目录游标循环");
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error(`模型 ${selected} 的能力未知，未发送推理强度覆盖值`);
}
