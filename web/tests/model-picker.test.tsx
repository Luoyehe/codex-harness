// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelPicker, modelSelection } from '../components/ModelPicker';
import type { Model, Options } from '../lib/types';
import { mediaAdmission } from '../lib/input-modalities';
import { executionOptions, modelSettingsIssue } from '../lib/workflows';
import { Composer } from '../components/Composer';
import type { Api } from '../lib/api';

afterEach(cleanup);
const models: Model[] = [
  { id: 'shared', model: 'shared', modelProvider: 'openai', providerName: 'ChatGPT', displayName: '同名模型 A', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], inputModalities: ['text', 'image'] },
  { id: 'shared', model: 'shared', modelProvider: 'coding', providerName: '智谱', displayName: '同名模型 B', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }], inputModalities: ['text'] },
];
const open = () => fireEvent.click(screen.getByText((_, node) => node?.tagName === 'SUMMARY' && node.getAttribute('aria-label') === '选择模型与思考强度'));
it('changes provider and model together, clearing a previous incompatible effort', () => {
  let current: Options = {};
  function Harness() {
    const [options, setOptions] = useState<Options>({ model: 'shared', modelProvider: 'openai', effort: 'high' });
    current = options;
    return <ModelPicker models={models} options={options} onOptions={setOptions} existingThread={false} />;
  }
  render(<Harness />); open();
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: modelSelection(models[1]!) } });
  expect(current).toEqual({ model: 'shared', modelProvider: 'coding', effort: undefined });
  const effort = screen.getByRole('combobox', { name: '思考强度' });
  expect(within(effort).queryByRole('option', { name: '高' })).toBeNull();
  fireEvent.change(effort, { target: { value: 'max' } });
  expect(current.effort).toBe('max');
});
it('does not present a bundled or inherited default as an available model with an empty catalog', () => {
  const providers = vi.fn();
  render(<ModelPicker models={[]} options={{}} onOptions={vi.fn()} defaults={{ model: 'bundled-model' }} existingThread={false} onProviders={providers} />);
  open();
  expect(screen.queryByText(/bundled-model/)).toBeNull();
  expect(screen.getByRole('combobox', { name: '模型' }).matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '管理供应商' }));
  expect(providers).toHaveBeenCalledOnce();
});
it('limits an existing conversation to its own provider and shows unsupported effort explicitly', () => {
  render(<ModelPicker models={[...models, { id: 'simple', modelProvider: 'coding', supportedReasoningEfforts: [] }]} options={{ model: 'simple' }} onOptions={vi.fn()}
    defaults={{ modelProvider: 'coding' }} existingThread />);
  open();
  expect(screen.queryByRole('option', { name: '同名模型 A' })).toBeNull();
  expect(screen.getByRole('combobox', { name: '思考强度' }).matches(':disabled')).toBe(true);
  expect(screen.getByRole('option', { name: '此模型未提供可调强度' })).toBeTruthy();
});
it('checks media and collaboration defaults against the selected provider rather than a same-name model', () => {
  const options = { model: 'shared', modelProvider: 'coding', mode: 'plan' as const };
  const defaults = { model: 'shared', modelProvider: 'openai', reasoningEffort: 'high' };
  const modes = [{ name: '计划', mode: 'plan' as const, model: 'shared', reasoning_effort: 'high' as const }];
  expect(mediaAdmission({ attachments: [{ mimeType: 'image/png' }], models, modelsLoading: false, defaultsLoading: false, options, defaults, modes, intent: 'send' }).issue).toContain('未声明支持图片');
  expect(executionOptions(options, defaults, modes)).toMatchObject({ modelProvider: 'coding', collaborationMode: { settings: { reasoning_effort: null } } });
});
it('blocks a stale reasoning override after the default model changes and lets it return to default', () => {
  const send = vi.fn(async () => false);
  const simple: Model = { id: 'simple', modelProvider: 'coding', supportedReasoningEfforts: [] };
  function Harness({ defaults }: { defaults: Record<string, unknown> }) {
    const [options, setOptions] = useState<Options>({ effort: 'high' });
    return <Composer api={{} as Api} value="preserve draft" onChange={vi.fn()} onSend={send} onStop={vi.fn()}
      busy={false} disabled={false} active={false} options={options} onOptions={setOptions} models={[...models, simple]}
      defaults={defaults} defaultsLoading={false} notice="" contextKey="same-draft" />;
  }
  const view = render(<Harness defaults={{ model: 'shared', modelProvider: 'openai' }} />);
  expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(false);
  view.rerender(<Harness defaults={{ model: 'simple', modelProvider: 'coding' }} />);
  expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(true);
  fireEvent.keyDown(screen.getByRole('textbox', { name: '给 Codex 的消息' }), { key: 'Enter' });
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('思考强度已不适用于当前模型');
  open();
  const picker = screen.getByRole('combobox', { name: '思考强度' });
  expect(picker.matches(':disabled')).toBe(false);
  expect(screen.getByRole('option', { name: '恢复模型默认强度' })).toBeTruthy();
  fireEvent.change(picker, { target: { value: '' } });
  expect(screen.queryByRole('option', { name: '原强度已不可用' })).toBeNull();
  expect(screen.getByRole('button', { name: '发送消息' }).matches(':disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(send).toHaveBeenCalledOnce();
});
it('validates reasoning against the exact provider and permits legacy provider aliases', () => {
  const state = { options: { effort: 'high' }, defaults: { model: 'shared', modelProvider: 'coding' },
    defaultsLoading: false, modelsLoading: false, models, modes: [] };
  expect(modelSettingsIssue(state)).toContain('思考强度已不适用于');
  expect(modelSettingsIssue({ ...state, models: [] })).toContain('尚未确认');
  expect(modelSettingsIssue({ ...state, options: {} })).toBe('');
  expect(modelSettingsIssue({ ...state, defaults: { model: 'shared', modelProvider: 'openai' },
    models: [{ ...models[0]!, modelProvider: 'harness_chatgpt', providerAliases: ['openai'] }] })).toBe('');
});
it('does not apply unused model overrides to queue admission', () => {
  const send = vi.fn(async () => false);
  render(<Composer api={{} as Api} value="queue draft" onChange={vi.fn()} onSend={send} onStop={vi.fn()}
    busy={false} disabled={false} active existingThread options={{ effort: 'high' }} onOptions={vi.fn()}
    models={[]} defaults={{ model: 'removed-model' }} defaultsLoading={false} notice="" contextKey="queue-thread" />);
  fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
  expect(send).toHaveBeenCalledWith([], 'queue');
});

it('waits for an existing chat identity before showing same-name model capabilities', () => {
  const change = vi.fn();
  const view = render(<ModelPicker models={models} options={{ model: 'shared' }} onOptions={change}
    existingThread defaultsLoading />);
  open();
  expect(screen.getByRole('combobox', { name: '模型' }).matches(':disabled')).toBe(true);
  expect(screen.queryByRole('option', { name: '高' })).toBeNull();
  expect(screen.queryByRole('option', { name: '最高' })).toBeNull();
  expect(screen.getByText('读取模型设置…')).toBeTruthy();
  view.rerender(<ModelPicker models={models} options={{ model: 'shared' }} onOptions={change}
    existingThread defaultsLoading={false} defaults={{ model: 'shared', modelProvider: 'coding', reasoningEffort: 'max' }} />);
  expect(screen.getByRole('option', { name: '最高' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: '同名模型 A' })).toBeNull();
  expect(change).not.toHaveBeenCalled();
});

it('does not guess capabilities when a saved model name has no unambiguous provider', () => {
  render(<ModelPicker models={models} options={{ model: 'shared' }} onOptions={vi.fn()} existingThread={false} />);
  open();
  expect(screen.getByRole('combobox', { name: '思考强度' }).matches(':disabled')).toBe(true);
  expect(screen.queryByRole('option', { name: '高' })).toBeNull();
  expect(screen.queryByRole('option', { name: '最高' })).toBeNull();
});
