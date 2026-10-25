import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import { object } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

const unchanged = () => {};
type Report = { resultId: string; kind: string; status: string; exitCode?: number; data?: Record<string, unknown>; stderr?: string; error?: string; reason?: string };
const failures: Record<string, string> = { timed_out: '诊断达到 20 秒时限，已停止并确认进程清理。可检查服务器网络与配置后，再手动运行。', output_truncated: '诊断输出超过保留限制，无法展示完整报告；进程清理已确认。', invalid_report: '命令已结束，但未返回当前版本支持的完整报告。' };
function DiagnosticsSession({ api, enabled, connected }: { api: Api; enabled: boolean; connected: boolean }) {
  const action = useExtensionAction(api, enabled && connected, unchanged), [resultId, setResultId] = useState('');
  const report = useResource(`${connected}:${resultId}`, signal => api.call<Report>('diagnostics/cli/result/read', { resultId }, signal), connected && Boolean(resultId));
  const accepted = action.operation?.state === 'accepted' && action.operation.method === 'diagnostics/cli/run' ? action.operation.id : '';
  useEffect(() => {
    if (!accepted || !connected) return;
    const controller = new AbortController();
    void api.call('operation/read', { operationId: accepted }, controller.signal).then(receipt => {
      if (controller.signal.aborted || receipt.operationId !== accepted || receipt.method !== 'diagnostics/cli/run' || receipt.state !== 'accepted') return;
      const result = object(receipt.result); if (typeof result.resultId === 'string') setResultId(result.resultId);
    }, () => {}); return () => controller.abort();
  }, [accepted, connected, api]);
  useEffect(() => { if (!connected) setResultId(''); }, [connected]);
  const data = report.data, serialized = data?.data ? JSON.stringify(data.data, null, 2) : '', overall = data?.data?.overallStatus;
  const run = async (kind: 'doctor' | 'models-bundled') => { setResultId(''); const result = await action.run('diagnostics/cli/run', { kind }, '诊断命令已结束，请核对报告中的检查结果。'); if (typeof result?.resultId === 'string') setResultId(result.resultId); };
  return <section className="stack info-card"><h3>原生 CLI 诊断</h3><p className="muted">使用当前安装的 Codex 检查环境或读取内置模型目录。不会启动模型推理；每次最多 20 秒。请先结束任务与终端。报告只对当前连接保留 10 分钟，断线后需重新检查。</p>
    <div className="button-row"><button className="button" disabled={action.disabled} onClick={() => void run('doctor')}>检查 Codex 环境</button><button className="button" disabled={action.disabled} onClick={() => void run('models-bundled')}>读取内置模型目录</button></div>
    <p className="small muted">内置目录用于排查版本能力；它不代表当前账户可用的模型，也不会刷新远端目录。</p><ExtensionStatus api={api} action={action} recoveryLabel="查询原诊断操作回执"/><ReadState {...report}/>
    {connected && data && <div className="stack"><p role="status">{data.status === 'completed' ? overall === 'fail' ? '诊断已完成，环境检查发现问题。' : (overall === 'warn' || overall === 'warning') ? '诊断已完成，环境检查有提醒。' : '诊断已完成。' : '命令未返回完整的受支持报告。'}{data.exitCode !== undefined ? ` 退出码：${data.exitCode}` : ''}</p>{(data.reason || data.error) && <p className="error">{failures[data.reason ?? ''] ?? data.error ?? '诊断失败，请检查服务日志。'}</p>}{serialized && <><pre className="raw log-output">{serialized.slice(0, 65536)}</pre>{serialized.length > 65536 && <p>页面只显示前 64 KiB，可下载完整报告。</p>}<button className="button" onClick={() => { const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = `codex-${data.kind}-report.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载诊断报告</button></>}{data.stderr && <details><summary>命令诊断输出</summary><pre className="raw">{data.stderr}</pre></details>}</div>}
  </section>;
}
export function CliDiagnosticsPanel(props: { api: Api; epoch: string; connectionId: string; enabled: boolean; connected: boolean }) { return <DiagnosticsSession key={`${props.epoch}:${props.connectionId}`} {...props}/>; }
