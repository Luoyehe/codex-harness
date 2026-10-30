import { object, type Model, type Options } from './types';
import { executionOptions, type CollaborationModeMask } from './workflows';
/** This is a UI admission check only; native model and attachment validation remain authoritative. */
export function mediaAdmission({
  attachments,
  intent,
  models,
  modelsLoading,
  defaults,
  defaultsLoading,
  options,
  modes,
}: {
  attachments: { mimeType: string }[];
  intent: 'send' | 'queue' | 'steer';
  models: Model[];
  modelsLoading: boolean;
  defaults?: Record<string, unknown>;
  defaultsLoading: boolean;
  options: Options;
  modes: CollaborationModeMask[];
}): { modalities: string[]; modelId: string; issue: string } {
  const modalities = [
    ...new Set(
      attachments.flatMap((file) =>
        file.mimeType.toLowerCase().startsWith('image/')
          ? ['image']
          : file.mimeType.toLowerCase().startsWith('audio/')
            ? ['audio']
            : [],
      ),
    ),
  ];
  if (!modalities.length) return { modalities, modelId: '', issue: '' };
  const unavailable = (issue: string, modelId = '') => ({ modalities, modelId, issue });
  if (intent === 'steer')
    return unavailable(
      '当前回合可能使用独立模型设置，无法确认它的图片或音频能力。请加入队列或在下一回合发送媒体；附件仍保留。',
    );
  if (defaultsLoading || modelsLoading)
    return unavailable('正在核对模型的图片与音频能力，完成前不能发送媒体附件。');
  let id: unknown = defaults?.model;
  if (intent === 'send') {
    try {
      const prepared = object(executionOptions(options, defaults, modes));
      id =
        object(object(prepared.collaborationMode).settings).model ??
        prepared.model ??
        defaults?.model;
    } catch {
      return unavailable('协作模式或默认模型尚未确认，请重新读取后再发送媒体附件。');
    }
  }
  if (typeof id !== 'string' || !id)
    return unavailable('尚未确认实际输入模型，不能发送图片或音频附件。');
  const provider = intent === 'send' ? options.modelProvider ?? defaults?.modelProvider : defaults?.modelProvider;
  const matches = models.filter((row) => (row.id === id || row.model === id) &&
    (!provider || !row.modelProvider || row.modelProvider === provider || (typeof provider === 'string' && row.providerAliases?.includes(provider))));
  if (
    matches.length !== 1 ||
    !Array.isArray(matches[0]!.inputModalities) ||
    matches[0]!.inputModalities!.some((value) => !['text', 'image', 'audio'].includes(value))
  )
    return unavailable(
      `模型 ${id} 的输入能力尚未由目录明确提供。请刷新或继续加载目录；不能假定媒体可用。`,
      id,
    );
  const missing = modalities.filter((value) => !matches[0]!.inputModalities!.includes(value));
  if (missing.length)
    return unavailable(
      `模型 ${id} 的目录未声明支持${missing.map((value) => (value === 'audio' ? '音频' : '图片')).join('、')}输入。请选择支持的模型或移除这些附件；草稿仍保留。`,
      id,
    );
  return { modalities, modelId: id, issue: '' };
}
