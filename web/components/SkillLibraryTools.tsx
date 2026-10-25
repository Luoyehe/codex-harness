import { useEffect, useMemo, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { fileDraftKey, listFileDrafts, newFileDraft, persistFileDraft, readFileDraft, type FileDraft } from '../lib/file-drafts';
import { byteLength, checkedSnapshot, fileTextError, type FileSnapshot } from '../lib/workspace';
import { message, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
import { FileEditor } from './FileEditor';

export function SkillDocument({ api, project, epoch, skillId }: { api: Api; project: Project; epoch: string; skillId: string }) {
  const content = useResource(`${project.id}:${epoch}:${skillId}`, async signal => {
    const result = await api.call<{ skillId: string; path: string; text: string; bytes: number; revision: string; name: string }>('skills/read', { projectId: project.id, skillId }, signal);
    if (result.skillId !== skillId || typeof result.text !== 'string' || byteLength(result.text) > 524288 || !/^[a-f0-9]{64}$/.test(result.revision)) throw new Error('技能说明响应无效或身份不匹配。');
    return result;
  });
  return <section className="stack"><ReadState {...content}/>{content.data && <><p className="small muted">实际 SKILL.md · 只读预览，打开内容不会运行技能。</p><pre className="raw skill-document">{content.data.text}</pre></>}</section>;
}

export function SkillRoots({ api, projects, epoch, enabled, onChanged }: { api: Api; projects: Project[]; epoch: string; enabled: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const action = useExtensionAction(api, enabled, onChanged), resource = useResource(`${epoch}:${action.revision}`, async signal => {
    const result = await api.call<{ roots: string[]; persistence: 'current_runtime' }>('skills/extraRoots/read', {}, signal);
    if (!Array.isArray(result.roots) || result.roots.length > 16 || result.roots.some(root => typeof root !== 'string') || result.persistence !== 'current_runtime') throw new Error('额外技能目录响应格式无效。');
    return result;
  }, open);
  const [selected, setSelected] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
  useEffect(() => { if (resource.data) { setSelected(projects.filter(project => resource.data!.roots.includes(project.cwd)).map(project => project.id)); setConfirmed(false); } }, [resource.data]);
  const unknown = resource.data?.roots.filter(root => !projects.some(project => project.cwd === root)) ?? [];
  return <details className="info-card" onToggle={e => setOpen(e.currentTarget.open)}><summary>额外技能目录（当前执行服务）</summary><div className="stack"><p>只从已注册项目选择额外技能根目录。本次设置覆盖当前额外目录列表，执行服务重启后清空；不会复制文件，也不会自动调用技能。</p><ReadState {...resource}/><ExtensionStatus api={api} action={action}/>{unknown.length > 0 && <p className="workspace-warning">当前还包含未注册目录；提交新选择会移除它们：{unknown.join('、')}</p>}{projects.map(project => <label className="check-row" key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={e => { setSelected(value => e.target.checked ? [...value, project.id] : value.filter(id => id !== project.id)); setConfirmed(false); }}/><span>{project.name}<small className="path"> · {project.cwd}</small></span></label>)}<p className="small muted">已选择 {selected.length} / 16 个目录；取消全部选择会清空额外目录。</p><label className="check-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>确认替换当前运行时的额外技能目录</label><button className="button" disabled={action.disabled || !resource.data || resource.loading || selected.length > 16 || !confirmed} onClick={() => void action.run('skills/extraRoots/set', { projectIds: selected, confirm: true })}>应用本次目录选择</button></div></details>;
}

const directories = (slug: string) => ['.agents', '.agents/skills', `.agents/skills/${slug}`];
const filename = (slug: string) => `.agents/skills/${slug}/SKILL.md`;
type Plan = { missing: string[]; file?: FileSnapshot };
export function SkillCreator({ api, project, epoch, enabled, onChanged }: { api: Api; project: Project; epoch: string; enabled: boolean; onChanged: () => void }) {
  const [slug, setSlug] = useState(''), [text, setText] = useState(''), [consentOwner, setConsentOwner] = useState<object>(), [prepared, setPrepared] = useState(''), [error, setError] = useState(''), [reading, setReading] = useState(false);
  const [revision, setRevision] = useState(0), [drafts, setDrafts] = useState<FileDraft[]>([]), cache = useRef(new Map<string, FileDraft>()), textRevision = useRef(0), readAttempt = useRef(0);
  const scope = useMemo(() => ({}), [api, project.id, epoch]), owner = useRef<object | undefined>(scope); owner.current = scope;
  const consent = consentOwner === scope, setConsent = (value: boolean) => setConsentOwner(value ? scope : undefined);
  const editText = (value: string) => { textRevision.current++; setText(value); setConsent(false); };
  useEffect(() => { owner.current = scope; setReading(false); return () => { owner.current = undefined; }; }, [scope]);
  const action = useExtensionAction(api, enabled, () => { setRevision(value => value + 1); onChanged(); }, JSON.stringify([project.id, epoch]));
  const path = prepared ? filename(prepared) : '';
  useEffect(() => { setReading(false); setConsent(false); }, [epoch]);
  useEffect(() => { try { setDrafts(listFileDrafts().filter(draft => draft.projectId === project.id && /^\.agents\/skills\/[a-z0-9-]+\/SKILL\.md$/.test(draft.path))); } catch (e) { setError(message(e)); } }, [project.id, revision]);
  const plan = useResource(`${project.id}:${epoch}:${prepared}:${revision}:${action.revision}`, async signal => {
    const result: Plan = { missing: [] };
    for (const directory of directories(prepared)) {
      try { const metadata = checkedSnapshot(await api.call('workspace/metadata', { projectId: project.id, path: directory }, signal), directory); if (metadata.kind !== 'directory') throw new Error(`技能目录被其他文件占用：${directory}`); }
      catch (e) { if (e instanceof RpcError && e.code === 'not_found' && e.delivery === 'not_sent') result.missing.push(directory); else throw e; }
    }
    try { const metadata = checkedSnapshot(await api.call('workspace/metadata', { projectId: project.id, path }, signal), path); if (metadata.kind !== 'file') throw new Error('目标 SKILL.md 不是普通文件。'); if (metadata.editable) result.file = checkedSnapshot(await api.call('workspace/read', { projectId: project.id, path }, signal), path) as FileSnapshot; else result.file = metadata; }
    catch (e) { if (!(e instanceof RpcError && e.code === 'not_found' && e.delivery === 'not_sent')) throw e; }
    return result;
  }, Boolean(prepared));
  const discovered = useResource(`${project.id}:${epoch}:${path}:${revision}`, signal => api.call<{ data: { errors: { message: string }[]; skills: { name: string; path: string; enabled: boolean }[] }[] }>('skills/list', { projectId: project.id, forceReload: true }, signal), Boolean(path && plan.data?.file));
  const expectedPath = `${project.cwd.replace(/[\\/]$/, '')}/${path}`.replaceAll('\\', '/');
  const found = discovered.data?.data.flatMap(row => row.skills).find(skill => skill.path.replaceAll('\\', '/') === expectedPath);
  const prepare = () => {
    setError('');
    try {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) throw new Error('技能目录使用小写字母、数字和单个连字符，最多 64 字符。');
      const problem = fileTextError(text); if (problem || !text.trim()) throw new Error(problem || '请先填写或导入技能说明。');
      if (!consent) return;
      const target = filename(slug), previous = readFileDraft(project.id, target);
      if (previous && previous.text !== text) throw new Error('此路径已有保留草稿，请先继续该草稿，不会覆盖。');
      const draft = previous ?? newFileDraft(project.id, target, null, text); persistFileDraft(draft); cache.current.set(fileDraftKey(project.id, target), draft); setPrepared(slug); setRevision(value => value + 1);
    } catch (e) { setError(message(e)); }
  };
  const pendingDraft = path ? cache.current.get(fileDraftKey(project.id, path))?.pending ?? drafts.find(draft => draft.path === path)?.pending : undefined;
  return <details className="info-card"><summary>在项目中新建或导入 SKILL.md</summary><div className="stack"><p>保存到 <code>.agents/skills/技能目录/SKILL.md</code>。导入只读取你选择的 UTF-8 文本。保存后技能可能被后续任务发现并使用；向导不会调用技能或运行其中的命令。</p>{error && <p className="error" role="alert">{error}</p>}<ExtensionStatus api={api} action={action} recoveryLabel="查询原技能目录操作回执"/>
    {!prepared ? <><label className="field">技能目录名称<input value={slug} maxLength={64} placeholder="review-changes" onChange={e => { setSlug(e.target.value); setConsent(false); }}/></label><button className="button small" disabled={Boolean(text)} onClick={() => editText(`---\nname: ${slug || 'review-changes'}\ndescription: 说明此技能适用的任务和触发条件。\n---\n\n# 技能步骤\n\n1. 阅读任务与项目指引。\n2. 完成所需操作并验证结果。\n`)}>填入技能模板</button><label className="field">导入本地 SKILL.md<input type="file" accept=".md,text/markdown,text/plain" disabled={reading} onChange={async e => { const file = e.target.files?.[0], key = owner.current, version = textRevision.current, attempt = ++readAttempt.current; e.target.value = ''; if (!file) return; setError(''); setReading(true); try { if (file.size > 524288) throw new Error('技能文件超过 512 KiB。'); const body = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); const problem = fileTextError(body); if (problem) throw new Error(problem); if (owner.current === key && readAttempt.current === attempt) { if (textRevision.current !== version) setError('读取期间技能说明已编辑，保留当前草稿；如需替换，请重新选择文件。'); else editText(body); } } catch (e) { if (owner.current === key && readAttempt.current === attempt) setError(message(e)); } finally { if (owner.current === key && readAttempt.current === attempt) setReading(false); } }}/></label><label className="field">技能说明<textarea value={text} rows={10} onChange={e => editText(e.target.value)}/></label><label className="check-row"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>已查看内容，准备在当前项目创建新技能；不覆盖已有 SKILL.md</label><button className="button primary" disabled={action.disabled || !consent || reading} onClick={prepare}>保存本地草稿并检查目录</button>{drafts.length > 0 && <div className="stack"><h4>继续保留的技能草稿</h4>{drafts.map(draft => <button className="button small" key={draft.path} onClick={() => { cache.current.set(fileDraftKey(project.id, draft.path), draft); setPrepared(draft.path.split('/')[2]!); setRevision(value => value + 1); }}>{draft.path}{draft.pending ? ' · 保存待确认' : ''}</button>)}</div>}</> : <><p className="path"><strong>目标：</strong>{path}</p><ReadState {...plan}/><button className="button small" disabled={plan.loading} onClick={() => { setRevision(value => value + 1); plan.refresh(); }}>重新检查目录与文件</button>{plan.data && <>{plan.data.file ? <p className="workspace-warning">目标文件已存在，向导不会覆盖。可在项目文件中按版本校验编辑；保留草稿仍可核对。</p> : plan.data.missing.length > 0 ? <div className="stack"><p>还需创建 {plan.data.missing.length} 层目录。每次仅提交下面这一步，确认回执后重新检查，再由你继续。</p><button className="button" disabled={action.disabled} onClick={() => void action.run('workspace/mkdir', { projectId: project.id, path: plan.data!.missing[0] })}>创建目录：{plan.data.missing[0]}</button></div> : <p className="small muted">目录已就绪。下方保存只创建新文件，目标若已存在会拒绝。</p>}{(!plan.data.file && plan.data.missing.length === 0 || pendingDraft) && <FileEditor key={project.id + ':' + path} api={api} projectId={project.id} path={path} creating remote={plan.data.file} loading={plan.loading} readError={plan.error} enabled={!action.disabled && !plan.data.file && plan.data.missing.length === 0} cache={cache.current} onChanged={() => { setRevision(value => value + 1); onChanged(); }}/>}</>}{plan.data?.file && <><ReadState {...discovered}/>{found ? <p role="status">原生技能目录已发现：{found.name} · {found.enabled ? '已启用' : '已停用'}。尚未调用技能。</p> : discovered.data && <p className="workspace-warning">文件存在，但原生技能目录尚未发现此技能。请检查名称、frontmatter 与目录错误，不将保存视为安装成功。</p>}{discovered.data?.data.flatMap(row => row.errors).map((error, i) => <p className="error" key={i}>{error.message}</p>)}</>}<button className="button small" disabled={action.busy} onClick={() => { setPrepared(''); setError(''); }}>返回技能草稿选择</button></>}
  </div></details>;
}
