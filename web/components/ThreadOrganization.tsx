import { useEffect, useRef, useState } from 'react';
import type { ThreadReadResponse } from '../../protocol/ts/v2/ThreadReadResponse';
import type { Api } from '../lib/api';
import type { Project, Thread } from '../lib/types';
import { safeUrl } from '../lib/types';
import {
  sameRoot,
  type NativeProject,
  type ThreadAttachment,
  type ThreadSection,
} from '../lib/organization';
import { workspacePath } from '../lib/workspace';
import { usePaged } from '../hooks/usePaged';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
export function SectionSettings({
  api,
  epoch,
  enabled,
  visible = true,
  onChanged,
}: {
  api: Api;
  epoch: string;
  enabled: boolean;
  visible?: boolean;
  onChanged: () => void;
}) {
  const action = useExtensionAction(api, enabled && visible, onChanged),
    sections = usePaged<ThreadSection>(
      api,
      'threadSection/list',
      {},
      `${epoch}:${action.revision}`,
      visible,
    ),
    [edit, setEdit] = useState<{ id?: string; name: string; icon: string; color: string }>(),
    [remove, setRemove] = useState<ThreadSection>();
  useEffect(() => {
    if (!visible) setRemove(undefined);
  }, [visible]);
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>会话分区</h3>
        <button
          className="button small"
          disabled={action.disabled}
          onClick={() => setEdit({ name: '', icon: '', color: '' })}
        >
          新增分区
        </button>
      </div>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原分区操作回执" />
      <ReadState {...sections} />
      {sections.items.map((section) => (
        <article className="info-card stack" key={section.id}>
          <strong>
            {section.appearance?.icon} {section.name}
          </strong>
          {section.appearance?.color && <small>颜色标识：{section.appearance.color}</small>}
          <div className="inline wrap">
            <button
              className="button small"
              disabled={action.disabled}
              onClick={() =>
                setEdit({
                  id: section.id,
                  name: section.name,
                  icon: section.appearance?.icon ?? '',
                  color: section.appearance?.color ?? '',
                })
              }
            >
              编辑 {section.name}
            </button>
            <button
              className="button danger small"
              disabled={action.disabled}
              onClick={() => setRemove(section)}
            >
              删除分区
            </button>
          </div>
        </article>
      ))}
      {sections.hasMore && (
        <button className="button" disabled={sections.loading} onClick={() => void sections.more()}>
          更多分区
        </button>
      )}
      {edit && (
        <form
          className="info-card stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await action.run(
              edit.id ? 'threadSection/update' : 'threadSection/create',
              {
                ...(edit.id ? { sectionId: edit.id } : {}),
                name: edit.name,
                appearance: { icon: edit.icon || null, color: edit.color || null },
              },
            );
            if (result) setEdit(undefined);
          }}
        >
          <fieldset disabled={action.busy} className="stack">
            <label className="field">
              分区名称
              <input
                value={edit.name}
                required
                maxLength={256}
                onChange={(event) => setEdit({ ...edit, name: event.target.value })}
              />
            </label>
            <label className="field">
              图标标识或 Emoji（可选）
              <input
                value={edit.icon}
                maxLength={128}
                onChange={(event) => setEdit({ ...edit, icon: event.target.value })}
              />
            </label>
            <label className="field">
              颜色标识（可选）
              <input
                value={edit.color}
                maxLength={128}
                placeholder="例如 green 或 #668866"
                onChange={(event) => setEdit({ ...edit, color: event.target.value })}
              />
            </label>
            <div className="inline">
              <button className="button primary" disabled={action.disabled}>
                保存分区
              </button>
              <button className="button" type="button" onClick={() => setEdit(undefined)}>
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {remove && (
        <div className="workspace-warning stack">
          <p>删除“{remove.name}”分区并解除其中会话的分区归属；保留会话历史和工作目录。</p>
          <div className="inline">
            <button
              className="button danger"
              disabled={action.disabled}
              onClick={async () => {
                if (await action.run('threadSection/delete', { sectionId: remove.id }))
                  setRemove(undefined);
              }}
            >
              确认删除分区组织
            </button>
            <button className="button" onClick={() => setRemove(undefined)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
export function ThreadOrganization({
  api,
  epoch,
  threadId,
  project,
  enabled,
  ready,
  idle,
  visible = true,
  onChanged,
  onDeleted,
  onOpenThread,
}: {
  api: Api;
  epoch: string;
  threadId: string;
  project?: Project;
  enabled: boolean;
  ready: boolean;
  idle: boolean;
  visible?: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onOpenThread: (id: string) => void;
}) {
  const action = useExtensionAction(api, enabled && visible, onChanged),
    key = `${epoch}:${threadId}:${action.revision}`;
  const thread = useResource(
    key,
    (signal) => api.call<ThreadReadResponse>('thread/read', { threadId }, signal),
    visible && Boolean(threadId),
  );
  const projects = usePaged<NativeProject>(
    api, 'nativeProject/list', {}, key, visible && Boolean(threadId),
  ),
    sections = usePaged<ThreadSection>(
      api, 'threadSection/list', {}, key, visible && Boolean(threadId),
    );
  const related = usePaged<Thread>(
    api,
    'thread/list',
    { projectId: project?.id, archived: false, sortKey: 'section_position', sortDirection: 'asc' },
    key,
    visible && Boolean(project && threadId),
  );
  const [projectEdit, setProjectEdit] = useState<string>(),
    [sectionEdit, setSectionEdit] = useState<{ sectionId: string; beforeThreadId: string }>(),
    [deleteConsent, setDeleteConsent] = useState(false),
    [memoryNotice, setMemoryNotice] = useState('');
  useEffect(() => {
    if (!visible) setDeleteConsent(false);
  }, [visible]);
  const nativeProjectId = projectEdit ?? thread.data?.thread.projectId ?? '',
    sectionId = sectionEdit?.sectionId ?? thread.data?.thread.section?.id ?? '',
    beforeThreadId = sectionEdit?.beforeThreadId ?? '';
  const deleted = useRef(false);
  useEffect(() => {
    if (
      !deleted.current &&
      action.operation?.method === 'thread/delete' &&
      action.operation.state === 'accepted'
    ) {
      deleted.current = true;
      onDeleted();
    }
  }, [action.operation?.id, action.operation?.state, onDeleted]);
  const readState = thread.data?.readState,
    availableProjects = projects.items.filter((row) =>
      row.roots.some((root) => sameRoot(root.path, thread.data?.thread.cwd ?? project?.cwd ?? '')),
    ),
    sameSection = related.items.filter(
      (row) => row.id !== threadId && (row.section?.id ?? '') === sectionId,
    );
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>当前会话组织</h3>
        <button className="button small" onClick={action.refresh}>
          重新读取会话组织
        </button>
      </div>
      {!threadId ? (
        <p className="muted">选择一个已有会话。新会话发送首条消息后才能保存组织关联。</p>
      ) : (
        <>
          <ReadState {...thread} />
          <ExtensionStatus api={api} action={action} recoveryLabel="查询原会话组织操作回执" />
          {thread.data && (
            <>
              <h4>{thread.data.thread.name || thread.data.thread.preview || threadId}</h4>
              <p className="small path">工作目录：{thread.data.thread.cwd}</p>
              <label className="field">
                所属原生会话项目
                <select
                  value={nativeProjectId}
                  disabled={action.busy}
                  onChange={(event) => {
                    setProjectEdit(event.target.value);
                  }}
                >
                  <option value="">不归属原生项目</option>
                  {nativeProjectId &&
                    !availableProjects.some((row) => row.id === nativeProjectId) && (
                      <option value={nativeProjectId} disabled>
                        当前归属（目录未加载或范围不匹配）
                      </option>
                    )}
                  {availableProjects.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <ReadState {...projects} />
              {projects.hasMore && (
                <button
                  className="button small"
                  disabled={projects.loading}
                  onClick={() => void projects.more()}
                >
                  更多会话项目
                </button>
              )}
              <button
                className="button"
                disabled={action.disabled || projects.loading || Boolean(projects.error)}
                onClick={async () => {
                  if (
                    await action.run('thread/project/set', {
                      threadId,
                      nativeProjectId: nativeProjectId || null,
                    })
                  )
                    setProjectEdit(undefined);
                }}
              >
                保存项目归属
              </button>
              <p className="small muted">只列出包含此工作目录的原生项目；保存归属不会切换目录。</p>
              <ReadState {...sections} />
              <label className="field">
                所属分区
                <select
                  value={sectionId}
                  disabled={action.busy}
                  onChange={(event) => {
                    setSectionEdit({ sectionId: event.target.value, beforeThreadId: '' });
                  }}
                >
                  <option value="">无分区</option>
                  {sectionId && !sections.items.some((row) => row.id === sectionId) && (
                    <option value={sectionId}>当前分区（尚未加载）</option>
                  )}
                  {sections.items.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              {sections.hasMore && (
                <button
                  className="button small"
                  disabled={sections.loading}
                  onClick={() => void sections.more()}
                >
                  更多分区
                </button>
              )}
              <label className="field">
                分区内顺序
                <select
                  value={beforeThreadId}
                  disabled={action.busy}
                  onChange={(event) => {
                    setSectionEdit({ sectionId, beforeThreadId: event.target.value });
                  }}
                >
                  <option value="">移到所选分区末尾</option>
                  {sameSection.map((row) => (
                    <option key={row.id} value={row.id}>
                      放在 {row.name || row.preview || row.id} 之前
                    </option>
                  ))}
                </select>
              </label>
              <ReadState {...related} />
              {related.hasMore && (
                <button
                  className="button small"
                  disabled={related.loading}
                  onClick={() => void related.more()}
                >
                  加载更多可排序会话
                </button>
              )}
              <button
                className="button"
                disabled={action.disabled || sections.loading || Boolean(sections.error)}
                onClick={async () => {
                  if (
                    await action.run('thread/section/move', {
                      threadId,
                      sectionId: sectionId || null,
                      beforeThreadId: beforeThreadId || null,
                    })
                  )
                    setSectionEdit(undefined);
                }}
              >
                保存分区与顺序
              </button>
              <h4>已读状态</h4>
              <p>
                {readState
                  ? readState.firstUnread === null
                    ? '当前没有未读位置。'
                    : '此会话有未读位置。'
                  : '当前会话没有可用的持久已读状态。'}
              </p>
              <div className="inline wrap">
                <button
                  className="button small"
                  disabled={action.disabled || !readState}
                  onClick={() =>
                    void action.run('thread/readState/update', {
                      threadId,
                      operation: { type: 'read' },
                      expectedRevision: readState!.revision,
                    })
                  }
                >
                  标记已读
                </button>
                <button
                  className="button small"
                  disabled={action.disabled || !readState}
                  onClick={() =>
                    void action.run('thread/readState/update', {
                      threadId,
                      operation: { type: 'unread' },
                      expectedRevision: readState!.revision,
                    })
                  }
                >
                  标记未读
                </button>
              </div>
              <h4>会话记忆</h4>
              <p className="small muted">
                这里只设置此会话是否参与记忆。运行时没有返回当前模式；重新打开时不会猜测其状态。
              </p>
              {memoryNotice && <p role="status">{memoryNotice}</p>}
              <div className="inline wrap">
                {(['enabled', 'disabled'] as const).map((mode) => (
                  <button
                    className="button small"
                    key={mode}
                    disabled={action.disabled || !ready || !idle}
                    onClick={async () => {
                      if (await action.run('thread/memoryMode/set', { threadId, mode }))
                        setMemoryNotice(
                          mode === 'enabled'
                            ? '本次启用会话记忆的请求已受理。'
                            : '本次停用会话记忆的请求已受理。',
                        );
                    }}
                  >
                    {mode === 'enabled' ? '启用此会话记忆' : '停用此会话记忆'}
                  </button>
                ))}
              </div>
              <h4>订阅与历史管理</h4>
              <p className="small muted">
                停止订阅保留历史，不表示原生进程已经卸载。以后继续时可能需要明确加载会话。
              </p>
              <button
                className="button"
                disabled={action.disabled || !idle}
                onClick={() =>
                  void action.run(
                    'thread/unsubscribe',
                    { threadId },
                    '停止订阅请求已受理；保留会话历史。',
                  )
                }
              >
                停止订阅此会话
              </button>
              <details className="info-card">
                <summary>永久删除此会话历史</summary>
                <div className="stack">
                  <p>
                    永久删除此会话的历史记录。此操作不会恢复工作目录文件，也不等于撤销执行过的修改。
                  </p>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={deleteConsent}
                      onChange={(event) => setDeleteConsent(event.target.checked)}
                    />
                    确认永久删除当前会话“{thread.data.thread.name || threadId}”的历史
                  </label>
                  <button
                    className="button danger"
                    disabled={action.disabled || !ready || !idle || !deleteConsent}
                    onClick={async () => {
                      if (await action.run('thread/delete', { threadId })) onDeleted();
                    }}
                  >
                    永久删除会话历史
                  </button>
                </div>
              </details>
            </>
          )}
          <div hidden={!thread.data} inert={!thread.data}>
            <ThreadLinks
              key={threadId}
              api={api}
              epoch={key}
              threadId={threadId}
              project={project}
              enabled={enabled}
              visible={visible && Boolean(thread.data)}
              onChanged={onChanged}
              onOpenThread={onOpenThread}
            />
          </div>
        </>
      )}
    </section>
  );
}
function ThreadLinks({
  api,
  epoch,
  threadId,
  project,
  enabled,
  visible,
  onChanged,
  onOpenThread,
}: {
  api: Api;
  epoch: string;
  threadId: string;
  project?: Project;
  enabled: boolean;
  visible: boolean;
  onChanged: () => void;
  onOpenThread: (id: string) => void;
}) {
  const action = useExtensionAction(api, enabled && visible, onChanged),
    [kind, setKind] = useState('link'),
    [value, setValue] = useState(''),
    [label, setLabel] = useState(''),
    [error, setError] = useState(''),
    [remove, setRemove] = useState<ThreadAttachment>(),
    [owner, setOwner] = useState<ThreadAttachment>();
  const key = `${epoch}:${action.revision}`,
    attachments = usePaged<ThreadAttachment>(
      api, 'thread/attachment/list', { threadId }, key, visible,
    );
  const owners = usePaged<{ threadId: string; archived: boolean }>(
    api,
    'thread/attachmentOwner/list',
    {
      projectId: project?.id,
      attachmentType: owner?.attachmentType,
      identityKey: owner?.identityKey,
    },
    `${key}:${owner?.id}`,
    visible && Boolean(owner && project),
  );
  useEffect(() => {
    if (!visible) setRemove(undefined);
  }, [visible]);
  const add = async () => {
    setError('');
    try {
      let identityKey: string, payload: Record<string, unknown>;
      if (kind === 'workspace_file') {
        if (!project) throw new Error('请选择工作台项目。');
        const path = workspacePath(value);
        identityKey = `${project.id}:${path}`;
        payload = { projectId: project.id, path, label };
      } else {
        const url = safeUrl(value);
        if (!url) throw new Error('请输入完整的 HTTP(S) 链接。');
        identityKey = url;
        payload = { url, label };
      }
      if (
        await action.run('thread/attachment/add', {
          threadId,
          attachmentType: kind,
          identityKey,
          payload,
        })
      ) {
        setValue('');
        setLabel('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '关联无效。');
    }
  };
  return (
    <section className="stack">
      <h3>会话关联</h3>
      <p className="small muted">
        关联保存链接或项目文件的描述，不上传文件、创建工作树或修改外部服务。
      </p>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原关联操作回执" />
      <ReadState {...attachments} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {attachments.items.map((item) => (
        <article className="info-card stack" key={item.id}>
          <strong>{item.attachmentType}</strong>
          <code className="path">{item.identityKey}</code>
          <details>
            <summary>关联描述</summary>
            <pre className="raw">{JSON.stringify(item.payload, null, 2)}</pre>
          </details>
          <div className="inline wrap">
            {safeUrl(item.identityKey) && (
              <a
                className="button small"
                href={safeUrl(item.identityKey)}
                target="_blank"
                rel="noreferrer"
              >
                打开链接 ↗
              </a>
            )}
            <button className="button small" disabled={!project} onClick={() => setOwner(item)}>
              查找同项目关联会话
            </button>
            <button
              className="button danger small"
              disabled={action.disabled}
              onClick={() => setRemove(item)}
            >
              移除关联
            </button>
          </div>
        </article>
      ))}
      {attachments.hasMore && (
        <button
          className="button"
          disabled={attachments.loading}
          onClick={() => void attachments.more()}
        >
          更多关联
        </button>
      )}
      {remove && (
        <div className="workspace-warning">
          <p>确认只移除当前会话的此关联描述，保留链接目标和文件。</p>
          <button
            className="button danger small"
            disabled={action.disabled}
            onClick={async () => {
              if (
                await action.run('thread/attachment/remove', {
                  threadId,
                  attachmentType: remove.attachmentType,
                  identityKey: remove.identityKey,
                })
              )
                setRemove(undefined);
            }}
          >
            确认移除关联
          </button>{' '}
          <button className="button small" onClick={() => setRemove(undefined)}>
            取消
          </button>
        </div>
      )}
      {owner && (
        <div className="info-card stack">
          <h4>同工作目录的关联会话</h4>
          <ReadState {...owners} />
          {owners.items.map((item) => (
            <button
              className="button small"
              key={item.threadId}
              onClick={() => onOpenThread(item.threadId)}
            >
              {item.threadId}
              {item.archived ? ' · 已归档' : ''}
            </button>
          ))}
          {!owners.loading && !owners.items.length && <p className="muted">当前页没有匹配会话。</p>}
          {owners.hasMore && (
            <button
              className="button small"
              disabled={owners.loading}
              onClick={() => void owners.more()}
            >
              继续查找关联会话
            </button>
          )}
        </div>
      )}
      <form
        className="info-card stack"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <fieldset disabled={action.busy} className="stack">
          <h4>新增关联</h4>
          <label className="field">
            关联类型
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setValue('');
              }}
            >
              <option value="link">网页链接</option>
              <option value="pull_request">Pull request 链接</option>
              <option value="workspace_file">项目文件描述</option>
            </select>
          </label>
          <label className="field">
            {kind === 'workspace_file' ? '项目内相对路径' : 'HTTP(S) 地址'}
            <input
              required
              maxLength={4096}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <label className="field">
            关联说明（可选）
            <input
              maxLength={4096}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={action.disabled || !value || (kind === 'workspace_file' && !project)}
          >
            保存关联描述
          </button>
        </fieldset>
      </form>
    </section>
  );
}
