import { randomUUID } from 'node:crypto';
import { DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { WorkflowMutation } from './workflows.js';
import { validateTimelineContract } from './timeline-contract.js';
interface Signal { promise: Promise<void>; resolve(): void }
function signal(): Signal { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
interface Session {
  sessionHandle: string; threadId: string; clientId: string; eventChannelId: string | undefined;
  state: 'starting' | 'active' | 'stopping' | 'closed'; revoked: boolean; dispatched: boolean; nextSequence: number; lastAcceptedSequence: number;
  nativeSessionId: string; started: boolean; stopDispatched: boolean; epochEnded: boolean; closure: Signal; epochEnd: Signal; closedNotification?: JsonObject;
  version?: string; sdp?: string; reason?: string; bytes: number; frames: number; rateAt: number; rateBytes: number;
  startSettled: Promise<void>; inputs: Promise<void>; stopping?: Promise<void>; timer?: NodeJS.Timeout;
}
interface Host {
  native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>;
  mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue>;
  requireLoaded(threadId: string): void; available(): void;
  invalidate(threadId: string): void;
  emit(data: JsonObject, channel?: string): void; changed(): void; failEpoch(): Promise<void>;
}
const events: Record<string, string> = {
  started: 'ThreadRealtimeStartedNotification', itemAdded: 'ThreadRealtimeItemAddedNotification', 'item/started': 'ThreadRealtimeItemStartedNotification',
  'item/transcript/delta': 'ThreadRealtimeItemTranscriptDeltaNotification', 'item/completed': 'ThreadRealtimeItemCompletedNotification',
  'transcript/delta': 'ThreadRealtimeTranscriptDeltaNotification', 'transcript/done': 'ThreadRealtimeTranscriptDoneNotification',
  'outputAudio/delta': 'ThreadRealtimeOutputAudioDeltaNotification', sdp: 'ThreadRealtimeSdpNotification', error: 'ThreadRealtimeErrorNotification', closed: 'ThreadRealtimeClosedNotification',
};
const startFields = ['threadId', 'clientManagedHandoffs', 'delegationAckFiller', 'flushTranscriptTailOnSessionEnd', 'codexResponsesAsItems', 'codexResponseItemPrefix', 'codexResponseHandoffMode', 'backendReasoningStatus', 'codexResponseHandoffChannelPrefixes', 'model', 'outputModality', 'includeStartupContext', 'initialItems', 'realtimeStartInstructions', 'realtimeEndInstructions', 'prompt', 'transport', 'version', 'voice'];
function checked(schema: string, value: JsonValue, max = LIMITS.historyBytes): JsonObject { try { jsonBytes(value, max); validateTimelineContract(schema, value); return object(value); } catch { throw new DeliveryError('invalid_native_response', 'Realtime returned an invalid or oversized response'); } }
function audio(value: JsonValue | undefined): void {
  const chunk = object(value, 'audio'); validateOfficial('ThreadRealtimeAudioChunk', chunk);
  const data = string(chunk.data, 'audio data', 350000); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new DeliveryError('invalid_params', 'Audio must be canonical base64 PCM16');
  const bytes = Buffer.from(data, 'base64'); const channels = integer(chunk.numChannels, 'numChannels', 1, 2); const rate = integer(chunk.sampleRate, 'sampleRate', 8000, 96000);
  if (bytes.length > 256 * 1024 || bytes.length % (2 * channels) || bytes.toString('base64') !== data) throw new DeliveryError('invalid_params', 'Invalid PCM16 frame');
  if (chunk.samplesPerChannel !== null && integer(chunk.samplesPerChannel, 'samplesPerChannel', 1, rate) * channels * 2 !== bytes.length) throw new DeliveryError('invalid_params', 'PCM16 sample count does not match the frame');
  if (chunk.itemId !== null) string(chunk.itemId, 'itemId', 256);
}
/** Raw audio and SDP belong to one live browser lease, never the receipt log. */
export class Realtime {
  private sessions = new Map<string, Session>();
  constructor(private host: Host) {}
  activeThreads(): string[] { return [...this.sessions.values()].filter(entry => entry.state !== 'closed').map(entry => entry.threadId); }
  has(threadId: string): boolean { return this.activeThreads().includes(threadId); }
  private owner(id: JsonValue | undefined, context: CallContext): Session { const entry = this.sessions.get(string(id, 'sessionHandle', 36)); if (!entry || entry.revoked || entry.clientId !== context.clientId || entry.eventChannelId !== context.eventChannelId) throw new DeliveryError('not_found', 'Voice session is unavailable for this connection and runtime epoch'); return entry; }
  private summary(entry: Session): JsonObject { return { sessionHandle: entry.sessionHandle, threadId: entry.threadId, state: entry.state, nextSequence: entry.nextSequence, lastAcceptedSequence: entry.lastAcceptedSequence, ...(entry.nativeSessionId ? { realtimeSessionId: entry.nativeSessionId } : {}), ...(entry.version ? { version: entry.version } : {}), ...(entry.reason ? { reason: entry.reason } : {}) }; }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'thread/realtime/listVoices') { onlyKeys(params, []); return checked('ThreadRealtimeListVoicesResponse', await this.host.native(method, {}), 64 * 1024); }
    if (method === 'thread/timeline/list') {
      onlyKeys(params, ['threadId', 'cursor', 'limit']); const p = { ...params, limit: params.limit == null ? 50 : integer(params.limit, 'limit', 1, 100) }; validateOfficial('ThreadTimelineListParams', p);
      if (params.cursor != null) string(params.cursor, 'cursor', LIMITS.cursorBytes); const result = checked('ThreadTimelineListResponse', await this.host.native(method, p));
      if (!Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('invalid_native_response', 'Timeline page exceeded its budget');
      if (result.nextCursor !== null) { string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes); if (result.nextCursor === params.cursor) throw new DeliveryError('cursor_loop', 'Timeline cursor did not advance'); } return result;
    }
    if (method === 'thread/realtime/start') return this.start(params, context);
    const entry = this.owner(params.sessionHandle, context);
    if (method === 'thread/realtime/read') { onlyKeys(params, ['sessionHandle']); return { ...this.summary(entry), ...(entry.sdp ? { sdp: entry.sdp } : {}) }; }
    if (method === 'thread/realtime/stop') { onlyKeys(params, ['sessionHandle']); context.beforeWrite?.(); await this.stop(entry); return { ...this.summary(entry), stopped: true }; }
    return this.append(method, params, entry, context);
  }
  private async start(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, startFields); const threadId = string(params.threadId, 'threadId'); this.host.requireLoaded(threadId); this.host.available();
    jsonBytes(params, 128 * 1024); const p = { ...params, voiceSessionId: randomUUID(), realtimeSessionId: randomUUID() }; validateOfficial('ThreadRealtimeStartParams', p);
    if (params.transport != null) { const transport = object(params.transport); if (transport.type === 'webrtc') string(transport.sdp, 'SDP offer', 64 * 1024); else if (transport.type === 'existingCall') string(transport.callId, 'callId', 256); }
    if (params.initialItems != null && (!Array.isArray(params.initialItems) || params.initialItems.length > 128 || Buffer.byteLength(jsonBytes(params.initialItems)) > 32 * 1024)) throw new DeliveryError('capacity', 'Initial voice context exceeds its budget');
    if (this.has(threadId)) throw new DeliveryError('voice_busy', 'This thread already has a voice session');
    if (this.activeThreads().length >= 4 || this.sessions.size >= 32) throw new DeliveryError('capacity', 'Voice session capacity exhausted');
    let settled!: () => void; const entry: Session = { sessionHandle: randomUUID(), threadId, clientId: context.clientId, eventChannelId: context.eventChannelId, state: 'starting', revoked: false, dispatched: false, nativeSessionId: p.realtimeSessionId, started: false, stopDispatched: false, epochEnded: false, closure: signal(), epochEnd: signal(), nextSequence: 0, lastAcceptedSequence: -1, bytes: 0, frames: 0, rateAt: Date.now(), rateBytes: 0, startSettled: new Promise(resolve => { settled = resolve; }), inputs: Promise.resolve() };
    this.sessions.set(entry.sessionHandle, entry); this.host.changed();
    try {
      await this.host.mutate({ method: 'thread/realtime/start', threadId, params: p, schema: 'ThreadRealtimeStartParams', responseSchema: 'ThreadRealtimeStartResponse', mode: 'idle', history: true, directInput: true,
        beforeWrite: () => { if (entry.revoked || this.sessions.get(entry.sessionHandle) !== entry) throw new DeliveryError('client_disconnected', 'Voice owner disconnected before startup'); this.host.invalidate(threadId); entry.dispatched = true; },
      }, context);
      return this.summary(entry);
    } catch (error) {
      if (error instanceof DeliveryError && error.delivery === 'not_sent') { entry.state = 'closed'; this.sessions.delete(entry.sessionHandle); }
      else { await this.host.failEpoch(); throw new DeliveryError('voice_start_unknown', 'Voice startup outcome is unknown; the runtime was closed', 'unknown'); }
      throw error;
    } finally { settled(); this.host.changed(); }
  }
  private append(method: string, params: JsonObject, entry: Session, context: CallContext): Promise<JsonValue> {
    if (!['thread/realtime/appendAudio', 'thread/realtime/appendText', 'thread/realtime/appendSpeech'].includes(method)) throw new DeliveryError('method_not_found', 'Unsupported realtime workflow');
    if (entry.state !== 'active') throw new DeliveryError('voice_not_ready', 'Wait for the native voice session to become active');
    const suffix = method.slice(method.lastIndexOf('/') + 1), schema = suffix === 'appendAudio' ? 'ThreadRealtimeAppendAudio' : suffix === 'appendText' ? 'ThreadRealtimeAppendText' : 'ThreadRealtimeAppendSpeech';
    onlyKeys(params, ['sessionHandle', 'sequence', ...(suffix === 'appendAudio' ? ['audio'] : suffix === 'appendText' ? ['text', 'role'] : ['text'])]);
    const { sessionHandle: _id, sequence: _sequence, ...input } = params; const p = { threadId: entry.threadId, ...input }; validateOfficial(schema + 'Params', p);
    if (suffix === 'appendAudio') audio(params.audio); else string(params.text, 'text', 16 * 1024);
    const sequence = integer(params.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER); if (sequence !== entry.nextSequence) throw new DeliveryError('sequence_conflict', 'Read the current voice sequence; frames must not be retried or sent out of order');
    const bytes = Buffer.byteLength(jsonBytes(p)); if (entry.frames >= 8 || entry.bytes + bytes > 512 * 1024) throw new DeliveryError('capacity', 'Voice input queue is full');
    const now = Date.now(); if (now - entry.rateAt >= 1000) { entry.rateAt = now; entry.rateBytes = 0; }
    if (entry.rateBytes + bytes > 1024 * 1024) throw new DeliveryError('capacity', 'Voice input rate exceeded');
    entry.nextSequence++; entry.frames++; entry.bytes += bytes; entry.rateBytes += bytes;
    const task = entry.inputs.then(async () => {
      let accepted = false;
      try {
        const guard = (): void => { this.owner(entry.sessionHandle, context); this.host.available(); if (entry.state === 'closed' || entry.closedNotification || entry.epochEnded) throw new DeliveryError('voice_closed', 'Voice session closed before this input was sent'); };
        guard(); const result = await this.host.native(method, p, { beforeWrite: () => { guard(); context.beforeWrite?.(); this.host.invalidate(entry.threadId); } }); accepted = true; validateOfficial(schema + 'Response', result); entry.lastAcceptedSequence = sequence;
        return { sessionHandle: entry.sessionHandle, sequence, accepted: true, nextSequence: entry.nextSequence };
      } catch (error) {
        if (accepted || !(error instanceof DeliveryError) || error.delivery === 'unknown') { await this.host.failEpoch(); throw new DeliveryError('voice_input_unknown', 'Voice input acknowledgement was lost; the frame must not be resent', 'unknown'); } throw error;
      } finally { entry.frames--; entry.bytes -= bytes; }
    }); entry.inputs = task.then(() => {}, () => {}); return task;
  }
  notification(method: string, params: JsonObject): boolean {
    if (!method.startsWith('thread/realtime/')) return false;
    const suffix = method.slice('thread/realtime/'.length), schema = events[suffix]; if (!schema) return true;
    const entry = [...this.sessions.values()].find(item => item.threadId === params.threadId && item.state !== 'closed'); if (!entry || !entry.dispatched || entry.epochEnded || entry.closedNotification) return true;
    checked(schema, params, 512 * 1024);
    // 0.164.0 echoes the requested ID before SDP/fanout. Canonical history
    // items also retain that ID, including promotions after an older session.
    if (suffix === 'started') {
      if (params.realtimeSessionId !== entry.nativeSessionId) return true;
      entry.started = true; if (entry.state === 'starting') entry.state = 'active'; entry.version = string(params.version, 'version', 16);
    } else if (suffix === 'item/started' || suffix === 'item/completed') {
      if (object(params.item).realtimeSessionId !== entry.nativeSessionId) return true;
    } else if (suffix === 'closed') {
      // A previous close can precede this start's matching started event. A
      // failed startup has no started event, but its explicit stop still closes.
      if (!entry.started && !entry.stopDispatched) return true;
      if (params.reason !== null) string(params.reason, 'reason', 4096);
      entry.closedNotification = params; entry.closure.resolve();
      if (!entry.stopping) this.finishClosed(entry);
      return true;
    } else if (!entry.started && suffix !== 'error') return true;
    if (suffix === 'sdp') entry.sdp = string(params.sdp, 'SDP answer', 64 * 1024);
    if (suffix === 'outputAudio/delta') audio(params.audio);
    if (!entry.revoked) this.host.emit({ ...this.summary(entry), clientId: entry.clientId, method, params }, entry.eventChannelId);
    this.host.changed(); return true;
  }
  private finishClosed(entry: Session): void {
    if (entry.state === 'closed') return;
    entry.state = 'closed'; delete entry.sdp;
    const params = entry.closedNotification!; if (params.reason !== null) entry.reason = string(params.reason, 'reason', 4096);
    clearTimeout(entry.timer); entry.timer = setTimeout(() => this.sessions.delete(entry.sessionHandle), 600000); entry.timer.unref();
    if (!entry.revoked) this.host.emit({ ...this.summary(entry), clientId: entry.clientId, method: 'thread/realtime/closed', params }, entry.eventChannelId);
    this.host.changed();
  }
  private stop(entry: Session): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (entry.state === 'closed') return Promise.resolve();
    entry.state = 'stopping'; this.host.changed();
    const current = (): void => { if (entry.epochEnded || this.sessions.get(entry.sessionHandle) !== entry) throw new DeliveryError('voice_epoch_ended', 'Voice runtime ended before cleanup was confirmed', 'unknown'); };
    const cleanup = (async () => {
      await entry.startSettled; if (entry.state === 'closed' && !entry.epochEnded) return; current(); await entry.inputs; current();
      if (!entry.closedNotification) {
        try {
          const result = await this.host.native('thread/realtime/stop', { threadId: entry.threadId }, { timeoutMs: 10000, beforeWrite: () => {
            current(); if (entry.closedNotification) throw new DeliveryError('voice_closed', 'Voice closed before the stop was sent');
            this.host.invalidate(entry.threadId); entry.stopDispatched = true;
          } });
          validateOfficial('ThreadRealtimeStopResponse', result);
        } catch (error) { if (entry.stopDispatched || !entry.closedNotification) throw error; }
      }
      // The empty RPC response only acknowledges enqueueing the close op.
      // Core drains its old fanout before emitting closed. Keep both boundaries.
      await entry.closure.promise; current();
    })();
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryError('voice_stop_timeout', 'Voice closure was not confirmed', 'unknown')), 10000); timer.unref(); });
    const ended = entry.epochEnd.promise.then(() => { throw new DeliveryError('voice_epoch_ended', 'Voice runtime ended before cleanup was confirmed', 'unknown'); });
    entry.stopping = Promise.race([cleanup, timeout, ended]).then(() => this.finishClosed(entry), async () => {
      entry.epochEnded = true; entry.epochEnd.resolve();
      await this.host.failEpoch(); entry.state = 'closed'; entry.reason = 'runtime_closed'; delete entry.sdp;
    }).finally(() => clearTimeout(timer));
    return entry.stopping;
  }
  async disconnect(clientId?: string, channel?: string): Promise<void> {
    const owned = [...this.sessions.values()].filter(entry => (clientId === undefined || entry.clientId === clientId) && (channel === undefined || entry.eventChannelId === channel));
    for (const entry of owned) entry.revoked = true;
    await Promise.all(owned.map(async entry => { await this.stop(entry); clearTimeout(entry.timer); this.sessions.delete(entry.sessionHandle); }));
  }
  reset(): void { for (const entry of this.sessions.values()) { entry.revoked = true; entry.epochEnded = true; entry.epochEnd.resolve(); clearTimeout(entry.timer); } this.sessions.clear(); }
}
