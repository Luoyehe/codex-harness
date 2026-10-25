import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { array, object } from '../lib/types';
type Environment = { environmentId: string; name: string; endpoint: string; selectionReady: boolean; info?: { cwd: string | null } };
export function EnvironmentPicker({ api, epoch, value, existingThread, defaults, disabled, onChange, onProblem }: { api: Api; epoch: string; value?: string[]; existingThread: boolean; defaults?: Record<string, unknown>; disabled: boolean; onChange: (value: string[] | undefined) => void; onProblem: (problem: string) => void }) {
  const [open, setOpen] = useState(false);
  const catalog = useResource(epoch, async signal => {
    const result = await api.call<{ data: Environment[] }>('environment/list', {}, signal);
    if (!Array.isArray(result.data) || result.data.length > 32 || result.data.some(row => typeof row.environmentId !== 'string' || typeof row.name !== 'string' || typeof row.selectionReady !== 'boolean')) throw new Error('远端执行目录格式无效。');
    return result;
  }, open || Boolean(value?.length));
  const selected = value ?? [], unknown = selected.filter(id => !catalog.data?.data.some(row => row.environmentId === id && row.selectionReady));
  const issue = selected.length > 8 ? '一次最多选择 8 个远端执行环境。' : !selected.length ? '' : catalog.loading ? '正在核对远端执行环境，完成前不能发送。' : catalog.error ? `远端执行目录读取失败：${catalog.error}` : unknown.length ? '所选远端环境已失效或尚未核对，请清空选择或在设置中重新登记并读取信息。' : '';
  useEffect(() => onProblem(issue), [issue, onProblem]);
  const inherited = array<unknown>(object(defaults?.thread).environments ?? defaults?.environments).map(object);
  return <details className="environment-picker" onToggle={e => setOpen(e.currentTarget.open)}><summary>执行环境 · {value === undefined ? existingThread ? '沿用会话' : '本机项目' : selected.length ? `${selected.length} 个远端` : '不使用远端'}</summary><div className="context-panel stack"><p className="small muted">只选择在设置中登记并明确读取信息的环境。远端命令使用该环境核对过的工作目录；本机项目文件和远端文件属于不同范围。</p>{existingThread && inherited.length > 0 && <p className="small path">会话当前报告：{inherited.map(row => `${String(row.environmentId)} · ${String(row.cwd ?? '')}`).join('；')}</p>}<div className="inline"><button type="button" className="button small" disabled={disabled} onClick={() => onChange(undefined)}>{existingThread ? '沿用当前会话环境' : '使用本机项目默认环境'}</button><button type="button" className="button small" disabled={disabled} onClick={() => onChange([])}>本次不使用远端环境</button><button type="button" className="button small" disabled={catalog.loading} onClick={catalog.refresh}>刷新环境目录</button></div>{catalog.error && <p className="error" role="alert">{catalog.error}</p>}{catalog.loading && <p role="status">读取已登记的执行环境…</p>}{catalog.data?.data.map(row => <label className="check-row" key={row.environmentId}><input type="checkbox" checked={selected.includes(row.environmentId)} disabled={disabled || !row.selectionReady} onChange={e => onChange(e.target.checked ? [...selected, row.environmentId] : selected.filter(id => id !== row.environmentId))}/><span>{row.name}<small className="path"> · {row.endpoint} · {row.info?.cwd ?? '请先到设置读取远端信息'}</small></span></label>)}{catalog.data?.data.length === 0 && <p className="muted small">当前没有登记的远端环境。可在“设置 → 远端环境与连接”登记。</p>}{unknown.length > 0 && !catalog.loading && <p className="workspace-warning">草稿中的失效选择：{unknown.join('、')}。不会自动替换成其他远端。</p>}<p className="small muted">勾选后只改变此草稿；点击发送才提交。注册连接会持续到执行服务重启。</p></div></details>;
}
