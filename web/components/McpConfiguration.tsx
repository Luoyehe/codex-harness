import { useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { useSettingsDraft, useSettingsNavigation } from '../hooks/useSettingsDraft';
import { SettingsDraftDialog } from './SettingsDraftDialog';
import { useExtensionAction, ExtensionStatus, ReadState } from './ExtensionControls';
type ConfigEntry = { id?: string; name: string };
const entryKey = (entry: ConfigEntry) => entry.id ?? entry.name;
const selector = (entry: ConfigEntry) => entry.id ? { id: entry.id } : { name: entry.name };
const entryLabel = (entry: ConfigEntry) => entry.id && entry.name.includes('[redacted]')
  ? `${entry.name} · ${entry.id.slice(0, 12)}` : entry.name;

type ServerConfig = ConfigEntry & {
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
type Catalog = { userVersion: string | null; servers: ServerConfig[]; inheritedServers: string[]; unassigned?: Record<string, boolean>; legacySwitches?: (ConfigEntry & { enabled: boolean; targetIds: string[] })[]; inheritedDetails?: { id?: string; name: string; enabled: boolean; effectiveEnabled?: boolean; restartRequired?: boolean; overrideAllowed?: boolean; codingPlanHttpDefaultOff?: boolean; managedOwner?: string; transport: string; overridden: boolean }[] };
function LegacySwitch({ name, value, targets, disabled, restore, discard }: {
  name: string; value: boolean; targets: (ConfigEntry & { managedOwner?: string })[]; disabled: boolean; restore: (target: ConfigEntry) => void; discard: () => void;
}) {
  const [target, setTarget] = useState('');
  const selected = targets.find(row => entryKey(row) === target);
  return <div className="info-card">
    <p>原服务 {name} · 原设置为{value ? '启用' : '停用'}</p>
    <label>将旧开关应用到
      <select value={selected ? target : ''} disabled={disabled || !targets.length}
        onChange={event => setTarget(event.target.value)}>
        <option value="">选择已核对的服务</option>
        {targets.map(row => <option key={entryKey(row)} value={entryKey(row)}>{entryLabel(row)} · {row.managedOwner ? `连接 ${row.managedOwner}` : '继承服务'}</option>)}
      </select>
    </label>
    <button className="button small" disabled={disabled || !selected} onClick={() => selected && restore(selected)}>应用原设置</button>
    <button className="button small" disabled={disabled} onClick={discard}>放弃这条旧设置</button>
  </div>;
}

type Pair = { name: string; value: string };
type Edit = {
  source?: ServerConfig;
  baseVersion: string;
  name: string;
  transport: 'stdio' | 'http';
  // Undefined keeps the native value. Read-side placeholders never enter these overrides.
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  env?: Pair[];
  headers?: Pair[];
  envNames?: string[];
  headerNames?: string[];
  envHeaders?: Pair[];
  bearer: string;
  clearSecrets: boolean;
};

function startEdit(baseVersion: string, source?: ServerConfig): Edit {
  return {
    baseVersion, source, name: source?.name ?? '',
    transport: source?.transport === 'http' ? 'http' : 'stdio',
    bearer: '', clearSecrets: false,
  };
}
const masked = (text?: string) => text?.includes('[redacted]') === true;
function clearPrivateDraft(edit: Edit): Edit {
  return { ...edit,
    envNames: edit.env?.map(row => row.name) ?? edit.envNames,
    headerNames: edit.headers?.map(row => row.name) ?? edit.headerNames,
    env: undefined, headers: undefined, clearSecrets: false,
    ...(masked(edit.source?.url) ? { url: undefined } : {}),
    ...(masked(edit.source?.command) ? { command: undefined } : {}),
    ...(edit.source?.args?.some(masked) ? { args: undefined } : {}),
  };
}
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
  clearedNames,
}: {
  label: string;
  value?: Pair[];
  onChange: (value?: Pair[]) => void;
  secret?: boolean;
  clearedNames?: string[];
}) {
  const rows = value ?? clearedNames?.map((name) => ({ name, value: '' }));
  return (
    <fieldset className="stack">
      <legend>{label}</legend>
      <label className="check-row">
        <input
          type="checkbox"
          checked={value !== undefined}
          onChange={(event) => onChange(event.target.checked ? rows ?? [] : undefined)}
        />
        替换此组值（不勾选保留原值，勾选且无行表示清空此组）
      </label>
      {value === undefined && Boolean(clearedNames?.length) && (
        <p className="small muted">字段名称已保留，值已清除。重新勾选替换后填写本次要提交的值。</p>
      )}
      {rows?.map((row, index) => (
        <div className="mcp-pair" key={index}>
          <input
            aria-label={`${label}名称 ${index + 1}`}
            value={row.name}
            disabled={value === undefined}
            maxLength={128}
            onChange={(event) =>
              onChange(
                rows.map((old, i) => (i === index ? { ...old, name: event.target.value } : old)),
              )
            }
          />
          <input
            aria-label={`${label}值 ${index + 1}`}
            type={secret ? 'password' : 'text'}
            autoComplete="off"
            value={row.value}
            disabled={value === undefined}
            maxLength={16384}
            onChange={(event) =>
              onChange(
                rows.map((old, i) => (i === index ? { ...old, value: event.target.value } : old)),
              )
            }
          />
          <button
            type="button"
            className="button small"
            disabled={value === undefined}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
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
type McpConfigurationProps = {
  onServiceSettings?: () => void;
  api: Api;
  projectId: string;
  epoch: string;
  enabled: boolean;
  visible?: boolean;
  onChanged: () => void;
};
export function McpConfiguration(props: McpConfigurationProps) {
  const owner = useRef({
    api: props.api, csrf: props.api.csrf, projectId: props.projectId, generation: 0,
  });
  if (
    owner.current.api !== props.api || owner.current.csrf !== props.api.csrf ||
    owner.current.projectId !== props.projectId
  )
    owner.current = {
      api: props.api, csrf: props.api.csrf, projectId: props.projectId,
      generation: owner.current.generation + 1,
    };
  return <McpConfigurationForm key={owner.current.generation} {...props} />;
}
function McpConfigurationForm({
  api,
  projectId,
  epoch,
  enabled,
  visible = true,
  onChanged,
  onServiceSettings,
}: McpConfigurationProps) {
  const action = useExtensionAction(
    api, enabled && visible, onChanged, JSON.stringify([epoch, visible, enabled]),
  ),
    catalog = useResource(
      `${projectId}:${epoch}:${action.revision}`,
      (signal) => api.call<Catalog>('mcp/config/read', { projectId }, signal),
      visible && Boolean(projectId),
    );
  const [edit, setEdit] = useState<Edit>(),
    [remove, setRemove] = useState<ConfigEntry & { version: string }>(),
    [confirm, setConfirm] = useState(false),
    [comparedVersion, setComparedVersion] = useState<string>(),
    [error, setError] = useState('');
  const editBaseline = useRef('');
  const editRef = useRef(edit);
  editRef.current = edit;
  const isDirty = () => Boolean(editRef.current && JSON.stringify(editRef.current) !== editBaseline.current);
  useSettingsDraft(isDirty);
  const drafts = useRef(new Set([isDirty]));
  const navigationOwner = useMemo(() => ({}), [api, api.csrf, projectId, epoch, visible, enabled, catalog.data?.userVersion]);
  const navigation = useSettingsNavigation(drafts.current, navigationOwner);
  const [secretNotice, setSecretNotice] = useState('');
  useEffect(() => {
    setConfirm(false);
    setComparedVersion(undefined);
    if (!visible) {
      const current = editRef.current;
      if (current) {
        const cleared = clearPrivateDraft(current);
        if (current.env || current.headers || current.command !== cleared.command ||
            current.url !== cleared.url || current.args !== cleared.args)
          setSecretNotice('已离开配置面板，新填的敏感值已清除。');
        setEdit(cleared);
      }
    }
  }, [epoch, visible, enabled]);
  const original = edit?.source;
  const currentServer = original && catalog.data?.servers.find(server => entryKey(server) === entryKey(original));
  const sameIdentity = !original || currentServer?.transport === original.transport;
  const conflict = Boolean(edit && catalog.data && (catalog.data.userVersion !== edit.baseVersion || !sameIdentity));
  const removalConflict = Boolean(remove && catalog.data && (catalog.data.userVersion !== remove.version ||
    !catalog.data.servers.some(server => entryKey(server) === entryKey(remove))));
  const source = original?.transport === edit?.transport ? original : undefined;
  const hiddenCommand = masked(source?.command), hiddenUrl = masked(source?.url), hiddenArgs = source?.args?.some(masked);
  const savedCommand = hiddenCommand ? '' : source?.command ?? '';
  const savedUrl = hiddenUrl ? '' : source?.url ?? '';
  const savedArgs = hiddenArgs ? [] : source?.args ?? [];
  const args = edit?.args ?? savedArgs;
  const savedEnabled = original?.enabled ?? true;
  const compared = Boolean(comparedVersion && comparedVersion === catalog.data?.userVersion);
  const canCompare = sameIdentity && !catalog.loading && !catalog.error;
  const patch = (change: Partial<Edit>) => {
    setEdit((current) => (current ? { ...current, ...change } : current));
    setConfirm(false);
  };
  const setArgs = (next: string[]) => patch({
    args: !hiddenArgs && next.length === savedArgs.length && next.every((arg, i) => arg === savedArgs[i]) ? undefined : next,
  });
  const begin = (server?: ServerConfig) => {
    const baseVersion = catalog.data?.userVersion;
    if (typeof baseVersion !== 'string') return;
    if (edit && (edit.source && server ? entryKey(edit.source) === entryKey(server) && sameIdentity : !edit.source && !server)) return;
    navigation.request(() => {
      setRemove(undefined);
      setConfirm(false);
      setComparedVersion(undefined);
      setError('');
      const next = startEdit(baseVersion, server);
      editBaseline.current = JSON.stringify(next);
      setEdit(next);
    }, '放弃编辑并切换服务');
  };
  const save = async () => {
    if (
      !edit || !confirm || conflict || action.disabled || catalog.loading ||
      !catalog.data || catalog.error
    ) return;
    setError('');
    try {
      if (!edit.source && catalog.data?.servers.some((server) => !masked(server.name) && server.name === edit.name))
        throw new Error('此用户服务名称已存在，请从列表选择编辑。');
      if (edit.transport === 'stdio' ? masked(edit.command) || edit.args?.some(masked) : masked(edit.url))
        throw new Error('请填写完整的新值，或撤销该字段的替换以保留原值。');
      const change = {
        type: 'upsert',
        transport: edit.transport,
        enabled: edit.enabled ?? savedEnabled,
        ...(edit.clearSecrets ? { clearSecrets: true } : {}),
        ...(edit.transport === 'stdio'
          ? {
              ...(edit.command !== undefined || !source ? { command: edit.command ?? '' } : {}),
              ...(edit.args !== undefined || !source ? { args } : {}),
              ...(edit.env !== undefined ? { env: pairs(edit.env) } : {}),
            }
          : {
              ...(edit.url !== undefined || !source ? { url: edit.url ?? '' } : {}),
              ...(edit.headers !== undefined ? { httpHeaders: pairs(edit.headers) } : {}),
              ...(edit.envHeaders !== undefined ? { envHttpHeaders: pairs(edit.envHeaders) } : {}),
              ...(edit.bearer ? { bearerTokenEnvVar: edit.bearer } : {}),
            }),
      };
      // An uncertain receipt must not leave newly supplied secrets available for replay.
      setEdit(current => current && clearPrivateDraft(current));
      setConfirm(false);
      if (
        await action.run(
          'mcp/config/write',
          { projectId, expectedVersion: edit.baseVersion, ...(edit.source ? selector(edit.source) : { name: edit.name, createOnly: true }), change },
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
  const legacySwitches = catalog.data?.legacySwitches ?? Object.entries(catalog.data?.unassigned ?? {})
    .map(([name, enabled]) => ({ name, enabled, id: undefined, targetIds: undefined }));
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
      {secretNotice && <p className="small muted" role="status">{secretNotice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {catalog.data && (
        <>
          <p className="small muted">
            仅修改选中的用户层服务。未填写的敏感字段保持原值，其他服务保持原样。切换设置类别会清除新填敏感值及其替换选择，并清除授权勾选；其他未保存编辑仍保留。
          </p>
          {legacySwitches.length > 0 && <section className="stack">
            <h4>待确认归属的旧开关</h4>
            <p>旧配置只记录了服务名，无法确认当时的连接。请选择对应服务以恢复原设置。若连接已停用，可以先重新启用该连接。</p>
            {legacySwitches.map(entry => {
              const logical = (name: string) => name.replace(/-(?:default|[0-9a-f]{32})$/, '');
              const targets = (catalog.data?.inheritedDetails ?? []).filter(row => row.overrideAllowed &&
                (entry.targetIds ? !!row.id && entry.targetIds.includes(row.id) : logical(row.name) === logical(entry.name)));
              return <LegacySwitch key={entryKey(entry) + catalog.data!.userVersion} name={entryLabel(entry)} value={entry.enabled} targets={targets}
                disabled={!enabled || action.busy || catalog.loading || !!edit}
                discard={() => void action.run('mcp/config/write', { projectId, expectedVersion: catalog.data!.userVersion,
                  ...selector(entry), change: { type: 'discardLegacy', enabled: entry.enabled } }, '旧设置已放弃。')}
                restore={target => void action.run('mcp/config/write', { projectId, expectedVersion: catalog.data!.userVersion,
                  ...selector(target), ...(entry.id ? { legacyId: entry.id } : {}),
                  change: { type: 'inherit', enabled: entry.enabled, ...(entry.id ? {} : { legacyName: entry.name }) } }, '旧设置已恢复到所选服务。')} />;
            })}
          </section>}
          {catalog.data.inheritedServers.length > 0 && <p className="small muted">来自其他配置层：{catalog.data.inheritedServers.join('、')}</p>}
          {catalog.data.inheritedDetails?.map(server => (
            <div className="info-card" key={entryKey(server)}>
              <strong>{entryLabel(server)}</strong>
              <p>{server.transport} · {server.overridden ? '用户覆盖' : '继承配置'}</p>
              {server.overrideAllowed !== true && <p className="small muted">此继承项的来源未授权用户级开关，请在其所属配置层管理。</p>}
              {server.overrideAllowed === true && server.codingPlanHttpDefaultOff === true && server.transport === 'http' && <p className="small muted">智谱 Coding Plan 集成默认关闭此远程服务，以兼容当前 Codex 的 MCP 握手。如需使用，可单独启用并核对实际连接状态。</p>}
              <p>已保存：{server.enabled ? '启用' : '停用'} · 当前生效：{typeof server.effectiveEnabled !== 'boolean' ? '未确认' : server.effectiveEnabled ? '启用' : '停用'}</p>
              {server.restartRequired && <div className="workspace-warning" role="status">
                重启原生服务后采用已保存的设置。
                {onServiceSettings && <button className="button small" onClick={onServiceSettings}>前往服务管理</button>}
              </div>}
              <button className="button small" disabled={server.overrideAllowed !== true || !enabled || action.busy || catalog.loading || !!edit}
                onClick={() => void action.run('mcp/config/write', { projectId, expectedVersion: catalog.data!.userVersion, ...selector(server), change: { type: 'inherit', enabled: !server.enabled } }, '单项设置已保存，请核对有效配置。')}>
                {server.enabled ? '停用' : '启用'} {entryLabel(server)}
              </button>
              {server.overridden && <button className="button small" disabled={server.overrideAllowed !== true || !enabled || action.busy || catalog.loading || !!edit}
                onClick={() => void action.run('mcp/config/write', { projectId, expectedVersion: catalog.data!.userVersion, ...selector(server), change: { type: 'inherit', enabled: null } }, '已恢复继承配置。')}>恢复继承设置</button>}
            </div>
          ))}
          {catalog.data.servers.map((server) => (
            <article className="info-card stack" key={entryKey(server)}>
              <div className="section-heading">
                <strong>{entryLabel(server)}</strong>
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
                  编辑 {entryLabel(server)}
                </button>
                <button
                  className="button danger small"
                  disabled={action.disabled || !catalog.data?.userVersion}
                  onClick={() => navigation.request(() => {
                    setEdit(undefined);
                    setConfirm(false);
                    setRemove({ id: server.id, name: server.name, version: catalog.data!.userVersion! });
                  }, '放弃编辑并准备移除')}
                >
                  移除 {entryLabel(server)} 用户配置
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
          <fieldset disabled={action.busy || !visible} className="stack">
            <h4>{edit.source ? `编辑 ${entryLabel(edit.source)}` : '新增服务'}</h4>
            {conflict && (
              <div className="workspace-conflict stack">
                <p>{catalog.data?.userVersion !== edit.baseVersion ? '用户配置版本已变化。' : '服务标识已失效。'}输入仍保留，请比较上方重新读取的服务状态。</p>
                {!sameIdentity && <p>原服务已移除、传输方式已变化或后台已重启，请从最新列表重新选择。</p>}
                <label className="check-row">
                  <input
                    type="checkbox"
                    disabled={!canCompare}
                    checked={compared}
                    onChange={(event) => setComparedVersion(event.target.checked ? catalog.data?.userVersion ?? undefined : undefined)}
                  />
                  已核对当前配置，保留本表单修改
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={!canCompare || !compared}
                  onClick={() => {
                    if (!canCompare || !compared || !comparedVersion) return;
                    const baseline = startEdit(comparedVersion, currentServer);
                    editBaseline.current = JSON.stringify(baseline);
                    patch({ baseVersion: baseline.baseVersion, source: currentServer });
                    setComparedVersion(undefined);
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
                readOnly={Boolean(edit.source)}
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
                    envNames: undefined,
                    headerNames: undefined,
                    envHeaders: undefined,
                    bearer: '',
                  })
                }
              >
                <option value="stdio">stdio 本地进程</option>
                <option value="http">HTTP 服务</option>
              </select>
            </label>
            {edit.source && edit.transport !== edit.source.transport && (
              <p className="workspace-warning">
                变更传输方式会清除原传输方式的专属字段和已保存敏感值。
              </p>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={edit.enabled ?? savedEnabled}
                onChange={(event) => patch({ enabled: event.target.checked === savedEnabled ? undefined : event.target.checked })}
              />
              启用用户配置中的此服务
            </label>
            {edit.transport === 'stdio' ? (
              <>
                <label className="field">
                  程序名或路径
                  <input
                    value={edit.command ?? savedCommand}
                    placeholder={hiddenCommand ? '已隐藏，留空保留原值' : undefined}
                    required={!hiddenCommand}
                    maxLength={4096}
                    onChange={(event) => patch({ command: event.target.value === savedCommand ? undefined : event.target.value })}
                  />
                </label>
                <fieldset className="stack">
                  <legend>命令参数（每行一个参数，原样传递）</legend>
                  {hiddenArgs && <label className="check-row">
                    <input type="checkbox" checked={edit.args !== undefined}
                      onChange={event => patch({ args: event.target.checked ? [] : undefined })} />
                    替换全部命令参数（含隐藏值，取消勾选可保留原参数，勾选后无行表示清空）
                  </label>}
                  {args.map((arg, index) => (
                    <div className="inline" key={index}>
                      <input
                        aria-label={`命令参数 ${index + 1}`}
                        value={arg}
                        maxLength={8192}
                        onChange={(event) =>
                          setArgs(args.map((old, i) => i === index ? event.target.value : old))
                        }
                      />
                      <button
                        type="button"
                        className="button small"
                        onClick={() => setArgs(args.filter((_, i) => i !== index))}
                      >
                        删除参数
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button small"
                    disabled={args.length >= 256 || Boolean(hiddenArgs && edit.args === undefined)}
                    onClick={() => setArgs([...args, ''])}
                  >
                    添加参数
                  </button>
                </fieldset>
                <PairFields
                  label="环境变量" value={edit.env} clearedNames={edit.envNames}
                  onChange={(env) => patch({ env, envNames: undefined })}
                />
              </>
            ) : (
              <>
                <label className="field">
                  HTTP(S) 服务地址
                  <input
                    value={edit.url ?? savedUrl}
                    placeholder={hiddenUrl ? '已隐藏，留空保留原值' : undefined}
                    required={!hiddenUrl}
                    maxLength={4096}
                    onChange={(event) => patch({ url: event.target.value === savedUrl ? undefined : event.target.value })}
                  />
                </label>
                <PairFields
                  label="HTTP 请求头"
                  value={edit.headers}
                  clearedNames={edit.headerNames}
                  onChange={(headers) => patch({ headers, headerNames: undefined })}
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
              清除已保存的环境变量、请求头及 Bearer Token 设置，再应用本次填写的值
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
          <p>确认只移除 {entryLabel(remove)} 的用户层定义。来自其他配置层的同名服务仍可能生效。</p>
          {removalConflict && <p className="error">配置版本或服务标识已变化，请取消后从最新列表重新选择移除。</p>}
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
              disabled={
                action.disabled || !confirm || removalConflict || catalog.loading ||
                !catalog.data || Boolean(catalog.error)
              }
              onClick={async () => {
                if (
                  await action.run('mcp/config/write', {
                    projectId,
                    ...selector(remove),
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
      <SettingsDraftDialog navigation={navigation} />
    </section>
  );
}
