import { expect, it } from 'vitest';
import { applyNotification, mergeHistory } from '../lib/history';
import type { Turn } from '../lib/types';

it('joins native plan and indexed reasoning deltas without erasing repeated part starts', () => {
  let turns: Turn[] = [];
  const push = (method: string, params: Record<string, unknown>) => {
    turns = applyNotification(turns, method, { turnId: 't', ...params }).turns;
  };
  push('item/started', { item: { id: 'p', type: 'plan', text: 'Step ' } });
  push('item/plan/delta', { itemId: 'p', delta: 'one' });
  push('item/started', { item: { id: 'r', type: 'reasoning', summary: [], content: [] } });
  push('item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 0 });
  push('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Review ' });
  push('item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 0 });
  push('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'code' });
  push('item/reasoning/textDelta', { itemId: 'r', contentIndex: 1, delta: 'Second part' });
  push('item/started', { item: { id: 'r', type: 'reasoning', summary: [], content: [] } });
  expect(turns[0]?.items[0]?.text).toBe('Step one');
  expect(turns[0]?.items[1]).toMatchObject({
    summary: ['Review code'],
    content: ['', 'Second part'],
  });
  expect(() =>
    push('item/reasoning/textDelta', { itemId: 'r', contentIndex: 1000000, delta: 'invalid' }),
  ).toThrow('安全范围');
  expect(turns[0]?.items[1]?.content).toEqual(['', 'Second part']);
});

it('keeps overlapping reasoning snapshots separate, then accepts final content exactly once', () => {
  const delta = applyNotification([], 'item/reasoning/summaryTextDelta', {
    turnId: 't',
    itemId: 'r',
    summaryIndex: 0,
    delta: 'same',
  });
  let turns = mergeHistory(
    delta.turns,
    [
      {
        id: 't',
        status: 'inProgress',
        items: [{ id: 'r', type: 'reasoning', summary: ['prefix same'], content: [] }],
      },
    ],
    new Set([delta.touched!]),
  );
  expect(turns[0]?.items[0]?.historySync).toMatchObject({
    field: 'reasoning',
    snapshot: expect.stringContaining('prefix same'),
    deltas: expect.stringContaining('same'),
  });
  turns = applyNotification(turns, 'item/completed', {
    turnId: 't',
    item: { id: 'r', type: 'reasoning', summary: ['prefix samesame'], content: [] },
  }).turns;
  turns = applyNotification(turns, 'item/reasoning/summaryTextDelta', {
    turnId: 't',
    itemId: 'r',
    summaryIndex: 0,
    delta: 'late',
  }).turns;
  expect(turns[0]?.items[0]).toMatchObject({ summary: ['prefix samesame'], streamComplete: true });
  expect(turns[0]?.items[0]?.historySync).toBeUndefined();
  turns = applyNotification(turns, 'turn/completed', {
    turnId: 't',
    turn: { id: 't', status: 'completed' },
  }).turns;
  turns = applyNotification(turns, 'turn/plan/updated', {
    turnId: 't',
    plan: [{ step: 'late' }],
  }).turns;
  expect(turns[0]?.items).toHaveLength(1);
});

it('does not append plan deltas onto an active history snapshot with an unknown watermark', () => {
  let turns = mergeHistory(
    [],
    [{ id: 't', status: 'inProgress', items: [{ id: 'p', type: 'plan', text: 'one two' }] }],
    new Set(),
  );
  turns = applyNotification(turns, 'item/plan/delta', {
    turnId: 't',
    itemId: 'p',
    delta: 'two',
  }).turns;
  expect(turns[0]?.items[0]?.historySync).toEqual({
    field: 'text',
    snapshot: 'one two',
    deltas: 'two',
  });
});
