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
  initialTab?: 'general' | 'admin';
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
}) {
  const [accountMounted, setAccountMounted] = useState(false);
  const [tab, setTab] = useState<string>(initialTab),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const tabs = [
    ['general', '通用'],
    ['provider', '模型供应商'],
    ['account', '模型账户'],
    ['extensions', '扩展与配置'],
    ['mcp', 'MCP'],
    ['remote', '远端环境与连接'],
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
                if (id === 'account') setAccountMounted(true);
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
              <hr />
              <DraftsSettings projects={projects} onOpen={onOpenDraft} />
              <hr />
              <button
                className="button"
                onClick={() => void onLogout().catch((e) => setError(message(e)))}
              >
                退出工作台登录
              </button>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}
          {tab === 'provider' && (
            <ProviderSettings
              enabled={configurationReady && connected}
              api={api}
              epoch={epoch}
              onChanged={onChanged}
            />
          )}{' '}
          {accountMounted && (
            <div className="stack" hidden={tab !== 'account'}>
              <AccountSettings
                api={api}
                epoch={runtimeEpoch}
                connectionId={connectionId}
                connected={connected}
                enabled={configurationReady && connected}
                events={events}
                onServiceSettings={() => setTab('admin')}
              />
              <AccountToolsPanel
                api={api}
                events={events}
                epoch={runtimeEpoch}
                connectionId={connectionId}
                enabled={configurationReady}
                connected={connected}
                onChanged={onChanged}
              />
            </div>
          )}{' '}
          {tab === 'extensions' && (
            <ExtensionsPanel
              onOpenNativeTerminal={onOpenNativeTerminal}
              threadId={threadId}
              api={api}
              projects={projects}
              initialProjectId={projectId}
              epoch={epoch}
              enabled={configurationReady}
              onChanged={onChanged}
            />
          )}{' '}
          {tab === 'mcp' && (
            <McpPanel
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
          )}{' '}
          {tab === 'remote' && (
            <RemoteSettings
              api={api}
              events={events}
              epoch={runtimeEpoch}
              connectionId={connectionId}
              connected={connected}
              enabled={configurationReady}
              onChanged={onChanged}
            />
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
