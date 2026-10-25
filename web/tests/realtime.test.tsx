// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RealtimePanel, type RealtimePanelProps } from '../components/RealtimePanel';
import { RealtimeMedia } from '../lib/realtime-media';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { StrictMode } from 'react';
import { useConversation } from '../hooks/useConversation';
import { listOperations } from '../lib/operations';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const active = { sessionHandle: 'voice-handle', threadId: 'thread', state: 'active', nextSequence: 0, lastAcceptedSequence: -1 };
class Peer extends EventTarget {
  static all: Peer[] = []; localDescription?: RTCSessionDescriptionInit; iceGatheringState = 'complete'; connectionState = 'new'; ontrack?: (e: unknown) => void; onconnectionstatechange?: () => void;
  channel = { onmessage: null, close: vi.fn() }; addTrack = vi.fn(); setRemoteDescription = vi.fn(async () => {}); close = vi.fn();
  constructor() { super(); Peer.all.push(this); }
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'fixture offer' }));
  setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => { this.localDescription = value; });
}
let track: { stop: ReturnType<typeof vi.fn>; enabled: boolean }, stream: MediaStream, microphone: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); Peer.all = []; track = { stop: vi.fn(), enabled: true }; stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream; microphone = vi.fn(async () => stream);
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('isSecureContext', true); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(); vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(async () => { cleanup(); await Promise.resolve(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(handler?: (call: Call, props: RealtimePanelProps) => unknown) {
  const api = new Api(), calls: Call[] = [], props: RealtimePanelProps = { api, events: new Events(), epoch: 'epoch', lease: 'lease', connected: true, threadId: 'thread', threadReady: true, threadIdle: true, onStarted: vi.fn(), onClosed: vi.fn() };
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => { const call: Call = JSON.parse(String(init.body)); calls.push(call); const result = await handler?.(call, props); return { status: 200, ok: true, json: async () => ({ ok: true, result: result ?? (call.method === 'thread/realtime/listVoices' ? { voices: { v1: ['alloy'], v2: ['ash'], defaultV1: 'alloy', defaultV2: 'ash' } } : call.method === 'thread/realtime/stop' ? { ...active, state: 'closed', stopped: true } : active) }) }; }));
  return { calls, props };
}
function event(props: RealtimePanelProps, method: string, params: Record<string, unknown>, state = 'active') { props.events.publish({ type: 'realtime', data: { ...active, state, owned: true, method, params: { threadId: 'thread', ...params } } }); }
it('negotiates the browser offer once, accepts early SDP privately, and confirms closure without a native closed event', async () => {
  const { props, calls } = setup((call, props) => { if (call.method === 'thread/realtime/start') { queueMicrotask(() => event(props, 'thread/realtime/sdp', { sdp: 'answer' })); return active; } if (call.method === 'thread/realtime/read') return { ...active, sdp: 'answer' }; });
  render(<RealtimePanel {...props}/>); expect(microphone).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '启动一次语音' }));
  await screen.findByText('active'); await waitFor(() => expect(Peer.all[0]!.setRemoteDescription).toHaveBeenCalledTimes(1));
  expect(calls.find(call => call.method === 'thread/realtime/start')).toMatchObject({ params: { threadId: 'thread', outputModality: 'audio', transport: { type: 'webrtc', sdp: 'fixture offer' } } });
  expect(Peer.all[0]!.createDataChannel).toHaveBeenCalledWith('oai-events'); expect(props.onStarted).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '静音麦克风' })); expect(track.enabled).toBe(false); fireEvent.click(screen.getByRole('button', { name: '开启麦克风' })); expect(track.enabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '结束本次实时会话' })); await screen.findByText('closed'); expect(track.stop).toHaveBeenCalledTimes(1); expect(Peer.all[0]!.close).toHaveBeenCalledTimes(1); expect(props.onClosed).toHaveBeenCalledTimes(1);
  act(() => event(props, 'thread/realtime/closed', { reason: null }, 'closed')); expect(props.onClosed).toHaveBeenCalledTimes(1); expect(JSON.stringify(localStorage)).not.toContain('fixture offer');
});
it('unknown startup only reads its original receipt and never repeats microphone capture or native start', async () => {
  let operationId = ''; const { props, calls } = setup(call => { if (call.method === 'thread/realtime/start') { operationId = call.operationId!; throw new Error('transport lost'); } if (call.method === 'operation/read') return { operationId, method: 'thread/realtime/start', state: 'accepted', result: { ...active, state: 'closed' } }; if (call.method === 'thread/realtime/read') return { ...active, state: 'closed' }; });
  render(<RealtimePanel {...props}/>); fireEvent.click(screen.getByRole('button', { name: '启动一次语音' })); fireEvent.click(await screen.findByRole('button', { name: '查询原语音操作回执' }));
  await screen.findByText('closed'); expect(calls.filter(call => call.method === 'thread/realtime/start')).toHaveLength(1); expect(microphone).toHaveBeenCalledTimes(1); expect(track.stop).toHaveBeenCalledTimes(1); expect(props.onClosed).toHaveBeenCalledWith('thread');
});
it('live text has a single monotonic sequence, no durable payload, and a lost response never replays', async () => {
  const { props, calls } = setup(call => { if (call.method === 'thread/realtime/appendText') throw new Error('unknown frame'); });
  render(<RealtimePanel {...props}/>); fireEvent.change(screen.getByRole('combobox', { name: '实时会话方式' }), { target: { value: 'text' } }); fireEvent.click(screen.getByRole('button', { name: '启动一次实时文字' })); await screen.findByText('active'); await waitFor(() => expect((screen.getByRole('button', { name: '读取当前语音状态' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole('textbox', { name: '发送到当前实时会话' }), { target: { value: 'private realtime message' } }); fireEvent.click(screen.getByRole('button', { name: '发送一次实时文字' }));
  await screen.findByText(/本段文字未重发/); expect(calls.filter(call => call.method === 'thread/realtime/appendText')).toEqual([{ method: 'thread/realtime/appendText', params: { sessionHandle: 'voice-handle', sequence: 0, text: 'private realtime message', role: 'user' } }]);
  expect(JSON.stringify(localStorage)).not.toContain('private realtime message'); expect(microphone).not.toHaveBeenCalled(); expect((screen.getByRole('button', { name: '发送一次实时文字' }) as HTMLButtonElement).disabled).toBe(true);
});
it('cancel while microphone permission is unresolved stops the late stream before any native start', async () => {
  let resolve!: (value: MediaStream) => void; microphone.mockImplementation(() => new Promise(done => { resolve = done; })); const { props, calls } = setup(); const view = render(<RealtimePanel {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: '启动一次语音' })); await waitFor(() => expect(microphone).toHaveBeenCalled()); view.rerender(<RealtimePanel {...props} connected={false}/>); await act(async () => resolve(stream));
  expect(track.stop).toHaveBeenCalledTimes(1); expect(calls.some(call => call.method === 'thread/realtime/start')).toBe(false); expect(Peer.all[0]!.close).toHaveBeenCalledTimes(1);
});
it('unmount during accepted startup cleans local media immediately and stops a late native session exactly once', async () => {
  let resolve!: (value: unknown) => void; const { props, calls } = setup(call => call.method === 'thread/realtime/start' ? new Promise(done => { resolve = done; }) : undefined); const view = render(<RealtimePanel {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: '启动一次语音' })); await waitFor(() => expect(calls.some(call => call.method === 'thread/realtime/start')).toBe(true)); view.unmount(); expect(track.stop).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(active); }); await waitFor(() => expect(calls.filter(call => call.method === 'thread/realtime/stop')).toHaveLength(1)); expect(props.onStarted).not.toHaveBeenCalled(); expect(props.onClosed).not.toHaveBeenCalled();
});
it('ignores foreign events and invalidates local audio immediately on owner loss', async () => {
  const { props } = setup(); const view = render(<RealtimePanel {...props}/>); fireEvent.click(screen.getByRole('button', { name: '启动一次语音' })); await screen.findByText('active');
  act(() => props.events.publish({ type: 'realtime', data: { ...active, owned: false, method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: 'foreign secret' } } })); expect(screen.queryByText('foreign secret')).toBeNull();
  view.rerender(<RealtimePanel {...props} connected={false}/>); expect(track.stop).toHaveBeenCalledTimes(1); expect(screen.queryByText('active')).toBeNull();
});
it('the media helper does not apply a second conflicting answer and aborts incomplete ICE on close', async () => {
  const audio = document.createElement('audio'), media = new RealtimeMedia(audio, vi.fn()); await media.offer(); await media.accept('answer'); await media.accept('answer'); await expect(media.accept('different')).rejects.toThrow('冲突'); expect(Peer.all[0]!.setRemoteDescription).toHaveBeenCalledTimes(1); media.close();
  const second = new RealtimeMedia(audio, vi.fn()); const pending = second.offer(); Peer.all[1]!.iceGatheringState = 'gathering'; await waitFor(() => expect(Peer.all[1]!.localDescription).toBeDefined()); second.close(); await expect(pending).rejects.toThrow('取消');
});
it.each([{ edits: [], remaining: '' }, { edits: ['B'], remaining: 'B' }, { edits: ['B', 'A'], remaining: 'A' }])('acknowledges only the submitted realtime draft revision: $edits', async ({ edits, remaining }) => {
  let resolve!: (value: unknown) => void;
  const { props, calls } = setup(call => call.method === 'thread/realtime/appendText' ? new Promise(done => { resolve = done; }) : undefined);
  render(<RealtimePanel {...props}/>);
  fireEvent.change(screen.getByRole('combobox', { name: '实时会话方式' }), { target: { value: 'text' } }); fireEvent.click(screen.getByRole('button', { name: '启动一次实时文字' }));
  await screen.findByText('active'); await waitFor(() => expect((screen.getByRole('button', { name: '读取当前语音状态' }) as HTMLButtonElement).disabled).toBe(false));
  const input = screen.getByRole('textbox', { name: '发送到当前实时会话' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'A' } });
  act(() => { fireEvent.submit(input.form!); fireEvent.submit(input.form!); });
  await waitFor(() => expect(resolve).toBeTypeOf('function')); expect(input.matches(':disabled')).toBe(false);
  for (const value of edits) fireEvent.change(input, { target: { value } });
  await act(async () => resolve({ sessionHandle: active.sessionHandle, sequence: 0, accepted: true, nextSequence: 1 }));
  expect(input.value).toBe(remaining); expect(calls.filter(call => call.method === 'thread/realtime/appendText')).toHaveLength(1);
});
it.each(['failed', 'invalid'] as const)('preserves newer realtime text after a %s acknowledgement without replay', async outcome => {
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
  const { props, calls } = setup(call => call.method === 'thread/realtime/appendText' ? new Promise((done, fail) => { resolve = done; reject = fail; }) : undefined);
  render(<RealtimePanel {...props}/>); fireEvent.change(screen.getByRole('combobox', { name: '实时会话方式' }), { target: { value: 'text' } }); fireEvent.click(screen.getByRole('button', { name: '启动一次实时文字' }));
  await screen.findByText('active'); await waitFor(() => expect((screen.getByRole('button', { name: '读取当前语音状态' }) as HTMLButtonElement).disabled).toBe(false));
  const input = screen.getByRole('textbox', { name: '发送到当前实时会话' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'A' } }); fireEvent.submit(input.form!); await waitFor(() => expect(resolve).toBeTypeOf('function'));
  fireEvent.change(input, { target: { value: 'B' } });
  await act(async () => { if (outcome === 'failed') reject(new Error('frame lost')); else resolve({ sessionHandle: 'foreign', sequence: 0, accepted: true, nextSequence: 1 }); });
  await screen.findByText(/本段文字未重发/); expect(input.value).toBe('B');
  fireEvent.submit(input.form!); expect(calls.filter(call => call.method === 'thread/realtime/appendText')).toHaveLength(1);
});
it('does not apply an unmounted realtime owner acknowledgement to its replacement draft', async () => {
  let resolve!: (value: unknown) => void;
  const { props, calls } = setup(call => call.method === 'thread/realtime/appendText' ? new Promise(done => { resolve = done; }) : undefined);
  const view = render(<RealtimePanel {...props}/>);
  const start = async () => { fireEvent.change(screen.getByRole('combobox', { name: '实时会话方式' }), { target: { value: 'text' } }); fireEvent.click(screen.getByRole('button', { name: '启动一次实时文字' })); await screen.findByText('active'); await waitFor(() => expect((screen.getByRole('button', { name: '读取当前语音状态' }) as HTMLButtonElement).disabled).toBe(false)); };
  await start(); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A' } }); fireEvent.click(screen.getByRole('button', { name: '发送一次实时文字' })); await waitFor(() => expect(resolve).toBeTypeOf('function'));
  view.rerender(<RealtimePanel {...props} lease="replacement"/>);
  await waitFor(() => expect((screen.getByRole('button', { name: '启动一次语音' }) as HTMLButtonElement).disabled).toBe(false));
  await start(); const input = screen.getByRole('textbox') as HTMLTextAreaElement; fireEvent.change(input, { target: { value: 'replacement draft' } });
  await act(async () => resolve({ sessionHandle: active.sessionHandle, sequence: 0, accepted: true, nextSequence: 1 }));
  expect(input.value).toBe('replacement draft'); expect(calls.filter(call => call.method === 'thread/realtime/appendText')).toHaveLength(1);
});

it.each(['thread', 'epoch', 'lease', 'api', 'thread ABA', 'api ABA'] as const)('isolates late accepted startup after %s replacement while retaining cleanup and its unknown receipt', async change => {
  let resolveStart!: (value: unknown) => void;
  const { props, calls } = setup(call => {
    if (call.method === 'thread/read') return { thread: { id: call.params.threadId, status: { type: 'idle' } } };
    if (call.method === 'thread/history') return { turns: [], timeline: [], complete: true, turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, nextCursor: null };
    if (call.method === 'thread/realtime/start') return new Promise(resolve => { resolveStart = resolve; });
    if (call.method === 'thread/realtime/stop') throw new Error('cleanup response lost');
  });
  const originalMutation = vi.spyOn(props.api, 'beginMutation'), replacementApi = new Api(), replacementMutation = vi.spyOn(replacementApi, 'beginMutation');
  let observed!: ReturnType<typeof useConversation>;
  function Harness(value: RealtimePanelProps) {
    const conversation = useConversation(value.api, value.events, value.threadId, value.epoch); observed = conversation;
    return <RealtimePanel {...value} threadReady={conversation.ready} threadIdle={!conversation.active && !conversation.realtimeActive} onStarted={id => { value.onStarted(id); conversation.voiceStarted(id); }} onClosed={id => { value.onClosed(id); conversation.voiceClosed(id); }}/>;
  }
  const view = render(<Harness {...props}/>);
  await waitFor(() => expect(observed.ready).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: '实时会话方式' }), { target: { value: 'text' } }); fireEvent.click(screen.getByRole('button', { name: '启动一次实时文字' }));
  await waitFor(() => expect(resolveStart).toBeTypeOf('function'));
  const next = { ...props, ...(change.startsWith('thread') ? { threadId: 'other-thread' } : change === 'epoch' ? { epoch: 'replacement' } : change === 'lease' ? { lease: 'replacement' } : { api: replacementApi }) };
  view.rerender(<Harness {...next}/>); if (change.endsWith('ABA')) view.rerender(<Harness {...props}/>);
  await waitFor(() => expect(observed.ready).toBe(true));
  await act(async () => resolveStart(active));
  await waitFor(() => expect(listOperations()).toEqual([expect.objectContaining({ method: 'thread/realtime/stop', state: 'unknown' })]));
  expect(observed.realtimeActive).toBe(false); expect(observed.ready).toBe(true); expect(observed.historyStale).toBe(false);
  expect(props.onStarted).not.toHaveBeenCalled(); expect(props.onClosed).not.toHaveBeenCalled();
  const start = calls.find(call => call.method === 'thread/realtime/start')!, stop = calls.find(call => call.method === 'thread/realtime/stop')!;
  expect(start.operationId).toBeTruthy(); expect(stop.operationId).toBeTruthy(); expect(stop.operationId).not.toBe(start.operationId);
  expect(stop.params).toEqual({ sessionHandle: active.sessionHandle }); expect(listOperations()[0]!.id).toBe(stop.operationId);
  expect(localStorage.getItem(`harness.acknowledged.v1.${start.operationId}`)).toBe('1');
  expect(originalMutation.mock.calls.map(([method]) => method)).toEqual(['thread/realtime/start', 'thread/realtime/stop']); expect(replacementMutation).not.toHaveBeenCalled();
  act(() => event(props, 'thread/realtime/closed', {}, 'closed')); view.rerender(<Harness {...(change.endsWith('ABA') ? props : next)}/>); view.unmount();
  expect(calls.filter(call => call.method === 'thread/realtime/stop')).toHaveLength(1); expect(listOperations()[0]).toMatchObject({ id: stop.operationId, state: 'unknown' }); expect(microphone).not.toHaveBeenCalled();
});
it('does not notify either owner when an old stop closes after replacement', async () => {
  let resolveStop!: (value: unknown) => void;
  const { props, calls } = setup(call => call.method === 'thread/realtime/stop' ? new Promise(resolve => { resolveStop = resolve; }) : undefined);
  const nextStarted = vi.fn(), nextClosed = vi.fn(), view = render(<RealtimePanel {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: '启动一次语音' })); await screen.findByText('active');
  view.rerender(<RealtimePanel {...props} api={new Api()} onStarted={nextStarted} onClosed={nextClosed}/>);
  expect(track.stop).toHaveBeenCalledTimes(1); expect(Peer.all[0]!.close).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(resolveStop).toBeTypeOf('function')); await act(async () => resolveStop({ ...active, state: 'closed' }));
  expect(props.onStarted).toHaveBeenCalledTimes(1); expect(props.onClosed).not.toHaveBeenCalled(); expect(nextStarted).not.toHaveBeenCalled(); expect(nextClosed).not.toHaveBeenCalled();
  expect(calls.filter(call => call.method === 'thread/realtime/stop')).toHaveLength(1); expect(screen.queryByText('closed')).toBeNull(); expect(screen.queryByText('active')).toBeNull();
});
it('retains a usable current owner through StrictMode effect replay and closes it once', async () => {
  const { props, calls } = setup(), view = render(<StrictMode><RealtimePanel {...props}/></StrictMode>);
  fireEvent.click(screen.getByRole('button', { name: '启动一次语音' })); await screen.findByText('active');
  expect(props.onStarted).toHaveBeenCalledTimes(1); expect(calls.filter(call => call.method === 'thread/realtime/start')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '结束本次实时会话' })); await screen.findByText('closed');
  expect(props.onClosed).toHaveBeenCalledTimes(1); view.unmount(); expect(calls.filter(call => call.method === 'thread/realtime/stop')).toHaveLength(1); expect(track.stop).toHaveBeenCalledTimes(1);
});
