import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import {
  activeRun,
  displayTime,
  runLabels,
  scheduleLabel,
  type Automation,
  type Run,
} from '../lib/automations';
import type { CollaborationModeMask } from '../lib/workflows';
import { message, type Model, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { useAutomationRuns } from '../hooks/useAutomationRuns';
import { AutomationForm } from './AutomationForm';
import type { ModelPagination } from './ModelDirectoryStatus';
import { Dialog } from './Dialog';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
export function AutomationsPanel({
  api,
  epoch,
  projects,
  projectId,
  models,
  modelCatalog,
  modes,
  enabled,
  idle,
  onOpenThread,
  onChanged,
  onClose,
}: {
  api: Api;
  epoch: string;
  projects: Project[];
  projectId: string;
  models: Model[];
  modelCatalog?: ModelPagination;
  modes: CollaborationModeMask[];
  enabled: boolean;
  idle: boolean;
  onOpenThread: (id: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(''),
    [editing, setEditing] = useState<{ record?: Automation }>();
  const list = useResource(`${epoch}:automations`, (signal) =>
    api.call<{ data: Automation[] }>('automation/list', {}, signal),
  );
  const health = useResource(`${epoch}:automation-health`, (signal) =>
    api.call<{ running: boolean; lastTickAt: number | null; lastError: string | null }>(
      'automation/status',
      {},
      signal,
    ),
  );
  const detail = useResource(
    `${epoch}:${selected}`,
    (signal) => api.call<Automation>('automation/read', { id: selected }, signal),
    Boolean(selected),
  );
  const [lastDetail, setLastDetail] = useState<{ epoch: string; record: Automation }>();
  useEffect(() => {
    if (detail.data) setLastDetail({ epoch, record: detail.data });
  }, [detail.data, epoch]);
  const currentDetail =
    detail.data ??
    (lastDetail?.epoch === epoch && lastDetail.record.id === selected
      ? lastDetail.record
      : undefined);
  const refresh = useCallback(() => {
    list.refresh();
    health.refresh();
    detail.refresh();
    onChanged();
  }, [list.refresh, health.refresh, detail.refresh, onChanged]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      health.refresh();
      list.refresh();
      if (selected && !editing) detail.refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [enabled, selected, Boolean(editing), health.refresh, list.refresh, detail.refresh]);
  return (
    <Dialog title="自动化" onClose={onClose} wide>
      <section className="stack automations-panel">
        <p className="small muted">
          让 Codex
          在指定时间开始一个新会话。计划保存在服务端，关闭浏览器不会暂停；暂停计划只停止未来触发。
        </p>
        {!enabled && (
          <p className="connection-banner">
            连接或任务状态尚未就绪。可以核对已保存记录，操作恢复后再修改计划。
          </p>
        )}
        <div className="inline">
          <span className="small" role="status">
            {health.data
              ? `调度器${health.data.running ? '运行中' : '未运行'} · 上次检查 ${health.data.lastTickAt ? new Date(health.data.lastTickAt).toLocaleTimeString() : '尚无记录'}`
              : '正在读取调度器状态…'}
          </span>
          <button className="button small" onClick={refresh}>
            刷新计划和状态
          </button>
          {!editing && (
            <button
              className="button primary small"
              disabled={!enabled || projects.length === 0}
              onClick={() => setEditing({})}
            >
              新建自动化
            </button>
          )}
        </div>
        {health.data?.lastError && (
          <p className="error" role="alert">
            调度器最近错误：{health.data.lastError}
          </p>
        )}
        <ReadState loading={false} error={health.error} />
        {editing ? (
          <AutomationForm
            key={editing.record?.id ?? 'new'}
            api={api}
            epoch={epoch}
            projects={projects}
            projectId={projectId}
            record={
              currentDetail &&
              editing.record &&
              currentDetail.id === editing.record.id &&
              currentDetail.revision > editing.record.revision
                ? currentDetail
                : editing.record
            }
            models={models}
            modelCatalog={modelCatalog}
            modes={modes}
            enabled={enabled}
            onChanged={refresh}
            onSaved={(id) => {
              setEditing(undefined);
              if (id) setSelected(id);
              refresh();
            }}
            onRetained={(record) => {
              setSelected(record.id);
              setEditing({ record });
            }}
            onCancel={() => setEditing(undefined)}
          />
        ) : (
          <div className="automation-columns">
            <nav className="stack automation-list" aria-label="自动化计划">
              <ReadState loading={list.loading} error={list.error} />
              {list.data?.data.map((record) => (
                <button
                  key={record.id}
                  className={`extension-card ${selected === record.id ? 'selected' : ''}`}
                  onClick={() => setSelected(record.id)}
                >
                  <strong>{record.name}</strong>
                  <span>{record.state === 'active' ? '已启用' : '已暂停'}</span>
                  <span className="small">
                    {scheduleLabel(record.schedule)} · {record.schedule.timeZone}
                  </span>
                  <span className="small muted">
                    {projects.find((project) => project.id === record.projectId)?.name ??
                      '目录尚未注册'}
                  </span>
                </button>
              ))}
              {list.data?.data.length === 0 && <p className="muted">还没有自动化计划。</p>}
            </nav>
            <div className="stack automation-detail">
              <ReadState loading={detail.loading} error={detail.error} />
              {currentDetail ? (
                <AutomationDetail
                  key={`${currentDetail.id}:${epoch}`}
                  api={api}
                  record={currentDetail}
                  epoch={epoch}
                  enabled={enabled}
                  idle={idle}
                  onEdit={() => setEditing({ record: currentDetail })}
                  onChanged={refresh}
                  onRemoved={() => {
                    setSelected('');
                    refresh();
                  }}
                  onOpenThread={onOpenThread}
                />
              ) : (
                !selected && (
                  <p className="muted">选择计划查看执行记录，或新建一个默认暂停的计划。</p>
                )
              )}
            </div>
          </div>
        )}
      </section>
    </Dialog>
  );
}
export function AutomationDetail({
  api,
  record,
  epoch,
  enabled,
  idle,
  onEdit,
  onChanged,
  onRemoved,
  onOpenThread,
}: {
  api: Api;
  record: Automation;
  epoch: string;
  enabled: boolean;
  idle: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onRemoved: () => void;
  onOpenThread: (id: string) => void;
}) {
  const runs = useAutomationRuns(api, record.id, epoch, true),
    [intent, setIntent] = useState<'resume' | 'run' | 'remove' | ''>(''),
    [preview, setPreview] = useState<{ revision: number; next: number[] }>(),
    [confirmed, setConfirmed] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const changed = useCallback(() => {
    void runs.refresh();
    onChanged();
  }, [runs.refresh, onChanged]);
  const action = useExtensionAction(api, enabled, changed);
  useEffect(() => {
    if (action.operation?.state === 'accepted' && action.operation.method === 'automation/remove')
      onRemoved();
  }, [action.operation?.id, action.operation?.state]);
  useEffect(() => {
    const timer = setInterval(() => void runs.refresh(), 5000);
    return () => clearInterval(timer);
  }, [runs.refresh]);
  useEffect(() => {
    setIntent('');
    setConfirmed(false);
    setPreview(undefined);
  }, [record.revision]);
  const command = async (name: 'pause' | 'resume' | 'run' | 'remove') => {
    const result = await action.run(
      `automation/${name}`,
      { id: record.id, expectedRevision: record.revision },
      name === 'pause'
        ? '计划已暂停；已经开始的运行会继续，请在运行记录中单独停止。'
        : name === 'run'
          ? '单次运行已加入调度队列，将新建会话。'
          : name === 'resume'
            ? '计划已启用，将自动执行。'
            : '计划已移除。',
    );
    if (result) {
      setIntent('');
      setConfirmed(false);
      if (name === 'remove') onRemoved();
    }
  };
  const inspectIntent = async (value: typeof intent) => {
    setIntent(value);
    setConfirmed(false);
    setError('');
    setPreview(undefined);
    if (value !== 'resume') return;
    setReading(true);
    try {
      const result = await api.call<{ next: number[] }>('automation/preview', {
        schedule: record.schedule,
      });
      if (!Array.isArray(result.next) || result.next.length > 5)
        throw new Error('计划预览响应无效。');
      setPreview({ revision: record.revision, next: result.next });
    } catch (e) {
      setError(message(e));
    } finally {
      setReading(false);
    }
  };
  const unresolved = runs.items.some(activeRun),
    previewReady =
      preview?.revision === record.revision && preview.next.some((at) => at > Date.now());
  return (
    <>
      <h3>{record.name}</h3>
      <p className="small">
        {record.state === 'active' ? '已启用' : '已暂停'} · 版本 {record.revision} · 下次计划时间：
        {displayTime(record.nextAt, record.schedule.timeZone)} {record.schedule.timeZone}
      </p>
      <p className="automation-instruction">{record.text}</p>
      <p className="small muted">
        {scheduleLabel(record.schedule)} · 运行时限 {record.maxRunMinutes} 分钟
      </p>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原自动化操作回执" />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="inline">
        <button className="button small" disabled={action.busy} onClick={onEdit}>
          编辑计划
        </button>
        {record.state === 'active' ? (
          <button
            className="button small"
            disabled={action.disabled}
            onClick={() => void command('pause')}
          >
            暂停未来触发
          </button>
        ) : (
          <button
            className="button small"
            disabled={action.disabled}
            onClick={() => void inspectIntent('resume')}
          >
            启用计划…
          </button>
        )}
        <button
          className="button small"
          disabled={action.disabled || unresolved || runs.loading || Boolean(runs.error)}
          onClick={() => void inspectIntent('run')}
        >
          立即运行一次…
        </button>
        <button
          className="button danger small"
          disabled={action.disabled || unresolved || runs.loading || Boolean(runs.error)}
          onClick={() => void inspectIntent('remove')}
        >
          移除计划…
        </button>
      </div>
      {intent && (
        <div className="workspace-warning stack">
          {intent === 'resume' ? (
            <>
              <strong>启用后将在服务端自动执行</strong>
              <ReadState loading={reading} error="" />
              {preview?.revision === record.revision && (
                <ol>
                  {preview.next.map((at) => (
                    <li key={at}>
                      {displayTime(at, record.schedule.timeZone)} {record.schedule.timeZone}
                    </li>
                  ))}
                </ol>
              )}
              {!reading && !previewReady && (
                <p>没有未来执行时间。请编辑计划，或选择立即运行一次。</p>
              )}
              <p>
                关闭浏览器后仍会继续调度。延误超过 5
                分钟将跳过；夏令时缺失时间跳过，重复时间只执行第一次。
              </p>
            </>
          ) : (
            <p>
              {intent === 'run'
                ? '将立即排队新建一个会话，按该计划的模型与权限执行一次；计划是否暂停不影响本次运行。'
                : '移除计划后不会再自动触发。运行历史最多保留 1,000 条，移除后此面板不再提供该计划的记录入口；已有会话仍可从会话列表查看。'}
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {intent === 'remove'
              ? '确认移除这个计划'
              : '确认执行此指令，可能使用模型额度并按权限修改文件'}
          </label>
          <div className="inline">
            <button
              className="button primary small"
              disabled={action.disabled || !confirmed || (intent === 'resume' && !previewReady)}
              onClick={() => void command(intent)}
            >
              确认
              {intent === 'resume' ? '启用计划' : intent === 'run' ? '立即运行一次' : '移除计划'}
            </button>
            <button className="button small" onClick={() => setIntent('')}>
              取消
            </button>
          </div>
        </div>
      )}
      <div className="section-heading">
        <h4>运行记录</h4>
        <button
          className="button small"
          disabled={runs.loading}
          onClick={() => void runs.refresh()}
        >
          刷新运行记录
        </button>
      </div>
      <ReadState loading={runs.loading} error={runs.error} />
      {runs.items.length === 0 && !runs.loading && <p className="muted small">还没有运行记录。</p>}
      {runs.items.map((run) => (
        <AutomationRunRow
          key={run.id}
          run={run}
          zone={record.schedule.timeZone}
          idle={idle}
          action={action}
          onOpenThread={onOpenThread}
        />
      ))}
      {runs.next !== null && (
        <button className="button small" disabled={runs.loading} onClick={() => void runs.more()}>
          更早的运行记录
        </button>
      )}
      <p className="small muted">
        服务端最多保留最近 1,000 条运行记录。结果未知时先核对会话并完成服务恢复；不会自动重放。
      </p>
    </>
  );
}
function AutomationRunRow({
  run,
  zone,
  idle,
  action,
  onOpenThread,
}: {
  run: Run;
  zone: string;
  idle: boolean;
  action: ReturnType<typeof useExtensionAction>;
  onOpenThread: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <article className="info-card stack automation-run">
      <div className="section-heading">
        <strong>{runLabels[run.state] ?? run.state}</strong>
        <span className="small">
          {displayTime(run.scheduledAt, zone)} · {run.manual ? '手动触发' : '按计划'}
        </span>
      </div>
      <span className="small muted">
        计划版本 {run.revision} · 运行 ID {run.id}
      </span>
      {run.code && <p className="small">状态原因：{run.code}</p>}
      <div className="inline">
        {run.threadId && (
          <button className="button small" onClick={() => onOpenThread(run.threadId!)}>
            {run.state === 'needs_attention' ? '打开会话处理审批' : '查看运行会话'}
          </button>
        )}
        {['queued', 'dispatching', 'running', 'needs_attention', 'stopping'].includes(
          run.state,
        ) && (
          <button
            className="button small"
            disabled={action.disabled || run.stopRequested || run.state === 'stopping'}
            onClick={() =>
              void action.run(
                'automation/stop',
                { runId: run.id },
                '停止请求已受理，请等待运行状态确认。',
              )
            }
          >
            {run.stopRequested || run.state === 'stopping'
              ? '正在等待停止确认'
              : run.state === 'queued'
                ? '取消本次排队'
                : '停止本次运行'}
          </button>
        )}
      </div>
      {run.state === 'unknown' && (
        <div className="workspace-warning">
          <p>
            没有确定的执行结果。请先核对会话和文件、恢复服务，再关闭此未知记录。关闭只允许后续运行，不表示本次成功，也不会重放指令。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            已核对结果，确认关闭未知记录
          </label>
          <button
            className="button small"
            disabled={action.disabled || !idle || !confirm}
            onClick={() =>
              void action.run(
                'automation/acknowledge',
                { runId: run.id, confirm: true },
                '未知记录已关闭；没有将本次运行标记为成功。',
              )
            }
          >
            关闭未知运行记录
          </button>
          {!idle && <p className="small">需先完成服务恢复并确认没有活动执行、终端或订阅。</p>}
        </div>
      )}
    </article>
  );
}
