import { Dialog } from './Dialog';

export function HistoryConversionDialog({ source, target, action, mayContinue, current, onCancel, onConfirm }: {
  source: string; target: string; action: 'select' | 'send' | 'load'; current: boolean;
  mayContinue?: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  return <Dialog title="确认供应商历史转换" onClose={onCancel}>
    <div className="stack">
      <p>{source === target ? `此会话需要修复 ${source} 的专用历史记录。` : `将此会话从 ${source} 切换到 ${target}。`}</p>
      <p>转换会处理供应商专用的推理历史，保留原始记录备份、正文和工具记录。不同供应商仍可能不兼容，转换或后续请求也可能失败。</p>
      <p>{action === 'select' ? '确认后采用所选模型。历史转换将在下次发送时执行；尚未加载的会话会在加载时执行，本次选择不会发送消息。' :
        action === 'send' ? '确认后转换历史并发送当前消息。' : mayContinue
          ? '确认后转换历史并按你的恢复操作加载此会话；不提交新消息，但已有待执行任务可能继续。'
          : '确认后转换历史并加载此会话，不发送消息；若有待继续的任务，仍须另外确认恢复。'}</p>
      {!current && <p role="status">会话、模型选择或操作状态已变化，请取消后重新操作。</p>}
      <div className="inline wrap">
        <button className="button" onClick={onCancel}>取消</button>
        <button className="button primary" disabled={!current} onClick={onConfirm}>
          {action === 'select' ? '确认选择' : action === 'send' ? '转换并发送当前消息' : '转换并加载会话'}
        </button>
      </div>
    </div>
  </Dialog>;
}
