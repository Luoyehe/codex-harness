import { fitHistoryImages, NativeMediaEvent } from '../../src/runtime/native-media-event.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { QueueReplyIdentity } from '../../src/runtime/queue-reply-identity.js';
import { createHash } from 'node:crypto';
import { NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, type JsonValue } from '../../src/runtime/types.js';
import { validateOfficial } from '../../src/runtime/validation.js';
import * as nativeLaunch from '../../src/runtime/native-launch.js';

const roots = path.resolve('.work/runtime-tests'); mkdirSync(roots, { recursive: true });
const natives: NativeRpc[] = [];
async function native(): Promise<NativeRpc> { const cwd = mkdtempSync(path.join(roots, 'native-')); const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/native-fixture.mjs')], home: cwd, cwd, env: {}, requestTimeoutMs: 2000 }); natives.push(rpc); await rpc.initialize(); return rpc; }
// A reply on stdout may arrive before the stdin write callback. Budget covers both.
async function flushedEcho(rpc: NativeRpc, params: JsonValue) {
  const written = Promise.withResolvers<void>();
  const [reply] = await Promise.all([rpc.call('echo', params, { onWritten: written.resolve }), written.promise]);
  return reply;
}
afterEach(async () => { await Promise.all(natives.splice(0).map(rpc => rpc.close())); });
describe('bounded native delivery', () => {
  test('initialization requests explicit gateway authorization under the pinned schema', async () => {
    const rpc = await native(), initialization = await rpc.call('fixture/initialize/read', {});
    validateOfficial('InitializeParams', initialization); expect(initialization).toMatchObject({ capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true } });
  });
  test('validates keys and nested Unicode before any write and keeps the connection usable', async () => {
    const rpc = await native(); let writes = 0;
    await expect(rpc.call('echo', { ['bad\ud800']: 'x' }, { beforeWrite: () => writes++ })).rejects.toMatchObject({ delivery: 'not_sent', code: 'invalid_unicode' });
    await expect(rpc.call('echo', { nested: ['\udfff'] })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(writes).toBe(0);
    expect(await flushedEcho(rpc, { emoji: '🙂' })).toEqual({ emoji: '🙂' });
    expect(rpc.budget).toEqual({ pending: 0, retainedBytes: 0 });
  });
  test('beforeWrite rejection is not_sent and does not reject unrelated requests', async () => {
    const rpc = await native();
    await expect(rpc.call('echo', {}, { beforeWrite: () => { throw new DeliveryError('thread_busy', 'busy'); } })).rejects.toMatchObject({ delivery: 'not_sent', code: 'thread_busy' });
    await expect(rpc.call('echo', {}, { beforeWrite: () => { throw new Error('storage unavailable'); } })).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(rpc.call('echo', { okay: true })).resolves.toEqual({ okay: true });
  });
  test('timeout after write is unknown and fails the epoch without replay', async () => {
    const rpc = await native(); let writes = 0;
    await expect(rpc.call('hold', {}, { timeoutMs: 20, beforeWrite: () => writes++ })).rejects.toMatchObject({ delivery: 'unknown' });
    expect(writes).toBe(1); expect(rpc.connected).toBe(false);
    await expect(rpc.call('echo', {})).rejects.toMatchObject({ delivery: 'not_sent' });
    await rpc.close(); expect(rpc.budget.retainedBytes).toBe(0);
  });
  test.each(['mcpServer/tool/call', 'plugin/install'])('sent %s times out in isolation and ignores its late reply', async method => {
    const rpc = await native(); let writes = 0;
    await expect(rpc.call(method, { holdReply: true }, { timeoutMs: 15, beforeWrite: () => writes++ }))
      .rejects.toMatchObject({ code: 'timeout', delivery: 'unknown' });
    expect(await rpc.call('echo', { otherThread: true })).toEqual({ otherThread: true });
    // The child emits the timed-out reply before acknowledging this fixture command.
    expect(await rpc.call('fixture/releaseReplies', {})).toEqual({ released: [method] });
    expect(await flushedEcho(rpc, { afterLateReply: true })).toEqual({ afterLateReply: true });
    expect(rpc.budget).toEqual({ pending: 0, retainedBytes: 0 });
    expect(writes).toBe(1);
  });
  test('queued timeout under actual pipe backpressure is not_sent and retains sent work budget', async () => {
    const rpc = await native(); await rpc.call('pause', {});
    const large = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }, { timeoutMs: 3000 }); const caught = large.catch(error => error);
    await expect(rpc.call('echo', {}, { timeoutMs: 30 })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(rpc.budget.retainedBytes).toBeGreaterThan(10 * 1024 * 1024); expect(rpc.connected).toBe(true);
    await rpc.close(); expect(await caught).toMatchObject({ delivery: 'unknown' }); expect(rpc.budget.retainedBytes).toBe(0);
  });
  test.runIf(process.platform === 'linux').each([true, false])('launcher shutdown closes saturated stdin and requires cleanup acknowledgement (%s)', async confirmed => {
    const cwd = mkdtempSync(path.join(roots, 'launcher-'));
    const python = process.env.HARNESS_TEST_PYTHON ?? '/usr/bin/python3';
    const driver = [
      'from deploy import native_launcher as n',
      'import os,signal,sys,threading',
      'n.security_process()',
      // A failed assertion must not strand the isolated fixture tree.
      'watchdog=threading.Timer(12,lambda:os.kill(os.getpid(),signal.SIGTERM)); watchdog.daemon=True; watchdog.start()',
      ...(confirmed ? [] : ['original=n.clean_children', 'n.clean_children=lambda child,deadline:(original(child,deadline) and False)']),
      "raise SystemExit(n.supervise([sys.argv[1],sys.argv[2]],{'PATH':'/usr/bin:/bin'},sys.argv[3],streaming=True))",
    ].join('\n');
    let bin = python, args = ['-c', driver, process.execPath, path.resolve('tests/runtime/native-fixture.mjs'), cwd];
    if (process.getuid?.() === 0) { bin = '/usr/bin/setpriv'; args = ['--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', python, ...args]; }
    // Substitute only fixed-launcher selection: the Node socket, Python bridge,
    // kernel backpressure and native child are real. UID policy has separate tests.
    const command = vi.spyOn(nativeLaunch, 'nativeCommand').mockReturnValue({ bin, args, cwd: path.resolve('.'), env: { PATH: '/usr/bin:/bin', PYTHONPATH: path.resolve('.') } });
    const rpc = new NativeRpc({ bin: '/unused', home: cwd, cwd, env: {}, launcher: { path: '/unused', user: 'ch-fixture-worker' } });
    // Capture the actual owned child before it can exit. An old numeric PID
    // may already belong to another process after close completes.
    const child = rpc['child'];
    const childClose = vi.fn(); child.once('close', childClose);
    let fatal = 0, cleanupUnknown = 0, written = false;
    rpc.on('fatal', () => fatal++); rpc.on('cleanup-unknown', () => cleanupUnknown++);
    try {
      await rpc.initialize(); await rpc.call('pause', {});
      const sent = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }, { timeoutMs: 0, onWritten: () => { written = true; } }).catch(error => error);
      const queued = rpc.call('echo', {}, { timeoutMs: 0 }).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(written).toBe(false); expect(rpc.budget.pending).toBe(2); expect(rpc.connected).toBe(true);
      const closed = rpc.close(); expect(rpc.close()).toBe(closed);
      expect(await sent).toMatchObject({ delivery: 'unknown' }); expect(await queued).toMatchObject({ delivery: 'not_sent' });
      if (confirmed) await closed;
      else await expect(closed).rejects.toThrow('without confirming cleanup');
      expect(fatal).toBe(1); expect(cleanupUnknown).toBe(confirmed ? 0 : 1);
      expect(written).toBe(false); expect(rpc.budget).toEqual({ pending: 0, retainedBytes: 0 });
      expect(childClose).toHaveBeenCalledTimes(1);
      expect(child.exitCode).not.toBeNull(); expect(child.signalCode).toBeNull();
      if (confirmed) expect(child.exitCode).toBe(0);
      else expect(child.exitCode).not.toBe(0);
    } finally { command.mockRestore(); await rpc.close().catch(() => {}); }
  }, 15000);
  test('preserves upstream error code/data and server request id type', async () => {
    const rpc = await native(); await expect(rpc.call('error', {})).rejects.toMatchObject({ code: 'native_error', delivery: 'not_sent', data: { code: -32000, data: { kind: 'fixture' } } });
    let id: unknown; rpc.on('request', request => { id = request.id; }); await rpc.call('prompt', {}); expect(id).toBe('original-string-id');
  });
  test('native error diagnostics redact managed multi-provider credentials without changing delivery evidence', async () => {
    const cwd = mkdtempSync(path.join(roots, 'redaction-'));
    const key = 'HARNESS_PROVIDER_KEY_' + 'B2'.repeat(16);
    const defaultValue = ['fixture', 'default', 'credential'].join('-'), namedValue = ['fixture', 'named', 'credential'].join('-');
    const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/native-fixture.mjs')], home: cwd, cwd, env: { HARNESS_PROVIDER_KEY_DEFAULT: defaultValue, [key]: namedValue }, requestTimeoutMs: 2000 }); natives.push(rpc);
    await rpc.initialize();
    await expect(rpc.call('fixture/error/reflect', { code: -32000, message: `Rejected ${defaultValue} and ${namedValue}`, data: { [key]: 'unregistered-value', reason: `error for ${namedValue}`, kind: 'fixture' } })).rejects.toMatchObject({ code: 'native_error', delivery: 'not_sent', message: 'Rejected [redacted] and [redacted]', data: { code: -32000, data: { [key]: '[redacted]', reason: 'error for [redacted]', kind: 'fixture' } } });
    await expect(rpc.call('echo', { usable: true })).resolves.toEqual({ usable: true });
  });
  test('drops an oversized identified queue read at its own boundary and serves subsequent calls', async () => {
    const rpc = await native();
    await expect(rpc.call('thread/queue/list', { threadId: 'large' })).rejects.toMatchObject({ code: 'queue_frame_capacity', delivery: 'not_sent' });
    expect(rpc.connected).toBe(true);
    expect(await rpc.call('echo', { stillConnected: true })).toEqual({ stillConnected: true });
  });
  test('proves only outer queue identities and ordered URL digests across split native output', () => {
    const url = 'data:image/png;base64,YWJj', frame = Buffer.from(JSON.stringify({id:77,result:{queuedSubmission:{
      input:[{type:'text',text:'nested example {"id":"wrong"}',text_elements:[]},{type:'image',url}],clientUserMessageId:'chosen',id:'actual'}}}));
    for (const expectedId of [77, 78]) {
      const reader = new QueueReplyIdentity(expectedId);
      for (let i=0; i<frame.length; i+=3) reader.update(frame.subarray(i,i+3));
      expect(reader.proof()).toEqual(expectedId===77 ? {queuedSubmissionId:'actual',clientUserMessageId:'chosen',inputCount:2,
        urlBySlot:[{ordinal:1,sha256:createHash('sha256').update(url).digest('hex')}] } : undefined);
    }
  });
  test.each(['thread/queue/add', 'thread/queue/update'])('%s leaves only its own oversized mutation reply unconfirmed while the runtime remains usable', async method => {
    const rpc = await native();
    await expect(rpc.call(method, { threadId: 'large' })).rejects.toMatchObject({ code: 'queue_frame_unconfirmed', delivery: 'unknown' });
    expect(rpc.connected).toBe(true);
    expect(await rpc.call('echo', { otherThread: true })).toEqual({ otherThread: true });
  });
  test('bounded media events keep real identifiers and adjacent text across fragmented native records', () => {
    const method = 'item/started';
    const params = { threadId: 'thread', turnId: 'turn', item: { type: 'userMessage', id: 'item', content: [
      { type: 'text', text: '中文、引号“原文”和换行\n' }, { type: 'image', url: 'data:image/png;base64,' + 'YWJj'.repeat(1000) }
    ] } };
    const project = (value: unknown) => {
      const frame = Buffer.from(JSON.stringify(value));
      const reader = new NativeMediaEvent();
      for (let offset = 0; offset < frame.length; offset += 17) reader.update(frame.subarray(offset, offset + 17));
      return reader.projection();
    };
    expect(project({ method, params })).toMatchObject({ method, params: { threadId: 'thread', turnId: 'turn',
      item: { id: 'item', content: [params.item.content[0], { type: 'text', text: expect.stringContaining('图片') }] } } });
    const literal = 'data:image/jpeg;base64,' + 'YWJj'.repeat(4000);
    const extra = { type: 'text', text: literal }, oldMarker = { type: 'text', text: 'harness:oversized-native-event/image' };
    const mixed = { ...params, item: { ...params.item, content: [extra, oldMarker, ...params.item.content] } };
    expect(project({ method, params: mixed })).toMatchObject({ params: { item: { content: [
      extra, oldMarker, params.item.content[0], { type: 'text', text: expect.stringContaining('图片') }
    ] } } });
    const toolItem = { ...params.item, type: 'mcpToolCall', arguments: { url: literal } };
    expect(project({ method, params: { ...params, item: toolItem } })).toEqual({
      method: 'harness/historyPreviewOmitted', params: { threadId: params.threadId }
    });
    expect(project({ method, params, id: 1 })).toBeUndefined();
    expect(project({ method, params: { ...params, turnId: null } })).toBeUndefined();
    expect(project({ method: 'thread/queue/changed', params })).toBeUndefined();
  });

  test('history previews preserve cursors, voice and replies and require the original read identity', () => {
    const photo = { type: 'image', url: 'data:image/png;base64,' + 'YWJj'.repeat(512) };
    const notes = { type: 'text', text: 'My notes', text_elements: [] };
    const item = { type: 'userMessage', id: 'user', content: [notes, photo] };
    const reply = { type: 'agentMessage', id: 'reply', text: 'Reviewed both documents.' };
    const result = { data: [item, reply].map(item => ({ type: 'item', turnId: 'turn', item })),
      nextCursor: 'older', activeRealtimeSessionAtPageStart: 'voice' };
    const project = (value: unknown) => {
      const reader = new NativeMediaEvent();
      reader.update(Buffer.from(JSON.stringify(value)));
      return reader;
    };
    const parsed = () => JSON.parse(JSON.stringify(result));
    const reader = project({ id: 7, result });
    const expected = { ...item, content: [notes, { type: 'text', text: expect.stringContaining('图片'), text_elements: [] }] };
    const preview = { ...result, data: [{ ...result.data[0], item: expected }, result.data[1]] };
    expect(reader.historyReply(7, 'timeline')).toEqual(preview);
    expect(reader.historyReply(8, 'timeline')).toBeUndefined();
    // A reply may fit the native frame but exceed the requested display window.
    expect(fitHistoryImages(parsed(), 'timeline', photo.url.length)).toEqual(preview);
    expect(fitHistoryImages(parsed(), 'timeline', photo.url.length + 1)).toEqual(result);
    const unrelated = project({ id: 7, result: { data: [{ turnId: 'turn', item: { type: 'mcpToolCall', result: { item } } }] } });
    expect(unrelated.historyReply(7, 'items')).toBeUndefined();
    const legacy = project({ id: 9, result: { thread: { id: 'source', turns: [{ id: 'turn', items: [item, reply] }] } } });
    expect(legacy.historyReply(9, 'thread')).toEqual({ thread: { id: 'source', turns: [{ id: 'turn', items: [expected, reply] }] } });
  });

  test('malformed native responses reject all waiters instead of hanging or claiming not_sent', async () => {
    const rpc = await native(); await expect(rpc.call('malformed', {})).rejects.toMatchObject({ delivery: 'unknown' }); expect(rpc.connected).toBe(false);
  });
});
