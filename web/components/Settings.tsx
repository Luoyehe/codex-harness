import { useMemo, useRef, useState } from 'react';
import { AdminSettings } from './AdminSettings';
import { InputPreferences } from './InputPreferences';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { message, type Project } from '../lib/types';
import { Dialog } from './Dialog';
import { ProviderSettings } from './ProviderSettings';
import { AccountToolsPanel } from './AccountToolsPanel';
import { AccountSettings } from './AccountSettings';
import { DraftsSettings } from './DraftsSettings';
import { ExtensionsPanel } from './ExtensionsPanel';
import { RemoteSettings } from './RemoteSettings';
import { McpPanel } from './McpPanel';
import { CliDiagnosticsPanel } from './CliDiagnosticsPanel';
import { SecuritySettings } from './SecuritySettings';
import { OperationHistory } from './OperationHistory';
import type { DraftMode } from '../lib/drafts';
import { SettingsDrafts, useSettingsNavigation } from '../hooks/useSettingsDraft';
export function Settings({
  api,
  epoch,
  events,
  projects,
  theme,
  onTheme,
  onClose,
  onRecover,
  onChanged,
  onProjectAction,
  onLogout,
  onOpenDraft,
  onOpenThread,
  configurationReady = true,
  managementReady,
  connectionId = '',
  runtimeEpoch = epoch,
  projectId,
  threadId = '',
  threadReady = false,
  historyComplete = false,
  threadIdle = false,
  lease = epoch,
  connected = true,
  initialTab = 'general',
  onOpenNativeTerminal,
  draftMode = 'native',
  navigationError = '',
}: {
  initialTab?: 'general' | 'admin' | 'provider' | 'projects';
  onOpenNativeTerminal?: (projectId: string) => void;
  runtimeEpoch?: string;
  connectionId?: string;
  threadId?: string;
  threadReady?: boolean;
  historyComplete?: boolean;
  threadIdle?: boolean;
  lease?: string;
  connected?: boolean;
  configurationReady?: boolean;
  managementReady?: boolean;
  projectId?: string;
  api: Api;
  epoch: string;
  events: Events;
  projects: Project[];
  theme: string;
  onTheme: (theme: string) => void;
  onClose: () => void;
  onRecover?: () => void;
  onChanged: () => void;
  onProjectAction: (project: Project, action: 'rename' | 'remove') => void;
  onLogout: () => Promise<void>;
  onOpenDraft: (key: string) => void;
  onOpenThread?: (id: string) => void;
  draftMode?: DraftMode;
  navigationError?: string;
}) {
  const [visited, setVisited] = useState<string[]>([initialTab]);
  const logoutRunning = useRef(false);
  const drafts = useRef(new Set<() => boolean>());
  const projectScopes = JSON.stringify(projects.map(({ id, cwd }) => [id, cwd]));
  const navigationOwner = useMemo(() => ({}), [api, api.csrf, epoch, runtimeEpoch, connectionId, projectId, threadId, projectScopes]);
  const navigation = useSettingsNavigation(drafts.current, navigationOwner);
  const [loggingOut, setLoggingOut] = useState(false);
  const [tab, setTab] = useState<string>(initialTab),
    [error, setError] = useState('');
  const tabs: ReadonlyArray<readonly [string, string]> = [
    ['general', '通用'],
    ['provider', '模型供应商'],
    ['projects', '项目目录'],
    ['extensions', '扩展与配置'],
    ['mcp', 'MCP'],
    ['remote', '远端环境与连接'],
    ['drafts', '本地草稿'],
    ['operations', '操作记录'],
    ['security', '账号与安全'],
    ['admin', '服务管理'],
  ];
  return (
    <Dialog title="设置" onClose={() => navigation.request(onClose, '放弃编辑并关闭')} wide>
      <SettingsDrafts.Provider value={drafts.current}>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置类别">
          {tabs.map(([id, name]) => (
            <button
              className={`nav-item ${tab === id ? 'selected' : ''}`}
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => {
                setVisited((previous) => (previous.includes(id) ? previous : [...previous, id]));
                setTab(id);
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {navigationError && <p className="error" role="alert">{navigationError}</p>}
          {tab === 'general' && (
            <section className="stack">
              <h3>外观</h3>
              <label className="field">
                主题
                <select value={theme} onChange={(e) => onTheme(e.target.value)}>
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>
              <InputPreferences />
            </section>
          )}
          {tab === 'projects' && (
            <section className="stack">
              <h3>已注册项目</h3>
              <p className="muted">移除只取消项目注册，不删除目录或历史文件。</p>
              {projects.map((p) => (
                <div className="info-card" key={p.id}>
                  <strong>{p.name}</strong>
                  <p className="small path">{p.cwd}</p>
                  <div className="inline">
                    <button className="button small" onClick={() => navigation.request(() => onProjectAction(p, 'rename'), '放弃编辑并重命名项目')}>重命名项目</button>
                    <button className="button small" onClick={() => navigation.request(() => onProjectAction(p, 'remove'), '放弃编辑并移除项目')}>移除项目</button>
                  </div>
                </div>
              ))}
            </section>
          )}
          {tab === 'drafts' && <DraftsSettings projects={projects} onOpen={(key) => navigation.request(() => onOpenDraft(key), '放弃编辑并打开草稿')} draftMode={draftMode} />}
          {tab === 'operations' && <OperationHistory api={api} runtimeReady={configurationReady && connected}
            recoveryEpoch={epoch} openThread={(id) => { if (onOpenThread) navigation.request(() => onOpenThread(id), '放弃编辑并打开会话'); }} />}
          {tab === 'security' && <section className="stack">
            <SecuritySettings key={api.csrf} api={api} authenticated={Boolean(api.csrf)} />
            <button className="button" disabled={loggingOut} onClick={() => navigation.request(() => { void (async () => {
              if (logoutRunning.current) return;
              logoutRunning.current = true; setLoggingOut(true); setError('');
              try { await onLogout(); } catch (e) { setError(message(e)); }
              finally { logoutRunning.current = false; setLoggingOut(false); }
            })(); }, '放弃编辑并退出登录')}>{loggingOut ? '正在退出…' : '退出工作台登录'}</button>
            {error && <p className="error" role="alert">{error}</p>}
          </section>}
          {visited.includes('provider') && (
            <div hidden={tab !== 'provider'} inert={tab !== 'provider'}>
              <ProviderSettings
                visible={tab === 'provider'}
                enabled={configurationReady && connected}
                api={api}
                epoch={epoch}
                onChanged={onChanged}
                accountPanel={(provider, isDefault) => <div className="stack provider-account">
                  <p className="small muted">ChatGPT 登录由本实例的 ChatGPT 供应商共享；API Key 在各自供应商配置中管理。</p>
                  <AccountSettings api={api} epoch={runtimeEpoch} connectionId={connectionId}
                    connected={connected} enabled={configurationReady && connected} events={events}
                    onServiceSettings={() => setTab('admin')} />
                  {isDefault && <AccountToolsPanel api={api} events={events} epoch={runtimeEpoch} connectionId={connectionId}
                    enabled={configurationReady} connected={connected} onChanged={onChanged} />}
                  {!isDefault && provider.kind === 'chatgpt-gateway' && <p className="small muted">需要网关 OAuth 授权时，先将此供应商设为默认，再在这里完成网关授权。</p>}
                </div>}
              />
            </div>
          )}{' '}
          {visited.includes('extensions') && (
            <div hidden={tab !== 'extensions'} inert={tab !== 'extensions'}>
              <ExtensionsPanel
                visible={tab === 'extensions'}
                onOpenNativeTerminal={onOpenNativeTerminal ? (id) => navigation.request(() => onOpenNativeTerminal(id), '放弃编辑并打开终端') : undefined}
                threadId={threadId}
                api={api}
                projects={projects}
                initialProjectId={projectId}
                epoch={epoch}
                enabled={configurationReady}
                onChanged={onChanged}
              />
            </div>
          )}{' '}
          {visited.includes('mcp') && (
            <div hidden={tab !== 'mcp'} inert={tab !== 'mcp'}>
              <McpPanel
                onServiceSettings={() => navigation.request(() => setTab('admin'), '切换到服务管理')}
                visible={tab === 'mcp'}
                runtimeEpoch={runtimeEpoch}
                projectId={projectId ?? ''}
                api={api}
                events={events}
                epoch={epoch}
                lease={lease}
                connected={connected}
                threadId={threadId}
                threadReady={threadReady}
                historyComplete={historyComplete}
                threadIdle={threadIdle}
                configurationReady={configurationReady}
              />
            </div>
          )}{' '}
          {visited.includes('remote') && (
            <div hidden={tab !== 'remote'} inert={tab !== 'remote'}>
              <RemoteSettings
                visible={tab === 'remote'}
                api={api}
                events={events}
                epoch={runtimeEpoch}
                connectionId={connectionId}
                connected={connected}
                enabled={configurationReady}
                onChanged={onChanged}
              />
            </div>
          )}{' '}
          {tab === 'admin' && (
            <div className="stack">
              <AdminSettings api={api} epoch={epoch} configurationReady={managementReady ?? (configurationReady && connected)} onRecover={onRecover} />
              <CliDiagnosticsPanel
                api={api}
                epoch={runtimeEpoch}
                connectionId={connectionId}
                connected={connected}
                enabled={connected}
              />
            </div>
          )}
        </div>
      </div>
      </SettingsDrafts.Provider>
      {navigation.intent && <Dialog title="放弃未保存的设置？" onClose={navigation.cancel}>
        <p>{navigation.intent.detail}</p>
        <div className="inline wrap">
          <button className="button primary" onClick={navigation.cancel}>继续编辑</button>
          <button className="button danger" onClick={navigation.confirm}>{navigation.intent.label}</button>
        </div>
      </Dialog>}
    </Dialog>
  );
}
