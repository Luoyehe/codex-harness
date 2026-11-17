export const statusLabel = (value: string | null | undefined, labels: Record<string, string>) =>
  value == null ? '未提供' : labels[value] ?? value;
export const skillScopes = { user: '用户', repo: '项目', system: '系统', admin: '管理员' };
export const hookTrust = { managed: '管理员托管', untrusted: '未信任', trusted: '已信任', modified: '内容已变更，需重新核对' };
export const guardianRisk = { low: '低', medium: '中', high: '高', critical: '极高' };
export const guardianAuthorization = { unknown: '未确认', low: '低', medium: '中', high: '高' };
