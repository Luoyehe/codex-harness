import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { commitState, indexVersions, type CommitState } from '../lib/git-state';
import { validRevision } from '../lib/workspace';
import { message, object, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
import { Diff } from './Messages';
type Slot = 'before' | 'captured' | 'next';
type Entry = { slot: Slot; bytes: number; revision: string; absent: boolean };
type Record = { operationId: string; state: string; phase?: string; entries: Entry[]; manifest?: string; discardAllowed?: boolean; incomplete?: boolean };
const names: { [slot in Slot]: string } = { before: '操作前的完整索引', captured: '捕获的原始索引', next: '操作后的索引' };
const prefix = 'workspace/git/index/recovery/';
function checkedRecord(value: unknown, operationId: string): Record {
  const record = object(value);
  if (record.operationId !== operationId || typeof record.state !== 'string' || !Array.isArray(record.entries) || record.entries.length > 3 || record.entries.some(value => { const entry = object(value); return !['before', 'captured', 'next'].includes(String(entry.slot)) || !validRevision(entry.revision) || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 || typeof entry.absent !== 'boolean'; }) || record.manifest !== undefined && !validRevision(record.manifest)) throw new Error('索引备份身份或版本格式无效。');
  return record as Record;
}
export function WorkspaceIndexRecovery({ api, project, epoch, connected, enabled, onChanged }: { api: Api; project: Project; epoch: string; connected: boolean; enabled: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(''), [slot, setSlot] = useState<Slot>('before'), [confirm, setConfirm] = useState(false), [discard, setDiscard] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<{ key: string; state: CommitState; diff: string }>();
  const changed = useCallback(() => { setPreview(undefined); setConfirm(false); setDiscard(false); onChanged(); }, [onChanged]), action = useExtensionAction(api, enabled, changed);
  const list = useResource(`${project.id}:${epoch}:${action.revision}`, async signal => {
    const result = await api.call<{ records: Record[]; complete: boolean; retainedLimit: number }>(prefix + 'list', { projectId: project.id }, signal);
    if (result.complete !== true || !Array.isArray(result.records) || result.records.length > 65) throw new Error('索引备份目录不完整或超过容量。');
    result.records.forEach(record => checkedRecord(record, record.operationId)); return result;
  }, connected && open);
  const detail = useResource(`${project.id}:${epoch}:${action.revision}:${selected}`, async signal => checkedRecord(await api.call(prefix + 'read', { projectId: project.id, operationId: selected }, signal), selected), connected && open && Boolean(selected));
  const entry = detail.data?.entries.find(entry => entry.slot === slot), key = JSON.stringify([project.id, epoch, selected, slot, detail.data?.manifest, entry?.revision]), owner = useRef(key); owner.current = key;
  useEffect(() => { setPreview(undefined); setConfirm(false); setDiscard(false); }, [key]);
  useEffect(() => { if (action.operation?.state === 'not_sent') { setPreview(undefined); setConfirm(false); setDiscard(false); list.refresh(); detail.refresh(); } }, [action.operation?.id, action.operation?.state]);
  const current = preview?.key === key ? preview : undefined;
  const inspect = async () => { if (reading || !entry) return; const expected = key; setReading(true); setError(''); setPreview(undefined); setConfirm(false); try {
    const before = commitState(await api.call('workspace/git/status', { projectId: project.id }));
    const diff = await api.call<{ text: string; staged: boolean; complete: boolean }>('workspace/git/diff', { projectId: project.id, staged: true });
    const after = commitState(await api.call('workspace/git/status', { projectId: project.id }));
    if (owner.current !== expected) return;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('核对期间 HEAD 或索引已变化，请重新读取。');
    if (diff.complete !== true || diff.staged !== true || typeof diff.text !== 'string') throw new Error('当前暂存区 Diff 不完整，不能确认恢复。');
    setPreview({ key: expected, state: before, diff: diff.text });
  } catch (e) { if (owner.current === expected) setError(message(e)); } finally { setReading(false); } };
  return <details className="info-card" onToggle={e => setOpen(e.currentTarget.open)}><summary>恢复或清理 Git 索引备份</summary><div className="stack"><p>这里恢复整个 Git 暂存区，不恢复工作区文件，也不移动 HEAD。与“恢复材料”中的普通文件备份分开管理。备份的本地状态不能证明原操作已获全局成功回执。</p><ExtensionStatus api={api} action={action} recoveryLabel="查询原索引恢复操作回执"/><ReadState {...list}/><button className="button small" disabled={!connected} onClick={() => { list.refresh(); detail.refresh(); setPreview(undefined); setConfirm(false); setDiscard(false); }}>刷新索引备份</button><label className="field">索引备份操作<select value={selected} onChange={e => { setSelected(e.target.value); setSlot('before'); }}><option value="">选择原索引操作</option>{list.data?.records.map(record => <option key={record.operationId} value={record.operationId}>{record.operationId} · {record.state}{record.incomplete ? ' · 材料不完整' : ''}</option>)}</select></label><ReadState {...detail}/>{detail.data && <><p className="small">本地状态：{detail.data.state} · 阶段：{detail.data.phase ?? '未提供'}</p><label className="field">索引备份版本<select value={slot} onChange={e => setSlot(e.target.value as Slot)}><option value="" disabled>选择备份</option>{detail.data.entries.map(entry => <option key={entry.slot} value={entry.slot}>{names[entry.slot]} · {entry.absent ? '原先没有索引' : `${entry.bytes.toLocaleString()} 字节`}</option>)}</select></label>{entry && <div className="stack"><p className="small path">备份校验：{entry.revision}</p>{entry.absent && <p className="workspace-warning">此备份表示原先没有索引；恢复后当前暂存区索引将被移除。工作区文件保留。</p>}<button className="button small" disabled={!connected || reading || action.disabled} onClick={() => void inspect()}>{reading ? '正在核对…' : '核对将被替换的当前暂存区'}</button>{current && <><p className="small path">当前 HEAD：{current.state.head ?? '尚无提交'}</p><details><summary>当前暂存区 Diff（将被所选备份替换）</summary>{current.diff ? <Diff text={current.diff}/> : <p className="muted">当前没有暂存修改。</p>}</details><label className="check-row"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/>确认用所选备份替换整个暂存区；本次当前索引也会保留恢复材料</label></>}<button className="button danger" disabled={action.disabled || !current || !confirm} onClick={() => void action.run(prefix + 'restore', { projectId: project.id, ...indexVersions(current!.state), recoveryOperationId: selected, slot: entry.slot, sourceRevision: entry.revision }, '索引恢复已受理，请重新核对 Git 状态。')}>恢复整个暂存区</button></div>}{detail.data.entries.length === 0 && <p className="muted">此记录没有可恢复的索引内容。</p>}<hr/><label className="check-row"><input type="checkbox" checked={discard} onChange={e => setDiscard(e.target.checked)}/>确认永久清理这笔已完成操作的索引备份，不删除回执或项目文件</label><button className="button danger small" disabled={action.disabled || !discard || detail.data.discardAllowed !== true || detail.data.state !== 'completed' || !detail.data.manifest} onClick={() => void action.run(prefix + 'discard', { projectId: project.id, recoveryOperationId: selected, expectedManifest: detail.data!.manifest, confirm: true }, '索引备份清理已受理，操作回执仍保留。')}>清理所选索引备份</button></>}{error && <p className="error" role="alert">{error}</p>}</div></details>;
}
