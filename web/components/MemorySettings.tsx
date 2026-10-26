import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import { array, object, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
const fields = [
  {
    key: 'generate_memories',
    label: '生成全局记忆',
    description: '允许原生服务从符合条件的会话生成记忆。',
  },
  {
    key: 'use_memories',
    label: '在任务中使用全局记忆',
    description: '允许原生服务向符合条件的任务注入已有记忆。',
  },
] as const;
type Field = (typeof fields)[number]['key'];
type Choice = '' | 'true' | 'false' | 'inherit';
type Base = { version: string; effective: Record<string, unknown>; user: Record<string, unknown> };
const describe = (value: unknown) =>
  value === true ? '启用' : value === false ? '停用' : '未提供 / 未设置';
const choiceLabel = (value: Choice) =>
  value === 'inherit' ? '清除用户覆盖，使用继承值' : value === 'true' ? '启用' : '停用';
export function MemorySettings({
  api,
  project,
  epoch,
  enabled,
  onChanged,
}: {
  api: Api;
  project: Project;
  epoch: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const action = useExtensionAction(api, enabled, onChanged),
    resource = useResource(`${project.id}:${epoch}:${action.revision}`, (signal) =>
      api.call('settings/read', { projectId: project.id }, signal),
    );
  const [base, setBase] = useState<Base>(),
    [changes, setChanges] = useState<Record<Field, Choice>>({
      generate_memories: '',
      use_memories: '',
    }),
    [confirm, setConfirm] = useState(false),
    [compared, setCompared] = useState(false);
  const effective = object(object(resource.data?.config).memories),
    editable = array<string>(resource.data?.editableKeys),
    version = resource.data?.userVersion;
  const userLayers = array<unknown>(resource.data?.layers)
    .map(object)
    .filter((row) => object(row.name).type === 'user' && object(row.name).profile === null);
  const user = userLayers.length === 1 ? object(object(userLayers[0]!.config).memories) : {};
  const selected = fields.filter((field) => Boolean(changes[field.key])),
    conflict = Boolean(base && typeof version === 'string' && base.version !== version);
  const writable =
    typeof version === 'string' && userLayers.length === 1 && userLayers[0]!.version === version;
  useEffect(() => {
    setConfirm(false);
    setCompared(false);
    if (writable && (!base || !selected.length))
      setBase({ version: version as string, effective, user });
  }, [resource.data]);
  const save = async () => {
    if (
      !base ||
      !writable ||
      conflict ||
      !confirm ||
      !selected.length ||
      selected.some((field) => !editable.includes(`memories.${field.key}`)) ||
      action.disabled
    )
      return;
    const submitted = { ...changes };
    setConfirm(false);
    const result = await action.run(
      'settings/write',
      {
        expectedVersion: base.version,
        changes: selected.map((field) => ({
          key: `memories.${field.key}`,
          value: submitted[field.key] === 'inherit' ? null : submitted[field.key] === 'true',
        })),
      },
      '记忆开关修改已受理，正在重新读取实际生效设置。',
    );
    if (result !== undefined)
      setChanges(
        (current) =>
          Object.fromEntries(
            Object.entries(current).map(([key, value]) => [
              key,
              value === submitted[key as Field] ? '' : value,
            ]),
          ) as Record<Field, Choice>,
      );
  };
  return (
    <section className="info-card stack">
      <div className="section-heading">
        <h3>全局记忆生成与使用</h3>
        <button className="button small" disabled={resource.loading} onClick={resource.refresh}>
          重新读取记忆设置
        </button>
      </div>
      <p className="small muted">
        保存只改变用户配置中的这两个开关，不改动其他记忆参数。停用生成或使用不会删除已有记忆，也不等于停止当前任务；当前会话参与记忆的开关在“会话组织”中。管理或项目层仍可能覆盖用户值。
      </p>
      <ReadState {...resource} />
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原记忆设置回执" />
      {resource.data && !writable && (
        <p className="workspace-warning">
          未取得唯一用户配置层及一致版本，只能查看，不能覆盖配置。
        </p>
      )}
      {fields.map((field) => (
        <label className="field" key={field.key}>
          {field.label}
          <span className="small muted">
            {field.description} 当前有效值：{describe(effective[field.key])}；用户覆盖：
            {describe(user[field.key])}
          </span>
          <select
            value={changes[field.key]}
            disabled={action.busy || !writable || !editable.includes(`memories.${field.key}`)}
            onChange={(event) => {
              setConfirm(false);
              setChanges((current) => ({ ...current, [field.key]: event.target.value as Choice }));
            }}
          >
            <option value="">保持不变</option>
            <option value="true">启用</option>
            <option value="false">停用</option>
            <option value="inherit">清除用户覆盖，使用继承值</option>
          </select>
        </label>
      ))}
      {selected.length > 0 && (
        <div className="stack">
          <h4>本次修改</h4>
          <ul>
            {selected.map((field) => (
              <li key={field.key}>
                {field.label}：原用户覆盖 {describe(base?.user[field.key])} →{' '}
                {choiceLabel(changes[field.key])}
              </li>
            ))}
          </ul>
        </div>
      )}
      {conflict && (
        <div className="workspace-conflict stack">
          <p>用户配置版本已变化。已保留选择，请核对当前有效值与用户覆盖；不会自动重试旧写入。</p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={compared}
              onChange={(event) => setCompared(event.target.checked)}
            />
            我已比较新版本，仍保留以上修改
          </label>
          <button
            className="button small"
            disabled={!compared || !writable || action.busy}
            onClick={() => {
              setBase({ version: version as string, effective, user });
              setConfirm(false);
              setCompared(false);
            }}
          >
            采用新版本作为保存基准
          </button>
        </div>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
        />
        确认只修改以上明确选择的记忆开关
      </label>
      <button
        className="button primary"
        disabled={
          action.disabled ||
          !writable ||
          !base ||
          !selected.length ||
          !confirm ||
          conflict ||
          resource.loading ||
          Boolean(resource.error)
        }
        onClick={() => void save()}
      >
        保存记忆开关
      </button>
    </section>
  );
}
