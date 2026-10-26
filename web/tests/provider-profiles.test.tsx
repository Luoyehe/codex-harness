// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderSettings } from '../components/ProviderSettings';
import type { Api } from '../lib/api';

afterEach(cleanup);
it('allows 64 Unicode characters in a profile name and rejects a longer draft before sending', async () => {
  const api = {
    call: vi.fn().mockResolvedValue({ revision: 'r', kind: 'chatgpt', profiles: [] }),
    mutate: vi.fn().mockResolvedValue({}),
  } as unknown as Api;
  render(<ProviderSettings api={api} epoch="name" onChanged={vi.fn()} />);
  const name = await screen.findByLabelText('新配置档名称');
  fireEvent.change(name, { target: { value: '中'.repeat(65) } });
  expect(
    screen.getByRole('button', { name: '保存当前配置为配置档' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText('配置档名称最多 64 个字符。')).toBeTruthy();
  fireEvent.change(name, { target: { value: '😀'.repeat(64) } });
  fireEvent.click(screen.getByRole('button', { name: '保存当前配置为配置档' }));
  await waitFor(() =>
    expect(api.mutate).toHaveBeenCalledWith('system/provider/write', {
      expectedRevision: 'r',
      saveProfileName: '😀'.repeat(64),
    }),
  );
});
const profiles = [
  {
    id: 'a'.repeat(32),
    name: 'Endpoint A',
    kind: 'responses',
    baseUrl: 'https://a.invalid',
    hasApiKey: true,
    revision: 'saved-a',
  },
  {
    id: 'b'.repeat(32),
    name: 'Endpoint B',
    kind: 'responses',
    baseUrl: 'https://b.invalid',
    hasApiKey: false,
    revision: 'saved-b',
  },
];
it('saves only the current complete profile and prevents restoration while local edits exist', async () => {
  const call = vi.fn().mockResolvedValue({ revision: 'r', kind: 'chatgpt', profiles }),
    mutate = vi.fn().mockResolvedValue({});
  render(
    <ProviderSettings api={{ call, mutate } as unknown as Api} epoch="a" onChanged={vi.fn()} />,
  );
  await screen.findByRole('option', { name: 'Endpoint A' });
  fireEvent.change(screen.getByLabelText('新配置档名称'), { target: { value: 'Endpoint A' } });
  expect(
    screen.getByRole('button', { name: '保存当前配置为配置档' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('新配置档名称'), { target: { value: 'Current' } });
  fireEvent.click(screen.getByRole('button', { name: '保存当前配置为配置档' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('system/provider/write', {
      expectedRevision: 'r',
      saveProfileName: 'Current',
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '保存当前配置为配置档' }).textContent).toBeTruthy(),
  );
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: profiles[0]!.id } });
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核对目标，恢复此配置并重启原生服务' }));
  fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: 'unsaved' } });
  expect(screen.getByRole('button', { name: '恢复所选配置档' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(mutate).toHaveBeenCalledTimes(1);
});
it('binds confirmation to an immutable profile identity and never sends displayed endpoint/key fields', async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn().mockResolvedValue({ revision: 'r', kind: 'chatgpt', profiles }),
    mutate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  render(
    <ProviderSettings api={{ call, mutate } as unknown as Api} epoch="a" onChanged={vi.fn()} />,
  );
  await screen.findByRole('option', { name: 'Endpoint A' });
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: profiles[0]!.id } });
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核对目标，恢复此配置并重启原生服务' }));
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: profiles[1]!.id } });
  expect(screen.getByRole('button', { name: '恢复所选配置档' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核对目标，恢复此配置并重启原生服务' }));
  fireEvent.click(screen.getByRole('button', { name: '恢复所选配置档' }));
  expect(mutate).toHaveBeenCalledWith('system/provider/write', {
    expectedRevision: 'r',
    profileId: profiles[1]!.id,
  });
  expect(screen.getByLabelText('选择已保存配置').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '恢复所选配置档' }));
  expect(mutate).toHaveBeenCalledTimes(1);
  await act(async () => finish({}));
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: profiles[1]!.id } });
  fireEvent.click(screen.getByRole('checkbox', { name: '删除此配置档；当前生效配置保持不变' }));
  fireEvent.click(screen.getByRole('button', { name: '删除所选配置档' }));
  expect(mutate).toHaveBeenLastCalledWith('system/provider/write', {
    expectedRevision: 'r',
    deleteProfileId: profiles[1]!.id,
  });
  await act(async () => finish({}));
});
