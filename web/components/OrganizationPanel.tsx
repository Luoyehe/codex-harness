import { useState } from 'react';
import type { Api } from '../lib/api';
import type { Project } from '../lib/types';
import { Dialog } from './Dialog';
import { NativeProjects } from './NativeProjects';
import { SectionSettings, ThreadOrganization } from './ThreadOrganization';
export function OrganizationPanel({
  api,
  epoch,
  projects,
  projectId,
  threadId,
  enabled,
  threadReady,
  threadIdle,
  globalIdle,
  onChanged,
  onDeleted,
  onOpenThread,
  onClose,
}: {
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
}) {
  const [tab, setTab] = useState(threadId ? 'thread' : 'projects');
  return (
    <Dialog title="会话组织" onClose={onClose} wide>
      <section className="stack organization-panel">
        <nav className="extension-tabs" aria-label="会话组织类别">
          {[
            ['thread', '当前会话'],
            ['projects', '会话项目'],
            ['sections', '分区'],
          ].map(([id, label]) => (
            <button
              className={`button small ${tab === id ? 'selected' : ''}`}
              aria-pressed={tab === id}
              key={id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {!enabled && (
          <p className="connection-banner">运行时连接或操作状态尚未就绪，暂不能更改组织。</p>
        )}
        {tab === 'projects' ? (
          <NativeProjects
            api={api}
            epoch={epoch}
            projects={projects}
            threadId={threadId}
            threadEnabled={threadReady}
            idle={globalIdle}
            enabled={enabled}
            onChanged={onChanged}
          />
        ) : tab === 'sections' ? (
          <SectionSettings api={api} epoch={epoch} enabled={enabled} onChanged={onChanged} />
        ) : (
          <ThreadOrganization
            key={threadId}
            api={api}
            epoch={epoch}
            threadId={threadId}
            project={projects.find((project) => project.id === projectId)}
            enabled={enabled}
            ready={threadReady}
            idle={threadIdle}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onOpenThread={onOpenThread}
          />
        )}
      </section>
    </Dialog>
  );
}
