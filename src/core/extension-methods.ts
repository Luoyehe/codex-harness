import type { FeatureMethod } from './feature-methods.js';

const read: FeatureMethod = { access: 'read' };
const projectRead: FeatureMethod = { access: 'read', project: true };
const configuration: FeatureMethod = { access: 'write', activity: 'configuration' };
const projectConfiguration: FeatureMethod = { ...configuration, project: true };
export const extensionMethods: Readonly<Record<string, FeatureMethod>> = Object.freeze({
  'skills/list': projectRead, 'skills/read': projectRead, 'skills/config/write': projectConfiguration,
  'skills/extraRoots/read': read, 'skills/extraRoots/set': configuration,
  'hooks/list': projectRead,
  'plugin/list': projectRead, 'plugin/search': projectRead, 'plugin/installed': projectRead,
  'plugin/read': projectRead, 'plugin/install': projectConfiguration, 'plugin/uninstall': projectConfiguration,
  'plugin/reconcile': configuration,
  'plugin/skill/read': projectRead,
  'plugin/share/list': read, 'plugin/share/preview': projectRead, 'plugin/share/save': projectConfiguration,
  'plugin/share/updateTargets': configuration, 'plugin/share/delete': configuration, 'plugin/share/checkout': configuration,
  'marketplace/add': projectConfiguration, 'marketplace/remove': projectConfiguration, 'marketplace/upgrade': projectConfiguration,
  'app/list': read, 'app/read': read, 'app/installed': read,
  'settings/read': projectRead, 'settings/write': configuration,
  'project/trust/read': projectRead, 'project/trust/write': projectConfiguration,
  'mcp/config/read': projectRead, 'mcp/config/write': projectConfiguration,
  'import/preview': projectRead, 'import/history': projectRead, 'import/apply': projectConfiguration,
  'configRequirements/read': read,
  'experimentalFeature/list': read, 'experimentalFeature/enablement/set': configuration,
  'memory/status': read, 'memory/reset': configuration,
  'account/usage/read': read, 'account/workspaceMessages/read': read,
  'userVerification/status': read,
  'account/resetCredit/preview': read, 'account/resetCredit/consume': configuration,
  'account/sendAddCreditsNudgeEmail': configuration,
  'account/gatewayOAuth/read': read, 'account/gatewayOAuth/handoff': read,
  'account/gatewayOAuth/login': configuration, 'account/gatewayOAuth/cancel': configuration,
  'server/diagnostics': read,
  'feedback/save': projectConfiguration, 'feedback/upload': projectConfiguration,
  'rollout/compress': configuration,
});
