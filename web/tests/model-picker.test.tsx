// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelPicker, modelSelection } from '../components/ModelPicker';
import type { Model, Options } from '../lib/types';
import { mediaAdmission } from '../lib/input-modalities';
import { executionOptions, modelSettingsIssue } from '../lib/workflows';
import { providerModels, providerRelation } from '../lib/provider-models';
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
it('explicitly sends the selected model default instead of silently inheriting the previous effort', () => {
  const catalog: Model[] = [
    { ...models[0]!, id: 'first', model: 'first', defaultReasoningEffort: 'high' },
    { ...models[0]!, id: 'second', model: 'second', defaultReasoningEffort: 'medium' },
  ];
  const defaults = { model: 'first', modelProvider: 'openai', reasoningEffort: 'high' };
  let current: Options = {};
  function Harness() {
    const [options, setOptions] = useState<Options>({}); current = options;
    return <ModelPicker models={catalog} options={options} onOptions={setOptions} defaults={defaults} existingThread />;
  }
  render(<Harness />); open();
  expect(screen.getByRole('option', { name: '沿用会话强度（高）' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: modelSelection(catalog[1]!) } });
  expect(current.effort).toBe('medium');
  expect(executionOptions(current, defaults, [])).toMatchObject({ model: 'second', effort: 'medium' });
  const picker = screen.getByRole('combobox', { name: '思考强度' }) as HTMLSelectElement;
  expect(picker.selectedOptions[0]?.textContent).toBe('模型默认（中）');
  fireEvent.change(picker, { target: { value: 'high' } });
  fireEvent.change(picker, { target: { value: 'medium' } });
  expect(current.effort).toBe('medium');
  expect(executionOptions({ ...current, mode: 'plan' }, defaults, [{ name: '计划', mode: 'plan', model: 'first', reasoning_effort: 'high' }])).toMatchObject({ collaborationMode: { settings: { reasoning_effort: 'medium' } } });
  fireEvent.change(picker, { target: { value: '' } });
  expect(current.effort).toBeUndefined();
  expect(picker.selectedOptions[0]?.textContent).toBe('沿用会话强度（高）');
  expect(executionOptions({ ...current, mode: 'plan' }, defaults, [{ name: '计划', mode: 'plan', model: 'first', reasoning_effort: 'medium' }])).toMatchObject({ collaborationMode: { settings: { model: 'second', reasoning_effort: 'high' } } });
});
it('does not invent a target default when the model directory does not provide one', () => {
  const next = { ...models[0]!, id: 'unknown-default', model: 'unknown-default' };
  let current: Options = {};
  function Harness() {
    const [options, setOptions] = useState<Options>({}); current = options;
    return <ModelPicker models={[models[0]!, next]} options={options} onOptions={setOptions}
      defaults={{ model: 'shared', modelProvider: 'openai', reasoningEffort: 'high' }} existingThread />;
  }
  render(<Harness />); open();
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: modelSelection(next) } });
  expect(current.effort).toBeUndefined();
  expect(screen.queryByRole('option', { name: /模型默认/ })).toBeNull();
  expect(screen.getByRole('option', { name: '沿用会话强度（高）' })).toBeTruthy();
});
it('does not confuse a mode preset with a known thread effort when native settings omit it', () => {
  const mode = [{ name: '计划', mode: 'plan' as const, model: 'shared', reasoning_effort: 'high' as const }];
  const defaults = { model: 'shared', modelProvider: 'openai' };
  render(<ModelPicker models={models} options={{ mode: 'plan' }} onOptions={vi.fn()} defaults={defaults} existingThread />); open();
  expect(screen.getByRole('option', { name: '使用模型默认' })).toBeTruthy();
  expect(executionOptions({ mode: 'plan' }, defaults, mode)).toMatchObject({ collaborationMode: { settings: { reasoning_effort: null } } });
});
it('preserves native effort when the selected provider is a verified alias of the current provider', () => {
  const catalog: Model[] = [{ ...models[0]!, modelProvider: 'harness_chatgpt', providerAliases: ['openai'] }];
  const options: Options = { model: 'shared', modelProvider: 'harness_chatgpt', mode: 'plan' };
  const defaults = { model: 'other', modelProvider: 'openai', reasoningEffort: 'high' };
  expect(executionOptions(options, defaults, [{ name: '计划', mode: 'plan', model: 'shared', reasoning_effort: 'medium' }], catalog)).toMatchObject({ collaborationMode: { settings: { reasoning_effort: 'high' } } });
});
it('shows a new conversation using project effort when the same provider supplies no model default', () => {
  const options: Options = { model: 'shared', modelProvider: 'openai', mode: 'plan' };
  const defaults = { model: 'other', modelProvider: 'openai', reasoningEffort: 'high' };
  render(<ModelPicker models={models} options={options} onOptions={vi.fn()} defaults={defaults} existingThread={false} />); open();
  expect(screen.getByRole('option', { name: '沿用默认设置（高）' })).toBeTruthy();
  expect(executionOptions(options, defaults, [{ name: '计划', mode: 'plan', model: 'other', reasoning_effort: 'medium' }])).toMatchObject({ collaborationMode: { settings: { reasoning_effort: 'high' } } });
});
it.each(['inherit', 'default', 'plan'] as const)('selects the exact fixed native default instead of old session effort in %s mode', mode => {
  const fixed: Model = { id: 'glm-5-turbo', modelProvider: 'coding', defaultReasoningEffort: 'max', supportedReasoningEfforts: [] };
  const defaults = { model: 'glm-5.3', modelProvider: 'coding', reasoningEffort: 'high' };
  const modes = [{ name: '执行', mode: 'default' as const, model: null, reasoning_effort: null },
    { name: '计划', mode: 'plan' as const, model: null, reasoning_effort: null }];
  let current: Options = {};
  function Harness() {
    const [options, setOptions] = useState<Options>(mode === 'inherit' ? {} : { mode }); current = options;
    return <ModelPicker models={[fixed]} options={options} onOptions={setOptions} defaults={defaults} existingThread />;
  }
  render(<Harness />); open();
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: modelSelection(fixed) } });
  expect(current.effort).toBe('max');
  expect((screen.getByRole('combobox', { name: '思考强度' }) as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('模型固定强度（最高）');
  expect(screen.queryByRole('option', { name: '高' })).toBeNull();
  expect(screen.queryByRole('option', { name: '原强度已不可用' })).toBeNull();
  expect(screen.getByRole('combobox', { name: '思考强度' }).hasAttribute('disabled')).toBe(true);
  expect(modelSettingsIssue({ options: current, defaults, defaultsLoading: false, models: [fixed], modelsLoading: false, modes })).toBe('');
  const sent = executionOptions(current, defaults, modes, [fixed]);
  expect(sent).toMatchObject({ model: 'glm-5-turbo', modelProvider: 'coding', effort: 'max' });
  if (mode === 'inherit') expect(sent).not.toHaveProperty('collaborationMode');
  else expect(sent).toMatchObject({ collaborationMode: { mode, settings: { model: 'glm-5-turbo', reasoning_effort: 'max' } } });
});
it('accepts only the uniquely identified fixed model default and keeps other reasoning values invalid', () => {
  const fixed: Model = { id: 'fixed', modelProvider: 'coding', providerAliases: ['native-coding'], defaultReasoningEffort: 'max', supportedReasoningEfforts: [] };
  const defaults = { model: 'fixed', modelProvider: 'native-coding', reasoningEffort: 'high' };
  const state = { options: { model: 'fixed', modelProvider: 'coding', effort: 'max' }, defaults, defaultsLoading: false, models: [fixed], modelsLoading: false, modes: [] };
  expect(modelSettingsIssue(state)).toBe('');
  expect(modelSettingsIssue({ ...state, options: { ...state.options, effort: 'high' } })).toContain('已不适用于');
  expect(modelSettingsIssue({ ...state, models: [{ ...fixed, defaultReasoningEffort: undefined }] })).toContain('已不适用于');
  expect(modelSettingsIssue({ ...state, models: [{ ...fixed, supportedReasoningEfforts: undefined }] })).toContain('已不适用于');
  expect(modelSettingsIssue({ ...state, models: [fixed, fixed] })).toContain('尚未确认');
  expect(modelSettingsIssue({ ...state, options: { ...state.options, modelProvider: 'other' } })).toContain('尚未确认');
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
it('scopes an existing conversation to its actual provider and keeps unsupported effort explicit', () => {
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
  expect(screen.getByRole('option', { name: '清除本次强度设置' })).toBeTruthy();
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

it('waits for the actual provider and never treats a saved choice as proof of the loaded identity', () => {
  const change = vi.fn();
  const view = render(<ModelPicker models={models} options={{ model: 'shared', modelProvider: 'openai' }} onOptions={change} existingThread defaultsLoading />);
  open();
  expect(screen.getByRole('combobox', { name: '模型' }).matches(':disabled')).toBe(true);
  expect(screen.getByText('读取模型设置…')).toBeTruthy();
  expect(screen.queryByRole('option', { name: '同名模型 A' })).toBeNull();
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

it('keeps the existing provider model menu local without moving the draft or sending', () => {
  const send = vi.fn(async () => false), changeDraft = vi.fn();
  let current: Options = {};
  function Harness() {
    const [options, setOptions] = useState<Options>({ effort: 'max' });
    current = options;
    return <Composer api={{} as Api} value="keep this conversation draft" onChange={changeDraft} onSend={send} onStop={vi.fn()}
      busy={false} disabled={false} active={false} existingThread options={options} onOptions={setOptions} models={models}
      defaults={{ modelProvider: 'coding', model: 'shared', reasoningEffort: 'max' }} defaultsLoading={false} notice="" contextKey="same-thread" />;
  }
  render(<Harness />); open();
  expect(screen.queryByRole('group', { name: 'ChatGPT' })).toBeNull();
  expect(screen.getByRole('group', { name: '智谱' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: modelSelection(models[1]!) } });
  expect(current).toEqual({ model: 'shared', modelProvider: 'coding', effort: undefined });
  expect(screen.getByRole('textbox', { name: '给 Codex 的消息' })).toHaveProperty('value', 'keep this conversation draft');
  expect(changeDraft).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(send).toHaveBeenCalledExactlyOnceWith([], 'send');
});

it('admits unlabelled models only for a complete entirely legacy catalog and respects explicit aliases', () => {
  const legacy = { id: 'legacy' }, tagged = { id: 'tagged', providerId: 'unresolved' };
  expect(providerModels([legacy], 'openai', true)).toEqual([legacy]);
  expect(providerModels([legacy], 'openai', false)).toEqual([]);
  expect(providerModels([...models, legacy, tagged], 'coding', true)).toEqual([models[1]]);
  const alias = { ...models[0]!, modelProvider: 'harness_chatgpt', providerAliases: ['openai'] };
  expect(providerModels([alias, legacy], 'openai', true)).toEqual([alias]);
  expect(providerRelation([models[1]!], 'openai', 'harness_chatgpt', false)).toBe('unknown');
  expect(providerRelation([models[1]!, alias], 'openai', 'harness_chatgpt', true)).toBe('same');
  expect(providerRelation([models[1]!, alias], 'coding', 'harness_chatgpt', true)).toBe('different');
});
