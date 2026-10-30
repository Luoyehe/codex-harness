import { useEffect, useRef } from 'react';
import { object, type Model, type Options } from '../lib/types';

const effortName = (value: string) => ({ none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }[value] ?? value);
export const modelSelection = (model: Model): string => model.modelProvider
  ? JSON.stringify([model.modelProvider, model.model ?? model.id]) : model.model ?? model.id;
const matchesProvider = (model: Model, provider?: string) => !provider || !model.modelProvider ||
  model.modelProvider === provider || model.providerAliases?.includes(provider);

export function ModelPicker({ models, options, onOptions, defaults, existingThread, loading, defaultsLoading, disabled,
  onRefresh, more, onMore, onProviders, refreshDisabled,
}: {
  models: Model[]; options: Options; onOptions: (options: Options) => void;
  defaults?: Record<string, unknown>; existingThread: boolean; loading?: boolean; defaultsLoading?: boolean; disabled?: boolean;
  onRefresh?: () => void; more?: boolean; onMore?: () => void; onProviders?: () => void;
  refreshDisabled?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const inheritedProvider = typeof defaults?.modelProvider === 'string' ? defaults.modelProvider : undefined;
  const provider = options.modelProvider ?? inheritedProvider;
  const id = options.model ?? (typeof defaults?.model === 'string' ? defaults.model : undefined);
  const available = existingThread && inheritedProvider
    ? models.filter(row => matchesProvider(row, inheritedProvider)) : models;
  const selected = available.find(row => (row.model ?? row.id) === id && matchesProvider(row, provider));
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const nativeEffort = selected && object(selected).defaultReasoningEffort;
  const inheritedEffort = (!options.model || options.model === defaults?.model) && (!options.modelProvider || options.modelProvider === inheritedProvider)
    ? defaults?.reasoningEffort : nativeEffort;
  const effort = options.effort ?? (typeof inheritedEffort === 'string' ? inheritedEffort : undefined);
  const title = selected?.displayName ?? selected?.model ?? selected?.id ?? (existingThread && id ? id : loading ? '读取模型…' : '选择模型');
  const groups = [...new Set(available.map(row => row.modelProvider ?? ''))];
  const selection = options.model && selected ? modelSelection(selected) : options.model ? '__unavailable__' : '';
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <details className="model-picker" ref={ref} onKeyDown={(event) => {
    if (event.key === 'Escape' && ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); event.stopPropagation(); }
  }}>
    <summary aria-label="选择模型与思考强度"><span>{title}</span>{effort && efforts.length > 0 && <small>{effortName(effort)}</small>}<span aria-hidden="true">⌄</span></summary>
    <section className="model-picker-panel stack" aria-label="模型与思考强度">
      <label className="field">模型
        <select disabled={disabled || loading || available.length === 0} value={selection} onChange={(event) => {
          const next = available.find(row => modelSelection(row) === event.target.value);
          onOptions({ ...options, model: next ? next.model ?? next.id : undefined,
            modelProvider: next?.modelProvider, effort: undefined });
        }}>
          <option value="">{defaultsLoading ? '正在读取默认设置…' : available.length ? existingThread ? '沿用会话模型' : '使用默认模型' : loading ? '正在读取模型…' : '尚无可选模型'}</option>
          {selection === '__unavailable__' && <option value="__unavailable__" disabled>当前模型不在目录：{options.model}</option>}
          {groups.map(group => <optgroup key={group} label={available.find(row => (row.modelProvider ?? '') === group)?.providerName ?? (group || '模型')}>
            {available.filter(row => (row.modelProvider ?? '') === group).map(row => <option key={modelSelection(row)} value={modelSelection(row)}>{row.displayName ?? row.model ?? row.id}</option>)}
          </optgroup>)}
        </select>
      </label>
      <label className="field">思考强度
        <select disabled={disabled || loading || efforts.length === 0 && !options.effort} value={options.effort ?? ''} onChange={(event) => onOptions({ ...options, effort: event.target.value || undefined })}>
          <option value="">{efforts.length ? `模型默认${typeof inheritedEffort === 'string' ? `（${effortName(inheritedEffort)}）` : ''}` : options.effort ? '恢复模型默认强度' : selected ? '此模型未提供可调强度' : '请先选择模型'}</option>
          {options.effort && !efforts.some(row => row.reasoningEffort === options.effort) && <option value={options.effort} disabled>原强度已不可用</option>}
          {efforts.map(row => <option key={row.reasoningEffort} value={row.reasoningEffort}>{effortName(row.reasoningEffort)}</option>)}
        </select>
      </label>
      {available.length === 0 && !loading && <p className="small muted">先添加供应商并完成所需登录，再读取模型目录。</p>}
      {disabled && <p className="small muted">排队或追加指令沿用会话设置，不能修改本次模型。</p>}
      <div className="inline wrap">
        {onRefresh && <button className="button small" disabled={loading || refreshDisabled} onClick={onRefresh}>刷新模型目录</button>}
        {more && <button className="button small" disabled={loading} onClick={onMore}>加载更多模型</button>}
        {onProviders && <button className="button subtle small" onClick={() => { if (ref.current) ref.current.open = false; onProviders(); }}>管理供应商</button>}
      </div>
      {refreshDisabled && <p className="small muted">后台就绪且当前任务结束后可更新供应商目录。</p>}
    </section>
  </details>;
}
