import { useEffect, useState } from 'react';
import { array, object } from '../lib/types';
import type { useExtensionAction } from './ExtensionControls';

type Profile = {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  region?: string;
  model?: string;
  hasApiKey?: boolean;
};
export function ProviderProfiles({
  provider,
  action,
  hasDraft,
  onUpdated,
}: {
  provider: Record<string, unknown>;
  action: ReturnType<typeof useExtensionAction>;
  hasDraft: boolean;
  onUpdated: () => void;
}) {
  const profiles = array<Profile>(provider.profiles),
    retention = object(provider.retention);
  const [name, setName] = useState(''),
    [selected, setSelected] = useState(''),
    [confirm, setConfirm] = useState('');
  const profile = profiles.find((profile) => profile.id === selected);
  useEffect(() => setConfirm(''), [action.scope]);
  const trimmedName = name.trim(),
    nameTooLong = Array.from(trimmedName).length > 64;
  const disabled = action.disabled || hasDraft || typeof provider.revision !== 'string';
  const run = async (params: Record<string, string>, notice: string) => {
    if (disabled) return;
    if (
      await action.run(
        'system/provider/write',
        { expectedRevision: provider.revision, ...params },
        notice,
      )
    ) {
      setConfirm('');
      setName('');
      onUpdated();
    }
  };
  return (
    <section className="stack">
      <h3>已保存的供应商配置</h3>
      <p className="small muted">
        配置档将密钥、模型目录与原服务地址绑定保存在服务器；切换时整体恢复，不会把密钥带到另一个地址。最多保存
        16 项，重名不会覆盖。
      </p>
      {hasDraft && <p role="status">请先保存或放弃上方编辑，再使用配置档。</p>}
      <label className="field">
        新配置档名称
        <input
          maxLength={128}
          value={name}
          disabled={action.busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {nameTooLong && (
        <p className="error small" role="status">
          配置档名称最多 64 个字符。
        </p>
      )}
      <button
        className="button"
        disabled={
          disabled ||
          !trimmedName ||
          nameTooLong ||
          profiles.length >= 16 ||
          profiles.some((profile) => profile.name === trimmedName)
        }
        onClick={() =>
          void run({ saveProfileName: trimmedName }, '当前已生效配置已保存；服务未重启。')
        }
      >
        保存当前配置为配置档
      </button>
      <label className="field">
        选择已保存配置
        <select
          value={profile?.id ?? ''}
          disabled={action.busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setConfirm('');
          }}
        >
          <option value="">请选择配置档</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      {profile && (
        <div className="info-card stack">
          <strong>{profile.name}</strong>
          <p>
            {profile.kind} · {profile.baseUrl ?? profile.region ?? '原生模型服务'} ·{' '}
            {profile.model ?? '原生默认模型'}
          </p>
          <p className="small muted">
            {profile.hasApiKey ? '已保存与此端点绑定的密钥。' : '此配置不使用保存的 API Key。'}
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirm === `restore:${profile.id}`}
              onChange={(event) => setConfirm(event.target.checked ? `restore:${profile.id}` : '')}
            />
            我已核对目标，恢复此配置并重启原生服务
          </label>
          <button
            className="button"
            disabled={disabled || confirm !== `restore:${profile.id}`}
            onClick={() =>
              void run({ profileId: profile.id }, '配置档已恢复，正在读取新运行环境。')
            }
          >
            恢复所选配置档
          </button>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirm === `delete:${profile.id}`}
              onChange={(event) => setConfirm(event.target.checked ? `delete:${profile.id}` : '')}
            />
            删除此配置档；当前生效配置保持不变
          </label>
          <button
            className="button danger"
            disabled={disabled || confirm !== `delete:${profile.id}`}
            onClick={() =>
              void run({ deleteProfileId: profile.id }, '配置档已删除；当前配置与服务保持不变。')
            }
          >
            删除所选配置档
          </button>
        </div>
      )}
      {typeof retention.generations === 'number' && (
        <p className="small muted">
          配置历史 {retention.generations} / {String(retention.limit)} 代；自动保留最近{' '}
          {String(retention.retainedHistory)} 代及仍用于恢复的版本。
        </p>
      )}
    </section>
  );
}
