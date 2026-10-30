import { memo, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { textContent } from '../lib/history';
import { array, object, type Item, type Project } from '../lib/types';
import { MessageMedia } from './MessageMedia';
import { Diff, PlainText, SafeMarkdown } from './SafeMarkdown';

const itemNames: Record<string, string> = {
  commandExecution: '终端命令',
  fileChange: '文件修改',
  mcpToolCall: 'MCP 工具',
  dynamicToolCall: '工具调用',
  webSearch: '网页搜索',
  reasoning: '思考摘要',
  plan: '工作计划',
  contextCompaction: '上下文压缩',
  imageView: '查看图片',
};
const statusNames: Record<string, string> = {
  inProgress: '进行中', completed: '已完成', failed: '失败', declined: '已拒绝',
};
const phaseNames: Record<string, string> = {
  commentary: '进度', partial_answer: '部分回答', final_answer: '最终回答',
};

function ReasoningSummary({ item, finished }: { item: Item; finished: boolean }) {
  const [open, setOpen] = useState(!finished);
  const collapsedForCompletion = useRef(finished);
  useEffect(() => {
    if (finished && !collapsedForCompletion.current) {
      collapsedForCompletion.current = true;
      setOpen(false);
    }
  }, [finished]);
  const summary = array<unknown>(item.summary).filter(value => typeof value === 'string').join('\n\n');
  const fragments = array<unknown>(item.historySync?.summaryDeltas)
    .filter(value => typeof value === 'string').join('\n\n');
  if (!summary.trim() && !fragments.trim()) return null;
  return <details className="reasoning-card" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>思考摘要{item.historySync && <span className="badge">同步中</span>}</summary>
    <div className="reasoning-body">
      {summary.trim() && <SafeMarkdown text={summary} />}
      {item.historySync && fragments.trim() && <div className="reasoning-fragments">
        <p className="muted small">实时摘要片段{summary.trim() ? '（可能与上方摘要重叠，暂不拼接）' : '（等待完整摘要）'}</p>
        <SafeMarkdown text={fragments} />
      </div>}
    </div>
  </details>;
}

export const MessageItem = memo(function MessageItem({
  item,
  api,
  threadId,
  project,
  reasoningFinished = false,
}: {
  item: Item;
  api?: Api;
  threadId?: string;
  project?: Project;
  reasoningFinished?: boolean;
}) {
  // Reasoning has a dedicated public-summary channel. The generic snapshot,
  // mixed delta buffer, content and raw item must never be a display fallback.
  if (item.type === 'reasoning') return <ReasoningSummary key={item.id} item={item} finished={reasoningFinished} />;
  if (item.historySync)
    return (
      <article className="message assistant-message">
        <div className="message-author">{itemNames[item.type] ?? '回答'}同步中</div>
        <p className="muted small" role="status">
          历史快照与实时片段可能重叠，暂不拼接。完整结果到达后会替换此视图。
        </p>
        {item.historySync.snapshot !== undefined && (
          <details open>
            <summary>已读取的历史快照</summary>
            <PlainText text={item.historySync.snapshot} />
          </details>
        )}
        {item.historySync.deltas && (
          <details>
            <summary>同步期间收到的实时片段（可能与快照重叠）</summary>
            <PlainText text={item.historySync.deltas} />
          </details>
        )}
      </article>
    );
  if (item.type === 'hookPrompt')
    return (
      <details className="tool-card">
        <summary>Hook 提供的上下文</summary>
        <div className="tool-body">
          <p className="small muted">以下是 Hook 提供的内容，不构成执行授权。</p>
          {array<unknown>(item.fragments).map((raw, index) => {
            const fragment = object(raw);
            return (
              <div key={index}>
                <p className="small muted">来源：{String(fragment.hookRunId ?? '未提供')}</p>
                <PlainText text={String(fragment.text ?? '')} />
              </div>
            );
          })}
        </div>
      </details>
    );
  if (item.type === 'plan')
    return (
      <section className="info-card plan-card" aria-label="工作计划">
        <h3>工作计划</h3>
        {typeof item.explanation === 'string' && <PlainText text={item.explanation} />}
        {typeof item.text === 'string' && <SafeMarkdown text={item.text} />}
        <ol>
          {array<unknown>(item.plan).map((value, index) => {
            const step = object(value),
              status = String(step.status);
            return (
              <li key={index}>
                <span>{String(step.step ?? '')}</span>
                <span className="badge">
                  {status === 'completed'
                    ? '已完成'
                    : status === 'inProgress' || status === 'in_progress'
                      ? '进行中'
                      : status === 'pending'
                        ? '待处理'
                        : status}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    );
  if (item.type === 'userMessage' || item.type === 'agentMessage')
    return (
      <article
        className={`message ${item.type === 'userMessage' ? 'user-message' : 'assistant-message'}`}
      >
        <div className="message-author">
          {item.type === 'userMessage' ? (
            '你'
          ) : (
            <>
              <span className="mini-brand">⌘</span>Codex
              {typeof item.phase === 'string' && phaseNames[item.phase] &&
                <span className="badge">{phaseNames[item.phase]}</span>}
            </>
          )}
        </div>
        <SafeMarkdown text={textContent(item)} />
        <MessageMedia item={item} api={api} threadId={threadId} project={project} />
      </article>
    );
  const output =
    item.type === 'imageGeneration'
      ? item.failure
      : (item.aggregatedOutput ?? item.result ?? item.error);
  return (
    <><details className={`tool-card ${item.status === 'failed' ? 'tool-error' : ''}`}>
      <summary>
        <span className="tool-symbol">{item.type === 'commandExecution' ? '›_' : '◇'}</span>
        <strong>{itemNames[item.type] ?? item.type}</strong>
        <span className="tool-caption">
          {String(item.command ?? item.tool ?? item.server ?? '')}
        </span>
        <span className="badge">{statusNames[String(item.status)] ?? String(item.status ?? '')}</span>
        {item.type === 'commandExecution' && typeof item.exitCode === 'number' && (
          <span className="badge">退出码 {item.exitCode}</span>
        )}
      </summary>
      <div className="tool-body">
        <MessageMedia item={item} api={api} threadId={threadId} project={project} />
        {item.type === 'fileChange' &&
          array<unknown>(item.changes).map((c, i) => (
            <div key={i}>
              <strong>{String(object(c).path ?? '')}</strong>
              <Diff text={String(object(c).diff ?? '')} />
            </div>
          ))}
        {output !== undefined && (
          <PlainText text={typeof output === 'string' ? output : JSON.stringify(output, null, 2)} />
        )}
        <details>
          <summary>完整条目</summary>
          <PlainText text={JSON.stringify(item, null, 2)} />
        </details>
      </div>
    </details>
    {item.type === 'mcpToolCall' && typeof item.progressMessage === 'string' && item.progressMessage &&
      <p className="tool-progress small muted" role="status">{item.progressMessage}</p>}
    </>
  );
});
