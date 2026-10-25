import { expect, test } from 'vitest';
import { validateTimelineContract } from '../../src/runtime/timeline-contract.js';
const page = (entry: object) => ({ data: [entry], nextCursor: null, activeRealtimeSessionAtPageStart: null });
test('pinned camelCase boundary variants validate without mutating the actual native payload', () => {
  const entry = { type: 'turnCompleted', position: 1, turnId: 't', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 };
  const value = page(entry); validateTimelineContract('ThreadTimelineListResponse', value); expect(entry).not.toHaveProperty('turn_id');
  validateTimelineContract('ThreadRealtimeItemCompletedNotification', { threadId: 't', item: { id: 'v', realtimeSessionId: 's', type: 'bemItemPromoted', turnId: 't', itemId: 'i', presentation: { type: 'wholeItem' } } });
});
test('timeline adapter rejects conflicting spellings, missing required fields and extra identity claims', () => {
  const entry = { type: 'turnStarted', position: 1, turnId: 't', startedAt: null };
  for (const changed of [{ ...entry, turn_id: 'foreign' }, { type: 'turnStarted', position: 1, startedAt: null }, { ...entry, threadId: 'foreign' }, { ...entry, startedAt: undefined }]) expect(() => validateTimelineContract('ThreadTimelineListResponse', page(changed))).toThrow();
  expect(() => validateTimelineContract('ThreadRealtimeItemCompletedNotification', { threadId: 't', item: { id: 'v', realtimeSessionId: 's', type: 'bemItemPromoted', turnId: 't', itemId: 'i', item_id: 'foreign', presentation: { type: 'wholeItem' } } })).toThrow();
});
