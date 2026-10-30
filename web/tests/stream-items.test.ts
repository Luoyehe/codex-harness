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

it('separates indexed public summary fragments from mixed raw reasoning during history synchronization', () => {
  const first = applyNotification([], 'item/reasoning/summaryTextDelta', {
    turnId: 't', itemId: 'r', summaryIndex: 0, delta: 'public ',
  }).turns;
  let turns = applyNotification(first, 'item/reasoning/textDelta', {
    turnId: 't', itemId: 'r', contentIndex: 0, delta: 'private raw fragment',
  }).turns;
  turns = applyNotification(turns, 'item/reasoning/summaryPartAdded', {
    turnId: 't', itemId: 'r', summaryIndex: 0,
  }).turns;
  turns = applyNotification(turns, 'item/reasoning/summaryTextDelta', {
    turnId: 't', itemId: 'r', summaryIndex: 0, delta: 'progress',
  }).turns;
  turns = applyNotification(turns, 'item/reasoning/summaryTextDelta', {
    turnId: 't', itemId: 'r', summaryIndex: 2, delta: 'later part',
  }).turns;
  expect(first[0]?.items[0]?.historySync?.summaryDeltas).toEqual(['public ']);
  expect(turns[0]?.items[0]?.historySync?.summaryDeltas).toEqual(['public progress', '', 'later part']);
  expect(turns[0]?.items[0]?.historySync?.deltas).toContain('private raw fragment');
  turns = mergeHistory(turns, [{ id: 't', status: 'inProgress', items: [
    { id: 'r', type: 'reasoning', summary: ['public snapshot'], content: ['private snapshot'] },
  ] }], new Set());
  expect(turns[0]?.items[0]?.summary).toEqual(['public snapshot']);
  expect(turns[0]?.items[0]?.historySync?.summaryDeltas).toEqual(['public progress', '', 'later part']);
  turns = applyNotification(turns, 'item/completed', { turnId: 't', item: {
    id: 'r', type: 'reasoning', summary: ['authoritative summary'], content: ['private final'],
  } }).turns;
  expect(turns[0]?.items[0]?.summary).toEqual(['authoritative summary']);
  expect(turns[0]?.items[0]?.historySync).toBeUndefined();
});

it('keeps only the latest tool progress, ignores unbound progress and never replaces a completed item', () => {
  const progress = (turns: Turn[], message: unknown) => applyNotification(turns, 'item/mcpToolCall/progress', {
    turnId: 't', itemId: 'tool', message,
  }).turns;
  expect(progress([], 'unbound')).toEqual([]);
  for (const status of ['completed', 'failed']) {
    const historical: Turn[] = [{ id: 't', status: 'inProgress', items: [{ id: 'tool', type: 'mcpToolCall', status }] }];
    expect(progress(historical, 'late snapshot progress')).toBe(historical);
  }
  let turns = applyNotification([], 'item/started', { turnId: 't', item: {
    id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'inspect', status: 'inProgress',
  } }).turns;
  turns = progress(turns, 'first progress');
  const first = turns;
  turns = progress(turns, 'latest progress');
  expect(first[0]?.items[0]?.progressMessage).toBe('first progress');
  expect(turns[0]?.items).toHaveLength(1);
  expect(turns[0]?.items[0]).toMatchObject({ tool: 'inspect', progressMessage: 'latest progress' });
  expect(() => progress(turns, 42)).toThrow('工具进度缺少文字内容');
  turns = applyNotification(turns, 'item/completed', { turnId: 't', item: {
    id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'inspect', status: 'completed', result: { content: [] },
  } }).turns;
  turns = progress(turns, 'late progress');
  expect(turns[0]?.items[0]?.progressMessage).toBeUndefined();
  expect(turns[0]?.items[0]?.status).toBe('completed');
  turns = applyNotification(turns, 'turn/completed', { turnId: 't', turn: { id: 't', status: 'completed' } }).turns;
  expect(progress(turns, 'late turn progress')[0]?.items).toEqual(turns[0]?.items);
  expect(() => progress([{ id: 't', status: 'inProgress', items: [{ id: 'tool', type: 'agentMessage', text: 'answer' }] }], 'wrong type')).toThrow('条目类型发生变化');
});

it('accepts terminal MCP snapshots over earlier progress without overriding a completed live item', () => {
  const initial: Turn[] = [{ id: 't', status: 'inProgress', items: [{
    id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'inspect', status: 'inProgress',
  }] }];
  const live = applyNotification(initial, 'item/mcpToolCall/progress', {
    turnId: 't', itemId: 'tool', message: 'earlier progress',
  });
  for (const status of ['completed', 'failed']) {
    const terminal = { id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'inspect', status,
      result: status === 'completed' ? { content: [{ type: 'text', text: 'finished result' }] } : null,
      error: status === 'failed' ? { message: 'finished failure' } : null };
    const merged = mergeHistory(live.turns, [{ id: 't', status: 'inProgress', items: [terminal] }], new Set([live.touched!]));
    expect(merged[0]?.items[0]).toEqual(terminal);
    expect(merged[0]?.items[0]?.progressMessage).toBeUndefined();
    const completed = applyNotification(live.turns, 'item/completed', { turnId: 't', item: terminal }).turns;
    const stale = mergeHistory(completed, initial, new Set([live.touched!]));
    expect(stale[0]?.items[0]).toEqual({ ...terminal, streamComplete: true });
  }
});

it('removes transient tool progress on turn completion without inventing a tool result', () => {
  let turns: Turn[] = [{ id: 't', status: 'inProgress', items: [
    { id: 'tool', type: 'mcpToolCall', status: 'inProgress', progressMessage: 'old progress' },
    { id: 'reasoning', type: 'reasoning', summary: ['public'], historySync: { field: 'reasoning', deltas: 'raw', summaryDeltas: ['fragment'] } },
  ] }];
  const reasoning = turns[0]!.items[1];
  turns = applyNotification(turns, 'turn/completed', { turnId: 't', turn: { id: 't', status: 'completed' } }).turns;
  expect(turns[0]?.items[0]).toEqual({ id: 'tool', type: 'mcpToolCall', status: 'inProgress' });
  expect(turns[0]?.items[1]).toBe(reasoning);
});
