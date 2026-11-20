// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Api } from '../lib/api';
import { downloadBlob } from '../lib/download';
import { QueueHandoffOriginals } from '../components/QueueHandoffOriginals';

vi.mock('../lib/download', () => ({ downloadBlob: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const uploaded = { attachmentId: 'owned-file', name: '宽图.png', mimeType: 'image/png', size: 3 };

test('a manual source-file selection lists only metadata, then requests the original for download in the same conversation and backup', async () => {
  const call = vi.fn().mockResolvedValueOnce({ data: [uploaded] }).mockResolvedValueOnce({ ...uploaded, base64: 'AQL/' });
  render(<QueueHandoffOriginals api={{ call } as unknown as Api} scope="epoch" threadId="source" handoffId="record" count={1} />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '查看候选原件' }));
  fireEvent.click(await screen.findByRole('button', { name: '下载原文件' }));
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
  expect(call.mock.calls.map(row => row.slice(0, 2))).toEqual([
    ['thread/queue/handoff/candidates', { threadId: 'source', handoffId: 'record' }],
    ['thread/queue/handoff/candidates', { threadId: 'source', handoffId: 'record', attachmentId: 'owned-file' }],
  ]);
  expect(vi.mocked(downloadBlob).mock.calls[0]?.[0].size).toBe(3);
  expect(vi.mocked(downloadBlob).mock.calls[0]?.[1]).toBe('宽图.png');
});

test('a download that finishes after the original conversation closes is discarded', async () => {
  let finish!: (data: unknown) => void;
  const call = vi.fn().mockResolvedValueOnce({ data: [uploaded] }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<QueueHandoffOriginals api={{ call } as unknown as Api} scope="epoch" threadId="source" handoffId="record" count={1} />);
  fireEvent.click(screen.getByRole('button', { name: '查看候选原件' }));
  fireEvent.click(await screen.findByRole('button', { name: '下载原文件' }));
  view.unmount();
  await act(async () => finish({ ...uploaded, base64: 'AQL/' }));
  expect(call.mock.calls[1]?.[2].aborted).toBe(true);
  expect(downloadBlob).not.toHaveBeenCalled();
});

test('a mismatched response cannot download another candidate', async () => {
  const call = vi.fn().mockResolvedValueOnce({ data: [uploaded] }).mockResolvedValueOnce({ ...uploaded, attachmentId: 'different', base64: 'AQL/' });
  render(<QueueHandoffOriginals api={{ call } as unknown as Api} scope="epoch" threadId="source" handoffId="record" count={1} />);
  fireEvent.click(screen.getByRole('button', { name: '查看候选原件' }));
  fireEvent.click(await screen.findByRole('button', { name: '下载原文件' }));
  expect((await screen.findByRole('alert')).textContent).toContain('与所选记录不符');
  expect(downloadBlob).not.toHaveBeenCalled();
});
