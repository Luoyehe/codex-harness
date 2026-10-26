import { useState } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { array, type Project } from '../lib/types';
import { gitStatusLabel, type GitEntry, type GitRef } from '../lib/workspace';
import { Diff } from './Messages';
import { WorkspaceIndex } from './WorkspaceIndex';
import { WorkspaceIndexRecovery } from './WorkspaceIndexRecovery';
import { WorkspaceCommit } from './WorkspaceCommit';
export function WorkspaceGit({
  api,
  project,
  epoch,
  connected,
  onFile,
  onReviewBase,
  enabled = false,
}: {
  enabled?: boolean;
  api: Api;
  project: Project;
  epoch: string;
  connected: boolean;
  onFile: (path: string) => void;
  onReviewBase: (ref: string) => void;
}) {
  const [staged, setStaged] = useState(false),
    [selectedRef, setSelectedRef] = useState('');
  const key = `${project.id}:${epoch}`;
  const status = useResource(
    key,
    (signal) => api.call('workspace/git/status', { projectId: project.id }, signal),
    connected,
  );
  const diff = useResource(
    `${key}:${staged}`,
    (signal) => api.call('workspace/git/diff', { projectId: project.id, staged }, signal),
    connected,
  );
  const refs = useResource(
    key,
    (signal) => api.call('workspace/git/refs', { projectId: project.id }, signal),
    connected,
  );
  const references = array<GitRef>(refs.data?.refs),
    entries = array<GitEntry>(status.data?.entries);
  const selected = references.find((ref) => ref.name === selectedRef);
  return (
    <section className="workspace-git stack">
      <div className="section-heading">
        <h3>Git 工作区</h3>
        <button
          className="button small"
          disabled={!connected || status.loading || diff.loading || refs.loading}
          onClick={() => {
            status.refresh();
            diff.refresh();
            refs.refresh();
          }}
        >
          刷新 Git
        </button>
      </div>
      {!connected && <p className="connection-banner">连接恢复后可重新读取 Git 状态。</p>}
      {status.error && (
        <p className="error" role="alert">
          {status.error}
        </p>
      )}
      {status.loading && <p role="status">读取 Git 状态…</p>}
      {status.data && status.data.complete !== true && (
        <p className="error" role="alert">
          Git 状态不完整，未作为完整结果展示。
        </p>
      )}
      {status.data?.complete === true && (
        <>
          <WorkspaceIndex
            api={api}
            project={project}
            epoch={epoch}
            entries={entries}
            enabled={enabled}
            onFile={onFile}
            onChanged={() => {
              status.refresh();
              diff.refresh();
              refs.refresh();
            }}
          />
        </>
      )}
      <div className="section-heading">
        <h3>修改 Diff</h3>
        <label className="field">
          <span className="sr-only">Diff 范围</span>
          <select
            value={staged ? 'staged' : 'worktree'}
            onChange={(e) => setStaged(e.target.value === 'staged')}
          >
            <option value="worktree">工作区尚未暂存</option>
            <option value="staged">已暂存的修改</option>
          </select>
        </label>
      </div>
      {diff.loading && <p role="status">读取 Diff…</p>}
      {diff.error && (
        <p className="error" role="alert">
          {diff.error}
        </p>
      )}
      {diff.data &&
        (diff.data.complete === true && typeof diff.data.text === 'string' ? (
          diff.data.text ? (
            <Diff text={diff.data.text} />
          ) : (
            <p className="muted">所选范围没有文本 Diff。</p>
          )
        ) : (
          <p className="error" role="alert">
            Diff 结果不完整，未显示为完整修改。
          </p>
        ))}
      <h3>分支与引用</h3>
      {refs.error && (
        <p className="error" role="alert">
          {refs.error}
        </p>
      )}
      {refs.loading && <p role="status">读取引用…</p>}
      <label className="field">
        选择引用
        <select
          value={selectedRef}
          onChange={(e) => setSelectedRef(e.target.value)}
          disabled={refs.loading || !references.length}
        >
          <option value="">选择本地分支、远程分支或标签</option>
          {references.map((ref) => (
            <option key={ref.name} value={ref.name}>
              {ref.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="info-card">
          <strong className="path">{selected.name}</strong>
          <code className="path">{selected.objectId}</code>
          {selected.symbolicTarget && <p className="small muted">指向 {selected.symbolicTarget}</p>}
          <button
            className="button"
            disabled={!connected}
            onClick={() => onReviewBase(selected.name)}
          >
            以此为基准发起审查
          </button>
        </div>
      )}
      {refs.data?.truncated === true && (
        <p className="workspace-warning">引用列表达到 1,000 项上限，仅显示当前返回的条目。</p>
      )}
      <WorkspaceIndexRecovery
        api={api}
        project={project}
        epoch={epoch}
        connected={connected}
        enabled={enabled}
        onChanged={() => {
          status.refresh();
          diff.refresh();
          refs.refresh();
        }}
      />
      <WorkspaceCommit
        api={api}
        project={project}
        epoch={epoch}
        enabled={enabled}
        onChanged={() => {
          status.refresh();
          diff.refresh();
          refs.refresh();
        }}
      />
      <p className="small muted">
        状态、Diff 和引用查询不会切换分支。Git 提交需要单独核对暂存区并明确确认。
      </p>
    </section>
  );
}
