// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { MemorySettings } from '../components/MemorySettings';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'memory-project', name: 'Project', cwd: '/project' };
function settings(version = 'v1') { return { userVersion: version, config: { memories: { generate_memories: false, use_memories: true, max_raw_memories_for_consolidation: 99 } }, editableKeys: ['memories.generate_memories', 'memories.use_memories'], layers: [{ name: { type: 'user', profile: null }, version, config: { memories: { generate_memories: true, use_memories: true, max_raw_memories_for_consolidation: 17 } } }] }; }
function setup(handler: (call: Call) => unknown = () => undefined) { const calls: Call[] = [], api = new Api(); vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => { const call: Call = JSON.parse(init.body); calls.push(call); const result = await handler(call) ?? (call.method === 'settings/read' ? settings() : {}); return { ok: true, status: 200, json: async () => ({ ok: true, result }) }; })); render(<MemorySettings api={api} project={project} epoch="epoch" enabled onChanged={vi.fn()}/>); return { calls }; }
const confirm = () => fireEvent.click(screen.getByRole('checkbox', { name: '确认只修改以上明确选择的记忆开关' }));
const save = () => fireEvent.click(screen.getByRole('button', { name: '保存记忆开关' }));
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows effective and user values, confirms a leaf-only diff and clears a single override with null', async () => {
  const { calls } = setup(); const generate = await screen.findByRole('combobox', { name: /生成全局记忆/ });
  await waitFor(() => expect((generate as HTMLSelectElement).disabled).toBe(false));
  expect(screen.getByText(/当前有效值：停用；用户覆盖：启用/)).toBeTruthy();
  fireEvent.change(generate, { target: { value: 'inherit' } }); save(); expect(calls.filter(c => c.method === 'settings/write')).toHaveLength(0);
  confirm(); save(); await waitFor(() => expect(calls.filter(c => c.method === 'settings/write')).toHaveLength(1));
  expect(calls.find(c => c.method === 'settings/write')?.params).toEqual({ expectedVersion: 'v1', changes: [{ key: 'memories.generate_memories', value: null }] });
});
it('preserves choices across revision conflict and requires comparison and a fresh explicit confirmation', async () => {
  let version = 'v1'; const { calls } = setup(c => c.method === 'settings/read' ? settings(version) : undefined);
  const use = await screen.findByRole('combobox', { name: /在任务中使用全局记忆/ }); await waitFor(() => expect((use as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(use, { target: { value: 'false' } }); confirm(); version = 'v2'; fireEvent.click(screen.getByRole('button', { name: '重新读取记忆设置' }));
  await screen.findByText(/用户配置版本已变化/); save(); expect(calls.some(c => c.method === 'settings/write')).toBe(false);
  expect((use as HTMLSelectElement).value).toBe('false'); fireEvent.click(screen.getByRole('checkbox', { name: /我已比较新版本/ })); fireEvent.click(screen.getByRole('button', { name: '采用新版本作为保存基准' }));
  save(); expect(calls.some(c => c.method === 'settings/write')).toBe(false); confirm(); save();
  await waitFor(() => expect(calls.find(c => c.method === 'settings/write')?.params).toEqual({ expectedVersion: 'v2', changes: [{ key: 'memories.use_memories', value: false }] }));
});
it('refuses writes when there is no unique exact user layer version', async () => {
  const { calls } = setup(c => c.method === 'settings/read' ? { ...settings(), layers: [...settings().layers, ...settings().layers] } : undefined);
  await screen.findByText(/未取得唯一用户配置层及一致版本/); expect((screen.getByRole('combobox', { name: /生成全局记忆/ }) as HTMLSelectElement).disabled).toBe(true); confirm(); save(); expect(calls.some(c => c.method === 'settings/write')).toBe(false);
});
it('queries the original unknown receipt without replaying a write', async () => {
  let id = ''; const { calls } = setup(c => { if (c.method === 'settings/write') { id = c.operationId!; throw new Error('lost response'); } if (c.method === 'operation/read') return { operationId: id, method: 'settings/write', state: 'unknown' }; });
  const generate = await screen.findByRole('combobox', { name: /生成全局记忆/ }); await waitFor(() => expect((generate as HTMLSelectElement).disabled).toBe(false)); fireEvent.change(generate, { target: { value: 'false' } }); confirm(); save();
  fireEvent.click(await screen.findByRole('button', { name: '查询原记忆设置回执' })); await waitFor(() => expect(calls.some(c => c.method === 'operation/read')).toBe(true)); expect(calls.filter(c => c.method === 'settings/write')).toHaveLength(1); expect((generate as HTMLSelectElement).value).toBe('false'); expect((screen.getByRole('button', { name: '保存记忆开关' }) as HTMLButtonElement).disabled).toBe(true);
});
