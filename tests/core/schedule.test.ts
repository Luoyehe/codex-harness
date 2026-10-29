import { describe, expect, it } from 'vitest';
import { nextScheduled, schedule, schedulePreview } from '../../src/core/schedule.js';

const ms = Date.parse;
describe('zoned automation occurrence calculation', () => {
  it('preserves fixed elapsed intervals and requires a future one-shot occurrence', () => {
    const plan = schedule({ kind: 'interval', hours: 2, anchor: ms('2026-01-01T00:30:00Z'), timeZone: 'Asia/Shanghai' });
    expect(nextScheduled(plan, ms('2026-01-01T00:30:00Z'))).toBe(ms('2026-01-01T02:30:00Z'));
    expect(nextScheduled(schedule({ kind: 'once', at: 1234, timeZone: 'UTC' }), 1234)).toBeNull();
    expect(schedulePreview(plan, ms('2026-01-01T00:00:00Z'))).toHaveLength(5);
  });
  it('skips nonexistent spring times and never schedules the repeated fall hour twice', () => {
    const spring = schedule({ kind: 'weekly', days: [0], time: '02:30', timeZone: 'America/New_York' });
    expect(nextScheduled(spring, ms('2026-03-07T12:00:00Z'))).toBe(ms('2026-03-15T06:30:00Z'));
    const fall = schedule({ kind: 'weekly', days: [0], time: '01:30', timeZone: 'America/New_York' });
    expect(nextScheduled(fall, ms('2026-11-01T04:00:00Z'))).toBe(ms('2026-11-01T05:30:00Z'));
    expect(nextScheduled(fall, ms('2026-11-01T05:45:00Z'))).toBe(ms('2026-11-08T06:30:00Z'));
  });
  it.each(['2026-03-01T07:30:00Z', '2026-03-01T07:30:00.001Z', '2026-03-02T12:00:00Z'])('finds the next weekly occurrence across the spring gap after %s', after => {
    const spring = schedule({ kind: 'weekly', days: [0], time: '02:30', timeZone: 'America/New_York' });
    expect(nextScheduled(spring, ms(after))).toBe(ms('2026-03-15T06:30:00Z'));
  });
  it('previews every future occurrence across the spring gap without inventing the missing week', () => {
    const spring = schedule({ kind: 'weekly', days: [0], time: '02:30', timeZone: 'America/New_York' });
    expect(schedulePreview(spring, ms('2026-02-28T12:00:00Z'))).toEqual([
      '2026-03-01T07:30:00Z', '2026-03-15T06:30:00Z', '2026-03-22T06:30:00Z', '2026-03-29T06:30:00Z', '2026-04-05T06:30:00Z',
    ].map(ms));
  });
  it.each([
    { timeZone: 'Australia/Lord_Howe', days: [0], time: '02:15', after: '2026-09-26T15:45:00Z', next: '2026-10-10T15:15:00Z' },
    { timeZone: 'Pacific/Apia', days: [5], time: '09:00', after: '2011-12-23T19:00:00Z', next: '2012-01-05T19:00:00Z' },
  ])('skips a missing weekly time or whole date in $timeZone immediately after the preceding occurrence', ({ timeZone, days, time, after, next }) => {
    const plan = schedule({ kind: 'weekly', days, time, timeZone });
    expect(nextScheduled(plan, ms(after))).toBe(ms(next));
  });
  it('supports half-hour DST zones and rejects malformed schedules', () => {
    const lordHowe = schedule({ kind: 'weekly', days: [0], time: '02:15', timeZone: 'Australia/Lord_Howe' });
    expect(nextScheduled(lordHowe, ms('2026-10-03T00:00:00Z'))).toBe(ms('2026-10-10T15:15:00Z'));
    for (const value of [{ kind: 'weekly', days: [1, 1], time: '12:00', timeZone: 'UTC' }, { kind: 'weekly', days: [1], time: '24:00', timeZone: 'UTC' }, { kind: 'once', at: 1, timeZone: 'Missing/Zone' }, { kind: 'interval', hours: 0, anchor: 0, timeZone: 'UTC' }, { kind: 'once', at: 1, timeZone: 'UTC', command: 'shell' }]) expect(() => schedule(value)).toThrow();
  });
});
