import { useMemo, useRef, useState, type ComponentProps } from 'react';
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
import { DiagnosticsSnapshot } from '../hooks/useDiagnostics';
import { SettingsDrafts, hasSettingsDrafts, useSettingsDraft, useSettingsNavigation } from '../hooks/useSettingsDraft';
import { Dialog } from './Dialog';
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
  const drafts = useRef(new Set<() => boolean>());
  useSettingsDraft(() => hasSettingsDrafts(drafts.current));
  const projectScopes = JSON.stringify(projects.map(({ id, cwd }) => [id, cwd]));
  const navigationOwner = useMemo(() => ({}), [api, api.csrf, epoch, projectId, projectScopes, visible]);
  const navigation = useSettingsNavigation(drafts.current, navigationOwner);
  const project = projects.find((row) => row.id === projectId),
    tabs = [
      ['skills', '技能与 Hooks'],
      ['plugins', '插件与市场'],
      ['apps', '应用'],
      ['sharing', '插件共享'],
      ['import', '导入'],
      ['config', '配置与功能'],
      ['insights', '记忆与诊断'],
    ];
  return (
    <SettingsDrafts.Provider value={drafts.current}>
    <section className="extensions-panel stack" hidden={!visible} inert={!visible}
      onClickCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}
      onSubmitCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}>
      <label className="field">
        扩展与配置的项目范围
        <select value={projectId} onChange={(event) => {
          const target = event.target.value, destination = projects.find(row => row.id === target);
          if (!visible || target === projectId || target && !destination) return;
          navigation.request(() => setProjectId(target), '放弃编辑并切换项目',
            `切换到${destination ? `“${destination.name}”` : '未选择项目'}后，当前项目中尚未保存的编辑将丢失；已保留的文件草稿不受影响。`);
        }}>
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
      {visible && tab === 'apps' && (
        <AppCatalog api={api} epoch={epoch} />
      )}
      {visited.has('insights') && <section hidden={!visible || tab !== 'insights'} inert={!visible || tab !== 'insights'}>
        <DiagnosticsSnapshot api={api} epoch={epoch} visible={visible && tab === 'insights'}>
          {project ? (
            <MemorySettings
              key={project.id}
              api={api}
              project={project}
              epoch={epoch}
              enabled={enabled}
              visible={visible && tab === 'insights'}
              onChanged={onChanged}
            />
          ) : (
            <p className="muted">选择已注册项目后可读取实际记忆配置来源并修改全局开关。</p>
          )}
          <RuntimeInsights api={api} epoch={epoch} enabled={enabled} visible={visible && tab === 'insights'} onChanged={onChanged} />
          <DiagnosticsPanel
            key={epoch + ':' + projectId + ':' + threadId}
            api={api}
            epoch={epoch}
            enabled={enabled}
            visible={visible && tab === 'insights'}
            onChanged={onChanged}
            project={project}
            threadId={projectId === initialProjectId ? threadId : ''}
          />
        </DiagnosticsSnapshot>
      </section>}
      {!project && !['apps', 'insights', 'sharing'].includes(tab) && (
        <p className="muted">请选择一个已注册项目。</p>
      )}
      {project && visited.has('import') && <section hidden={!visible || tab !== 'import'} inert={!visible || tab !== 'import'}>
        <ImportPanel
          key={project.id}
          api={api}
          project={project}
          epoch={epoch}
          enabled={enabled}
          visible={visible && tab === 'import'}
          onChanged={onChanged}
        />
      </section>}
      {project && visited.has('config') && <section hidden={!visible || tab !== 'config'} inert={!visible || tab !== 'config'}>
          <ProjectTrustSettings
            key={project.id + ':' + epoch}
            api={api}
            project={project}
            epoch={epoch}
            enabled={enabled}
            visible={visible && tab === 'config'}
            onChanged={onChanged}
          />
          <ConfigSettings
            key={project.id}
            api={api}
            project={project}
            epoch={epoch}
            enabled={enabled}
            visible={visible && tab === 'config'}
            onChanged={onChanged}
          />
      </section>}
      {navigation.intent && <Dialog title="放弃当前项目的未保存编辑？" onClose={navigation.cancel}>
        <p>{navigation.intent.detail}</p>
        <div className="inline wrap">
          <button className="button primary" onClick={navigation.cancel}>继续编辑</button>
          <button className="button danger" onClick={navigation.confirm}>{navigation.intent.label}</button>
        </div>
      </Dialog>}
    </section>
    </SettingsDrafts.Provider>
  );
}

export function ExtensionsPanel(props: ComponentProps<typeof ExtensionsPanelContent>) {
  const owner = useRef({ api: props.api, csrf: props.api.csrf, epoch: props.epoch, threadId: props.threadId,
    initialProjectId: props.initialProjectId, generation: 0 });
  if (owner.current.api !== props.api || owner.current.csrf !== props.api.csrf || owner.current.epoch !== props.epoch ||
    owner.current.threadId !== props.threadId || owner.current.initialProjectId !== props.initialProjectId)
    owner.current = { api: props.api, csrf: props.api.csrf, epoch: props.epoch, threadId: props.threadId,
      initialProjectId: props.initialProjectId, generation: owner.current.generation + 1 };
  return <ExtensionsPanelContent key={owner.current.generation} {...props} />;
}
