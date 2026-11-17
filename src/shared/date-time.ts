/** Calendar-aware RFC 3339 validation shared by forms and runtime admission. */
export function validDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return false;
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0), offsetMinute = Number(match[10] ?? 0);
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false;
  if (second < 60) return true;
  const offset = (offsetHour * 60 + offsetMinute) * (match[8] === '-' ? -1 : 1);
  return ((hour * 60 + minute - offset) % 1440 + 1440) % 1440 === 1439;
}
