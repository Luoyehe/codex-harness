import { useState } from 'react';
import type { Api } from '../lib/api';
import type { Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
type Trust = {
  userVersion: string | null;
  configuredTrust: 'trusted' | 'untrusted' | null;
  cwd: string;
  projectLayers: { name: unknown; disabledReason: string | null }[];
};
export function ProjectTrustSettings({
  api,
  project,
  epoch,
  enabled,
  onChanged,
}: {
  api: Api;
  project: Project;
  epoch: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const action = useExtensionAction(api, enabled, onChanged),
    state = useResource(`${project.id}:${epoch}:${action.revision}`, (signal) =>
      api.call<Trust>('project/trust/read', { projectId: project.id }, signal),
    );
  const [choice, setChoice] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const version = state.data?.userVersion;
  const choiceKey = `${project.id}:${version}:${choice}`;
  return (
    <section className="info-card stack">
      <div className="section-heading">
        <h3>项目配置的信任</h3>
        <button className="button small" onClick={action.refresh}>
          重新读取项目信任
        </button>
      </div>
      <ReadState {...state} />
      <ExtensionStatus api={api} action={action} />
      {state.data && (
        <>
          <p className="small path">{state.data.cwd}</p>
          <p>
            此路径的用户配置：
            {state.data.configuredTrust === 'trusted'
              ? '信任'
              : state.data.configuredTrust === 'untrusted'
                ? '不信任'
                : '未单独设置'}
          </p>
          <p className="small muted">
            这里只修改所选路径的用户设置；父目录、仓库根目录和管理策略仍可能参与最终配置。登记项目与信任项目是两个独立动作。
          </p>
          {state.data.projectLayers?.map((layer, index) => (
            <p className={layer.disabledReason ? 'workspace-warning' : 'small muted'} key={index}>
              {layer.disabledReason ?? '一个项目配置层已启用。'}
            </p>
          ))}
          <label className="field">
            新的项目信任选择
            <select
              value={choice}
              onChange={(e) => {
                setChoice(e.target.value);
                setConfirmation('');
              }}
            >
              <option value="">选择需要的变更</option>
              <option value="trusted">信任项目配置</option>
              <option value="untrusted">不信任项目配置</option>
              <option value="default">移除此路径的单独设置</option>
            </select>
          </label>
          <p className="workspace-warning">
            信任项目会允许 Codex 加载其 .codex 配置，可能启用
            MCP、插件或其他执行配置。仅信任你审阅过的项目。此设置不授权新的工作台路径，也不会自动信任
            Hook 内容。
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmation === choiceKey}
              onChange={(e) => setConfirmation(e.target.checked ? choiceKey : '')}
            />
            我已审阅所选项目的配置并确认此次变更
          </label>
          <button
            className="button"
            disabled={action.disabled || !choice || !version || confirmation !== choiceKey}
            onClick={async () => {
              if (
                await action.run(
                  'project/trust/write',
                  {
                    projectId: project.id,
                    expectedVersion: version,
                    trustLevel: choice,
                    confirm: true,
                  },
                  '项目信任设置已保存，下次加载项目时应用；Hook 信任不变。',
                )
              ) {
                setChoice('');
                setConfirmation('');
              }
            }}
          >
            保存项目信任
          </button>
        </>
      )}
    </section>
  );
}
