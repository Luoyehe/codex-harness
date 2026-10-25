// Public gateway contract only; keep server database and validation modules out of the web build.
export type Schedule = { kind: 'once'; at: number; timeZone: string } | { kind: 'interval'; hours: number; anchor: number; timeZone: string } | { kind: 'weekly'; days: number[]; time: string; timeZone: string };
export type AutomationSpec = { name: string; projectId: string; text: string; options: Record<string, unknown>; schedule: Schedule; maxRunMinutes: number };
export type Automation = AutomationSpec & { id: string; revision: number; state: 'active' | 'paused' | 'removed'; nextAt: number | null; createdAt: number; updatedAt: number };
export type Run = { id: string; automationId: string; revision: number; scheduledAt: number; manual: boolean; operationId: string; state: 'queued' | 'dispatching' | 'running' | 'needs_attention' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'closed_unknown' | 'not_sent' | 'skipped' | 'canceled'; threadId: string | null; turnId: string | null; startedAt: number | null; finishedAt: number | null; stopRequested: boolean; stopSent: boolean; code: string | null };
export const runLabels: Record<Run['state'], string> = { queued: '等待执行', dispatching: '正在提交', running: '执行中', needs_attention: '等待你的决定', stopping: '正在停止', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '结果未知', closed_unknown: '未知记录已关闭', not_sent: '未发送', skipped: '已跳过', canceled: '已取消' };
export const activeRun = (run: Run) => ['queued', 'dispatching', 'running', 'needs_attention', 'stopping', 'unknown'].includes(run.state);
function dateFormat(timeZone: string) { return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
function parts(format: Intl.DateTimeFormat, at: number) { return Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value])); }
export function localTime(at: number, timeZone: string): string { const p = parts(dateFormat(timeZone), at); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
/** datetime-local has no zone. Resolve it explicitly and reject nonexistent wall times. */
export function zonedTime(value: string, timeZone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请选择日期和时间。');
  const target = Date.parse(value + ':00Z');
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 16) !== value) throw new Error('日期或时间无效。');
  let format: Intl.DateTimeFormat; try { format = dateFormat(timeZone); } catch { throw new Error('请选择有效的 IANA 时区。'); }
  const civil = (at: number) => { const p = parts(format, at); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!); };
  const offsets = new Set<number>(); for (let hour = -36; hour <= 36; hour += 6) { const probe = target + hour * 3_600_000; offsets.add(civil(probe) - probe); }
  const candidates = [...offsets].map(offset => target - offset).filter(candidate => civil(candidate) === target).sort((a, b) => a - b);
  if (candidates[0] === undefined) throw new Error('此时区在该日期没有这个时间（夏令时跳时），请另选时间。');
  return candidates[0];
}
export function displayTime(at: number | null, timeZone: string) { return at === null ? '无' : new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at); }
export function scheduleLabel(schedule: Schedule) { return schedule.kind === 'once' ? `一次 · ${displayTime(schedule.at, schedule.timeZone)}` : schedule.kind === 'interval' ? `每 ${schedule.hours} 小时` : `每周 ${schedule.days.map(day => '日一二三四五六'[day]).join('、')} ${schedule.time}`; }
