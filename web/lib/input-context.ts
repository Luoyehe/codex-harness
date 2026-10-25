import { object } from './types';
import { byteLength, workspacePath } from './workspace';
export type InputReference = { type: 'skill'; skillId: string } | { type: 'app'; appId: string } | { type: 'file'; path: string; revision: string; startLine?: number; endLine?: number };
export type DraftReference = InputReference & { projectId: string; label: string };
export type ContextNote = { label: string; text: string };
export function referenceInput(reference: DraftReference): InputReference { const { projectId: _project, label: _label, ...input } = reference; return input; }
export function contextProblem(references: DraftReference[], notes: ContextNote[]): string {
  if (!Array.isArray(references) || references.length > 24 || !Array.isArray(notes) || notes.length > 8) return '最多选择 24 个引用和 8 段补充上下文。';
  const identities = new Set<string>();
  for (const reference of references) {
    if (!reference || typeof reference.projectId !== 'string' || !reference.projectId || typeof reference.label !== 'string' || reference.label.length > 4096) return '引用缺少明确的项目归属或名称。';
    const input = referenceInput(reference), identity = JSON.stringify(input); if (identities.has(identity)) return '同一引用不能重复添加。'; identities.add(identity);
    if (input.type === 'skill') { if (typeof input.skillId !== 'string' || !/^[a-f0-9]{64}$/.test(input.skillId)) return '技能引用标识无效，请重新从目录选择。'; }
    else if (input.type === 'app') { if (typeof input.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(input.appId)) return 'App 引用标识无效。'; }
    else if (input.type === 'file') {
      try { workspacePath(input.path); } catch { return '文件引用必须是项目内相对路径。'; }
      if (!/^[a-f0-9]{64}$/.test(input.revision) || input.startLine !== undefined && (!Number.isSafeInteger(input.startLine) || input.startLine < 1) || input.endLine !== undefined && (!Number.isSafeInteger(input.endLine) || input.endLine < (input.startLine ?? 1) || input.endLine - (input.startLine ?? 1) >= 2000)) return '文件引用版本或行范围无效，单个文件最多 2,000 行。';
    } else return '引用类型无效。';
  }
  if (notes.some(note => !note || typeof note.label !== 'string' || note.label.length > 128 || typeof note.text !== 'string' || note.text.length > 64 * 1024)) return '补充上下文的名称最多 128 字符，正文最多 64 KiB 字符。';
  if (byteLength(JSON.stringify({ refs: references.map(referenceInput), extras: notes })) > 256 * 1024 || notes.reduce((size, note) => size + byteLength(note.text), 0) > 256 * 1024) return '所选引用和补充上下文超过 256 KiB。';
  return '';
}
export function contextPayload(projectId: string, references: DraftReference[], extraContext: ContextNote[]) {
  const error = contextProblem(references, extraContext); if (error) throw new Error(error);
  if (references.some(reference => reference.projectId !== projectId)) throw new Error('引用来自其他项目，请返回原项目或重新选择引用。');
  if (extraContext.some(note => !note.label.trim() || !note.text.trim())) throw new Error('请填写每段补充上下文的名称和内容，或移除空白项。');
  return { references: references.map(referenceInput), extraContext };
}
export function parseOutputSchema(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  if (byteLength(text) > 64 * 1024) throw new Error('结构化输出 Schema 最多 64 KiB。');
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new Error('结构化输出 Schema 不是有效 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结构化输出 Schema 必须为 JSON 对象。');
  let nodes = 0; const visit = (value: unknown, depth: number) => { if (++nodes > 2048 || depth > 24) throw new Error('结构化输出 Schema 太复杂。'); if (Array.isArray(value)) for (const child of value) visit(child, depth + 1); else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) throw new Error('Schema 引用只能指向此 Schema 内部。'); visit(child, depth + 1); } }; visit(parsed, 0); return object(parsed);
}
export function selectedLines(text: string, start: number, end: number) { const first = text.slice(0, start).split('\n').length, last = text.slice(0, Math.max(start, end > start ? end - 1 : end)).split('\n').length; return { startLine: first, endLine: last }; }
