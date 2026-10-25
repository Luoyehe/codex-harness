import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import type { Project } from '../lib/types';
import { message } from '../lib/types';
import { workspacePath } from '../lib/workspace';

type Result = { path: string; query: string; mode: string; matches: { path: string; line?: number; preview?: string }[]; complete: boolean; reasons: string[]; visitedEntries: number; readBytes: number; skippedEntries: number; excludedNames: string[] };
const reasons: Record<string, string> = { result_limit: '结果数上限', entry_limit: '目录项上限', byte_limit: '读取字节上限', time_limit: '搜索时间上限', depth_limit: '目录深度上限', unsupported_or_changed_entries: '有不可读、二进制、链接、过大或搜索中变化的条目' };
export function WorkspaceSearch({ api, project, epoch, connected, onOpenFile }: { api: Api; project: Project; epoch: string; connected: boolean; onOpenFile: (path: string) => void }) {
  const [query, setQuery] = useState(''), [path, setPath] = useState(''), [mode, setMode] = useState('path'), [sensitive, setSensitive] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<{ key: string; value: Result }>();
  const identity = `${project.id}:${epoch}:${connected}`, key = JSON.stringify([identity, query, path, mode, sensitive]), current = useRef(key); current.current = key;
  const currentResult = result?.key === key ? result.value : undefined;
  return <details className="info-card"><summary>搜索项目文件与内容</summary><form className="stack" onSubmit={async e => {
    e.preventDefault(); if (busy || !connected || !query.trim()) return; const requestKey = key; setBusy(true); setError(''); setResult(undefined);
    try { const scope = workspacePath(path, true); const value = await api.call<Result>('workspace/search', { projectId: project.id, path: scope, query, mode, caseSensitive: sensitive, limit: 100 }); if (value.query !== query || value.path !== scope || value.mode !== mode || !Array.isArray(value.matches) || value.matches.length > 100 || typeof value.complete !== 'boolean') throw new Error('搜索响应与当前范围不匹配。'); for (const hit of value.matches) workspacePath(hit.path); if (current.current === requestKey) setResult({ key: requestKey, value }); }
    catch (e) { if (current.current === requestKey) setError(message(e)); }
    finally { setBusy(false); }
  }}><p className="small muted">按字面文字搜索，不执行正则或 shell。仅搜索当前项目，跳过 Git 和恢复元数据；最多扫描 10,000 项、读取 32 MiB、显示 100 个匹配。结果是读取时的快照，打开文件会重新核对。</p><label className="field">查找文字<input type="search" value={query} maxLength={256} onChange={e => setQuery(e.target.value)}/></label><label className="field">搜索范围（项目内目录，可留空）<input value={path} maxLength={4096} onChange={e => setPath(e.target.value)}/></label><label className="field">搜索方式<select value={mode} onChange={e => setMode(e.target.value)}><option value="path">文件路径</option><option value="text">UTF-8 文本内容</option></select></label><label className="check-row"><input type="checkbox" checked={sensitive} onChange={e => setSensitive(e.target.checked)}/>区分大小写</label><button className="button" disabled={!connected || busy || !query.trim()}>{busy ? '正在搜索…' : '搜索此范围'}</button>{error && <p className="error" role="alert">{error}</p>}
    {currentResult && <div className="stack">{!currentResult.complete && <p className="workspace-warning" role="status">搜索结果不完整：{currentResult.reasons.map(reason => reasons[reason] ?? reason).join('；')}。可缩小搜索目录后再次查找。</p>}<p className="small muted">扫描 {currentResult.visitedEntries} 项 · 匹配 {currentResult.matches.length} 处 · 跳过 {currentResult.skippedEntries} 项</p><ul className="search-hits">{currentResult.matches.map((hit, index) => <li key={`${hit.path}:${hit.line ?? 0}:${index}`}><button type="button" className="search-hit" onClick={() => onOpenFile(hit.path)} disabled={!connected}><span className="path">{hit.path}{hit.line ? ` · 第 ${hit.line} 行` : ''}</span>{hit.preview !== undefined && <small>{hit.preview}</small>}</button></li>)}</ul>{currentResult.matches.length === 0 && <p className="muted">{currentResult.complete ? '此范围内没有匹配。' : '已检查的部分没有匹配；尚不能确认整个范围。'}</p>}</div>}
  </form></details>;
}
