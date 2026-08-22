/** Compact relative time for sidebar lists ("刚刚 / 5 分钟前 / 昨天 / 3 天前 / M月D日)。 */
export function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const ms = Date.now() - unixSeconds * 1000;
  if (ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day} 天前`;
  const d = new Date(unixSeconds * 1000);
  return d.getFullYear() === new Date().getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Last path segment as a friendly project name. */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || "/";
}
