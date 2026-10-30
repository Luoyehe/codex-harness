import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { array, composing, object } from '../lib/types';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';
import { ModelCatalog } from './ModelCatalog';
import { ProviderProfiles } from './ProviderProfiles';

type Gateway = {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  cookieName: string;
  redirectPort: string;
};
const emptyGateway: Gateway = {
  authorizationUrl: '',
  tokenUrl: '',
  clientId: '',
  cookieName: '',
  redirectPort: '',
};
const gatewayFields: [keyof Gateway, string][] = [
  ['authorizationUrl', 'OAuth 授权 URL'],
  ['tokenUrl', 'OAuth Token URL'],
  ['clientId', 'OAuth 公共 Client ID'],
  ['cookieName', '网关认证 Cookie 名称'],
  ['redirectPort', '服务器回调端口（可选）'],
];

type ProviderSettingsProps = {
  api: Api;
  epoch: string;
  onChanged: () => void;
  enabled?: boolean;
  visible?: boolean;
  accountPanel?: ReactNode | ((provider: Record<string, unknown>, isDefault: boolean) => ReactNode);
};
export function ProviderSettings(props: ProviderSettingsProps) {
  const owner = useRef({ api: props.api, csrf: props.api.csrf, generation: 0 });
  if (owner.current.api !== props.api || owner.current.csrf !== props.api.csrf)
    owner.current = {
      api: props.api, csrf: props.api.csrf, generation: owner.current.generation + 1,
    };
  return <ProviderSettingsForm key={owner.current.generation} {...props} />;
}
function ProviderSettingsForm({
  api,
  epoch,
  onChanged,
  enabled = true,
  visible = true,
  accountPanel,
}: ProviderSettingsProps) {
  const resource = useResource(
    epoch, (signal) => api.call('system/provider/read', {}, signal), visible,
  );
  // A refresh temporarily has no data. Keep non-secret editors mounted while it runs.
  const lastProvider = useRef(resource.data);
  if (resource.data) lastProvider.current = resource.data;
  const registry = resource.data ?? lastProvider.current;
  const [selectedId, setSelectedId] = useState('');
  const connections = array<Record<string, unknown>>(registry?.connections);
  const effectiveId = selectedId || String(registry?.defaultProviderId ?? 'default');
  const provider = useMemo(() => {
    const values = resource.data ?? lastProvider.current;
    if (!values) return undefined;
    const row = array<Record<string, unknown>>(values.connections).find(item => item.id === effectiveId);
    return row ? { ...row, revision: values.revision, providerId: row.id } : effectiveId === 'new' ? undefined : values;
  }, [resource.data, effectiveId]);
  const [name, setName] = useState(''), [connectionEnabled, setConnectionEnabled] = useState(true);
  const [supportsTools, setSupportsTools] = useState(true);
  const [kind, setKind] = useState('chatgpt'),
    [baseUrl, setBaseUrl] = useState(''),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState('');
  const [apiKey, setApiKey] = useState(''),
    [clearKey, setClearKey] = useState(false),
    [saved, setSaved] = useState(false),
    [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [gateway, setGateway] = useState<Gateway>(emptyGateway),
    [gatewayConsent, setGatewayConsent] = useState('');
  const [region, setRegion] = useState('');
  const dirty = useRef(false),
    baseRevision = useRef<unknown>(undefined),
    [initialized, setInitialized] = useState(false),
    [conflict, setConflict] = useState(false);
  const action = useExtensionAction(
    api,
    enabled && visible && !resource.loading && !resource.error,
    () => {
      resource.refresh();
      onChanged();
    },
    JSON.stringify([epoch, visible, enabled]),
  );
  const gatewayScope = JSON.stringify({ baseUrl, gateway }),
    isGateway = kind === 'chatgpt-gateway';
  const isBedrock = kind === 'bedrock-runtime' || kind === 'bedrock-mantle',
    usesKey = ['responses', 'zhipu-coding', 'bedrock-runtime', 'bedrock-mantle'].includes(kind);
  useEffect(() => {
    setApiKey('');
    setClearKey(false);
    setAllowInsecureHttp(false);
    setGatewayConsent('');
  }, [epoch, visible, enabled]);
  useEffect(() => {
    if (resource.data && dirty.current) {
      setConflict(resource.data.revision !== baseRevision.current);
      return;
    }
    if (!resource.data) return;
    if (effectiveId === 'new') {
      baseRevision.current = resource.data.revision;
      setConflict(false); setInitialized(true); setKind('responses'); setName('');
      setBaseUrl(''); setModel(''); setEffort(''); setRegion(''); setApiKey('');
      setClearKey(false); setAllowInsecureHttp(false); setGatewayConsent(''); setGateway(emptyGateway);
      setConnectionEnabled(true);
      setSupportsTools(true);
      return;
    }
    const value = provider ?? resource.data;
    baseRevision.current = resource.data.revision;
    setConflict(false);
    setKind(String(value.kind));
    setName(String(value.name ?? ''));
    setConnectionEnabled(value.enabled !== false);
    setSupportsTools(value.supportsTools !== false);
    setBaseUrl(String(value.baseUrl ?? ''));
    setModel(String(value.model ?? ''));
    setEffort(String(value.effort ?? ''));
    setRegion(String(value.region ?? ''));
    setApiKey('');
    setClearKey(false);
    setAllowInsecureHttp(value.allowInsecureHttp === true);
    setGatewayConsent('');
    const oauth = object(value.gatewayOAuth);
    setGateway(
      Object.fromEntries(gatewayFields.map(([key]) => [key, String(oauth[key] ?? '')])) as Gateway,
    );
    // Expose editors only after their displayed values and revision share one baseline.
    setInitialized(true);
  }, [resource.data, provider, effectiveId]);
  const save = async () => {
    if (
      !initialized ||
      !resource.data ||
      conflict ||
      action.disabled ||
      (isGateway && gatewayConsent !== gatewayScope)
    )
      return;
    setSaved(false);
    const params = {
      expectedRevision: baseRevision.current,
      ...(connections.length || effectiveId === 'new' ? {
        providerId: effectiveId, enabled: connectionEnabled,
        ...(name.trim() ? { name: name.trim() } : {}),
      } : {}),
      kind,
      ...(kind === 'responses' ? { baseUrl, allowInsecureHttp, ...(connections.length ? { supportsTools } : {}) } : {}),
      ...(isBedrock ? { region } : {}),
      ...(isGateway
        ? {
            baseUrl,
            confirmGatewayCredentials: true,
            gatewayOAuth: {
              authorizationUrl: gateway.authorizationUrl,
              tokenUrl: gateway.tokenUrl,
              clientId: gateway.clientId,
              cookieName: gateway.cookieName,
              ...(gateway.redirectPort ? { redirectPort: Number(gateway.redirectPort) } : {}),
            },
          }
        : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(usesKey ? (apiKey ? { apiKey } : clearKey ? { apiKey: '' } : {}) : {}),
    };
    // Secret input is intentionally not retained while a result is uncertain.
    setApiKey('');
    const result = await action.run('system/provider/write', params, '配置已保存，正在读取新运行环境。');
    if (result) {
      dirty.current = false;
      if (effectiveId === 'new') {
        const previous = new Set(connections.map(row => row.id));
        const added = array<Record<string, unknown>>(result.connections).find(row => !previous.has(row.id));
        setSelectedId(typeof added?.id === 'string' ? added.id : '');
      }
      setSaved(true);
      resource.refresh();
    }
  };
  return (
    <div className="stack">
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原供应商配置回执" />
      {connections.length > 0 && (
        <section className="stack" aria-label="已添加模型供应商">
          <div className="inline">
            {connections.map(row => <button key={String(row.id)} type="button"
              className={row.id === effectiveId ? 'button primary' : 'button'}
              disabled={action.busy || dirty.current}
              aria-pressed={row.id === effectiveId}
              onClick={() => { dirty.current = false; setSelectedId(String(row.id)); setSaved(false); }}>
              {String(row.name)}{row.enabled === false ? '（已停用）' : row.id === registry?.defaultProviderId ? '（默认）' : ''}
            </button>)}
            <button type="button" className="button" disabled={action.busy || dirty.current || connections.length >= 16}
              onClick={() => { dirty.current = false; setSelectedId('new'); setSaved(false); }}>添加供应商</button>
          </div>
          {dirty.current && <button type="button" className="button small" onClick={() => { dirty.current = false; setSaved(false); resource.refresh(); }}>放弃当前编辑</button>}
        </section>
      )}
      <form
        className="settings-form stack"
        onChange={() => {
          dirty.current = true;
          setSaved(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && composing(e)) e.preventDefault();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {resource.loading && <p role="status">读取配置中…</p>}
        {resource.error && (
          <p role="alert" className="error">
            {resource.error}
            <button
              type="button"
              className="button small"
              disabled={action.busy || !visible}
              onClick={resource.refresh}
            >
              重新读取
            </button>
          </p>
        )}
        <fieldset className="provider-fields stack" disabled={action.busy || !visible || !initialized}>
          <h3>模型供应商</h3>
          <p className="muted">
            可同时启用多个服务，开始新对话时选择模型。保存配置会重启运行时，请先结束正在执行的任务。
          </p>
          {(connections.length > 0 || effectiveId === 'new') && <>
            <label className="field">显示名称<input value={name} maxLength={64} onChange={event => setName(event.target.value)} placeholder="例如：个人 Coding Plan" /></label>
            <label className="check-row"><input type="checkbox" checked={connectionEnabled} onChange={event => setConnectionEnabled(event.target.checked)} />启用此供应商</label>
          </>}
          <label className="field">
            供应商
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setModel(''); setEffort(''); setBaseUrl(''); setRegion('');
                setSaved(false);
                setApiKey('');
                setClearKey(false);
                setAllowInsecureHttp(false);
                setGatewayConsent('');
              }}
            >
              <option value="chatgpt">ChatGPT 账户</option>
              <option value="responses">自定义 Responses 服务</option>
              <option value="zhipu-coding">智谱 Coding Plan</option>
              <option value="chatgpt-gateway">ChatGPT 经企业网关（OAuth）</option>
              <option value="bedrock-runtime">Amazon Bedrock Runtime</option>
              <option value="bedrock-mantle">Amazon Bedrock Mantle</option>
            </select>
          </label>
          {['responses', 'chatgpt-gateway'].includes(kind) && (
            <label className="field">
              {isGateway ? '网关 Codex Base URL' : 'API Base URL'}
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                placeholder={
                  isGateway
                    ? 'https://gateway.example/backend-api/codex'
                    : 'https://your-provider.example/v1'
                }
              />
            </label>
          )}
          {kind === 'zhipu-coding' && (
            <p className="small muted">服务地址：https://open.bigmodel.cn/api/v1</p>
          )}
          {kind === 'responses' && <>
            <label className="check-row"><input type="checkbox" checked={supportsTools} onChange={event => setSupportsTools(event.target.checked)} />默认支持工具调用</label>
            <p className="small muted">用于文件、命令等 Agent 任务。这是你的配置声明；只返回模型 ID 的目录无法验证此能力。服务明确声明不支持时会遵循服务返回值。</p>
          </>}
          {isBedrock && (
            <>
              <label className="field">
                AWS 区域
                <input
                  value={region}
                  onChange={(e) => {
                    setRegion(e.target.value);
                    setApiKey('');
                  }}
                  required
                  placeholder="us-east-1"
                />
              </label>
              <p>
                使用该区域的 Bedrock Bearer API Key。区域与服务地址由管理配置固定，模型目录由原生
                CLI 提供；模型及账户权限仍以 AWS 实际开放情况为准。
              </p>
              <p className="small muted">
                此入口支持商业区域的 Bearer Key。不会读取个人 AWS
                profile、共享凭据文件或实例角色；中国区、GovCloud 与隔离区不适用此配置。
              </p>
            </>
          )}
          {usesKey && (
            <>
              <label className="field">
                API Key
                <input
                  type="password"
                  autoComplete="off"
                  disabled={clearKey}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    provider?.kind === kind && provider?.hasApiKey
                      ? '供应商与地址未变时，留空保留密钥'
                      : '输入此供应商的 API Key'
                  }
                />
              </label>
              <p className="small muted">
                更改供应商或服务地址不会沿用旧密钥。密钥不写入浏览器持久存储。
                切换设置类别会清除新填密钥与授权勾选，保留其他未保存编辑。
              </p>
              {kind === 'responses' && baseUrl.startsWith('http://') && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={allowInsecureHttp}
                    onChange={(e) => setAllowInsecureHttp(e.target.checked)}
                  />
                  允许向私有 HTTP 地址发送 API Key（连接未加密）
                </label>
              )}
              {kind === 'responses' && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(e) => {
                      setClearKey(e.target.checked);
                      if (e.target.checked) setApiKey('');
                    }}
                  />
                  不使用 API Key（明确留空）
                </label>
              )}
            </>
          )}
          {isGateway && (
            <>
              <p>
                此网关需要代理 Codex 的 models 与 responses 路径，并支持 OAuth 授权码与
                PKCE。保存后在下方完成账号登录与网关授权。
              </p>
              {gatewayFields.map(([key, label]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    type={key.endsWith('Url') ? 'url' : key === 'redirectPort' ? 'number' : 'text'}
                    {...(key === 'redirectPort' ? { min: 1024, max: 65535 } : { required: true })}
                    value={gateway[key]}
                    onChange={(e) =>
                      setGateway((current) => ({ ...current, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
              <p className="small muted">
                回调端口留空由原生服务选择。浏览器不在执行服务器上时，需要 SSH
                转发该回调端口。授权地址和 Token 地址必须使用 HTTPS。
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={gatewayConsent === gatewayScope}
                  onChange={(e) => setGatewayConsent(e.target.checked ? gatewayScope : '')}
                />
                我已核对以上目标；此网关会收到 ChatGPT 凭据与模型请求内容
              </label>
            </>
          )}
          <label className="field">
            默认模型 ID
            <input
              aria-label="默认模型 ID"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="由供应商实际支持的模型"
            />
            <small className="muted">可以留空；保存后读取模型目录，再选择默认模型。</small>
          </label>
          <label className="field">
            默认推理强度
            <input
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              placeholder="留空采用供应商默认值"
            />
          </label>
          {conflict && (
            <p role="alert" className="error">
              已保存的配置发生变化；你的编辑已保留。请重新读取配置后再修改。
              <button
                type="button"
                className="button small"
                onClick={() => {
                  dirty.current = false;
                  resource.refresh();
                }}
              >
                放弃编辑并重新读取
              </button>
            </p>
          )}
          {saved && (
            <p role="status" className="success">
              配置已保存。
            </p>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={
              action.disabled ||
              !initialized ||
              !resource.data ||
              conflict ||
              (isGateway && gatewayConsent !== gatewayScope)
            }
          >
            {action.busy ? '正在保存…' : '保存配置'}
          </button>
        </fieldset>
      </form>
      {provider && initialized && !dirty.current && ['chatgpt', 'chatgpt-gateway'].includes(kind) && provider.kind === kind && provider.enabled !== false &&
        (typeof accountPanel === 'function' ? accountPanel(provider, effectiveId === registry?.defaultProviderId || !connections.length) : accountPanel)}
      {provider && initialized && connections.length > 0 && effectiveId !== 'new' && !dirty.current && (
        <div className="inline">
          <button type="button" className="button" disabled={action.disabled || provider.enabled === false || effectiveId === registry?.defaultProviderId}
            onClick={async () => { if (await action.run('system/provider/write', { expectedRevision: registry?.revision, defaultProviderId: effectiveId }, '已更新新对话的默认供应商。')) resource.refresh(); }}>设为默认供应商</button>
          <details><summary>移除供应商</summary><p>移除后，使用此供应商的历史对话将无法继续，直到重新配置相同服务。</p>
            <button type="button" className="button danger" disabled={action.disabled || connections.length <= 1}
              onClick={async () => { if (await action.run('system/provider/write', { expectedRevision: registry?.revision, removeProviderId: effectiveId }, '已移除供应商。')) { setSelectedId(''); resource.refresh(); } }}>确认移除 {String(provider.name)}</button>
          </details>
        </div>
      )}
      {provider && initialized && (
        <>
          <hr />
          <details open={!connections.length}><summary>配置备份</summary><ProviderProfiles
            provider={registry ?? provider}
            action={action}
            hasDraft={dirty.current}
            onUpdated={() => {
              dirty.current = false;
              resource.refresh();
            }}
          /></details>
          <hr />
          <ModelCatalog
            key={effectiveId + ':' + String(provider.revision)}
            api={api}
            provider={provider}
            visible={visible}
            scopeKey={epoch}
            enabled={enabled && !resource.loading && !resource.error}
            onApplied={() => {
              resource.refresh();
              onChanged();
            }}
          />
        </>
      )}
    </div>
  );
}
