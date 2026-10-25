import { useEffect, useRef, useState } from 'react';
import type { ServerDiagnosticsResponse } from '../../protocol/ts/v2/ServerDiagnosticsResponse';
import type { Api } from '../lib/api';
import { message, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { downloadBlob, downloadJson } from '../lib/download';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

export function DiagnosticsPanel({ api, epoch, enabled, onChanged, project, threadId = '' }: { api: Api; epoch: string; enabled: boolean; onChanged: () => void; project?: Project; threadId?: string }) {
  const action = useExtensionAction(api, enabled, onChanged), diagnostics = useResource(epoch + ':' + action.revision, signal => api.call<ServerDiagnosticsResponse>('server/diagnostics', {}, signal));
  const [category, setCategory] = useState('bug'), [reason, setReason] = useState(''), [logs, setLogs] = useState(false), [destination, setDestination] = useState('save'), [confirmed, setConfirmed] = useState(false), [compress, setCompress] = useState(false), [savedPath, setSavedPath] = useState(''), [downloadError, setDownloadError] = useState(''), [downloading, setDownloading] = useState(false);
  const identity = `${epoch}:${project?.id}:${threadId}`, current = useRef(identity), mounted = useRef(true); current.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setConfirmed(false); setSavedPath(''); setDownloadError(''); }, [identity]);
  const recovered = action.operation?.method === 'feedback/save' && action.operation.state === 'accepted' && action.operation.projectId === project?.id ? `.harness-feedback-${action.operation.id}.zip` : '';
  const localPath = savedPath || recovered;
  const change = (setter: () => void) => { setter(); setConfirmed(false); };
  return <section className="stack">
    <div className="section-heading"><h3>诊断下载与反馈</h3><button className="button small" onClick={diagnostics.refresh}>重新读取诊断</button></div>
    <p className="small muted">摘要只包含运行时进程与统计指标，经过服务端脱敏，不含会话正文、日志或完整配置。下载到你的浏览器，不会上传。</p>
    <ReadState {...diagnostics}/>
    <button className="button" disabled={!diagnostics.data} onClick={() => { try { const data = diagnostics.data!; downloadJson({ generatedAt: new Date().toISOString(), process: data.process, gauges: data.gauges }, 'codex-harness-diagnostics.json'); setDownloadError(''); } catch (e) { setDownloadError(message(e)); } }}>下载诊断摘要 JSON</button>
    <ExtensionStatus api={api} action={action} recoveryLabel="查询原维护或反馈回执"/>
    <details className="info-card"><summary>原生反馈包</summary><div className="stack">
      <p>反馈包关联当前会话，可包含会话正文、指令、文件路径，以及你勾选的日志。它由 Codex CLI 生成，Harness 不会宣称包内数据已全部脱敏。</p>
      {!project || !threadId ? <p className="workspace-warning">先打开已注册项目中的一个会话，再生成或提交原生反馈。</p> : <p className="small path">项目：{project.name} · 会话：{threadId}</p>}
      <label className="field">反馈类型<select value={category} onChange={e => change(() => setCategory(e.target.value))}><option value="bug">功能问题</option><option value="good_result">结果很好</option><option value="bad_result">结果不符合预期</option><option value="other">其他</option></select></label>
      <label className="field">反馈说明<textarea value={reason} maxLength={8000} onChange={e => change(() => setReason(e.target.value))}/></label>
      <label className="check-row"><input type="checkbox" checked={logs} onChange={e => change(() => setLogs(e.target.checked))}/>包含原生运行日志</label>
      <label className="field">反馈去向<select value={destination} onChange={e => change(() => setDestination(e.target.value))}><option value="save">仅保存 ZIP 到当前项目</option><option value="upload">提交到 Codex 原生反馈服务</option></select></label>
      <p className="small muted">{destination === 'save' ? '使用新的唯一文件名保存，不覆盖已有文件。之后可下载到本机。' : '将向外部反馈服务发送当前会话、反馈说明和所选日志，遵守当前账号与管理策略。'}</p>
      <label className="check-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>我确认上述内容与去向</label>
      <button className="button primary" disabled={action.disabled || !confirmed || !project || !threadId} onClick={async () => {
        const requestIdentity = identity;
        const result = await action.run('feedback/' + destination, { projectId: project!.id, threadId, classification: category, reason, includeLogs: logs, confirm: true }, destination === 'save' ? '反馈包保存已确认。' : '反馈上传已确认。');
        if (result && current.current === requestIdentity) { setConfirmed(false); if (result.saved === true && typeof result.path === 'string') setSavedPath(result.path); }
      }}>{destination === 'save' ? '生成本地反馈 ZIP' : '确认上传反馈'}</button>
      {localPath && <div className="stack"><p className="small path">已保存：{localPath}</p><button className="button" disabled={downloading || !project} onClick={async () => {
        const requestIdentity = identity; setDownloading(true); setDownloadError('');
        try {
          const metadata = await api.call('workspace/metadata', { projectId: project!.id, path: localPath });
          if (!mounted.current || current.current !== requestIdentity) return;
          if (typeof metadata.revision !== 'string') throw new Error('反馈文件不存在或超过 8 MiB，请从项目目录读取原文件。');
          const result = await api.call('workspace/download', { projectId: project!.id, path: localPath, expectedRevision: metadata.revision });
          if (!mounted.current || current.current !== requestIdentity) return;
          if (typeof result.base64 !== 'string' || result.base64.length > 11_184_812 || result.path !== localPath || result.revision !== metadata.revision) throw new Error('下载返回的文件身份不匹配。');
          const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)); if (bytes.length !== result.bytes) throw new Error('下载字节数不匹配。');
          downloadBlob(new Blob([bytes], { type: 'application/zip' }), localPath);
        } catch (e) { if (mounted.current && current.current === requestIdentity) setDownloadError(message(e)); }
        finally { if (mounted.current && current.current === requestIdentity) setDownloading(false); }
      }}>下载已保存的反馈 ZIP</button></div>}
    </div></details>
    <details className="info-card"><summary>原生历史存储维护</summary><div className="stack"><p>请求 Codex 对历史存储进行后台压缩。原生锁或冷却期可能跳过本次工作；受理回执不代表压缩完成，也不等于压缩当前会话上下文。</p><label className="check-row"><input type="checkbox" checked={compress} onChange={e => setCompress(e.target.checked)}/>确认触发后台存储维护</label><button className="button" disabled={action.disabled || !compress} onClick={async () => { if (await action.run('rollout/compress', { confirm: true }, '已受理维护触发；完成状态未获确认。')) setCompress(false); }}>触发存储维护</button></div></details>
    {downloadError && <p className="error" role="alert">{downloadError}</p>}
  </section>;
}
