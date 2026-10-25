import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { composing, object } from '../lib/types';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';
import { ModelCatalog } from './ModelCatalog';

type Gateway = { authorizationUrl: string; tokenUrl: string; clientId: string; cookieName: string; redirectPort: string };
const emptyGateway: Gateway = { authorizationUrl: '', tokenUrl: '', clientId: '', cookieName: '', redirectPort: '' };
const gatewayFields: [keyof Gateway, string][] = [['authorizationUrl', 'OAuth 授权 URL'], ['tokenUrl', 'OAuth Token URL'], ['clientId', 'OAuth 公共 Client ID'], ['cookieName', '网关认证 Cookie 名称'], ['redirectPort', '服务器回调端口（可选）']];

export function ProviderSettings({ api, epoch, onChanged, enabled = true }: { api: Api; epoch: string; onChanged: () => void; enabled?: boolean }) {
  const resource = useResource(epoch, signal => api.call('system/provider/read', {}, signal));
  const [kind, setKind] = useState('chatgpt'), [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [apiKey, setApiKey] = useState(''), [clearKey, setClearKey] = useState(false), [saved, setSaved] = useState(false), [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [gateway, setGateway] = useState<Gateway>(emptyGateway), [gatewayConsent, setGatewayConsent] = useState('');
  const [region, setRegion] = useState('');
  const dirty = useRef(false), baseRevision = useRef<unknown>(undefined), [conflict, setConflict] = useState(false);
  const action = useExtensionAction(api, enabled, () => { resource.refresh(); onChanged(); });
  const gatewayScope = JSON.stringify({ baseUrl, gateway }), isGateway = kind === 'chatgpt-gateway';
  const isBedrock = kind === 'bedrock-runtime' || kind === 'bedrock-mantle', usesKey = ['responses', 'zhipu-coding', 'bedrock-runtime', 'bedrock-mantle'].includes(kind);
  useEffect(() => {
    if (resource.data && dirty.current) { setConflict(resource.data.revision !== baseRevision.current); return; }
    if (!resource.data) return;
    baseRevision.current = resource.data.revision; setConflict(false); setKind(String(resource.data.kind));
    setBaseUrl(String(resource.data.baseUrl ?? '')); setModel(String(resource.data.model ?? '')); setEffort(String(resource.data.effort ?? ''));
    setRegion(String(resource.data.region ?? ''));
    setApiKey(''); setClearKey(false); setAllowInsecureHttp(resource.data.allowInsecureHttp === true); setGatewayConsent('');
    const oauth = object(resource.data.gatewayOAuth);
    setGateway(Object.fromEntries(gatewayFields.map(([key]) => [key, String(oauth[key] ?? '')])) as Gateway);
  }, [resource.data]);
  const save = async () => {
    if (!resource.data || conflict || action.disabled || isGateway && gatewayConsent !== gatewayScope) return;
    setSaved(false);
    const params = {
      expectedRevision: baseRevision.current, kind,
      ...(kind === 'responses' ? { baseUrl, allowInsecureHttp } : {}),
      ...(isBedrock ? { region } : {}),
      ...(isGateway ? { baseUrl, confirmGatewayCredentials: true, gatewayOAuth: {
        authorizationUrl: gateway.authorizationUrl, tokenUrl: gateway.tokenUrl, clientId: gateway.clientId,
        cookieName: gateway.cookieName, ...(gateway.redirectPort ? { redirectPort: Number(gateway.redirectPort) } : {}),
      } } : {}),
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(usesKey ? apiKey ? { apiKey } : clearKey ? { apiKey: '' } : {} : {}),
    };
    // Secret input is intentionally not retained while a result is uncertain.
    setApiKey('');
    if (await action.run('system/provider/write', params, '配置已保存，正在读取新运行环境。')) { dirty.current = false; setSaved(true); resource.refresh(); }
  };
  return <div className="stack">
    <ExtensionStatus api={api} action={action} recoveryLabel="查询原供应商配置回执"/>
    <form className="settings-form stack" onChange={() => { dirty.current = true; setSaved(false); }} onKeyDown={e => { if (e.key === 'Enter' && composing(e)) e.preventDefault(); }} onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset className="provider-fields stack" disabled={action.busy}>
        <h3>模型供应商</h3><p className="muted">配置只影响此 Harness 的独立运行环境。自定义服务需要支持 Responses API、流式输出及工具调用。保存会重启原生服务。</p>
        {resource.loading && <p role="status">读取配置中…</p>}
        {resource.error && <p role="alert" className="error">{resource.error}<button type="button" className="button small" onClick={resource.refresh}>重新读取</button></p>}
        <label className="field">供应商<select value={kind} onChange={e => { setKind(e.target.value); setSaved(false); setApiKey(''); setClearKey(false); setAllowInsecureHttp(false); setGatewayConsent(''); }}>
          <option value="chatgpt">ChatGPT 账户</option><option value="responses">自定义 Responses 服务</option><option value="zhipu-coding">智谱 Coding Plan</option><option value="chatgpt-gateway">ChatGPT 经企业网关（OAuth）</option><option value="bedrock-runtime">Amazon Bedrock Runtime</option><option value="bedrock-mantle">Amazon Bedrock Mantle</option>
        </select></label>
        {['responses', 'chatgpt-gateway'].includes(kind) && <label className="field">{isGateway ? '网关 Codex Base URL' : 'API Base URL'}<input type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required placeholder={isGateway ? 'https://gateway.example/backend-api/codex' : 'https://your-provider.example/v1'}/></label>}
        {kind === 'zhipu-coding' && <p className="small muted">服务地址：https://open.bigmodel.cn/api/v1</p>}
        {isBedrock && <><label className="field">AWS 区域<input value={region} onChange={e => { setRegion(e.target.value); setApiKey(''); }} required placeholder="us-east-1"/></label><p>使用该区域的 Bedrock Bearer API Key。区域与服务地址由管理配置固定，模型目录由原生 CLI 提供；模型及账户权限仍以 AWS 实际开放情况为准。</p><p className="small muted">此入口支持商业区域的 Bearer Key。不会读取个人 AWS profile、共享凭据文件或实例角色；中国区、GovCloud 与隔离区不适用此配置。</p></>}
        {usesKey && <>
          <label className="field">API Key<input type="password" autoComplete="off" disabled={clearKey} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={resource.data?.kind === kind && resource.data?.hasApiKey ? '供应商与地址未变时，留空保留密钥' : '输入此供应商的 API Key'}/></label>
          <p className="small muted">更改供应商或服务地址不会沿用旧密钥。密钥不写入浏览器持久存储。</p>
          {kind === 'responses' && baseUrl.startsWith('http://') && <label className="check-row"><input type="checkbox" checked={allowInsecureHttp} onChange={e => setAllowInsecureHttp(e.target.checked)}/>允许向私有 HTTP 地址发送 API Key（连接未加密）</label>}
          {kind === 'responses' && <label className="check-row"><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(''); }}/>不使用 API Key（明确留空）</label>}
        </>}
        {isGateway && <>
          <p>此网关需要代理 Codex 的 models 与 responses 路径，并支持 OAuth 授权码与 PKCE。ChatGPT 登录和网关授权是两个独立步骤；保存后在“模型账户”中完成。</p>
          {gatewayFields.map(([key, label]) => <label className="field" key={key}>{label}<input type={key.endsWith('Url') ? 'url' : key === 'redirectPort' ? 'number' : 'text'} {...(key === 'redirectPort' ? { min: 1024, max: 65535 } : { required: true })} value={gateway[key]} onChange={e => setGateway(current => ({ ...current, [key]: e.target.value }))}/></label>)}
          <p className="small muted">回调端口留空由原生服务选择。浏览器不在执行服务器上时，需要 SSH 转发该回调端口。授权地址和 Token 地址必须使用 HTTPS。</p>
          <label className="check-row"><input type="checkbox" checked={gatewayConsent === gatewayScope} onChange={e => setGatewayConsent(e.target.checked ? gatewayScope : '')}/>我已核对以上目标；此网关会收到 ChatGPT 凭据与模型请求内容</label>
        </>}
        <label className="field">默认模型 ID<input value={model} onChange={e => setModel(e.target.value)} placeholder="由供应商实际支持的模型"/></label>
        <label className="field">默认推理强度<input value={effort} onChange={e => setEffort(e.target.value)} placeholder="留空采用供应商默认值"/></label>
        {conflict && <p role="alert" className="error">已保存的配置发生变化；你的编辑已保留。请重新读取配置后再修改。<button type="button" className="button small" onClick={() => { dirty.current = false; resource.refresh(); }}>放弃编辑并重新读取</button></p>}
        {saved && <p role="status" className="success">配置已保存。</p>}
        <button className="button primary" type="submit" disabled={action.disabled || !resource.data || conflict || isGateway && gatewayConsent !== gatewayScope}>{action.busy ? '正在保存…' : '保存配置'}</button>
      </fieldset>
    </form>
    {resource.data && <><hr/><ModelCatalog key={String(resource.data.revision)} api={api} provider={resource.data} enabled={enabled} onApplied={() => { resource.refresh(); onChanged(); }}/></>}
  </div>;
}
