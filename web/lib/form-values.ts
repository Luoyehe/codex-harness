// Form field names and question ids are opaque strings, including prototype names.
export function ownField<T>(value: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

export function withField<T>(
  value: Record<string, T>,
  key: string,
  next: T | undefined,
): Record<string, T> {
  if (next !== undefined) return { ...value, [key]: next };
  const result = { ...value };
  delete result[key];
  return result;
}
