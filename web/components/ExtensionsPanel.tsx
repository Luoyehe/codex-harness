import { useState } from 'react';
import type { Api } from '../lib/api';
import type { Project } from '../lib/types';
import { SkillSettings } from './SkillSettings';
import { PluginSettings } from './PluginSettings';
import { ConfigSettings } from './ConfigSettings';
import { AppCatalog, RuntimeInsights } from './RuntimeInsights';
import { MemorySettings } from './MemorySettings';
import { ImportPanel } from './ImportPanel';
import { PluginSharing } from './PluginSharing';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ProjectTrustSettings } from './ProjectTrustSettings';
export function ExtensionsPanel({ api, projects, initialProjectId, epoch, enabled, onChanged, threadId = '', onOpenNativeTerminal }: { onOpenNativeTerminal?: (projectId: string) => void; threadId?: string; api: Api; projects: Project[]; initialProjectId?: string; epoch: string; enabled: boolean; onChanged: () => void }) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? ''), [tab, setTab] = useState('skills');
  const project = projects.find(row => row.id === projectId), tabs = [['skills', '技能与 Hooks'], ['plugins', '插件与市场'], ['apps', 'Apps'], ['sharing', '插件共享'], ['import', '导入'], ['config', '配置与功能'], ['insights', '记忆与诊断']];
  return <section className="extensions-panel stack"><label className="field">扩展与配置的项目范围<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">选择已注册项目</option>{projects.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><nav className="extension-tabs" aria-label="扩展类别">{tabs.map(([id, name]) => <button className={`button small ${tab === id ? 'selected' : ''}`} key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{name}</button>)}</nav>{!enabled && <p className="connection-banner">配置变更需要运行时就绪且没有正在执行的任务、终端或未知操作。当前仍可读取状态。</p>}{tab === 'apps' ? <AppCatalog api={api} epoch={epoch}/> : tab === 'insights' ? <>{project ? <MemorySettings key={project.id} api={api} project={project} epoch={epoch} enabled={enabled} onChanged={onChanged}/> : <p className="muted">选择已注册项目后可读取实际记忆配置来源并修改全局开关。</p>}<RuntimeInsights api={api} epoch={epoch} enabled={enabled} onChanged={onChanged}/><DiagnosticsPanel key={epoch + ':' + projectId + ':' + threadId} api={api} epoch={epoch} enabled={enabled} onChanged={onChanged} project={project} threadId={projectId === initialProjectId ? threadId : ''}/></> : tab === 'sharing' ? <PluginSharing key={epoch + ':' + projectId} api={api} epoch={epoch} enabled={enabled} onChanged={onChanged} project={project}/> : !project ? <p className="muted">请选择一个已注册项目。</p> : tab === 'import' ? <ImportPanel key={project.id} api={api} project={project} epoch={epoch} enabled={enabled} onChanged={onChanged}/> : tab === 'skills' ? <SkillSettings onOpenNativeTerminal={onOpenNativeTerminal} projects={projects} key={project.id} api={api} project={project} epoch={epoch} enabled={enabled} onChanged={onChanged}/> : tab === 'plugins' ? <PluginSettings key={project.id} api={api} project={project} epoch={epoch} enabled={enabled} onChanged={onChanged}/> : <><ProjectTrustSettings key={project.id + ":" + epoch} api={api} project={project} epoch={epoch} enabled={enabled} onChanged={onChanged}/><ConfigSettings key={project.id} api={api} project={project} epoch={epoch} enabled={enabled} onChanged={onChanged}/></>}</section>;
}
