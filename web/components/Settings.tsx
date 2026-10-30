import { useState } from 'react';
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
export function Settings({
  api,
  epoch,
  events,
  projects,
  theme,
  onTheme,
  onClose,
  onChanged,
  onProjectsChanged,
  onLogout,
  onOpenDraft,
  onOpenThread,
  configurationReady = true,
  connectionId = '',
  runtimeEpoch = epoch,
  projectId,
  threadId = '',
  threadReady = false,
  threadIdle = false,
  lease = epoch,
  connected = true,
  initialTab = 'general',
  onOpenNativeTerminal,
}: {
  initialTab?: 'general' | 'admin' | 'provider';
  onOpenNativeTerminal?: (projectId: string) => void;
  runtimeEpoch?: string;
  connectionId?: string;
  threadId?: string;
  threadReady?: boolean;
  threadIdle?: boolean;
  lease?: string;
  connected?: boolean;
  configurationReady?: boolean;
  projectId?: string;
  api: Api;
  epoch: string;
  events: Events;
  projects: Project[];
  theme: string;
  onTheme: (theme: string) => void;
  onClose: () => void;
  onChanged: () => void;
  onProjectsChanged: () => void;
  onLogout: () => Promise<void>;
  onOpenDraft: (key: string) => void;
  onOpenThread?: (id: string) => void;
}) {
  const [visited, setVisited] = useState<string[]>([initialTab]);
  const [tab, setTab] = useState<string>(initialTab),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const tabs = [
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
    <Dialog title="设置" onClose={onClose} wide>
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
                  <button
                    className="button small"
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      setBusy(p.id);
                      setError('');
                      try {
                        await api.mutate('project/remove', { id: p.id });
                        onProjectsChanged();
                      } catch (e) {
                        setError(message(e));
                      } finally {
                        setBusy('');
                      }
                    }}
                  >
                    移除项目
                  </button>
                </div>
              ))}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}
          {tab === 'drafts' && <DraftsSettings projects={projects} onOpen={onOpenDraft} />}
          {tab === 'operations' && <OperationHistory api={api} runtimeReady={configurationReady && connected}
            recoveryEpoch={epoch} openThread={onOpenThread ?? (() => {})} />}
          {tab === 'security' && <section className="stack">
            <SecuritySettings key={api.csrf} api={api} authenticated={Boolean(api.csrf)} />
            <button className="button" onClick={() => void onLogout().catch((e) => setError(message(e)))}>退出工作台登录</button>
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
                onOpenNativeTerminal={onOpenNativeTerminal}
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
              <AdminSettings api={api} epoch={epoch} />
              <CliDiagnosticsPanel
                api={api}
                epoch={runtimeEpoch}
                connectionId={connectionId}
                connected={connected}
                enabled={configurationReady}
              />
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
