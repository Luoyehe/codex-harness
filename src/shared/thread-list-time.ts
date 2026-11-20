/** Native thread/list defaults to created_at and exposes Unix seconds. Older
 * sidebar data can contain Unix milliseconds, or only the last update time. */
export function threadListTime(row: Record<string, unknown>, sortKey: unknown): number | undefined {
  const time = sortKey === 'recency_at' ? row.recencyAt ?? row.updatedAt ?? row.createdAt :
    sortKey === 'updated_at' ? row.updatedAt ?? row.createdAt : row.createdAt;
  if (typeof time !== 'number' || !Number.isFinite(time)) return undefined;
  return Math.abs(time) >= 1e12 ? time / 1000 : time;
}
