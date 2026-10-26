import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from '../lib/api';
import type { Project } from '../lib/types';
import { validRevision, type GitRef } from '../lib/workspace';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
type Tree = {
  worktreeId: string;
  projectId: string | null;
  originProjectId: string;
  name: string;
  path: string;
  lastConfirmedPhase: string;
  head: string;
  revision: string;
  worktreeVersion: number;
  updatedAt: number;
};
type LiveTree = {
  worktreeId: string;
  phase: 'active' | 'archived' | 'recovery';
  path: string;
  head: string;
  revision: string;
};
const phaseLabels = { active: '活动', archived: '已归档', recovery: '需要恢复' };
export function WorkspaceWorktrees({
  api,
  project,
  epoch,
  connected,
  idle,
  onChanged,
  onSelectProject,
}: {
  api: Api;
  project: Project;
  epoch: string;
  connected: boolean;
  idle: boolean;
  onChanged: () => void;
  onSelectProject: (id: string) => void;
}) {
  const [selected, setSelected] = useState(''),
    [ref, setRef] = useState('HEAD'),
    [customRef, setCustomRef] = useState(''),
    [creating, setCreating] = useState(false),
    [confirmation, setConfirmation] = useState<{
      owner: object;
      action: string;
      worktreeId?: string;
      phase?: string;
      revision?: string;
      ref?: string;
    }>(),
    [intent, setIntent] = useState<'attach' | 'archive' | 'restore' | ''>(''),
    [revision, setRevision] = useState(0);
  const owner = useMemo(() => ({}), [api, project.id, epoch, connected]);
  const changed = useCallback(() => {
    setRevision((value) => value + 1);
    setConfirmation(undefined);
    setIntent('');
    onChanged();
  }, [onChanged]);
  const action = useExtensionAction(
      api,
      connected && idle,
      changed,
      JSON.stringify([project.id, epoch, connected]),
    ),
    key = `${project.id}:${epoch}:${revision}`;
  useEffect(() => {
    if (action.operation?.state === 'not_sent') changed();
  }, [action.operation?.id, action.operation?.state]);
  const list = useResource(
    key,
    (signal) =>
      api.call<{ data: Tree[] }>('workspace/worktree/list', { projectId: project.id }, signal),
    connected,
  );
  const refs = useResource(
    key,
    (signal) =>
      api.call<{ refs: GitRef[]; truncated: boolean }>(
        'workspace/git/refs',
        { projectId: project.id },
        signal,
      ),
    connected,
  );
  const detail = useResource(
    `${key}:${selected}`,
    (signal) =>
      api.call<LiveTree>(
        'workspace/worktree/read',
        { projectId: project.id, worktreeId: selected },
        signal,
      ),
    connected && Boolean(selected),
  );
  const current =
      detail.data?.worktreeId === selected && validRevision(detail.data.revision)
        ? detail.data
        : undefined,
    cached = list.data?.data.find((tree) => tree.worktreeId === selected);
  useEffect(() => {
    setConfirmation(undefined);
    setIntent('');
  }, [selected, current?.revision, current?.phase, epoch]);
  const confirmed =
    confirmation?.owner === owner &&
    confirmation.action === intent &&
    confirmation.worktreeId === selected &&
    confirmation.phase === current?.phase &&
    confirmation.revision === current?.revision;
  const createConfirmed =
    confirmation?.owner === owner &&
    confirmation.action === 'create' &&
    confirmation.ref === (ref === 'custom' ? customRef : ref);
  const allowed = (intent: string) =>
    current &&
    (intent === 'restore'
      ? ['archived', 'recovery'].includes(current.phase)
      : current.phase === 'active');
  const perform = async () => {
    if (!current || !confirmed || !allowed(intent) || action.disabled || !intent) return;
    await action.run(
      `workspace/worktree/${intent}`,
      {
        projectId: project.id,
        worktreeId: selected,
        expectedRevision: current.revision,
        ...(intent === 'attach' ? {} : { confirm: true }),
      },
      intent === 'archive'
        ? '工作树归档已受理，全部文件仍保留，项目登记将移除。'
        : '工作树已受理，请重新读取状态；活动工作树会登记为项目。',
    );
  };
  const selectedRef = ref === 'custom' ? customRef : ref,
    validRef =
      /^(?:HEAD|[0-9a-f]{40}|[0-9a-f]{64}|refs\/(?:heads|remotes|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255})$/.test(
        selectedRef,
      ) &&
      !selectedRef.includes('..') &&
      !selectedRef.includes('//') &&
      !/(?:\/|\.|\.lock)$/.test(selectedRef);
  return (
    <section className="stack workspace-worktrees">
      <div className="section-heading">
        <h3>受管工作树</h3>
        <button className="button small" disabled={!connected || action.busy} onClick={changed}>
          重新读取工作树
        </button>
      </div>
      <p className="small muted">
        显示从当前原始项目创建的隔离工作树。列表是上次确认的记录；选择后会重新读取实际状态。归档保留全部文件和
        Git 数据，不释放磁盘空间。
      </p>
      {!idle && (
        <p className="connection-banner">
          工作树变更需要全局空闲，请先结束活动任务、终端、进程和订阅。
        </p>
      )}
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原工作树操作回执" />
      <ReadState {...list} />
      <label className="field">
        选择受管工作树
        <select
          value={selected}
          disabled={action.busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setCreating(false);
            setIntent('');
            setConfirmation(undefined);
          }}
        >
          <option value="">选择工作树</option>
          {list.data?.data.map((tree) => (
            <option key={tree.worktreeId} value={tree.worktreeId}>
              {tree.name} · 上次确认
              {phaseLabels[tree.lastConfirmedPhase as keyof typeof phaseLabels] ??
                tree.lastConfirmedPhase}
            </option>
          ))}
        </select>
      </label>
      {list.data?.data.length === 0 && (
        <p className="muted small">
          此原始项目还没有受管工作树。已有工作树请回到创建它的原始项目管理。
        </p>
      )}
      {selected && (
        <>
          <ReadState {...detail} />
          {current && (
            <article className="info-card stack">
              <strong>实时状态：{phaseLabels[current.phase]}</strong>
              <p className="small path">{current.path}</p>
              <p className="small path">HEAD：{current.head}</p>
              <p className="small path">内容版本：{current.revision}</p>
              {cached && (
                <p className="small muted">
                  上次登记版本 {cached.worktreeVersion} ·{' '}
                  {new Date(cached.updatedAt).toLocaleString()}
                </p>
              )}
              <div className="inline wrap">
                {current.phase === 'active' && (
                  <>
                    {cached?.projectId && (
                      <button
                        className="button small"
                        onClick={() => onSelectProject(cached.projectId!)}
                      >
                        打开工作树项目
                      </button>
                    )}
                    <button
                      className="button small"
                      disabled={action.disabled}
                      onClick={() => {
                        setCreating(false);
                        setIntent('attach');
                        setConfirmation(undefined);
                      }}
                    >
                      核对并登记为项目…
                    </button>
                    <button
                      className="button small"
                      disabled={action.disabled}
                      onClick={() => {
                        setCreating(false);
                        setIntent('archive');
                        setConfirmation(undefined);
                      }}
                    >
                      归档工作树…
                    </button>
                  </>
                )}
                {['archived', 'recovery'].includes(current.phase) && (
                  <button
                    className="button small"
                    disabled={action.disabled}
                    onClick={() => {
                      setCreating(false);
                      setIntent('restore');
                      setConfirmation(undefined);
                    }}
                  >
                    {current.phase === 'recovery' ? '修复并恢复工作树…' : '恢复工作树…'}
                  </button>
                )}
              </div>
              {intent && (
                <div className="workspace-warning stack">
                  <p>
                    {intent === 'archive'
                      ? '将整个工作树移到受管归档位置，保留包括未提交和忽略文件在内的全部内容，并取消该工作树项目登记。原始项目保留。'
                      : intent === 'restore'
                        ? '将工作树恢复到固定受管位置，保留当前内容，并重新登记为项目。'
                        : '按刚读取的目录身份和版本核对活动工作树，并将其登记到项目列表。'}
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) =>
                        setConfirmation(
                          e.target.checked
                            ? {
                                owner,
                                action: intent,
                                worktreeId: selected,
                                phase: current?.phase,
                                revision: current?.revision,
                              }
                            : undefined,
                        )
                      }
                    />
                    确认对上述工作树执行此操作
                  </label>
                  <button
                    className="button primary"
                    disabled={action.disabled || !confirmed || !allowed(intent) || detail.loading}
                    onClick={() => void perform()}
                  >
                    确认
                    {intent === 'archive'
                      ? '归档工作树'
                      : intent === 'restore'
                        ? '恢复工作树'
                        : '登记工作树'}
                  </button>
                </div>
              )}
            </article>
          )}
        </>
      )}
      <button
        className="button"
        disabled={action.busy}
        onClick={() => {
          setCreating((value) => !value);
          setConfirmation(undefined);
          setIntent('');
        }}
      >
        从 Git 引用创建新工作树
      </button>
      {creating && (
        <fieldset className="stack" disabled={action.busy}>
          <legend>新建隔离工作目录</legend>
          <ReadState {...refs} />
          <label className="field">
            起始 Git 引用
            <select
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                setConfirmation(undefined);
              }}
            >
              <option value="HEAD">当前 HEAD</option>
              {refs.data?.refs.map((reference) => (
                <option key={reference.name} value={reference.name}>
                  {reference.name}
                </option>
              ))}
              <option value="custom">输入完整引用或提交 ID</option>
            </select>
          </label>
          {ref === 'custom' && (
            <label className="field">
              完整 Git 引用或提交 ID
              <input
                maxLength={300}
                value={customRef}
                onChange={(e) => {
                  setCustomRef(e.target.value);
                  setConfirmation(undefined);
                }}
                placeholder="refs/heads/main 或完整提交 ID"
              />
            </label>
          )}
          {refs.data?.truncated && (
            <p className="small muted">引用目录超过显示上限，可输入准确完整引用。</p>
          )}
          <p>
            从所选提交建立独立目录，使用分离
            HEAD；原目录的未提交更改留在原处。成功后新工作树会出现在项目列表。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={createConfirmed}
              onChange={(e) =>
                setConfirmation(
                  e.target.checked ? { owner, action: 'create', ref: selectedRef } : undefined,
                )
              }
            />
            确认从所选 Git 引用创建独立工作树
          </label>
          <button
            className="button primary"
            disabled={action.disabled || !createConfirmed || !validRef}
            onClick={async () => {
              if (!createConfirmed || !validRef || action.disabled) return;
              setConfirmation(undefined);
              if (
                await action.run(
                  'workspace/worktree/create',
                  { projectId: project.id, ref: selectedRef },
                  '创建已受理，正在重新读取工作树和项目列表。',
                )
              )
                setCreating(false);
            }}
          >
            创建工作树
          </button>
        </fieldset>
      )}
    </section>
  );
}
