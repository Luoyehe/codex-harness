// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mediaAdmission } from '../lib/input-modalities';
import { Composer } from '../components/Composer';
import type { Api } from '../lib/api';
const audio = { attachmentId: 'audio', name: 'note.wav', mimeType: 'audio/wav', size: 20 },
  image = { attachmentId: 'image', name: 'photo.png', mimeType: 'image/png', size: 20 };
const models = [
  { id: 'capable', model: 'capable', inputModalities: ['text', 'audio', 'image'] },
  { id: 'text', model: 'text', inputModalities: ['text'] },
];
const request = {
  attachments: [audio],
  intent: 'send' as const,
  models,
  modelsLoading: false,
  defaults: { model: 'capable' },
  defaultsLoading: false,
  options: {},
  modes: [],
};
afterEach(cleanup);
it('blocks unknown or duplicate catalogs and unsupported modalities without assuming capability', () => {
  expect(mediaAdmission({ ...request, models: [] }).issue).toContain('尚未由目录明确提供');
  expect(mediaAdmission({ ...request, models: [{ id: 'capable' }] }).issue).toContain(
    '尚未由目录明确提供',
  );
  expect(mediaAdmission({ ...request, models: [models[0]!, models[0]!] }).issue).toContain(
    '尚未由目录明确提供',
  );
  expect(mediaAdmission({ ...request, options: { model: 'text' } }).issue).toContain(
    '未声明支持音频',
  );
  expect(mediaAdmission({ ...request, modelsLoading: true }).issue).toContain('正在核对');
});
it('uses the exact prepared collaboration model and ignores send overrides for queue admission', () => {
  expect(
    mediaAdmission({
      ...request,
      options: { model: 'capable', mode: 'plan' },
      defaults: { model: 'text' },
      modes: [{ name: 'Plan', mode: 'plan', model: 'text', reasoning_effort: null }],
    }).issue,
  ).toBe('');
  expect(
    mediaAdmission({
      ...request,
      intent: 'queue',
      options: { model: 'capable' },
      defaults: { model: 'text' },
    }).issue,
  ).toContain('未声明支持音频');
  expect(
    mediaAdmission({
      ...request,
      intent: 'queue',
      options: { model: 'text' },
      defaults: { model: 'capable' },
    }).issue,
  ).toBe('');
  expect(mediaAdmission({ ...request, options: { mode: 'plan' }, modes: [] }).issue).toContain(
    '协作模式或默认模型尚未确认',
  );
});
it('does not pretend thread settings prove current-turn overrides and leaves ordinary file references usable', () => {
  expect(mediaAdmission({ ...request, intent: 'steer' }).issue).toContain('独立模型设置');
  expect(
    mediaAdmission({ ...request, models: [], attachments: [{ mimeType: 'application/pdf' }] })
      .issue,
  ).toBe('');
  expect(mediaAdmission({ ...request, attachments: [audio, image] }).modalities).toEqual([
    'audio',
    'image',
  ]);
});
function props() {
  return {
    api: {} as Api,
    value: 'keep my draft',
    onChange: vi.fn(),
    onSend: vi.fn().mockResolvedValue(false),
    onStop: vi.fn(),
    busy: false,
    disabled: false,
    active: false,
    options: {},
    onOptions: vi.fn(),
    models,
    defaults: { model: 'capable' },
    defaultsLoading: false,
    notice: '',
    contextKey: 'thread',
    savedAttachments: [audio],
    onAttachmentsChange: vi.fn(),
    onRefreshModels: vi.fn(),
  };
}
it('sends a supported audio attachment natively only after an explicit click', () => {
  const p = props();
  render(<Composer {...p} />);
  expect(screen.getByText(/音频将作为原生音频输入/)).toBeTruthy();
  expect(p.onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(p.onSend).toHaveBeenCalledWith([audio], 'send');
});
it('keeps text and attachments intact after selecting an unsupported model, with explicit read-only refresh', () => {
  const p = props();
  const view = render(<Composer {...p} />);
  view.rerender(<Composer {...p} options={{ model: 'text' }} />);
  expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.keyDown(screen.getByRole('textbox', { name: '给 Codex 的消息' }), { key: 'Enter' });
  expect(p.onSend).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
  ).toBe('keep my draft');
  expect(screen.getByRole('button', { name: '移除 note.wav' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重新核对模型能力' }));
  expect(p.onRefreshModels).toHaveBeenCalledOnce();
  expect(p.onAttachmentsChange).not.toHaveBeenCalled();
});
it('allows supported queued audio but blocks steering until a current-turn model can be proved', () => {
  const p = props();
  render(<Composer {...p} existingThread active canSteer options={{ model: 'text' }} />);
  expect((screen.getByRole('button', { name: '加入队列' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
  expect(p.onSend).toHaveBeenCalledWith([audio], 'queue');
  fireEvent.change(screen.getByRole('combobox', { name: '当前发送方式' }), {
    target: { value: 'steer' },
  });
  expect(
    (screen.getByRole('button', { name: '追加到当前回合' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText(/当前回合可能使用独立模型设置/)).toBeTruthy();
  expect(p.onSend).toHaveBeenCalledTimes(1);
});
it('cannot submit media while session/default identity is loading even if old catalog rows remain', () => {
  const p = props();
  render(<Composer {...p} defaultsLoading />);
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(p.onSend).not.toHaveBeenCalled();
  expect(screen.getByText(/正在核对模型的图片与音频能力/)).toBeTruthy();
});

it('admits native images or explicit text-model tool use, checking queue and steer independently', () => {
  const probe = (mime: string, supportsTools?: boolean, intent: 'send'|'queue'|'steer' = 'send', modalities = ['text']) =>
    mediaAdmission({ ...request, intent, attachments: [{ mimeType: mime }], defaults: { model: 'actual' },
      models: [{ id: 'actual', inputModalities: modalities, supportsTools }] }).issue;
  expect(probe('image/png', true)).toBe('');
  expect(probe('image/jpeg', true, 'queue')).toBe('');
  expect(probe('image/png', false)).toContain('未声明');
  expect(probe('image/png')).toContain('未声明');
  expect(probe('image/webp', true)).toContain('JPEG 和 PNG');
  expect(probe('image/webp', false, 'send', ['text','image'])).toBe('');
  expect(probe('audio/wav', true)).toContain('未声明支持音频');
  expect(probe('image/png', true, 'steer')).toContain('无法确认');
});

it('never borrows image capability or tool fallback from unowned rows in a mixed or incomplete provider catalog', () => {
  const old = {id:'same',supportsTools:true,inputModalities:['text']};
  const input={ ...request,attachments:[image],options:{model:'same',modelProvider:'target'},models:[old] };
  expect(mediaAdmission({...input,directoryComplete:false}).issue).toContain('明确提供');
  expect(mediaAdmission({...input,models:[old,{id:'other',modelProvider:'foreign'}]}).issue).toContain('明确提供');
  expect(mediaAdmission({...input,directoryComplete:true}).toolImageReference).toBe(true);
});
