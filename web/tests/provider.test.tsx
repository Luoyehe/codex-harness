// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { ModelCatalog } from '../components/ModelCatalog';
import { ProviderSettings } from '../components/ProviderSettings';
afterEach(cleanup);
describe('provider configuration intent', () => {
  it('preserves edits made while native catalog refresh is pending', async () => {
    let finish!: (value: unknown) => void;
    const mutate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const call = vi
      .fn()
      .mockResolvedValue({ revision: 'r', kind: 'chatgpt', model: 'saved-model' });
    render(
      <ProviderSettings api={{ mutate, call } as unknown as Api} epoch="a" onChanged={vi.fn()} />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('saved-model'),
    );
    fireEvent.click(screen.getByRole('button', { name: '发现模型' }));
    fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: 'unsaved-model' } });
    await act(async () => finish({
      source: 'native', kind: 'chatgpt', revision: 'r', applied: false, requiresConfirmation: false,
    }));
    await screen.findByText('当前使用原生模型目录，无需应用自定义目录。');
    expect(call).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('unsaved-model');
  });
  it('preserves a dirty draft on external revision change and requires explicit reload', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ revision: 'r1', kind: 'chatgpt', model: 'old' })
      .mockResolvedValue({ revision: 'r2', kind: 'chatgpt', model: 'external' });
    const api = { call, mutate: vi.fn() } as unknown as Api;
    const view = render(<ProviderSettings api={api} epoch="a" onChanged={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('old'),
    );
    fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: 'draft' } });
    view.rerender(<ProviderSettings api={api} epoch="b" onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: '放弃编辑并重新读取' });
    expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('draft');
    expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '放弃编辑并重新读取' }));
    await waitFor(() =>
      expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('external'),
    );
  });
  it('requires separate capability confirmation after discovering model IDs', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'responses', revision: 'r', source: 'provider', applied: false,
        models: [{ id: 'model-x', defaultEffort: null, efforts: [] }],
        requiresConfirmation: true,
      })
      .mockResolvedValue({
        kind: 'responses', revision: 'r2', applied: true, requiresConfirmation: false,
      });
    render(
      <ModelCatalog
        api={{ mutate } as unknown as Api}
        provider={{ revision: 'r', kind: 'responses' }}
        onApplied={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '发现模型' }));
    await screen.findByText('发现 1 个模型 ID，尚未应用。');
    expect(mutate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'model-x' }));
    const apply = screen.getByRole('button', { name: '应用 1 个确认的模型' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('model-x：允许覆盖的推理强度'), {
      target: { value: 'medium, high' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '支持工具调用' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: '我已核对选中模型的能力；应用后将重启运行时。' }),
    );
    fireEvent.click(apply);
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        'system/models/refresh',
        expect.objectContaining({
          expectedRevision: 'r',
          confirmCapabilities: true,
          models: [
            expect.objectContaining({
              id: 'model-x',
              efforts: ['medium', 'high'],
              supportsTools: true,
              inputModalities: ['text'],
            }),
          ],
        }),
      ),
    );
  });
  it('can explicitly configure a Responses service without authentication', async () => {
    const mutate = vi.fn().mockResolvedValue({}),
      call = vi.fn().mockResolvedValue({
        revision: 'r',
        kind: 'responses',
        baseUrl: 'http://192.168.1.5/v1',
        model: 'model-x',
        hasApiKey: true,
      });
    render(
      <ProviderSettings api={{ mutate, call } as unknown as Api} epoch="a" onChanged={vi.fn()} />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText('供应商') as HTMLSelectElement).value).toBe('responses'),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '不使用 API Key（明确留空）' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        'system/provider/write',
        {
          expectedRevision: 'r',
          kind: 'responses',
          baseUrl: 'http://192.168.1.5/v1',
          model: 'model-x',
          apiKey: '',
          allowInsecureHttp: false,
        },
      ),
    );
  });
});
