import type { JsonObject } from '../../src/runtime/types.js';
export function nativeThread(overrides: JsonObject = {}): JsonObject {
  return { id: 'thread', environments: null, extra: null, sessionId: 'thread', forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'paginated', modelProvider: 'fixture', model: 'fixture', reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null, status: { type: 'idle' }, path: null, cwd: '/project', cliVersion: '0.164.0', originator: null, source: 'appServer', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, daybreakEnabled: null, turns: [], ...overrides };
}
