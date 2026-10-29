import { useEffect, useState } from 'react';
import type { PluginListResponse } from '../../protocol/ts/v2/PluginListResponse';
import type { PluginSearchResult } from '../../protocol/ts/v2/PluginSearchResult';
import type { PluginReadResponse } from '../../protocol/ts/v2/PluginReadResponse';
import type { Api } from '../lib/api';
import { safeUrl, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { usePaged } from '../hooks/usePaged';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
export function PluginSettings({
  api,
  project,
  epoch,
  enabled,
  onChanged,
  visible = true,
}: {
  visible?: boolean;
  api: Api;
  project: Project;
  epoch: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const action = useExtensionAction(api, enabled && visible, onChanged, `${project.id}:${epoch}`),
    key = `${project.id}:${epoch}:${action.revision}`;
  const [view, setView] = useState('catalog'),
    [term, setTerm] = useState(''),
    [query, setQuery] = useState(''),
    [scope, setScope] = useState('global'),
    [selected, setSelected] = useState(''),
    [consent, setConsent] = useState(false),
    [skill, setSkill] = useState('');
  const [marketForm, setMarketForm] = useState(false),
    [sourceType, setSourceType] = useState('project'),
    [source, setSource] = useState(''),
    [refName, setRefName] = useState(''),
    [marketConsent, setMarketConsent] = useState(false),
    [marketAction, setMarketAction] = useState<{ method: string; name: string }>();
  const catalog = useResource(
    `${key}:${view}`,
    (signal) =>
      api.call<PluginListResponse>(
        view === 'installed' ? 'plugin/installed' : 'plugin/list',
        { projectId: project.id },
        signal,
      ),
    visible && view !== 'search',
  );
  const search = usePaged<PluginSearchResult>(
    api,
    'plugin/search',
    { projectId: project.id, searchTerm: query, scope },
    `${key}:${query}:${scope}`,
    visible && view === 'search' && Boolean(query),
  );
  const detail = useResource(
    `${key}:${selected}`,
    (signal) =>
      api.call<PluginReadResponse & { previewHash: string }>(
        'plugin/read',
        { projectId: project.id, pluginId: selected },
        signal,
      ),
    visible && Boolean(selected),
  );
  const contents = useResource(
    `${key}:${selected}:${skill}`,
    (signal) =>
      api.call<{ contents: string | null }>(
        'plugin/skill/read',
        { projectId: project.id, pluginId: selected, skillName: skill },
        signal,
      ),
    visible && Boolean(selected && skill),
  );
  useEffect(() => {
    setConsent(false);
    setSkill('');
  }, [selected, detail.data?.previewHash]);
  useEffect(() => { setConsent(false); setMarketConsent(false); setMarketAction(undefined); },
    [visible, enabled, epoch]);
  const rows =
    view === 'search'
      ? search.items
      : (catalog.data?.marketplaces.flatMap((market) =>
          market.plugins.map((plugin) => ({
            plugin,
            marketplaceName: market.name,
            marketplacePath: market.path,
          })),
        ) ?? []);
  const plugin = detail.data?.plugin,
    summary = plugin?.summary;
  const installable =
    summary?.availability === 'AVAILABLE' &&
    summary.installPolicy !== 'NOT_AVAILABLE' &&
    /^[a-f0-9]{64}$/.test(detail.data?.previewHash ?? '');
  const link = (url: unknown, label: string) =>
    safeUrl(url) ? (
      <a href={safeUrl(url)} target="_blank" rel="noreferrer">
        {label} ↗
      </a>
    ) : null;
  return (
    <section className="stack" hidden={!visible} inert={!visible}
      onClickCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}
      onSubmitCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}>
      <div className="section-heading">
        <h3>插件与市场</h3>
        <button className="button small" onClick={action.refresh}>
          重新读取
        </button>
      </div>
      <ExtensionStatus api={api} action={action} />
      <div className="inline wrap">
        <button
          className="button small"
          aria-pressed={view === 'catalog'}
          onClick={() => setView('catalog')}
        >
          插件目录
        </button>
        <button
          className="button small"
          aria-pressed={view === 'installed'}
          onClick={() => setView('installed')}
        >
          已安装
        </button>
        <button
          className="button small"
          disabled={action.disabled}
          onClick={() =>
            void action.run(
              'plugin/reconcile',
              {},
              '插件更新请求已受理，正在读取安装状态；请同时核对 Apps 与 MCP 是否可用。',
            )
          }
        >
          检查并更新已安装插件
        </button>
      </div>
      <form
        className="extension-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (term.trim()) {
            setQuery(term.trim());
            setView('search');
          }
        }}
      >
        <label className="field">
          搜索插件
          <input value={term} onChange={(event) => setTerm(event.target.value)} maxLength={512} />
        </label>
        <label className="field">
          目录范围
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="global">全部目录</option>
            <option value="workspace">工作区</option>
            <option value="personal">个人</option>
          </select>
        </label>
        <button className="button" disabled={!term.trim()}>
          搜索
        </button>
      </form>
      <ReadState
        loading={view === 'search' ? search.loading : catalog.loading}
        error={view === 'search' ? search.error : catalog.error}
      />
      {catalog.data?.marketplaceLoadErrors.map((error, index) => (
        <p className="error" role="alert" key={index}>
          {error.message}
        </p>
      ))}
      <div className="extension-cards">
        {rows.map(({ plugin: item, marketplaceName }) => (
          <button
            className={`extension-card ${selected === item.id ? 'selected' : ''}`}
            key={`${marketplaceName}:${item.id}`}
            onClick={() => setSelected(item.id)}
          >
            <strong>{item.interface?.displayName ?? item.name}</strong>
            <span className="small">
              {item.interface?.shortDescription ?? item.keywords.join(' · ')}
            </span>
            <span className="small muted">
              {marketplaceName} · {item.installed ? '已安装' : '未安装'} ·{' '}
              {item.enabled ? '启用' : '停用'}
            </span>
          </button>
        ))}
      </div>
      {view === 'search' && search.hasMore && (
        <button className="button" disabled={search.loading} onClick={() => void search.more()}>
          更多搜索结果
        </button>
      )}
      {!rows.length &&
        !(view === 'search'
          ? search.loading || search.error
          : catalog.loading || catalog.error) && <p className="muted">当前目录没有插件。</p>}
      {selected && (
        <section className="info-card stack">
          <ReadState {...detail} />
          {plugin && summary && (
            <>
              <div className="section-heading">
                <h3>{summary.interface?.displayName ?? summary.name}</h3>
                <span className="badge">{summary.availability}</span>
              </div>
              <p>{plugin.description ?? summary.interface?.longDescription}</p>
              <p className="small">
                版本 {summary.localVersion ?? summary.version ?? '未提供'} · 安装策略{' '}
                {summary.installPolicy} ·{' '}
                {summary.authPolicy === 'ON_INSTALL' ? '安装后需要认证' : '使用时认证'}
              </p>
              {summary.disabledReason && (
                <p className="workspace-warning">限制原因：{String(summary.disabledReason)}</p>
              )}
              <div className="inline wrap">
                {link(summary.interface?.websiteUrl, '网站')}
                {link(summary.interface?.privacyPolicyUrl, '隐私政策')}
                {link(summary.interface?.termsOfServiceUrl, '使用条款')}
              </div>
              <h4>此插件提供</h4>
              <ul>
                <li>技能：{plugin.skills.map((row) => row.name).join('、') || '无'}</li>
                <li>Hooks：{plugin.hooks.map((row) => row.eventName).join('、') || '无'}</li>
                <li>MCP 服务：{plugin.mcpServers.join('、') || '无'}</li>
                <li>Apps：{plugin.apps.map((row) => row.name).join('、') || '无'}</li>
                <li>计划任务：{plugin.scheduledTasks?.length ?? 0}</li>
              </ul>
              {plugin.onboardingSkill && (
                <p className="small">入门技能：{plugin.onboardingSkill.name}</p>
              )}
              {plugin.scheduledTasks && plugin.scheduledTasks.length > 0 && (
                <details>
                  <summary>查看计划任务内容</summary>
                  {plugin.scheduledTasks.map((task) => (
                    <div className="stack" key={task.key}>
                      <strong>{task.name}</strong>
                      <p>{task.prompt}</p>
                      <pre className="raw">{JSON.stringify(task.schedule, null, 2)}</pre>
                    </div>
                  ))}
                </details>
              )}
              {plugin.appTemplates.length > 0 && (
                <details>
                  <summary>App 模板与依赖</summary>
                  <ul>
                    {plugin.appTemplates.map((template) => (
                      <li key={template.templateId}>
                        {template.name}
                        <p>{template.description}</p>
                        {template.reason && <p>{String(template.reason)}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {plugin.skills.length > 0 && (
                <label className="field">
                  查看技能说明
                  <select value={skill} onChange={(event) => setSkill(event.target.value)}>
                    <option value="">选择技能</option>
                    {plugin.skills.map((row) => (
                      <option key={row.name} value={row.name}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {skill && (
                <>
                  <ReadState {...contents} />
                  {contents.data && (
                    <pre className="raw">{contents.data.contents ?? '目录没有提供技能正文。'}</pre>
                  )}
                </>
              )}
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {summary.installed
                  ? '确认卸载此插件，其工具将不再可用'
                  : '我已查看插件内容、权限与认证要求，确认安装'}
              </label>
              <button
                className={`button ${summary.installed ? 'danger' : 'primary'}`}
                disabled={action.disabled || !consent || (!summary.installed && !installable)}
                onClick={() =>
                  void action.run(
                    summary.installed ? 'plugin/uninstall' : 'plugin/install',
                    {
                      projectId: project.id,
                      pluginId: selected,
                      ...(!summary.installed ? { previewHash: detail.data!.previewHash } : {}),
                    },
                    '操作已受理。请核对重新读取的安装状态，并在 Apps 或 MCP 中完成所需认证。',
                  )
                }
              >
                {summary.installed ? '卸载插件' : '安装此插件'}
              </button>
            </>
          )}
        </section>
      )}
      <div className="section-heading">
        <h3>市场来源</h3>
        <button
          className="button small"
          onClick={() => {
            setMarketForm(!marketForm);
            setMarketConsent(false);
          }}
        >
          添加市场
        </button>
      </div>
      {catalog.data?.marketplaces.map((market) => (
        <div className="info-card stack" key={market.name}>
          <strong>{market.interface?.displayName ?? market.name}</strong>
          <p className="small path">{market.path ?? '远程目录'}</p>
          <div className="inline wrap">
            <button
              className="button small"
              disabled={action.disabled}
              onClick={() => setMarketAction({ method: 'marketplace/upgrade', name: market.name })}
            >
              升级市场
            </button>
            <button
              className="button danger small"
              disabled={action.disabled}
              onClick={() => setMarketAction({ method: 'marketplace/remove', name: market.name })}
            >
              移除市场
            </button>
          </div>
        </div>
      ))}
      {marketAction && (
        <div className="workspace-warning">
          <p>
            {marketAction.method === 'marketplace/remove' ? '确认移除市场来源' : '确认升级市场来源'}
            ：{marketAction.name}
          </p>
          <div className="inline">
            <button
              className="button primary small"
              disabled={action.disabled}
              onClick={async () => {
                const result = await action.run(marketAction.method, {
                  projectId: project.id,
                  marketplaceName: marketAction.name,
                });
                if (result) setMarketAction(undefined);
              }}
            >
              确认市场操作
            </button>
            <button className="button small" onClick={() => setMarketAction(undefined)}>
              取消
            </button>
          </div>
        </div>
      )}
      {marketForm && (
        <form
          className="info-card stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (visible && marketConsent)
              void action.run('marketplace/add', {
                projectId: project.id,
                source:
                  sourceType === 'project'
                    ? { type: 'project', path: source }
                    : { type: 'git', url: source },
                ...(refName.trim() ? { refName: refName.trim() } : {}),
              });
          }}
        >
          <label className="field">
            市场类型
            <select
              value={sourceType}
              onChange={(event) => {
                setSourceType(event.target.value);
                setSource('');
                setMarketConsent(false);
              }}
            >
              <option value="project">已注册项目内目录</option>
              <option value="git">HTTPS Git 仓库</option>
            </select>
          </label>
          <label className="field">
            {sourceType === 'project'
              ? '项目内相对路径（留空表示根目录）'
              : '不含凭据的 HTTPS 仓库地址'}
            <input
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setMarketConsent(false);
              }}
              maxLength={2048}
              required={sourceType === 'git'}
            />
          </label>
          <label className="field">
            分支或标签（可选）
            <input
              value={refName}
              onChange={(event) => {
                setRefName(event.target.value);
                setMarketConsent(false);
              }}
              maxLength={256}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={marketConsent}
              onChange={(event) => setMarketConsent(event.target.checked)}
            />
            确认添加所选来源；远程来源会访问该 Git 仓库
          </label>
          <button className="button primary" disabled={action.disabled || !marketConsent}>
            添加所选市场
          </button>
        </form>
      )}
    </section>
  );
}
