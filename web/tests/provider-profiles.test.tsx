// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderSettings } from '../components/ProviderSettings';
import { ProviderProfiles } from '../components/ProviderProfiles';
import { useExtensionAction } from '../components/ExtensionControls';
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

it('clears unsubmitted profile confirmation after hiding while keeping the authenticated operation owner', async () => {
  const api = { call: vi.fn().mockResolvedValue({ revision: 'r', kind: 'chatgpt', profiles }), mutate: vi.fn() } as unknown as Api;
  const props = { api, epoch: 'a', onChanged: vi.fn() };
  const view = render(<ProviderSettings {...props} />);
  await screen.findByRole('option', { name: 'Endpoint A' });
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: profiles[0]!.id } });
  const label = '我已核对目标，恢复此配置并重启原生服务';
  fireEvent.click(screen.getByRole('checkbox', { name: label }));
  expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(true);
  view.rerender(<ProviderSettings {...props} visible={false} />);
  view.rerender(<ProviderSettings {...props} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(false));
  expect(screen.getByRole('button', { name: '恢复所选配置档' }).hasAttribute('disabled')).toBe(true);
  expect(api.mutate).not.toHaveBeenCalled();
});

it.each([
  ['我已核对目标，恢复此配置并重启原生服务', '恢复所选配置档', 'profileId'],
  ['删除此配置档；当前生效配置保持不变', '删除所选配置档', 'deleteProfileId'],
])('requires fresh profile consent after a delayed registry read for %s', async (label, button, field) => {
  const connection = (id: string) => ({ id, name: id, kind: 'responses', enabled: true });
  const profile = { ...profiles[0]!, connections: [connection('a')], defaultProviderId: 'a' };
  const registry = (revision: string, ids: string[]) => ({
    revision, kind: 'responses', defaultProviderId: 'a', connections: ids.map(connection), profiles: [profile],
  });
  const old = registry('r1', ['a']), latest = registry('r2', ['a', 'new-connection']);
  let deliver!: (value: typeof latest) => void;
  const call = vi.fn().mockResolvedValueOnce(old)
    .mockImplementationOnce(() => new Promise<typeof latest>(resolve => { deliver = resolve; }))
    .mockResolvedValue(latest);
  const mutate = vi.fn().mockResolvedValue({});
  const props = { api: { call, mutate } as unknown as Api, onChanged: vi.fn() };
  const view = render(<ProviderSettings {...props} epoch="one" />);
  await screen.findByRole('button', { name: 'a（默认）' });
  fireEvent.click(screen.getByText('配置备份', { selector: 'summary' }));
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: profile.id } });
  const check = () => screen.getByRole('checkbox', { name: label }) as HTMLInputElement;
  const submit = () => screen.getByRole('button', { name: button }) as HTMLButtonElement;
  expect(screen.getByText('将移出的当前连接：无')).toBeTruthy();
  fireEvent.click(check());
  expect(submit().disabled).toBe(false);

  view.rerender(<ProviderSettings {...props} epoch="two" />);
  await screen.findByText('读取配置中…');
  expect(check().checked).toBe(false);
  expect(check().disabled).toBe(true);
  fireEvent.click(check());
  fireEvent.click(submit());
  expect(mutate).not.toHaveBeenCalled();

  await act(async () => deliver(latest));
  await screen.findByText('将移出的当前连接：new-connection');
  expect(check().disabled).toBe(false);
  expect(check().checked).toBe(false);
  expect(submit().disabled).toBe(true);
  fireEvent.click(submit());
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(check());
  fireEvent.click(submit());
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(mutate).toHaveBeenCalledWith('system/provider/write', { expectedRevision: 'r2', [field]: profile.id });
});

it('invalidates confirmation when the registry revision changes in an otherwise editable view', async () => {
  const mutate = vi.fn().mockResolvedValue({});
  const api = { mutate } as unknown as Api;
  const changed = vi.fn();
  function ProfileView({ revision }: { revision: string }) {
    const action = useExtensionAction(api, true, changed);
    return <ProviderProfiles provider={{ revision, profiles }} action={action} hasDraft={false} onUpdated={changed} />;
  }
  const view = render(<ProfileView revision="r1" />);
  const id = profiles[0]!.id;
  fireEvent.change(screen.getByLabelText('选择已保存配置'), { target: { value: id } });
  const check = screen.getByLabelText('我已核对目标，恢复此配置并重启原生服务') as HTMLInputElement;
  const apply = screen.getByRole('button', { name: '恢复所选配置档' }) as HTMLButtonElement;
  fireEvent.click(check);
  expect(apply.disabled).toBe(false);
  view.rerender(<ProfileView revision="r2" />);
  expect(check.disabled).toBe(false);
  expect(check.checked).toBe(false);
  expect(apply.disabled).toBe(true);
  fireEvent.click(apply);
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(check);
  fireEvent.click(apply);
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(mutate).toHaveBeenCalledWith('system/provider/write', { expectedRevision: 'r2', profileId: id });
});
