import type { FeatureMethod } from './feature-methods.js';
export const realtimeMethods: Readonly<Record<string, FeatureMethod>> = Object.freeze({
  'thread/realtime/listVoices': { access: 'read' }, 'thread/realtime/read': { access: 'read' },
  'thread/realtime/start': { access: 'write', activity: 'start' }, 'thread/realtime/stop': { access: 'write' },
  'thread/realtime/appendAudio': { access: 'live' }, 'thread/realtime/appendText': { access: 'live' }, 'thread/realtime/appendSpeech': { access: 'live' },
  'thread/timeline/list': { access: 'read' },
});
