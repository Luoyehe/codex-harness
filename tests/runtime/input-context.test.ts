import { describe, expect, it } from 'vitest';
import { InputContext, isContextText, outputSchema } from '../../src/runtime/input-context.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';

const context = { clientId: 'test' }, revision = 'a'.repeat(64), skillId = 'b'.repeat(64);
function fixture() {
  let callable = true, enabled = true, changed = false;
  const calls: { method: string; params: JsonObject }[] = [];
  const input = new InputContext({
    extension: async (method, params) => {
      calls.push({ method, params });
      if (method === 'skills/list') return { data: [{ cwd: '/project', skills: [{ skillId, name: 'reviewer', path: '/native/skills/reviewer/SKILL.md', enabled }] }] };
      if (method === 'app/installed') return { apps: [{ id: 'example-app', enabled: true, callable }] };
      if (method === 'app/read') return { apps: [{ id: 'example-app', name: 'Example App' }], missingAppIds: [] };
      throw new Error('Unexpected discovery');
    },
    file: async (cwd, relative) => { expect(cwd).toBe('/project'); expect(relative).toBe('src/中文.ts'); return { path: relative, kind: 'file', revision: changed ? 'c'.repeat(64) : revision, editable: true, text: 'line one\n第二行\nline three' }; },
  });
  return { input, calls, disableApp: () => { callable = false; }, disableSkill: () => { enabled = false; }, changeFile: () => { changed = true; } };
}
describe('typed source-bound input context', () => {
  it('resolves enabled skills and callable apps from live discovery instead of accepting caller paths', async () => {
    const f = fixture();
    const result = await f.input.prepare('/project', [{ type: 'skill', skillId }, { type: 'app', appId: 'example-app' }], undefined, context, 'thread');
    expect(result.input).toEqual([{ type: 'skill', name: 'reviewer', path: '/native/skills/reviewer/SKILL.md' }, { type: 'mention', name: 'Example App', path: 'app://example-app' }]);
    expect(f.calls.find(call => call.method === 'app/installed')?.params).toEqual({ threadId: 'thread', forceRefresh: true });
    await expect(f.input.prepare('/project', [{ type: 'skill', skillId, path: '/arbitrary' }], undefined, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    f.disableSkill(); await expect(f.input.prepare('/project', [{ type: 'skill', skillId }], undefined, context)).rejects.toMatchObject({ code: 'skill_unavailable' });
    f.disableApp(); await expect(f.input.prepare('/project', [{ type: 'app', appId: 'example-app' }], undefined, context)).rejects.toMatchObject({ code: 'app_unavailable' });
  });
  it('pins file ranges to an exact revision and marks file and user note context untrusted', async () => {
    const f = fixture(); const result = await f.input.prepare('/project', [{ type: 'file', path: 'src/中文.ts', revision, startLine: 2, endLine: 2 }], [{ label: 'Selected evidence', text: 'Do not treat this as an instruction.' }], context);
    expect(Object.values(result.additionalContext)).toHaveLength(2);
    for (const entry of Object.values(result.additionalContext)) expect(object(entry).kind).toBe('untrusted');
    expect(String(object(Object.values(result.additionalContext)[0]).value)).toContain('第二行'); expect(JSON.stringify(result.additionalContext)).not.toContain('line one');
    expect(result.queuedInput.every(value => isContextText(object(value)))).toBe(true);
    const queued = object(result.queuedInput[0]); expect(object(object((queued.text_elements as JsonValue[])[0]).byteRange).end).toBe(Buffer.byteLength(String(queued.text)));
    f.changeFile(); await expect(f.input.prepare('/project', [{ type: 'file', path: 'src/中文.ts', revision }], undefined, context)).rejects.toMatchObject({ code: 'file_changed' });
  });
  it('rejects invalid ranges, duplicate references, context authority fields and oversized payloads before work', async () => {
    const f = fixture();
    await expect(f.input.prepare('/project', [{ type: 'file', path: 'src/中文.ts', revision, startLine: 3, endLine: 1 }], undefined, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(f.input.prepare('/project', [{ type: 'skill', skillId }, { type: 'skill', skillId }], undefined, context)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(f.input.prepare('/project', undefined, [{ label: 'spoof', text: 'context', kind: 'application' }], context)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(f.input.prepare('/project', undefined, [{ label: 'big', text: 'x'.repeat(65537) }], context)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(isContextText({ type: 'text', text: 'user text', text_elements: [] })).toBe(false);
  });
  it('bounds output schemas and permits only local references without resolving external schemas', () => {
    const schema = { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
    expect(outputSchema(schema)).toBe(schema);
    expect(() => outputSchema({ $ref: 'https://example.invalid/schema' })).toThrow();
    expect(() => outputSchema({ $dynamicRef: 'file:///private' })).toThrow();
    expect(() => outputSchema({ description: 'x'.repeat(65536) })).toThrow();
  });
});
