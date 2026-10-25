import { describe, expect, it, vi } from 'vitest';
import { Imports } from '../../src/runtime/imports.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
const note = { itemType: 'AGENTS_MD', description: 'Import selected project instructions', cwd: '/project', details: null };
const completed = { importId: 'import', itemTypeResults: [{ itemType: 'AGENTS_MD', successes: [{ itemType: 'AGENTS_MD', cwd: '/project', source: '/project/CLAUDE.md', target: '/project/AGENTS.md', title: null }], failures: [] }] };
function setup() {
  const calls: { method: string; params: JsonObject }[] = []; let items: JsonValue[] = [note];
  const imports = new Imports(async (method, params) => { calls.push({ method, params }); if (method === 'externalAgentConfig/detect') return { items, connectors: [] }; return { data: [], connectors: [] }; });
  const selected = async () => { const preview = await imports.preview({ cwd: '/project' }); return { cwd: '/project', previewHash: preview.previewHash!, itemIds: (preview.items as JsonValue[]).map(value => object(value).itemId!), confirm: true } as JsonObject; };
  return { imports, calls, selected, set: (value: JsonValue[]) => { items = value; } };
}
describe('external migration ownership and final acknowledgement', () => {
  it('detects only requested roots and rejects home or caller-crafted migration items without explicit scope', async () => {
    const f = setup(); await f.selected(); expect(f.calls[0]).toMatchObject({ params: { includeHome: false, cwds: ['/project'], migrationSource: 'claude-code', maxSessions: 100 } });
    f.set([{ ...note, cwd: null }]); await expect(f.imports.preview({ cwd: '/project' })).rejects.toMatchObject({ code: 'import_scope' });
    await expect(f.imports.preview({ cwd: '/project', includeNativeHome: true })).resolves.toHaveProperty('items');
    await expect(f.imports.apply({ cwd: '/project', migrationItems: [note] }, async () => ({}))).rejects.toMatchObject({ delivery: 'not_sent' });
  });
  it('binds selected inventory to a fresh preview and requires additional executable-config review', async () => {
    const f = setup(), selected = await f.selected(); let writes = 0;
    f.set([{ ...note, description: 'Changed inventory' }]); await expect(f.imports.apply(selected, async () => { writes++; return {}; })).rejects.toMatchObject({ code: 'import_changed' });
    f.set([{ ...note, itemType: 'MCP_SERVER_CONFIG' }]); const executable = await f.selected();
    await expect(f.imports.apply(executable, async () => { writes++; return {}; })).rejects.toMatchObject({ code: 'import_execution_review' }); expect(writes).toBe(0);
  });
  it('handles completion-before-response and preserves per-type partial failures', async () => {
    const f = setup(), selected = await f.selected(); const result = { ...completed, itemTypeResults: [{ ...completed.itemTypeResults[0]!, failures: [{ itemType: 'AGENTS_MD', errorType: null, subErrorType: null, failureStage: 'copy', message: 'Target already exists', cwd: '/project', source: '/project/CLAUDE.md' }] }] };
    expect(await f.imports.apply(selected, async (_method, params) => { expect(params).toMatchObject({ migrationItems: [note] }); f.imports.notification('externalAgentConfig/import/completed', result); return { importId: 'import' }; })).toEqual({ ...result, completed: true });
  });
  it('waits for the matching completion ID and never treats start acknowledgement as completion', async () => {
    const f = setup(), selected = await f.selected(); let accepted = false;
    const task = f.imports.apply(selected, async () => { accepted = true; return { importId: 'import' }; });
    await vi.waitFor(() => expect(accepted).toBe(true)); f.imports.notification('externalAgentConfig/import/completed', { ...completed, importId: 'another' });
    let settled = false; void task.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    f.imports.notification('externalAgentConfig/import/completed', completed); await expect(task).resolves.toMatchObject({ completed: true, importId: 'import' }); f.imports.close();
  });
  it('marks loss after acceptance unknown and rejects promptly on shutdown', async () => {
    const f = setup(), selected = await f.selected(); const task = f.imports.apply(selected, async () => { f.imports.close(); return { importId: 'import' }; });
    await expect(task).rejects.toMatchObject({ delivery: 'unknown', code: 'import_unknown' });
  });
  it('times out without inventing completion or dispatching a second import', async () => {
    vi.useFakeTimers(); const f = setup(); let sent = 0;
    try {
      const selected = await f.selected(); const task = f.imports.apply(selected, async () => { sent++; return { importId: 'timed-out' }; });
      const checked = expect(task).rejects.toMatchObject({ delivery: 'unknown', code: 'import_unknown', data: { importId: 'timed-out' } });
      await vi.advanceTimersByTimeAsync(90_001); await checked; expect(sent).toBe(1);
      f.imports.notification('externalAgentConfig/import/completed', { ...completed, importId: 'timed-out' }); expect(sent).toBe(1);
    } finally { f.imports.close(); vi.useRealTimers(); }
  });
});
