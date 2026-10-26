import { useState } from 'react';
import type { PluginListResponse } from '../../protocol/ts/v2/PluginListResponse';
import type { PluginShareListItem } from '../../protocol/ts/v2/PluginShareListItem';
import type { PluginShareTarget } from '../../protocol/ts/v2/PluginShareTarget';
import type { Api } from '../lib/api';
import { safeUrl, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
type Shared = PluginShareListItem & { previewHash: string };
type Preview = {
  pluginId: string;
  pluginPath: string;
  previewHash: string;
  files: { path: string; bytes: number; sha256: string }[];
  totalBytes: number;
};
type AudienceValue = {
  discoverability: 'PRIVATE' | 'UNLISTED' | 'LISTED';
  targets: PluginShareTarget[];
};
const remoteId = (row: Shared): string =>
  row.plugin.remotePluginId ?? row.plugin.shareContext?.remotePluginId ?? '';
function Audience({
  value,
  onChange,
}: {
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
}) {
  return (
    <div className="stack">
      <label className="field">
        可见范围
        <select
          value={value.discoverability}
          onChange={(e) =>
            onChange({
              ...value,
              discoverability: e.target.value as AudienceValue['discoverability'],
            })
          }
        >
          <option value="PRIVATE">私有</option>
          <option value="UNLISTED">不列入目录</option>
          <option value="LISTED">列入工作区目录</option>
        </select>
      </label>
      <p className="small muted">
        请填写服务提供的用户、组或工作区 ID；名称和邮箱不会被猜测成 ID。实际权限由原生共享服务核验。
      </p>
      {value.targets.map((target, index) => (
        <div className="info-card stack" key={index}>
          <label className="field">
            接收者类型
            <select
              value={target.principalType}
              onChange={(e) =>
                onChange({
                  ...value,
                  targets: value.targets.map((row, i) =>
                    i === index
                      ? {
                          ...row,
                          principalType: e.target.value as PluginShareTarget['principalType'],
                        }
                      : row,
                  ),
                })
              }
            >
              <option value="user">用户</option>
              <option value="group">组</option>
              <option value="workspace">工作区</option>
            </select>
          </label>
          <label className="field">
            接收者 ID
            <input
              value={target.principalId}
              maxLength={256}
              onChange={(e) =>
                onChange({
                  ...value,
                  targets: value.targets.map((row, i) =>
                    i === index ? { ...row, principalId: e.target.value } : row,
                  ),
                })
              }
            />
          </label>
          <label className="field">
            权限
            <select
              value={target.role}
              onChange={(e) =>
                onChange({
                  ...value,
                  targets: value.targets.map((row, i) =>
                    i === index
                      ? { ...row, role: e.target.value as PluginShareTarget['role'] }
                      : row,
                  ),
                })
              }
            >
              <option value="reader">读取</option>
              <option value="editor">编辑</option>
            </select>
          </label>
          <button
            className="button small"
            onClick={() =>
              onChange({ ...value, targets: value.targets.filter((_, i) => i !== index) })
            }
          >
            移除此接收者
          </button>
        </div>
      ))}
      <button
        className="button small"
        disabled={value.targets.length >= 64}
        onClick={() =>
          onChange({
            ...value,
            targets: [...value.targets, { principalType: 'user', principalId: '', role: 'reader' }],
          })
        }
      >
        添加明确接收者
      </button>
    </div>
  );
}
function SharedDetails({
  row,
  action,
}: {
  row: Shared;
  action: ReturnType<typeof useExtensionAction>;
}) {
  const context = row.plugin.shareContext;
  const [audience, setAudience] = useState<AudienceValue>({
    discoverability: context?.discoverability ?? 'PRIVATE',
    targets: (context?.sharePrincipals ?? [])
      .filter((principal) => principal.role !== 'owner')
      .map(({ principalId, principalType, role }) => ({
        principalId,
        principalType,
        role: role as 'reader' | 'editor',
      })),
  });
  const [confirmed, setConfirmed] = useState(false),
    [remove, setRemove] = useState(''),
    [checkout, setCheckout] = useState(false);
  const id = remoteId(row),
    common = { remotePluginId: id, previewHash: row.previewHash, confirm: true };
  return (
    <section className="info-card stack">
      <h4>{row.plugin.interface?.displayName ?? row.plugin.name}</h4>
      <p className="small path">共享 ID：{id}</p>
      {safeUrl(context?.shareUrl) && (
        <a href={safeUrl(context?.shareUrl)} target="_blank" rel="noreferrer">
          查看原生共享页面 ↗
        </a>
      )}
      {context?.sharePrincipals === null || !context ? (
        <p className="workspace-warning">
          目录未提供当前完整接收者；保存下方列表会替换可编辑接收者，请先到共享页面核对。
        </p>
      ) : (
        <ul>
          {context.sharePrincipals.map((principal) => (
            <li key={principal.principalType + ':' + principal.principalId}>
              {principal.name} · {principal.principalType} · {principal.role}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>修改共享范围</summary>
        <div className="stack">
          <Audience
            value={audience}
            onChange={(next) => {
              setAudience(next);
              setConfirmed(false);
            }}
          />
          <p>保存会替换这份共享的可编辑接收者列表。已有所有者由原生服务管理。</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            确认使用上述范围与完整接收者列表
          </label>
          <button
            className="button"
            disabled={
              action.disabled ||
              !confirmed ||
              !id ||
              audience.targets.some((target) => !target.principalId.trim())
            }
            onClick={async () => {
              if (
                await action.run('plugin/share/updateTargets', {
                  ...common,
                  discoverability: audience.discoverability,
                  shareTargets: audience.targets,
                })
              )
                setConfirmed(false);
            }}
          >
            保存共享范围
          </button>
        </div>
      </details>
      <details>
        <summary>取回本地副本</summary>
        <div className="stack">
          <p>
            由 Codex 下载到其管理目录。此动作不会自动注册工作台项目，也不等于安装插件或信任 Hooks。
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={checkout}
              onChange={(e) => setCheckout(e.target.checked)}
            />
            确认下载此共享的本地副本
          </label>
          <button
            className="button"
            disabled={action.disabled || !checkout || !id}
            onClick={async () => {
              if (
                await action.run(
                  'plugin/share/checkout',
                  common,
                  '本地副本取回已确认，请刷新插件目录查看位置。',
                )
              )
                setCheckout(false);
            }}
          >
            取回副本
          </button>
        </div>
      </details>
      <details>
        <summary>删除远程共享</summary>
        <div className="stack">
          <p>删除远程共享会影响其接收者；此操作不会删除本地项目文件。</p>
          <label className="field">
            输入“删除共享”以确认
            <input value={remove} onChange={(e) => setRemove(e.target.value)} />
          </label>
          <button
            className="button danger"
            disabled={action.disabled || remove !== '删除共享' || !id}
            onClick={() => void action.run('plugin/share/delete', common)}
          >
            删除此远程共享
          </button>
        </div>
      </details>
    </section>
  );
}
export function PluginSharing({
  api,
  epoch,
  enabled,
  onChanged,
  project,
}: {
  api: Api;
  epoch: string;
  enabled: boolean;
  onChanged: () => void;
  project?: Project;
}) {
  const action = useExtensionAction(api, enabled, onChanged),
    key = `${epoch}:${project?.id}:${action.revision}`;
  const shared = useResource(key, (signal) =>
    api.call<{ data: Shared[] }>('plugin/share/list', {}, signal),
  );
  const catalog = useResource(
    key,
    (signal) =>
      api.call<PluginListResponse>(
        'plugin/list',
        { projectId: project!.id, marketplaceKinds: ['local'] },
        signal,
      ),
    Boolean(project),
  );
  const [selected, setSelected] = useState(''),
    [selectedRemote, setSelectedRemote] = useState(''),
    [destination, setDestination] = useState(''),
    [audience, setAudience] = useState<AudienceValue>({ discoverability: 'PRIVATE', targets: [] }),
    [confirmed, setConfirmed] = useState(false);
  const preview = useResource(
    `${key}:${selected}`,
    (signal) =>
      api.call<Preview>(
        'plugin/share/preview',
        { projectId: project!.id, pluginId: selected },
        signal,
      ),
    Boolean(project && selected),
  );
  const local =
      catalog.data?.marketplaces
        .flatMap((market) => market.plugins)
        .filter((plugin) => plugin.source.type === 'local') ?? [],
    row = shared.data?.data.find((item) => remoteId(item) === selectedRemote),
    replace = shared.data?.data.find((item) => remoteId(item) === destination);
  const confirmationKey = `${preview.data?.previewHash}:${destination}:${replace?.previewHash}:${JSON.stringify(audience)}`,
    [confirmedKey, setConfirmedKey] = useState('');
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>插件共享</h3>
        <button className="button small" onClick={action.refresh}>
          重新读取共享目录
        </button>
      </div>
      <p className="small muted">
        共享依赖当前 Codex
        账号、工作区策略与原生服务。页面读取目录不会发布内容；所有变更都需要明确目标与确认。
      </p>
      <ExtensionStatus api={api} action={action} />
      <ReadState {...shared} />
      <div className="extension-cards">
        {shared.data?.data.map((item) => (
          <button
            className={`button plugin-card ${remoteId(item) === selectedRemote ? 'selected' : ''}`}
            key={item.plugin.id}
            onClick={() => setSelectedRemote(remoteId(item))}
          >
            {item.plugin.interface?.displayName ?? item.plugin.name} ·{' '}
            {item.plugin.shareContext?.discoverability ?? '范围未提供'}
          </button>
        ))}
      </div>
      {row && (
        <SharedDetails key={remoteId(row) + ':' + row.previewHash} row={row} action={action} />
      )}{' '}
      {shared.data?.data.length === 0 && <p className="muted">当前共享目录为空。</p>}
      <details className="info-card">
        <summary>发布项目内的插件</summary>
        <div className="stack">
          <p>
            只能选择当前已注册项目中的本地插件。下面是当前目录清单；发送前会重新检查。请检查文件名与内容，避免把凭证或不应共享的文件放入插件目录。
          </p>
          <ReadState {...catalog} />
          {!project && <p className="muted">先选择已注册项目。</p>}
          <label className="field">
            待共享插件
            <select
              value={selected}
              disabled={!project}
              onChange={(e) => {
                setSelected(e.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">选择本地目录中的插件</option>
              {local.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.interface?.displayName ?? plugin.name}
                </option>
              ))}
            </select>
          </label>
          <ReadState {...preview} />
          {preview.data && (
            <>
              <p className="small path">{preview.data.pluginPath}</p>
              <p>
                {preview.data.files.length} 个文件 · {preview.data.totalBytes.toLocaleString()} 字节
              </p>
              <details>
                <summary>查看待发送文件清单</summary>
                <ul>
                  {preview.data.files.map((file) => (
                    <li className="small path" key={file.path}>
                      {file.path} · {file.bytes.toLocaleString()} 字节
                    </li>
                  ))}
                </ul>
              </details>
              <label className="field">
                发布目标
                <select
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">创建新的远程共享</option>
                  {shared.data?.data.map((item) => (
                    <option key={item.plugin.id} value={remoteId(item)}>
                      更新：{item.plugin.name}
                    </option>
                  ))}
                </select>
              </label>
              <Audience
                value={audience}
                onChange={(next) => {
                  setAudience(next);
                  setConfirmed(false);
                }}
              />
              <p className="workspace-warning">
                将向当前 Codex 账号的插件共享服务发送此目录。
                {audience.discoverability === 'LISTED' ? '你选择了列入工作区目录。' : ''}
                {destination ? '这会更新已有共享内容和所选范围。' : ''}
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirmed && confirmedKey === confirmationKey}
                  onChange={(e) => {
                    setConfirmed(e.target.checked);
                    setConfirmedKey(confirmationKey);
                  }}
                />
                我已审阅目录内容、发布目标和接收范围
              </label>
              <button
                className="button primary"
                disabled={
                  action.disabled ||
                  !confirmed ||
                  confirmedKey !== confirmationKey ||
                  Boolean(destination && !replace) ||
                  audience.targets.some((target) => !target.principalId.trim())
                }
                onClick={async () => {
                  if (
                    await action.run(
                      'plugin/share/save',
                      {
                        projectId: project!.id,
                        pluginId: selected,
                        previewHash: preview.data!.previewHash,
                        discoverability: audience.discoverability,
                        shareTargets: audience.targets,
                        ...(replace
                          ? {
                              remotePluginId: remoteId(replace),
                              remotePreviewHash: replace.previewHash,
                            }
                          : {}),
                        confirm: true,
                      },
                      '共享保存已确认，请刷新目录核对链接与接收范围。',
                    )
                  )
                    setConfirmed(false);
                }}
              >
                确认发送并保存共享
              </button>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
