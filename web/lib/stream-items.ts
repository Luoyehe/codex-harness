import { array, type Item, type JsonObject } from './types';

export const streamField = (item: Item): 'text' | 'aggregatedOutput' | 'reasoning' | undefined =>
  item.type === 'agentMessage' || item.type === 'plan'
    ? 'text'
    : item.type === 'commandExecution'
      ? 'aggregatedOutput'
      : item.type === 'reasoning'
        ? 'reasoning'
        : undefined;

export function streamSnapshot(
  item: Item,
  field: NonNullable<ReturnType<typeof streamField>>,
): string {
  if (field !== 'reasoning') return String(item[field] ?? '');
  return [
    '思考摘要',
    array<string>(item.summary).join('\n\n'),
    '详细思考内容',
    array<string>(item.content).join('\n\n'),
  ].join('\n');
}

export function appendStream(
  previous: Item | undefined,
  method: string,
  params: JsonObject,
  id: string,
): Item | undefined {
  const text = method === 'item/agentMessage/delta' || method === 'item/plan/delta';
  const output = method === 'item/commandExecution/outputDelta';
  const summary =
    method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded';
  const content = method === 'item/reasoning/textDelta';
  if (!text && !output && !summary && !content) return;
  const field = text ? 'text' : output ? 'aggregatedOutput' : 'reasoning';
  const type =
    method === 'item/plan/delta'
      ? 'plan'
      : text
        ? 'agentMessage'
        : output
          ? 'commandExecution'
          : 'reasoning';
  const item: Item = { ...previous, id, type: previous?.type ?? type };
  if (item.type !== type) throw new Error('实时条目类型发生变化，请重新核对历史。');
  const index = summary ? params.summaryIndex : params.contentIndex;
  if (
    (summary || content) &&
    (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > 1023)
  )
    throw new Error('思考片段序号超出安全范围，请重新核对历史。');
  const added = method === 'item/reasoning/summaryPartAdded';
  if (!added && typeof params.delta !== 'string') throw new Error('实时片段缺少文字内容。');
  const delta = added ? '' : String(params.delta);
  if (!previous || previous.historySync) {
    const fragment =
      field === 'reasoning' && delta ? `${summary ? '摘要' : '内容'} ${index}: ${delta}\n` : delta;
    item.historySync = {
      field,
      ...(previous?.historySync?.snapshot !== undefined
        ? { snapshot: previous.historySync.snapshot }
        : {}),
      deltas: (previous?.historySync?.deltas ?? '') + fragment,
      ...(previous?.historySync?.summaryDeltas
        ? { summaryDeltas: previous.historySync.summaryDeltas }
        : {}),
    };
    if (summary) {
      const parts = [...(item.historySync.summaryDeltas ?? [])];
      while (parts.length <= Number(index)) parts.push('');
      if (!added) parts[Number(index)] += delta;
      item.historySync.summaryDeltas = parts;
    }
  } else if (field === 'reasoning') {
    const key = summary ? 'summary' : 'content',
      parts = [...array<string>(item[key])];
    while (parts.length <= Number(index)) parts.push('');
    // PartAdded may be repeated; it must never erase text already received.
    if (!added) parts[Number(index)] += delta;
    item[key] = parts;
  } else item[field] = String(previous[field] ?? '') + delta;
  return item;
}
