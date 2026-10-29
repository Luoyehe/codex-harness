import { useRef, useState, type ComponentProps } from 'react';
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
function ExtensionsPanelContent({
  api,
  projects,
  initialProjectId,
  epoch,
  enabled,
  onChanged,
  threadId = '',
  onOpenNativeTerminal,
  visible = true,
}: {
  visible?: boolean;
  onOpenNativeTerminal?: (projectId: string) => void;
  threadId?: string;
  api: Api;
  projects: Project[];
  initialProjectId?: string;
  epoch: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? ''),
    [tab, setTab] = useState('skills');
  const [visited, setVisited] = useState(() => new Set(['skills']));
  const project = projects.find((row) => row.id === projectId),
    tabs = [
      ['skills', '技能与 Hooks'],
      ['plugins', '插件与市场'],
      ['apps', 'Apps'],
      ['sharing', '插件共享'],
      ['import', '导入'],
      ['config', '配置与功能'],
      ['insights', '记忆与诊断'],
    ];
  return (
    <section className="extensions-panel stack" hidden={!visible} inert={!visible}
      onClickCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}
      onSubmitCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}>
      <label className="field">
        扩展与配置的项目范围
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">选择已注册项目</option>
          {projects.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <nav className="extension-tabs" aria-label="扩展类别">
        {tabs.map(([id, name]) => (
          <button
            className={`button small ${tab === id ? 'selected' : ''}`}
            key={id}
            aria-pressed={tab === id}
            onClick={() => { setVisited((current) => new Set([...current, id!])); setTab(id!); }}
          >
            {name}
          </button>
        ))}
      </nav>
      {!enabled && (
        <p className="connection-banner">
          配置变更需要运行时就绪且没有正在执行的任务、终端或未知操作。当前仍可读取状态。
        </p>
      )}
      {project && visited.has('skills') && (
        <section hidden={!visible || tab !== 'skills'} inert={!visible || tab !== 'skills'}>
          <SkillSettings onOpenNativeTerminal={onOpenNativeTerminal} projects={projects}
            key={project.id + ':' + project.cwd} api={api} project={project} epoch={epoch}
            visible={visible && tab === 'skills'} enabled={enabled} onChanged={onChanged} />
        </section>
      )}
      {project && visited.has('plugins') && (
        <section hidden={!visible || tab !== 'plugins'} inert={!visible || tab !== 'plugins'}>
          <PluginSettings key={project.id + ':' + project.cwd} api={api} project={project}
            epoch={epoch} visible={visible && tab === 'plugins'} enabled={enabled} onChanged={onChanged} />
        </section>
      )}
      {visited.has('sharing') && (
        <section hidden={!visible || tab !== 'sharing'} inert={!visible || tab !== 'sharing'}>
          <PluginSharing key={projectId + ':' + project?.cwd} api={api} epoch={epoch}
            visible={visible && tab === 'sharing'} enabled={enabled} onChanged={onChanged} project={project} />
        </section>
      )}
      {!visible ? null : tab === 'apps' ? (
        <AppCatalog api={api} epoch={epoch} />
      ) : tab === 'insights' ? (
        <>
          {project ? (
            <MemorySettings
              key={project.id}
              api={api}
              project={project}
              epoch={epoch}
              enabled={enabled}
              onChanged={onChanged}
            />
          ) : (
            <p className="muted">选择已注册项目后可读取实际记忆配置来源并修改全局开关。</p>
          )}
          <RuntimeInsights api={api} epoch={epoch} enabled={enabled} onChanged={onChanged} />
          <DiagnosticsPanel
            key={epoch + ':' + projectId + ':' + threadId}
            api={api}
            epoch={epoch}
            enabled={enabled}
            onChanged={onChanged}
            project={project}
            threadId={projectId === initialProjectId ? threadId : ''}
          />
        </>
      ) : tab === 'sharing' ? null : !project ? (
        <p className="muted">请选择一个已注册项目。</p>
      ) : tab === 'import' ? (
        <ImportPanel
          key={project.id}
          api={api}
          project={project}
          epoch={epoch}
          enabled={enabled}
          onChanged={onChanged}
        />
      ) : tab === 'skills' || tab === 'plugins' ? null : (
        <>
          <ProjectTrustSettings
            key={project.id + ':' + epoch}
            api={api}
            project={project}
            epoch={epoch}
            enabled={enabled}
            onChanged={onChanged}
          />
          <ConfigSettings
            key={project.id}
            api={api}
            project={project}
            epoch={epoch}
            enabled={enabled}
            onChanged={onChanged}
          />
        </>
      )}
    </section>
  );
}

export function ExtensionsPanel(props: ComponentProps<typeof ExtensionsPanelContent>) {
  const owner = useRef({ api: props.api, epoch: props.epoch, threadId: props.threadId,
    initialProjectId: props.initialProjectId, generation: 0 });
  if (owner.current.api !== props.api || owner.current.epoch !== props.epoch ||
    owner.current.threadId !== props.threadId || owner.current.initialProjectId !== props.initialProjectId)
    owner.current = { api: props.api, epoch: props.epoch, threadId: props.threadId,
      initialProjectId: props.initialProjectId, generation: owner.current.generation + 1 };
  return <ExtensionsPanelContent key={owner.current.generation} {...props} />;
}
