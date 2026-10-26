import { useState } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { useExtensionAction, ExtensionStatus, ReadState } from './ExtensionControls';
type ServerConfig = {
  name: string;
  transport: 'stdio' | 'http' | 'unsupported';
  enabled: boolean;
  effectiveEnabled: boolean | null;
  command?: string;
  args?: string[];
  url?: string;
  hasEnv: boolean;
  hasHttpHeaders: boolean;
  hasBearerTokenEnvVar: boolean;
  hasEnvHttpHeaders: boolean;
};
type Catalog = { userVersion: string | null; servers: ServerConfig[]; inheritedServers: string[] };
type Pair = { name: string; value: string };
type Edit = {
  baseName?: string;
  baseVersion: string;
  originalTransport?: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  env?: Pair[];
  headers?: Pair[];
  envHeaders?: Pair[];
  bearer: string;
  clearSecrets: boolean;
};
function pairs(rows: Pair[]) {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (
      !row.name ||
      Object.hasOwn(result, row.name) ||
      ['__proto__', 'prototype', 'constructor'].includes(row.name)
    )
      throw new Error('环境变量或请求头名称为空、重复或不安全。');
    result[row.name] = row.value;
  }
  return result;
}
function PairFields({
  label,
  value,
  onChange,
  secret = true,
}: {
  label: string;
  value?: Pair[];
  onChange: (value?: Pair[]) => void;
  secret?: boolean;
}) {
  return (
    <fieldset className="stack">
      <legend>{label}</legend>
      <label className="check-row">
        <input
          type="checkbox"
          checked={value !== undefined}
          onChange={(event) => onChange(event.target.checked ? [] : undefined)}
        />
        替换此组值（不勾选保留原值，勾选且无行表示清空此组）
      </label>
      {value?.map((row, index) => (
        <div className="mcp-pair" key={index}>
          <input
            aria-label={`${label}名称 ${index + 1}`}
            value={row.name}
            maxLength={128}
            onChange={(event) =>
              onChange(
                value.map((old, i) => (i === index ? { ...old, name: event.target.value } : old)),
              )
            }
          />
          <input
            aria-label={`${label}值 ${index + 1}`}
            type={secret ? 'password' : 'text'}
            autoComplete="off"
            value={row.value}
            maxLength={16384}
            onChange={(event) =>
              onChange(
                value.map((old, i) => (i === index ? { ...old, value: event.target.value } : old)),
              )
            }
          />
          <button
            type="button"
            className="button small"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            删除行
          </button>
        </div>
      ))}
      {value && (
        <button
          type="button"
          className="button small"
          disabled={value.length >= 64}
          onClick={() => onChange([...value, { name: '', value: '' }])}
        >
          添加{label}
        </button>
      )}
    </fieldset>
  );
}
export function McpConfiguration({
  api,
  projectId,
  epoch,
  enabled,
  onChanged,
}: {
  api: Api;
  projectId: string;
  epoch: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const action = useExtensionAction(api, enabled, onChanged),
    catalog = useResource(
      `${projectId}:${epoch}:${action.revision}`,
      (signal) => api.call<Catalog>('mcp/config/read', { projectId }, signal),
      Boolean(projectId),
    );
  const [edit, setEdit] = useState<Edit>(),
    [remove, setRemove] = useState<{ name: string; version: string }>(),
    [confirm, setConfirm] = useState(false),
    [compared, setCompared] = useState(false),
    [error, setError] = useState('');
  const conflict = Boolean(edit && catalog.data?.userVersion !== edit.baseVersion),
    removalConflict = Boolean(remove && catalog.data?.userVersion !== remove.version);
  const patch = (change: Partial<Edit>) => {
    setEdit((current) => (current ? { ...current, ...change } : current));
    setConfirm(false);
  };
  const begin = (server?: ServerConfig) => {
    if (typeof catalog.data?.userVersion !== 'string') return;
    setRemove(undefined);
    setConfirm(false);
    setCompared(false);
    setError('');
    setEdit({
      baseName: server?.name,
      baseVersion: catalog.data.userVersion,
      originalTransport: server?.transport,
      name: server?.name ?? '',
      transport: server?.transport === 'http' ? 'http' : 'stdio',
      command: server?.command ?? '',
      args: server?.args ?? [],
      url: server?.url ?? '',
      enabled: server?.enabled ?? true,
      bearer: '',
      clearSecrets: false,
    });
  };
  const save = async () => {
    if (!edit || !confirm || conflict) return;
    setError('');
    try {
      if (!edit.baseName && catalog.data?.servers.some((server) => server.name === edit.name))
        throw new Error('此用户服务名称已存在，请从列表选择编辑。');
      const change = {
        type: 'upsert',
        transport: edit.transport,
        enabled: edit.enabled,
        ...(edit.clearSecrets ? { clearSecrets: true } : {}),
        ...(edit.transport === 'stdio'
          ? {
              command: edit.command,
              args: edit.args,
              ...(edit.env !== undefined ? { env: pairs(edit.env) } : {}),
            }
          : {
              url: edit.url,
              ...(edit.headers !== undefined ? { httpHeaders: pairs(edit.headers) } : {}),
              ...(edit.envHeaders !== undefined ? { envHttpHeaders: pairs(edit.envHeaders) } : {}),
              ...(edit.bearer ? { bearerTokenEnvVar: edit.bearer } : {}),
            }),
      };
      if (
        await action.run(
          'mcp/config/write',
          { projectId, expectedVersion: edit.baseVersion, name: edit.name, change },
          '用户服务配置已受理。请读取有效状态；配置保存不表示 MCP 已连接，空闲时可单独重载。',
        )
      ) {
        setEdit(undefined);
        setConfirm(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '配置无效。');
    }
  };
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>用户层 MCP 配置</h3>
        <button className="button small" onClick={catalog.refresh}>
          重新读取服务配置
        </button>
      </div>
      {!projectId && <p className="muted">请先选择已注册项目，以查看其有效配置。</p>}
      <ReadState {...catalog} />
      <ExtensionStatus api={api} action={action} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {catalog.data && (
        <>
          <p className="small muted">
            仅修改选中的用户层服务。未填写的敏感字段保持原值，其他服务保持原样。新输入的敏感值只在此表单内保留，关闭设置会清除。
          </p>
          {catalog.data.inheritedServers.length > 0 && (
            <p className="workspace-warning">
              来自其他配置层：{catalog.data.inheritedServers.join('、')}
              。用户层移除不会移除管理或项目层服务。
            </p>
          )}
          {catalog.data.servers.map((server) => (
            <article className="info-card stack" key={server.name}>
              <div className="section-heading">
                <strong>{server.name}</strong>
                <span className="badge">
                  {server.transport} · 用户层{server.enabled ? '启用' : '停用'}
                </span>
              </div>
              <p className="small path">
                {server.transport === 'stdio' ? server.command : server.url}
              </p>
              {server.args && <pre className="raw">{JSON.stringify(server.args, null, 2)}</pre>}
              <p className="small muted">
                有效状态：
                {server.effectiveEnabled === null
                  ? '未生效'
                  : server.effectiveEnabled
                    ? '启用'
                    : '停用'}{' '}
                · 已保存敏感字段：
                {[
                  server.hasEnv && '环境变量',
                  server.hasHttpHeaders && '请求头',
                  server.hasBearerTokenEnvVar && 'Token 引用',
                  server.hasEnvHttpHeaders && '请求头环境变量引用',
                ]
                  .filter(Boolean)
                  .join('、') || '无'}
              </p>
              <div className="inline wrap">
                <button
                  className="button small"
                  disabled={action.disabled || !catalog.data?.userVersion}
                  onClick={() => begin(server)}
                >
                  编辑 {server.name}
                </button>
                <button
                  className="button danger small"
                  disabled={action.disabled || !catalog.data?.userVersion}
                  onClick={() => {
                    setEdit(undefined);
                    setConfirm(false);
                    setRemove({ name: server.name, version: catalog.data!.userVersion! });
                  }}
                >
                  移除 {server.name} 用户配置
                </button>
              </div>
            </article>
          ))}
          <button
            className="button"
            disabled={action.disabled || !catalog.data.userVersion}
            onClick={() => begin()}
          >
            新增 MCP 服务
          </button>
        </>
      )}
      {edit && (
        <form
          className="info-card stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={action.busy} className="stack">
            <h4>{edit.baseName ? `编辑 ${edit.baseName}` : '新增服务'}</h4>
            {conflict && (
              <div className="workspace-conflict stack">
                <p>用户配置版本已变化。输入仍保留，请比较上方重新读取的服务状态。</p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={compared}
                    onChange={(event) => setCompared(event.target.checked)}
                  />
                  已核对当前配置，保留本表单修改
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={!compared || !catalog.data?.userVersion}
                  onClick={() => {
                    patch({ baseVersion: catalog.data!.userVersion! });
                    setCompared(false);
                  }}
                >
                  采用当前服务配置版本
                </button>
              </div>
            )}
            <label className="field">
              服务名称
              <input
                value={edit.name}
                readOnly={Boolean(edit.baseName)}
                maxLength={128}
                required
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label className="field">
              传输方式
              <select
                value={edit.transport}
                onChange={(event) =>
                  patch({
                    transport: event.target.value as 'stdio' | 'http',
                    env: undefined,
                    headers: undefined,
                    envHeaders: undefined,
                    bearer: '',
                  })
                }
              >
                <option value="stdio">stdio 本地进程</option>
                <option value="http">HTTP 服务</option>
              </select>
            </label>
            {edit.originalTransport && edit.transport !== edit.originalTransport && (
              <p className="workspace-warning">
                变更传输方式会清除原传输方式的专属字段和已保存敏感值。
              </p>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(event) => patch({ enabled: event.target.checked })}
              />
              启用用户配置中的此服务
            </label>
            {edit.transport === 'stdio' ? (
              <>
                <label className="field">
                  程序名或路径
                  <input
                    value={edit.command}
                    required
                    maxLength={4096}
                    onChange={(event) => patch({ command: event.target.value })}
                  />
                </label>
                <fieldset className="stack">
                  <legend>命令参数（每行一个参数，原样传递）</legend>
                  {edit.args.map((arg, index) => (
                    <div className="inline" key={index}>
                      <input
                        aria-label={`命令参数 ${index + 1}`}
                        value={arg}
                        maxLength={8192}
                        onChange={(event) =>
                          patch({
                            args: edit.args.map((old, i) =>
                              i === index ? event.target.value : old,
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="button small"
                        onClick={() => patch({ args: edit.args.filter((_, i) => i !== index) })}
                      >
                        删除参数
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button small"
                    disabled={edit.args.length >= 256}
                    onClick={() => patch({ args: [...edit.args, ''] })}
                  >
                    添加参数
                  </button>
                </fieldset>
                <PairFields label="环境变量" value={edit.env} onChange={(env) => patch({ env })} />
              </>
            ) : (
              <>
                <label className="field">
                  HTTP(S) 服务地址
                  <input
                    value={edit.url}
                    required
                    maxLength={4096}
                    onChange={(event) => patch({ url: event.target.value })}
                  />
                </label>
                <PairFields
                  label="HTTP 请求头"
                  value={edit.headers}
                  onChange={(headers) => patch({ headers })}
                />
                <PairFields
                  label="请求头环境变量引用"
                  value={edit.envHeaders}
                  secret={false}
                  onChange={(envHeaders) => patch({ envHeaders })}
                />
                <label className="field">
                  Bearer Token 的环境变量名（留空保留原值）
                  <input
                    value={edit.bearer}
                    maxLength={128}
                    autoComplete="off"
                    onChange={(event) => patch({ bearer: event.target.value })}
                  />
                </label>
              </>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={edit.clearSecrets}
                onChange={(event) => patch({ clearSecrets: event.target.checked })}
              />
              明确清除该服务所有原有敏感字段，再应用本次填写的值
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(event) => setConfirm(event.target.checked)}
              />
              确认保存此服务配置；重载或加载会话时可能启动配置的进程或建立网络连接
            </label>
            <div className="inline wrap">
              <button
                className="button primary"
                disabled={
                  action.disabled ||
                  !confirm ||
                  conflict ||
                  catalog.loading ||
                  Boolean(catalog.error)
                }
              >
                保存此服务配置
              </button>
              <button
                className="button"
                type="button"
                disabled={action.busy}
                onClick={() => setEdit(undefined)}
              >
                关闭表单并清除未保存输入
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {remove && (
        <div className="workspace-warning stack">
          <p>确认只移除 {remove.name} 的用户层定义。来自其他配置层的同名服务仍可能生效。</p>
          {removalConflict && <p className="error">版本已变化，请取消后从最新列表重新选择移除。</p>}
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(event) => setConfirm(event.target.checked)}
            />
            确认移除此用户服务定义
          </label>
          <div className="inline">
            <button
              className="button danger"
              disabled={action.disabled || !confirm || removalConflict}
              onClick={async () => {
                if (
                  await action.run('mcp/config/write', {
                    projectId,
                    name: remove.name,
                    expectedVersion: remove.version,
                    change: { type: 'remove' },
                  })
                )
                  setRemove(undefined);
              }}
            >
              确认移除服务配置
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
