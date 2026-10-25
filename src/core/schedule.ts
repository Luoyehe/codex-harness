import { HarnessError } from './errors.js';
import type { JsonObject, JsonValue } from './contracts.js';
import { object, validText } from './validation.js';

export type Schedule = { kind: 'once'; at: number; timeZone: string } | { kind: 'interval'; hours: number; anchor: number; timeZone: string } | { kind: 'weekly'; days: number[]; time: string; timeZone: string };
function exact(value: JsonObject, keys: string[]): void { if (Object.keys(value).some(key => !keys.includes(key))) throw new HarnessError('invalid', '计划包含不支持的字段。'); }
function epoch(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000) throw new HarnessError('invalid', '计划时间无效。'); return value; }
export function schedule(input: JsonValue): Schedule {
  object(input); const timeZone = validText(input.timeZone, 128);
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); } catch { throw new HarnessError('invalid', '请选择有效的 IANA 时区。'); }
  if (input.kind === 'once') { exact(input, ['kind', 'at', 'timeZone']); return { kind: 'once', at: epoch(input.at), timeZone }; }
  if (input.kind === 'interval') {
    exact(input, ['kind', 'hours', 'anchor', 'timeZone']);
    if (typeof input.hours !== 'number' || !Number.isSafeInteger(input.hours) || input.hours < 1 || input.hours > 168) throw new HarnessError('invalid', '间隔必须为 1 至 168 小时。');
    return { kind: 'interval', hours: input.hours, anchor: epoch(input.anchor), timeZone };
  }
  if (input.kind !== 'weekly') throw new HarnessError('invalid', '不支持此计划类型。');
  exact(input, ['kind', 'days', 'time', 'timeZone']);
  if (!Array.isArray(input.days) || !input.days.length || input.days.length > 7 || input.days.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) || new Set(input.days).size !== input.days.length || typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new HarnessError('invalid', '请选择星期和有效时间。');
  return { kind: 'weekly', days: (input.days as number[]).toSorted(), time: input.time, timeZone };
}
function parts(format: Intl.DateTimeFormat, time: number): number[] { const p = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value])); return ['year', 'month', 'day', 'hour', 'minute'].map(key => Number(p[key])); }
function civil(parts: number[]): number { return Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!); }
/** Wall-clock schedules skip nonexistent DST times and run only at the first occurrence of repeated times. */
export function nextScheduled(plan: Schedule, after: number): number | null {
  epoch(after);
  if (plan.kind === 'once') return plan.at > after ? plan.at : null;
  if (plan.kind === 'interval') { const step = plan.hours * 3_600_000; return plan.anchor > after ? plan.anchor : plan.anchor + (Math.floor((after - plan.anchor) / step) + 1) * step; }
  const format = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: plan.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = parts(format, after), [hour, minute] = plan.time.split(':').map(Number);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(Date.UTC(local[0]!, local[1]! - 1, local[2]! + day, hour, minute));
    if (!plan.days.includes(date.getUTCDay())) continue;
    const target = date.getTime(), offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 6) { const probe = target + hours * 3_600_000; offsets.add(civil(parts(format, probe)) - probe); }
    const candidates = [...offsets].map(offset => target - offset).filter(candidate => civil(parts(format, candidate)) === target).sort((a, b) => a - b);
    // Do not choose the second fold after a restart between two equal wall-clock times.
    if (candidates[0] !== undefined && candidates[0] > after) return candidates[0];
  }
  throw new HarnessError('schedule_unavailable', '无法计算此时区的下次运行时间。');
}
export function schedulePreview(plan: Schedule, after: number, count = 5): number[] { const out: number[] = []; for (let i = 0; i < count; i++) { const next = nextScheduled(plan, after); if (next === null) break; out.push(next); after = next; } return out; }
