export const statusLabel = (value: string | null | undefined, labels: Record<string, string>): string =>
  value == null || value === '' ? '未提供' : Object.hasOwn(labels, value) ? labels[value]! : `未知值（${value}）`;
export const skillScopes = { user: '用户', repo: '项目', system: '系统', admin: '管理员' };
export const hookTrust = { managed: '管理员托管', untrusted: '未信任', trusted: '已信任', modified: '内容已变更，需重新核对' };
export const guardianRisk = { low: '低', medium: '中', high: '高', critical: '极高' };
export const guardianAuthorization = { unknown: '未确认', low: '低', medium: '中', high: '高' };

export const pluginAvailability = { AVAILABLE: '可用', DISABLED_BY_ADMIN: '已由管理员停用' };
export const pluginInstallPolicy = { NOT_AVAILABLE: '禁止安装', AVAILABLE: '允许安装', INSTALLED_BY_DEFAULT: '默认安装' };
export const hookHandlers = { command: '命令', mcpTool: 'MCP 工具', prompt: '提示词', agent: '代理' };
export const recoveryStates = { running: '正在执行', accepted: '已受理', pending: '等待处理', reserved: '已预留', dispatching: '正在分发', executing: '正在执行', completed: '已完成', unknown: '结果未知', not_sent: '未发送', failed: '失败' };
export const recoveryPhases = { prepared: '已准备', published: '已写入索引', discarding: '正在丢弃备份' };
export const planTypes = { free: '免费版', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: '团队版', self_serve_business_prolite: '自助商务 Pro Lite', self_serve_business_usage_based: '自助商务按量版', business: '商务版', ent26: '企业版 26', enterprise_cbp_automation: '企业自动化', enterprise_cbp_usage_based: '企业按量版', enterprise: '企业版', edu: '教育版', edu_plus: '教育 Plus', edu_pro: '教育 Pro', sci: '科研版', sci_plus: '科研 Plus', unknown: '未确认' };

export const hookEvents = { preModelRequest: '模型请求前', postModelRequest: '模型请求后', preToolUse: '工具运行前', permissionRequest: '权限请求', postToolUse: '工具运行后', preCompact: '压缩前', postCompact: '压缩后', sessionStart: '会话开始', sessionEnd: '会话结束', userPromptSubmit: '用户提交输入', subagentStart: '子代理启动', subagentStop: '子代理停止', stop: '停止', interrupt: '中断' };
export function hookEventLabel(value: string | null | undefined): string {
  // Older native configurations use the same event names with an initial capital.
  const canonical = value && value.charAt(0).toLowerCase() + value.slice(1);
  return statusLabel(canonical && Object.hasOwn(hookEvents, canonical) ? canonical : value, hookEvents);
}
export const hookModes = { sync: '同步', async: '异步' };
export const hookScopes = { thread: '会话', turn: '回合' };
export const hookSources = { system: '系统', user: '用户', project: '项目', mdm: '设备管理', sessionFlags: '会话参数', plugin: '插件', cloudRequirements: '云端要求', cloudManagedConfig: '云端托管配置', legacyManagedConfigFile: '旧版托管配置文件', legacyManagedConfigMdm: '旧版托管设备配置', unknown: '来源未知' };
export const hookOutputs = { warning: '警告', stop: '停止', feedback: '反馈', context: '上下文', error: '错误' };
export const predictionStates = { pending: '等待结果', completed: '已完成', failed: '生成失败', stale: '已过期', unknown: '结果未知' };
export const pluginAuthPolicies = { ON_INSTALL: '安装后需要认证', ON_USE: '使用时认证' };
export const experimentalStages = { beta: '测试版', underDevelopment: '开发中', stable: '稳定版', deprecated: '已弃用', removed: '已移除' };
