export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Receipt identities carry the ledger generation; unrelated resource IDs remain UUID v4. */
export function operationId(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 0xffffffffffff)
    throw new Error('操作回执代际无效，请重新读取服务状态。');
  if (generation === 0) return uuid();
  const random = uuid().replaceAll('-', '');
  const hex = generation.toString(16).padStart(12, '0') + '8' + random.slice(13);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
