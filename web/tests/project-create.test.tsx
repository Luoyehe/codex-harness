// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Api } from '../lib/api';
import { ProjectDialog } from '../components/ProjectDialog';
import { listOperations, updateOperation } from '../lib/operations';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a new user creates a usable project with just its name, without knowing a server path', async () => {
  const requests: { method: string; params: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    return { status: 200, ok: true, json: async () => ({ ok: true, result: request.method === 'project/defaults' ? { directory: '/native/projects' } : { id: 'created', name: 'my-project', path: '/native/projects/my-project' } }) };
  }));
  const onAdded = vi.fn(), onClose = vi.fn(), onOpen = vi.fn();
  render(<ProjectDialog api={new Api()} onAdded={onAdded} onClose={onClose} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'my-project' } });
  await screen.findByText('/native/projects/my-project');
  const save = screen.getByRole('button', { name: '创建项目' }); await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(requests.filter(item => item.method === 'project/create')).toMatchObject([{ params: { name: 'my-project', directory: 'my-project' } }]);
  expect(onAdded).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('created');
});

test('existing directories remain a separate flow and show a useful permission error without losing the path', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    return { status: 200, ok: true, json: async () => request.method === 'project/defaults' ? { ok: true, result: { directory: '/native/projects' } } : { ok: false, error: { code: 'project_permission_denied', message: '项目执行账号无法访问此目录。请使用“新建项目”。', delivery: 'not_sent' } } };
  }));
  render(<ProjectDialog api={new Api()} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '添加已有目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Existing' } });
  fireEvent.change(screen.getByRole('textbox', { name: '服务器上的绝对目录' }), { target: { value: '/root/project' } });
  const save = screen.getByRole('button', { name: '添加项目' }); await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '项目执行账号无法访问此目录。请使用“新建项目”。');
  expect(screen.getByRole('textbox', { name: '服务器上的绝对目录' })).toHaveProperty('value', '/root/project');
});

test('an accepted project without an ID stays visible for reconciliation and cannot be resubmitted', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request.method);
    return { status: 200, ok: true, json: async () => ({ ok: true, result: request.method === 'project/defaults' ? { directory: '/native/projects' } : {} }) };
  }));
  const onOpen = vi.fn(), onClose = vi.fn();
  render(<ProjectDialog api={new Api()} onAdded={vi.fn()} onClose={onClose} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'new-project' } });
  const save = screen.getByRole('button', { name: '创建项目' });
  await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '项目已受理，但未收到项目编号。请关闭窗口后在项目列表中核对，不要重复添加。');
  expect(save).toHaveProperty('disabled', true);
  fireEvent.submit(save.closest('form')!);
  expect(requests.filter(method => method === 'project/create')).toHaveLength(1);
  expect(onOpen).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});

test('an unknown project later confirmed accepted stays frozen without a second create', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request.method);
    if (request.method === 'project/defaults') return { status: 200, ok: true, json: async () => ({ ok: true, result: { directory: '/native/projects' } }) };
    throw new Error('Fixture response lost after server acceptance');
  }));
  const api = new Api(), mutate = vi.spyOn(api, 'mutate'), onAdded = vi.fn(), onOpen = vi.fn(), onClose = vi.fn();
  render(<ProjectDialog api={api} onAdded={onAdded} onClose={onClose} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'new-project' } });
  const save = screen.getByRole('button', { name: '创建项目' });
  await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
  await waitFor(async () => expect((await listOperations())[0]?.state).toBe('unknown'));
  expect(save).toHaveProperty('disabled', true);
  const operation = (await listOperations())[0]!;
  await act(async () => { await updateOperation(operation.id, 'accepted'); });
  await waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
  expect(await screen.findByText('项目已受理。请关闭窗口后在项目列表中核对，不要重复添加。')).toBeTruthy();
  expect(save).toHaveProperty('disabled', true);
  fireEvent.click(save); fireEvent.submit(save.closest('form')!);
  expect(mutate).toHaveBeenCalledOnce();
  expect(requests.filter(method => method === 'project/create')).toHaveLength(1);
  expect(onOpen).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});

test('project mode choices expose their selected state and retain both drafts without submitting', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request.method);
    if (request.method !== 'project/defaults') throw new Error('Mode switching must not submit');
    return { status: 200, ok: true, json: async () => ({ ok: true, result: { directory: '/native/projects' } }) };
  }));
  render(<ProjectDialog api={new Api()} onAdded={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
  await screen.findByText('/native/projects/目录名');
  const create = screen.getByRole('button', { name: '新建项目' });
  const existing = screen.getByRole('button', { name: '添加已有目录' });
  expect(create.getAttribute('aria-pressed')).toBe('true');
  expect(existing.getAttribute('aria-pressed')).toBe('false');
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Shared name' } });
  fireEvent.change(screen.getByRole('textbox', { name: '目录名' }), { target: { value: 'new-directory' } });
  fireEvent.click(existing);
  expect(existing.getAttribute('aria-pressed')).toBe('true');
  expect(create.getAttribute('aria-pressed')).toBe('false');
  fireEvent.change(screen.getByRole('textbox', { name: '服务器上的绝对目录' }), { target: { value: '/existing/project' } });
  fireEvent.click(create);
  expect(screen.getByRole('textbox', { name: '目录名' })).toHaveProperty('value', 'new-directory');
  fireEvent.click(existing);
  expect(screen.getByRole('textbox', { name: '服务器上的绝对目录' })).toHaveProperty('value', '/existing/project');
  expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveProperty('value', 'Shared name');
  expect(requests).toEqual(['project/defaults']);
});
