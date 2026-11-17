export function httpErrorStatus(code: string): number {
  if (['unauthorized', 'mfa_required', 'mfa_invalid'].includes(code)) return 401;
  if (['csrf', 'host', 'origin'].includes(code)) return 403;
  if (code === 'not_found') return 404;
  if (code === 'method_not_allowed') return 405;
  if (code === 'content_type') return 415;
  if (code === 'rate_limited') return 429;
  if (['unavailable', 'authentication_unavailable', 'capacity'].includes(code)) return 503;
  return 400;
}
export function startupFailure(error: unknown, stage: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  const known = ['EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'SQLITE_BUSY'];
  return `Gateway startup failed [${stage}; ${typeof code === 'string' && known.includes(code) ? code : 'configuration'}]. Check service configuration and permissions.\n`;
}
