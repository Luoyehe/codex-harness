import { useEffect, useState } from 'react';
import type { ExperimentalFeature } from '../../protocol/ts/v2/ExperimentalFeature';
import type { Api } from '../lib/api';
import { array, object, type Model, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { usePaged } from '../hooks/usePaged';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
import { CompactThreshold } from './CompactThreshold';
type Field = {
  key: string;
  label: string;
  options?: string[];
  requirement?: string;
  numeric?: boolean;
  multiline?: boolean;
};
const fields: Field[] = [
  { key: 'model', label: '默认模型' },
  { key: 'review_model', label: '审查模型' },
  {
    key: 'model_reasoning_effort',
    label: '推理强度',
    options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    key: 'model_reasoning_summary',
    label: '推理摘要',
    options: ['auto', 'concise', 'detailed', 'none'],
  },
  { key: 'model_verbosity', label: '回答详细程度', options: ['low', 'medium', 'high'] },
  { key: 'service_tier', label: '服务档位' },
  {
    key: 'approval_policy',
    label: '审批策略',
    options: ['untrusted', 'on-failure', 'on-request', 'never'],
    requirement: 'allowedApprovalPolicies',
  },
  {
    key: 'approvals_reviewer',
    label: '审批处理者',
    options: ['user', 'auto_review', 'guardian_subagent'],
    requirement: 'allowedApprovalsReviewers',
  },
  {
    key: 'sandbox_mode',
    label: '沙箱模式',
    options: ['read-only', 'workspace-write', 'danger-full-access'],
    requirement: 'allowedSandboxModes',
  },
  {
    key: 'web_search',
    label: '网页搜索',
    options: ['disabled', 'cached', 'live'],
    requirement: 'allowedWebSearchModes',
  },
  { key: 'default_permissions', label: '默认权限配置名称' },
  { key: 'model_context_window', label: '模型上下文窗口 Token 数', numeric: true },
  { key: 'model_auto_compact_token_limit', label: '自动压缩 Token 阈值', numeric: true },
  {
    key: 'model_auto_compact_token_limit_scope',
    label: '自动压缩统计范围',
    options: ['total', 'body_after_prefix'],
  },
  { key: 'developer_instructions', label: '开发者指令', multiline: true },
  { key: 'compact_prompt', label: '压缩提示词', multiline: true },
];
const display = (value: unknown) =>
  value === null || value === undefined
    ? '未设置'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
type ConfigDraft = {
  base?: { version: string; config: Record<string, unknown> };
  changes: Record<string, string>;
};
// Keep unsent edits across modal/auth transitions without putting configuration text in persistent storage.
const drafts = new Map<string, ConfigDraft>();
export function ConfigSettings({
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
    key = `${project.id}:${epoch}:${action.revision}`;
  const current = useResource(key, (signal) =>
      api.call('settings/read', { projectId: project.id }, signal),
    ),
    requirements = useResource(key, (signal) => api.call('configRequirements/read', {}, signal));
  const features = usePaged<ExperimentalFeature>(api, 'experimentalFeature/list', {}, key);
  const models = usePaged<Model>(api, 'model/list', {}, key);
  const [base, setBase] = useState<ConfigDraft['base']>(() => drafts.get(project.id)?.base),
    [changes, setChanges] = useState<Record<string, string>>(
      () => drafts.get(project.id)?.changes ?? {},
    ),
    [compared, setCompared] = useState(false),
    [error, setError] = useState('');
  const config = object(current.data?.config),
    policy = object(requirements.data?.requirements),
    editable = array<string>(current.data?.editableKeys),
    version = current.data?.userVersion;
  const changed = Object.keys(changes),
    conflict = Boolean(base && typeof version === 'string' && base.version !== version);
  const update = (key: string, next: string) => {
    if (!drafts.has(project.id) && drafts.size >= 10) {
      setError('页面已保留 10 个项目的配置草稿。请先保存或放弃已有配置，再编辑此项目。');
      return;
    }
    setChanges((previous) => ({ ...previous, [key]: next }));
  };
  useEffect(() => {
    if (typeof version === 'string' && (!base || !changed.length)) setBase({ version, config });
    setCompared(false);
  }, [current.data]);
  useEffect(() => {
    if (changed.length) drafts.set(project.id, { base, changes });
    else drafts.delete(project.id);
  }, [base, changes, project.id]);
  const save = async () => {
    if (!base || typeof version !== 'string' || conflict || !changed.length) return;
    setError('');
    const submitted = { ...changes },
      edits: { key: string; value: string | number | null }[] = [];
    for (const field of fields.filter((field) => field.key in submitted)) {
      const value = submitted[field.key]!;
      if (value.includes('[redacted]')) {
        setError('遮蔽后的配置不能写回。请仅填写实际需要修改的值。');
        return;
      }
      if (
        field.numeric &&
        value !== '' &&
        (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
      ) {
        setError(`${field.label}必须为正整数，留空表示清除设置。`);
        return;
      }
      edits.push({
        key: field.key,
        value: value === '' ? null : field.numeric ? Number(value) : value,
      });
    }
    const result = await action.run('settings/write', {
      expectedVersion: base.version,
      changes: edits,
    });
    if (result)
      setChanges((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([name, value]) => submitted[name] !== value),
        ),
      );
  };
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>有效配置与来源</h3>
        <button
          className="button small"
          onClick={() => {
            current.refresh();
            requirements.refresh();
          }}
        >
          重新读取配置
        </button>
      </div>
      <p className="small muted">
        项目配置用于展示实际生效值；这里的保存只修改用户配置层。管理策略仍由运行时校验。留空并保存表示清除该用户设置。
      </p>
      <ReadState {...current} />
      <ReadState {...requirements} />
      <ExtensionStatus api={api} action={action} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {current.data && typeof version !== 'string' && (
        <p className="workspace-warning">
          尚未取得可写用户配置版本。已保留只读展示，请重新读取或检查配置来源。
        </p>
      )}
      {conflict && (
        <section className="workspace-conflict stack">
          <h4>配置版本已变化</h4>
          <p>未覆盖你的输入。比较当前配置后，可以明确采用新版本作为保存基准。</p>
          <ul>
            {changed.map((name) => (
              <li key={name}>
                {fields.find((field) => field.key === name)?.label}：原值{' '}
                {display(base?.config[name])}；当前值 {display(config[name])}
              </li>
            ))}
          </ul>
          <label className="check-row">
            <input
              type="checkbox"
              checked={compared}
              onChange={(event) => setCompared(event.target.checked)}
            />
            我已核对变化并保留需要的修改
          </label>
          <button
            className="button"
            disabled={!compared || action.busy}
            onClick={() => {
              if (typeof version === 'string') {
                setBase({ version, config });
                setCompared(false);
              }
            }}
          >
            采用当前配置版本
          </button>
        </section>
      )}
      <CompactThreshold
        contextWindow={
          changes.model_context_window ??
          base?.config.model_context_window ??
          config.model_context_window
        }
        threshold={
          changes.model_auto_compact_token_limit ??
          base?.config.model_auto_compact_token_limit ??
          config.model_auto_compact_token_limit
        }
        disabled={!editable.includes('model_auto_compact_token_limit') || action.disabled}
        onChange={(value) => update('model_auto_compact_token_limit', value)}
      />
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="config-fields">
          {fields.map((field) => {
            const source = object(object(current.data?.origins)[field.key]),
              sourceName = object(source.name),
              raw = base?.config[field.key] ?? config[field.key],
              value =
                changes[field.key] ??
                (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '');
            const model = models.items.find(
              (model) => (model.model ?? model.id) === (changes.model ?? config.model),
            );
            const allowed =
              field.key === 'model_reasoning_effort'
                ? (model?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? [])
                : field.requirement && Array.isArray(policy[field.requirement])
                  ? array<unknown>(policy[field.requirement]).filter(
                      (item): item is string => typeof item === 'string',
                    )
                  : field.options;
            const restricted = Boolean(
                field.requirement && Array.isArray(policy[field.requirement]) && !allowed?.length,
              ),
              disabled = !editable.includes(field.key) || action.busy || restricted;
            const updateField = (next: string) => update(field.key, next);
            return (
              <label className={`field ${field.multiline ? 'config-wide' : ''}`} key={field.key}>
                {field.label}
                {field.multiline ? (
                  <textarea
                    rows={4}
                    value={value}
                    disabled={disabled}
                    maxLength={65536}
                    onChange={(event) => updateField(event.target.value)}
                  />
                ) : field.options ? (
                  <select
                    value={value}
                    disabled={disabled}
                    onChange={(event) => updateField(event.target.value)}
                  >
                    <option value="">清除用户设置 / 使用继承值</option>
                    {value && !allowed?.includes(value) && (
                      <option value={value} disabled>
                        {value}（当前值）
                      </option>
                    )}
                    {allowed?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.numeric ? 'number' : 'text'}
                    min={field.numeric ? 1 : undefined}
                    step={field.numeric ? 1 : undefined}
                    value={value}
                    disabled={disabled}
                    maxLength={4096}
                    onChange={(event) => updateField(event.target.value)}
                  />
                )}
                <span className="small muted">
                  有效值：{display(config[field.key])} · 来源：{String(sourceName.type ?? '未提供')}
                  {field.key in changes ? ' · 已修改' : ''}
                </span>
              </label>
            );
          })}
        </div>
        <div className="inline wrap">
          <button
            className="button primary"
            disabled={
              action.disabled ||
              !base ||
              typeof version !== 'string' ||
              !changed.length ||
              conflict ||
              current.loading ||
              Boolean(current.error) ||
              requirements.loading ||
              Boolean(requirements.error)
            }
          >
            保存 {changed.length} 项配置
          </button>
          <button
            type="button"
            className="button"
            disabled={!changed.length || action.busy}
            onClick={() => {
              setChanges({});
              if (typeof version === 'string') setBase({ version, config });
              setError('');
            }}
          >
            放弃未保存配置
          </button>
        </div>
      </form>
      <details>
        <summary>配置层和管理约束</summary>
        <div className="stack">
          {array<Record<string, unknown>>(current.data?.layers).map((layer, index) => (
            <div className="info-card" key={index}>
              <strong>{String(object(layer.name).type)}</strong>
              <p className="small path">
                {String(
                  object(layer.name).file ??
                    object(layer.name).dotCodexFolder ??
                    object(layer.name).name ??
                    '',
                )}
              </p>
              {Boolean(layer.disabledReason) && (
                <p className="error">{String(layer.disabledReason)}</p>
              )}
              <pre className="raw">{JSON.stringify(layer.config, null, 2)}</pre>
            </div>
          ))}
          <pre className="raw">{JSON.stringify(policy, null, 2)}</pre>
        </div>
      </details>
      <details>
        <summary>完整有效配置（只读，敏感值已遮蔽）</summary>
        <pre className="raw">{JSON.stringify(config, null, 2)}</pre>
      </details>
      <div className="section-heading">
        <h3>功能开关</h3>
        <button className="button small" onClick={features.refresh}>
          刷新功能
        </button>
      </div>
      <ReadState {...features} />
      {features.items.map((feature) => {
        const required = object(policy.featureRequirements)[feature.name],
          managed = typeof required === 'boolean';
        return (
          <article className="info-card stack" key={feature.name}>
            <div className="section-heading">
              <strong>{feature.displayName ?? feature.name}</strong>
              <span className="badge">
                {feature.stage} · {feature.enabled ? '已启用' : '已停用'}
              </span>
            </div>
            {feature.description && <p>{feature.description}</p>}
            {feature.announcement && <p className="small muted">{feature.announcement}</p>}
            <p className="small muted">
              默认：{feature.defaultEnabled ? '启用' : '停用'}
              {managed ? ' · 由管理策略固定' : ''}
            </p>
            <button
              className="button small"
              disabled={
                action.disabled ||
                requirements.loading ||
                Boolean(requirements.error) ||
                managed ||
                ['deprecated', 'removed'].includes(feature.stage)
              }
              onClick={() =>
                void action.run('experimentalFeature/enablement/set', {
                  enablement: { [feature.name]: !feature.enabled },
                })
              }
            >
              {feature.enabled ? '停用功能' : '启用功能'}
            </button>
          </article>
        );
      })}
      {features.hasMore && (
        <button className="button" disabled={features.loading} onClick={() => void features.more()}>
          更多功能
        </button>
      )}
    </section>
  );
}
