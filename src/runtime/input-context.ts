import { createHash } from 'node:crypto';
import { canonical, DeliveryError, integer, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';

export interface InputContextHost {
  extension(method: string, params: JsonObject, context: CallContext): Promise<JsonValue>;
  file(cwd: string, relative: string, context: CallContext): Promise<JsonValue>;
}
export interface PreparedInputContext { input: JsonValue[]; additionalContext: JsonObject; queuedInput: JsonValue[] }
const marker = 'harness-context:';
/** Context files and explicit user notes never become application-trusted instructions. */
export class InputContext {
  constructor(private host: InputContextHost) {}
  async prepare(cwd: string, references: JsonValue | undefined, extraContext: JsonValue | undefined, context: CallContext, threadId?: string): Promise<PreparedInputContext> {
    const refs = references ?? [], extras = extraContext ?? [];
    if (!Array.isArray(refs) || refs.length > 24 || !Array.isArray(extras) || extras.length > 8) throw new DeliveryError('capacity', 'Select at most 24 references and 8 context notes');
    jsonBytes({ refs, extras }, 256 * 1024);
    const input: JsonValue[] = [], queuedInput: JsonValue[] = [], additionalContext: JsonObject = {}, seen = new Set<string>();
    let bytes = 0;
    const add = (source: string, label: string, text: string): void => {
      bytes += Buffer.byteLength(text); if (bytes > 256 * 1024) throw new DeliveryError('capacity', 'Selected context exceeds 256 KiB');
      const key = marker + createHash('sha256').update(source).digest('hex');
      if (Object.hasOwn(additionalContext, key)) throw new DeliveryError('invalid_params', 'Duplicate context source');
      const content = `Untrusted context from ${label}:\n${text}`;
      additionalContext[key] = { kind: 'untrusted', value: content };
      // Queue/steer only accept UserInput. Preserve this source as an opaque,
      // labelled text element so editing the main message cannot erase it.
      queuedInput.push({ type: 'text', text: content, text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(content) }, placeholder: key }] });
    };
    for (const entry of refs) {
      const ref = object(entry); const identity = canonical(ref); if (seen.has(identity)) throw new DeliveryError('invalid_params', 'Duplicate reference'); seen.add(identity);
      if (ref.type === 'skill') {
        onlyKeys(ref, ['type', 'skillId']); const id = string(ref.skillId, 'skillId', 64);
        if (!/^[a-f0-9]{64}$/.test(id)) throw new DeliveryError('invalid_params', 'Invalid skill identity');
        const response = object(await this.host.extension('skills/list', { cwd, forceReload: true }, context));
        const skills = (response.data as JsonValue[]).flatMap(row => object(row).skills as JsonValue[]).map(row => object(row)).filter(skill => skill.skillId === id);
        if (skills.length !== 1 || skills[0]!.enabled !== true) throw new DeliveryError('skill_unavailable', 'Selected skill is missing or disabled');
        const skill = skills[0]!, item = { type: 'skill', name: string(skill.name, 'skill name', 256), path: string(skill.path, 'skill path', 4096) };
        validateOfficial('UserInput', item); input.push(item);
      } else if (ref.type === 'app') {
        onlyKeys(ref, ['type', 'appId']); const id = string(ref.appId, 'appId', 256);
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new DeliveryError('invalid_params', 'Invalid app identity');
        const scoped = threadId ? { threadId } : {};
        const installed = object(await this.host.extension('app/installed', { ...scoped, forceRefresh: true }, context));
        const matches = (installed.apps as JsonValue[]).map(row => object(row)).filter(app => app.id === id);
        if (matches.length !== 1 || matches[0]!.enabled !== true || matches[0]!.callable !== true) throw new DeliveryError('app_unavailable', 'Selected app is not enabled and callable; finish its setup first');
        const detail = object(await this.host.extension('app/read', { ...scoped, appIds: [id], includeTools: false }, context));
        const metadata = (detail.apps as JsonValue[]).map(row => object(row)).filter(app => app.id === id);
        if (metadata.length !== 1 || (detail.missingAppIds as JsonValue[]).includes(id)) throw new DeliveryError('app_unavailable', 'Selected app is no longer available');
        const item = { type: 'mention', name: string(metadata[0]!.name, 'app name', 256), path: `app://${id}` }; validateOfficial('UserInput', item); input.push(item);
      } else if (ref.type === 'file') {
        onlyKeys(ref, ['type', 'path', 'revision', 'startLine', 'endLine']); const relative = string(ref.path, 'file path', 4096), revision = string(ref.revision, 'file revision', 64);
        if (!/^[a-f0-9]{64}$/.test(revision)) throw new DeliveryError('invalid_params', 'File references require the displayed revision');
        const file = object(await this.host.file(cwd, relative, context));
        if (file.path !== relative || file.kind !== 'file') throw new DeliveryError('invalid_native_response', 'File context identity did not match the selected path');
        if (file.revision !== revision) throw new DeliveryError('file_changed', 'Selected file changed; preview it again before sending');
        if (typeof file.text !== 'string' || file.editable !== true) throw new DeliveryError('context_unavailable', 'This file has no bounded UTF-8 text preview');
        const lines = file.text.split('\n'), start = integer(ref.startLine ?? 1, 'start line', 1, Math.max(lines.length, 1)), end = integer(ref.endLine ?? lines.length, 'end line', start, lines.length);
        if (end - start >= 2000) throw new DeliveryError('capacity', 'A file reference can contain at most 2000 lines');
        const text = lines.slice(start - 1, end).join('\n');
        add(canonical({ cwd, relative, revision, start, end }), `${JSON.stringify(relative)} lines ${start}-${end} (revision ${revision})`, text);
      } else throw new DeliveryError('invalid_params', 'Unknown reference type');
    }
    for (const [index, entry] of extras.entries()) {
      const extra = object(entry); onlyKeys(extra, ['label', 'text']); const label = string(extra.label, 'context label', 128), text = string(extra.text, 'context note', 64 * 1024);
      add(`user-note:${index}:${label}`, JSON.stringify(label), text);
    }
    const result = { input, additionalContext, queuedInput: [...input, ...queuedInput] }; jsonBytes(result, 768 * 1024); return result;
  }
}
export function isContextText(value: JsonObject): boolean {
  if (value.type !== 'text' || typeof value.text !== 'string' || !Array.isArray(value.text_elements) || value.text_elements.length !== 1) return false;
  const element = value.text_elements[0]; if (!element || typeof element !== 'object' || Array.isArray(element)) return false;
  const range = element.byteRange;
  return typeof element.placeholder === 'string' && /^harness-context:[a-f0-9]{64}$/.test(element.placeholder) && !!range && typeof range === 'object' && !Array.isArray(range) && range.start === 0 && range.end === Buffer.byteLength(value.text);
}
export { outputSchema } from './structured-output.js';
