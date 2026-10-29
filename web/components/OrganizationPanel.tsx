import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import type { Project } from '../lib/types';
import { Dialog } from './Dialog';
import { NativeProjects } from './NativeProjects';
import { SectionSettings, ThreadOrganization } from './ThreadOrganization';

type Props = {
  api: Api;
  epoch: string;
  projects: Project[];
  projectId: string;
  threadId: string;
  enabled: boolean;
  threadReady: boolean;
  threadIdle: boolean;
  globalIdle: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onOpenThread: (id: string) => void;
  onClose: () => void;
};
type Category = 'thread' | 'projects' | 'sections';
function OrganizationSession(props: Props) {
  const initial: Category = props.threadId ? 'thread' : 'projects';
  const [tab, setTab] = useState<Category>(initial);
  const [visited, setVisited] = useState<Record<Category, boolean>>({
    thread: initial === 'thread',
    projects: initial === 'projects',
    sections: false,
  });
  const visit = (next: Category) => {
    setVisited((previous) => (previous[next] ? previous : { ...previous, [next]: true }));
    setTab(next);
  };
  return (
    <Dialog title="会话组织" onClose={props.onClose} wide>
      <section className="stack organization-panel">
        <nav className="extension-tabs" aria-label="会话组织类别">
          {([
            ['thread', '当前会话'],
            ['projects', '会话项目'],
            ['sections', '分区'],
          ] as const).map(([id, label]) => (
            <button
              className={`button small ${tab === id ? 'selected' : ''}`}
              aria-pressed={tab === id}
              key={id}
              onClick={() => visit(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {!props.enabled && (
          <p className="connection-banner">运行时连接或操作状态尚未就绪，暂不能更改组织。</p>
        )}
        {visited.projects && (
          <div hidden={tab !== 'projects'} inert={tab !== 'projects'}>
            <NativeProjects
              api={props.api}
              epoch={props.epoch}
              projects={props.projects}
              threadId={props.threadId}
              threadEnabled={props.threadReady}
              idle={props.globalIdle}
              enabled={props.enabled}
              visible={tab === 'projects'}
              onChanged={props.onChanged}
            />
          </div>
        )}
        {visited.sections && (
          <div hidden={tab !== 'sections'} inert={tab !== 'sections'}>
            <SectionSettings
              api={props.api}
              epoch={props.epoch}
              enabled={props.enabled}
              visible={tab === 'sections'}
              onChanged={props.onChanged}
            />
          </div>
        )}
        {visited.thread && (
          <div hidden={tab !== 'thread'} inert={tab !== 'thread'}>
            <ThreadOrganization
              api={props.api}
              epoch={props.epoch}
              threadId={props.threadId}
              project={props.projects.find((project) => project.id === props.projectId)}
              enabled={props.enabled}
              visible={tab === 'thread'}
              ready={props.threadReady}
              idle={props.threadIdle}
              onChanged={props.onChanged}
              onDeleted={props.onDeleted}
              onOpenThread={props.onOpenThread}
            />
          </div>
        )}
      </section>
    </Dialog>
  );
}
export function OrganizationPanel(props: Props) {
  const owner = useRef({
    api: props.api,
    epoch: props.epoch,
    projectId: props.projectId,
    threadId: props.threadId,
    revision: 0,
  });
  if (
    owner.current.api !== props.api ||
    owner.current.epoch !== props.epoch ||
    owner.current.projectId !== props.projectId ||
    owner.current.threadId !== props.threadId
  )
    owner.current = {
      api: props.api,
      epoch: props.epoch,
      projectId: props.projectId,
      threadId: props.threadId,
      revision: owner.current.revision + 1,
    };
  return <OrganizationSession key={owner.current.revision} {...props} />;
}
