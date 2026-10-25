import type { ExternalAgentConfigMigrationItem } from '../../protocol/ts/v2/ExternalAgentConfigMigrationItem';
import { array, object } from './types';
export type ImportItem = ExternalAgentConfigMigrationItem & { itemId: string; requiresExecutionReview: boolean };
export type ImportPreview = { source: 'claude-code'; previewHash: string; previewKind: 'fresh_native_migration_inventory'; items: ImportItem[]; trustInherited: false };
export type ImportTypeResult = { itemType: string; successCount: number; failureCount: number; failures: { failureStage: string; message: string; source?: string | null }[] };
export const importLabels: Record<string, string> = { AGENTS_MD: '项目指引', CONFIG: '配置', SKILLS: '技能', PLUGINS: '插件', MCP_SERVER_CONFIG: 'MCP 配置', SUBAGENTS: '子 Agent', HOOKS: 'Hooks', COMMANDS: '命令', MEMORY: '记忆', SESSIONS: '会话历史' };
const executable = new Set(['CONFIG', 'PLUGINS', 'MCP_SERVER_CONFIG', 'SUBAGENTS', 'HOOKS', 'COMMANDS']);
export const executionReview = (item: ImportItem) => item.requiresExecutionReview || executable.has(item.itemType);
export function checkedImportPreview(value: unknown): ImportPreview { const result = object(value); if (result.source !== 'claude-code' || result.previewKind !== 'fresh_native_migration_inventory' || typeof result.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.previewHash) || !Array.isArray(result.items) || result.items.length > 64 || result.items.some(item => typeof object(item).itemId !== 'string' || !/^[a-f0-9]{64}$/.test(String(object(item).itemId)))) throw new Error('导入预览身份无效，请重新检测。'); return result as ImportPreview; }
/** Successful apply uses a minimal receipt; history retains native success/failure arrays. */
export function importResults(value: unknown): ImportTypeResult[] {
  const row = object(value);
  if (Array.isArray(row.itemTypeResults)) return row.itemTypeResults.map(value => { const item = object(value); return { itemType: String(item.itemType), successCount: typeof item.successCount === 'number' ? item.successCount : array(item.successes).length, failureCount: typeof item.failureCount === 'number' ? item.failureCount : array(item.failures).length, failures: array<ImportTypeResult['failures'][number]>(item.failures) }; });
  const successes = array<Record<string, unknown>>(row.successes), failures = array<Record<string, unknown>>(row.failures), types = new Set([...successes, ...failures].map(item => String(item.itemType)));
  return [...types].map(itemType => ({ itemType, successCount: successes.filter(item => item.itemType === itemType).length, failureCount: failures.filter(item => item.itemType === itemType).length, failures: failures.filter(item => item.itemType === itemType).map(item => ({ failureStage: String(item.failureStage), message: String(item.message), source: typeof item.source === 'string' ? item.source : null })) }));
}
