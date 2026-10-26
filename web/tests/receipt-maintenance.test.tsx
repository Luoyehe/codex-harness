// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReceiptMaintenance } from '../components/ReceiptMaintenance';
import { receiptArchive, rotationKey, type ArchivePreview } from '../lib/receipt-archive';
import type { Api } from '../lib/api';

const text = '{"receipt":"one"}\n{"receipt":"two"}\n';
const digest = createHash('sha256').update(text).digest('hex');
const preview: ArchivePreview = {
  generation: 1,
  nextGeneration: 2,
  digest,
  bytes: Buffer.byteLength(text),
  receipts: 2,
  retirements: 0,
  blocked: [],
  exportId: 'export-one',
};
const chunk = (offset: number) => ({
  digest,
  offset,
  totalBytes: preview.bytes,
  base64: btoa(text.slice(offset, offset + 18)),
  nextOffset: offset + 18 < preview.bytes ? offset + 18 : null,
});
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn().mockReturnValue('blob:receipt'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('checks every export byte and digest before enabling explicit rotation', async () => {
  const call = vi
    .fn()
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method.endsWith('/preview')) return preview;
      if (method.endsWith('/chunk')) return chunk(Number(params.offset));
      if (method.endsWith('/rotate'))
        return { rotated: true, generation: 2, archivedDigest: digest };
    });
  render(<ReceiptMaintenance api={{ call } as unknown as Api} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '读取容量与归档预览' }));
  const rotate = await screen.findByRole('button', { name: '确认归档并轮换' });
  expect(rotate.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '下载并校验完整回执归档' }));
  await screen.findByText(/完整归档已校验并交给浏览器下载/);
  const exported = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
  expect(await exported.text()).toBe(text);
  expect(rotate.hasAttribute('disabled')).toBe(true);
  fireEvent.click(
    screen.getByRole('checkbox', { name: '我已保存校验通过的完整归档，确认轮换回执代际' }),
  );
  fireEvent.click(rotate);
  await screen.findByText(/回执已归档并完成代际轮换/);
  expect(call).toHaveBeenLastCalledWith('operation/maintenance/rotate', {
    exportId: 'export-one',
    digest,
    nextGeneration: 2,
    exportedDigest: digest,
    confirm: true,
  });
  expect(sessionStorage.getItem(rotationKey)).toBeNull();
});
it('never enables rotation for discontinuous or tampered export data', async () => {
  const discontinuous = {
    call: vi.fn().mockResolvedValue({ ...chunk(0), nextOffset: 9 }),
  } as unknown as Api;
  await expect(
    receiptArchive(discontinuous, preview, new AbortController().signal, vi.fn()),
  ).rejects.toThrow('不连续');
  const tampered = {
    call: vi.fn().mockImplementation(async (_, params) => ({
      ...chunk(params.offset),
      base64: btoa(text.slice(params.offset, params.offset + 18).replaceAll('one', 'bad')),
    })),
  } as unknown as Api;
  await expect(
    receiptArchive(tampered, preview, new AbortController().signal, vi.fn()),
  ).rejects.toThrow('SHA-256');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('retains an unknown rotation across remount and only confirms it with generation plus archive digest', async () => {
  let recovered = false;
  const call = vi
    .fn()
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method.endsWith('/preview'))
        return recovered
          ? {
              ...preview,
              generation: 2,
              nextGeneration: 3,
              lastRotation: { generation: 2, archivedDigest: digest },
            }
          : preview;
      if (method.endsWith('/chunk')) return chunk(Number(params.offset));
      throw new Error('connection lost after dispatch');
    });
  const api = { call } as unknown as Api;
  const view = render(<ReceiptMaintenance api={api} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '读取容量与归档预览' }));
  fireEvent.click(await screen.findByRole('button', { name: '下载并校验完整回执归档' }));
  await screen.findByText(/完整归档已校验并交给浏览器下载/);
  fireEvent.click(
    screen.getByRole('checkbox', { name: '我已保存校验通过的完整归档，确认轮换回执代际' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '确认归档并轮换' }));
  await screen.findByText('connection lost after dispatch');
  expect(sessionStorage.getItem(rotationKey)).not.toBeNull();
  view.unmount();
  render(<ReceiptMaintenance api={api} onChanged={vi.fn()} />);
  expect(screen.queryByRole('button', { name: '确认归档并轮换' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '核对上次轮换结果' }));
  await screen.findByText(/上次轮换结果仍未能确认/);
  expect(screen.getByRole('button', { name: '确认归档并轮换' }).hasAttribute('disabled')).toBe(
    true,
  );
  recovered = true;
  fireEvent.click(screen.getByRole('button', { name: '核对上次轮换结果' }));
  await screen.findByText(/已通过服务代际和归档摘要确认上次轮换成功/);
  expect(call.mock.calls.filter(([method]) => method.endsWith('/rotate'))).toHaveLength(1);
  expect(sessionStorage.getItem(rotationKey)).toBeNull();
});
it('does not dispatch when an active-work blocker exists', async () => {
  const call = vi.fn().mockResolvedValue({ ...preview, blocked: ['active turn'] });
  render(<ReceiptMaintenance api={{ call } as unknown as Api} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '读取容量与归档预览' }));
  await screen.findByText(/暂不能轮换：active turn/);
  expect(screen.getByRole('button', { name: '确认归档并轮换' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(call.mock.calls.some(([method]) => method.endsWith('/rotate'))).toBe(false);
});
it('does not rotate when the durable local maintenance intent cannot be saved', async () => {
  const call = vi
    .fn()
    .mockImplementation(async (method: string, params: Record<string, unknown>) =>
      method.endsWith('/preview') ? preview : chunk(Number(params.offset)),
    );
  render(<ReceiptMaintenance api={{ call } as unknown as Api} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '读取容量与归档预览' }));
  fireEvent.click(await screen.findByRole('button', { name: '下载并校验完整回执归档' }));
  await screen.findByText(/完整归档已校验并交给浏览器下载/);
  fireEvent.click(
    screen.getByRole('checkbox', { name: '我已保存校验通过的完整归档，确认轮换回执代际' }),
  );
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage denied');
  });
  fireEvent.click(screen.getByRole('button', { name: '确认归档并轮换' }));
  await screen.findByText('storage denied');
  expect(call.mock.calls.some(([method]) => method.endsWith('/rotate'))).toBe(false);
});
it('discards a late exported archive after leaving the maintenance view', async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn().mockImplementation((method: string) =>
    method.endsWith('/preview')
      ? Promise.resolve(preview)
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const view = render(<ReceiptMaintenance api={{ call } as unknown as Api} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '读取容量与归档预览' }));
  fireEvent.click(await screen.findByRole('button', { name: '下载并校验完整回执归档' }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  view.unmount();
  await act(async () =>
    finish({ digest, offset: 0, totalBytes: preview.bytes, base64: btoa(text), nextOffset: null }),
  );
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
