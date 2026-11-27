/** Older runtimes only supplied the aggregate flag. Inconsistent snapshots cannot prove isolation. */
export function activityScope(activity: Record<string, unknown>): { globalUnknown: boolean; unknownThreads: string[] } {
  const { unknown, globalUnknown, unknownThreads } = activity;
  if (typeof globalUnknown === 'boolean' && Array.isArray(unknownThreads) &&
      unknownThreads.every((id): id is string => typeof id === 'string' && id.length > 0) &&
      unknown === (globalUnknown || unknownThreads.length > 0)) {
    return { globalUnknown, unknownThreads };
  }
  return { globalUnknown: unknown !== false || globalUnknown !== undefined || unknownThreads !== undefined, unknownThreads: [] };
}
