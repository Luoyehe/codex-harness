import type { CollaborationModeMask } from '../../protocol/ts/v2/CollaborationModeMask';
import type { QueuedSubmission as NativeQueuedSubmission } from '../../protocol/ts/v2/QueuedSubmission';
import type { ThreadGoal } from '../../protocol/ts/v2/ThreadGoal';
import type { ThreadSearchOccurrence } from '../../protocol/ts/v2/ThreadSearchOccurrence';
import type { ReviewTarget } from '../../protocol/ts/v2/ReviewTarget';
import { array, object, type Model, type Options, type Thread } from './types';
export type { CollaborationModeMask, ThreadGoal, ThreadSearchOccurrence, ReviewTarget };
export type QueuedSubmission = NativeQueuedSubmission & {
  text?: string;
  attachments?: { attachmentId: string; name: string; mimeType: string; size: number }[];
  attachmentIds?: string[];
  hasOpaqueInput?: boolean;
};
export const INPUT_METHODS = ['conversation/start', 'turn/start', 'turn/steer', 'thread/queue/add'];
export const queuedText = (entry: QueuedSubmission) =>
  entry.text ??
  entry.input
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
export const queuedExtras = (entry: QueuedSubmission) =>
  entry.input.filter((part) => part.type !== 'text');
export function executionOptions(
  options: Options,
  defaults: Record<string, unknown> | undefined,
  modes: CollaborationModeMask[],
) {
  const { mode, ...result } = options;
  if (!mode) return result;
  const preset = modes.find((item) => item.mode === mode);
  if (!preset) throw new Error('当前运行时没有提供所选协作模式，请刷新模式目录。');
  const model = options.model || defaults?.model || preset.model;
  const sameModel = (!options.model || options.model === defaults?.model) &&
    (!options.modelProvider || options.modelProvider === defaults?.modelProvider);
  if (typeof model !== 'string' || !model)
    throw new Error('请等待默认模型读取完成，或明确选择模型后再切换模式。');
  return {
    ...result,
    collaborationMode: {
      mode,
      settings: {
        model,
        reasoning_effort:
          options.effort ?? (sameModel ? defaults?.reasoningEffort ?? preset.reasoning_effort : null) ?? null,
        developer_instructions: null,
      },
    },
  };
}
/** Validate explicit reasoning settings against this exact provider/model, without changing the draft. */
export function modelSettingsIssue({ options, defaults, defaultsLoading, models, modelsLoading, modes }: {
  options: Options; defaults?: Record<string, unknown>; defaultsLoading: boolean;
  models: Model[]; modelsLoading: boolean; modes: CollaborationModeMask[];
}): string {
  if (defaultsLoading) return '正在核对模型设置，完成后即可发送。';
  if (!options.effort) return '';
  if (modelsLoading) return '正在核对模型的思考强度，完成后即可发送。';
  let model: unknown;
  try {
    const prepared = object(executionOptions(options, defaults, modes));
    model = object(object(prepared.collaborationMode).settings).model ?? prepared.model ?? defaults?.model;
  } catch (error) { return error instanceof Error ? error.message : '模型设置尚未确认，请重新选择。'; }
  const provider = options.modelProvider ?? defaults?.modelProvider;
  const matches = models.filter(row => (row.model ?? row.id) === model &&
    (!provider || !row.modelProvider || row.modelProvider === provider ||
      typeof provider === 'string' && row.providerAliases?.includes(provider)));
  if (matches.length !== 1)
    return '尚未确认当前模型支持的思考强度，请刷新或继续加载模型目录，或恢复模型默认强度。';
  if (!matches[0]!.supportedReasoningEfforts?.some(row => row.reasoningEffort === options.effort))
    return '所选思考强度已不适用于当前模型，请重新选择或恢复模型默认强度。';
  return '';
}
export function checkedExport(value: unknown, format: 'json' | 'markdown') {
  const result = object(value);
  if (
    typeof result.content !== 'string' ||
    typeof result.filename !== 'string' ||
    !result.filename ||
    result.filename.length > 240 ||
    /[\\/\x00-\x1f]/.test(result.filename) ||
    result.mimeType !== (format === 'json' ? 'application/json' : 'text/markdown')
  )
    throw new Error('完整导出响应无效，未生成文件。');
  return {
    content: result.content,
    filename: result.filename,
    mimeType: format === 'json' ? 'application/json' : 'text/markdown',
  };
}
export function attachmentLabels(input: unknown) {
  return array<unknown>(input)
    .filter((part) => object(part).type !== 'text')
    .map((part) => {
      const p = object(part),
        label = p.name ?? (typeof p.path === 'string' ? p.path.split(/[\\/]/).at(-1) : undefined);
      return typeof label === 'string'
        ? label
        : ({
            image: '图片',
            localImage: '图片',
            audio: '音频',
            localAudio: '音频',
            skill: '技能',
            mention: '引用',
          }[String(p.type)] ?? '附件');
    });
}
export function agentTreeRows(agents: Thread[]): { thread: Thread; depth: number }[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent])),
    children = new Map<string, Thread[]>(),
    seen = new Set<string>(),
    rows: { thread: Thread; depth: number }[] = [];
  for (const agent of agents)
    if (agent.parentThreadId && agent.parentThreadId !== agent.id && byId.has(agent.parentThreadId))
      children.set(agent.parentThreadId, [...(children.get(agent.parentThreadId) ?? []), agent]);
  const visit = (agent: Thread, depth: number) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    rows.push({ thread: agent, depth: Math.min(depth, 5) });
    for (const child of children.get(agent.id) ?? []) visit(child, depth + 1);
  };
  for (const agent of agents)
    if (!agent.parentThreadId || !byId.has(agent.parentThreadId)) visit(agent, 0);
  for (const agent of agents) visit(agent, 0);
  return rows;
}
