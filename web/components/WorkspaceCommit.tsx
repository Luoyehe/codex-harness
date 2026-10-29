import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { message, type Project } from '../lib/types';
import { commitState, type CommitState } from '../lib/git-state';
import { Diff } from './Messages';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';
type Props = {
  api: Api;
  project: Project;
  epoch: string;
  ownerEpoch?: string;
  enabled: boolean;
  visible?: boolean;
  onChanged: () => void;
};
function CommitForm({
  api,
  project,
  epoch,
  ownerEpoch = epoch,
  enabled,
  visible = true,
  onChanged,
}: Props) {
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [text, setText] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const activity = useRef({ visible, enabled, epoch, revision: 0 });
  if (
    activity.current.visible !== visible ||
    activity.current.enabled !== enabled ||
    activity.current.epoch !== epoch
  )
    activity.current = { visible, enabled, epoch, revision: activity.current.revision + 1 };
  const [preview, setPreview] = useState<{ key: string; state: CommitState; diff: string }>(),
    key = `${project.id}:${epoch}:${activity.current.revision}`,
    controller = useRef<AbortController | undefined>(undefined),
    owner = useRef(key);
  owner.current = key;
  const changed = useCallback(() => {
      setPreview(undefined);
      setConfirmed(false);
      onChanged();
    }, [onChanged]),
    action = useExtensionAction(api, enabled && visible, changed, `${project.id}:${ownerEpoch}`);
  useEffect(() => {
    setPreview(undefined);
    setConfirmed(false);
    setReading(false);
    return () => {
      controller.current?.abort();
    };
  }, [visible, enabled, epoch]);
  useEffect(() => {
    if (action.operation?.state === 'not_sent') {
      setPreview(undefined);
      setConfirmed(false);
    }
  }, [action.operation?.id, action.operation?.state]);
  const current = preview?.key === key ? preview : undefined;
  const inspect = async () => {
    if (reading || !visible || action.disabled) return;
    const expected = key,
      request = new AbortController();
    controller.current = request;
    const current = () => owner.current === expected && !request.signal.aborted;
    setReading(true);
    setError('');
    setPreview(undefined);
    setConfirmed(false);
    try {
      const state = commitState(
        await api.call('workspace/git/status', { projectId: project.id }, request.signal),
      );
      if (!current()) return;
      const diff = await api.call<{ text: string; staged: boolean; complete: boolean }>(
        'workspace/git/diff',
        { projectId: project.id, staged: true },
        request.signal,
      );
      if (!current()) return;
      const after = commitState(
        await api.call('workspace/git/status', { projectId: project.id }, request.signal),
      );
      if (!current()) return;
      if (JSON.stringify(state) !== JSON.stringify(after))
        throw new Error('读取期间 HEAD 或暂存区发生变化，请重新核对。');
      if (diff.complete !== true || diff.staged !== true || typeof diff.text !== 'string')
        throw new Error('暂存区 Diff 不完整，不能确认提交。');
      if (!diff.text) throw new Error('暂存区没有可提交的修改。');
      setPreview({ key: expected, state, diff: diff.text });
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) setReading(false);
    }
  };
  const commit = async () => {
    if (!visible || !current || !confirmed || action.disabled) return;
    setError('');
    try {
      if (
        !name.trim() ||
        /[\x00-\x1f\x7f<>]/.test(name) ||
        !/^[^\s@<>]+@[^\s@<>]+$/.test(email.trim()) ||
        !text.trim() ||
        text.includes('\0')
      )
        throw new Error('请填写有效的提交作者、邮箱和说明。');
      await action.run(
        'workspace/git/commit',
        {
          projectId: project.id,
          expectedHead: current.state.head,
          expectedHeadRevision: current.state.headRevision,
          expectedIndexRevision: current.state.indexRevision,
          author: { name: name.trim(), email: email.trim() },
          message: text,
        },
        'Git 提交已受理，请重新读取 HEAD 和工作区状态核对。',
      );
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <details className="info-card workspace-commit">
      <summary>提交已暂存的修改</summary>
      <section className="stack">
        <p>
          提交当前索引中的内容。未暂存的修改不包含在本次提交中；此处不会自动暂存、推送或切换分支。
        </p>
        <ExtensionStatus api={api} action={action} recoveryLabel="查询原 Git 提交回执" />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <fieldset className="stack" disabled={action.busy || !visible}>
          <div className="config-fields">
            <label className="field">
              提交作者
              <input
                maxLength={256}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <label className="field">
              提交作者邮箱
              <input
                type="email"
                maxLength={254}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
          </div>
          <label className="field">
            提交说明
            <textarea
              rows={4}
              maxLength={65_536}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <button
            className="button small"
            disabled={reading || action.disabled}
            onClick={() => void inspect()}
          >
            {reading ? '正在核对…' : '核对 HEAD 与已暂存修改'}
          </button>
          {current && (
            <>
              <p className="small path">
                {current.state.symbolicTarget ?? '分离 HEAD'} · {current.state.head ?? '尚无提交'}
              </p>
              <Diff text={current.diff} />
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                确认以上暂存修改、作者和说明，创建本地 Git 提交
              </label>
            </>
          )}
          <button
            className="button primary"
            disabled={
              action.disabled ||
              !current ||
              !confirmed ||
              !name.trim() ||
              !email.trim() ||
              !text.trim()
            }
            onClick={() => void commit()}
          >
            提交已暂存内容
          </button>
        </fieldset>
        <p className="small muted">
          提交使用核对时的 HEAD
          与索引版本。发生冲突后须重新读取；结果未知时只查询原回执，不会重复提交。
        </p>
      </section>
    </details>
  );
}
export function WorkspaceCommit(props: Props) {
  // Owner changes start a fresh form; a return to an earlier owner is still a new visit.
  const ownerEpoch = props.ownerEpoch ?? props.epoch;
  const owner = useRef({
    api: props.api,
    projectId: props.project.id,
    epoch: ownerEpoch,
    revision: 0,
  });
  if (
    owner.current.api !== props.api ||
    owner.current.projectId !== props.project.id ||
    owner.current.epoch !== ownerEpoch
  )
    owner.current = {
      api: props.api,
      projectId: props.project.id,
      epoch: ownerEpoch,
      revision: owner.current.revision + 1,
    };
  return <CommitForm key={owner.current.revision} {...props} />;
}
