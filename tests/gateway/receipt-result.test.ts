import { describe, expect, it } from 'vitest';
import { receiptResult } from '../../src/gateway/receipt-result.js';
describe('durable receipt data minimization', () => {
  it('projects fixed root management results and nested saved profiles without future secret fields', () => {
    const model = { id: 'fixture', defaultEffort: null, efforts: [], inputModalities: ['text'], contextWindow: 4096, supportsTools: false, instructions: 'Known\nmodel instructions' };
    const profile = { id: 'b'.repeat(32), name: 'Saved endpoint', kind: 'responses', revision: 'c'.repeat(32), baseUrl: 'https://provider.invalid/v1', model: 'fixture', hasApiKey: true };
    const oauth = { authorizationUrl: 'https://login.invalid/authorize', tokenUrl: 'https://login.invalid/token', clientId: 'public', cookieName: 'session', redirectPort: 9090 };
    const expected = { kind: 'chatgpt-gateway', revision: 'a'.repeat(32), baseUrl: 'https://provider.invalid/v1', hasApiKey: false, gatewayOAuth: oauth,
      models: [model], profiles: [profile], retention: { generations: 4, limit: 128, retainedHistory: 3 } };
    const actual = { ...expected, apiKey: 'private', futureToken: 'private', nativeCatalog: { secret: 'private' },
      gatewayOAuth: { ...oauth, clientSecret: 'private' }, models: [{ ...model, apiKey: 'private' }], profiles: [{ ...profile, apiKey: 'private', settings: { apiKey: 'private' } }],
      retention: { ...expected.retention, secrets: 'private' } };
    expect(receiptResult('system/provider/write', actual)).toEqual(expected);
    expect(receiptResult('system/models/refresh', { ...actual, applied: false, requiresConfirmation: true, source: 'provider' })).toEqual({ ...expected, applied: false, requiresConfirmation: true, source: 'provider' });
    expect(receiptResult('system/restart', { restarted: true, release: 'd'.repeat(64), privatePath: '/private' })).toEqual({ restarted: true, release: 'd'.repeat(64) });
  });
  it('refuses malformed management proof and unsupported system receipt kinds', () => {
    const provider = { kind: 'chatgpt', revision: 'a'.repeat(32), hasApiKey: false, models: [] };
    for (const change of [{ revision: 'invalid' }, { kind: ['chatgpt'] }, { hasApiKey: 'false' }, { profiles: Array(17).fill({}) },
      { retention: { generations: 129, limit: 128, retainedHistory: 3 } }, { baseUrl: ['https://', 'user', ':', 'secret', '@', 'provider.invalid/v1'].join('') },
      { models: [{ id: 'model', defaultEffort: null, efforts: [], inputModalities: ['text', ['image']] }] }])
      expect(() => receiptResult('system/provider/write', { ...provider, ...change })).toThrow(expect.objectContaining({ code: 'receipt_contract', delivery: 'unknown' }));
    expect(() => receiptResult('system/restart', { restarted: true })).toThrow();
    expect(() => receiptResult('system/models/refresh', { ...provider, applied: true, requiresConfirmation: true })).toThrow();
    expect(() => receiptResult('system/models/refresh', { ...provider, applied: false, requiresConfirmation: true, source: ['provider'] })).toThrow();
    expect(() => receiptResult('system/unreviewed-write', {})).toThrow();
    expect(() => receiptResult('system/provider/read', provider)).toThrow();
  });
  it('preserves the 64 Unicode character saved-profile name contract', () => {
    const profile = { id: 'b'.repeat(32), kind: 'chatgpt', revision: 'c'.repeat(32), hasApiKey: false };
    const provider = { kind: 'chatgpt', revision: 'a'.repeat(32), hasApiKey: false, models: [] };
    for (const name of ['中'.repeat(64), '🌟'.repeat(64)])
      expect(receiptResult('system/provider/write', { ...provider, profiles: [{ ...profile, name }] })).toMatchObject({ profiles: [{ name }] });
    for (const name of ['中'.repeat(65), '🌟'.repeat(65), ' '.repeat(3)])
      expect(() => receiptResult('system/provider/write', { ...provider, profiles: [{ ...profile, name }] })).toThrow();
  });
  it('account receipts preserve redemption outcome and OAuth handoff identity without private authorization links', () => {
    expect(receiptResult('account/gatewayOAuth/login', { handoffId: 'handoff', providerId: 'enterprise', started: true, authUrl: 'https://private' })).toEqual({ handoffId: 'handoff', providerId: 'enterprise', started: true });
    expect(receiptResult('account/resetCredit/consume', { outcome: 'nothingToReset', accountId: 'account' })).toEqual({ outcome: 'nothingToReset', accountId: 'account' });
    expect(() => receiptResult('account/resetCredit/consume', { outcome: 'success', accountId: 'account' })).toThrow();
  });
  it('environment and native pairing receipts exclude credentials and pairing codes', () => {
    expect(receiptResult('environment/add', { environmentId: 'env', registered: true, authBearerToken: 'private' })).toEqual({ environmentId: 'env', registered: true, requiresRestartToDisconnect: true });
    expect(receiptResult('environment/info', { environmentId: 'env', inspected: true, selectionReady: true, info: { cwd: 'file:///private' } })).toEqual({ environmentId: 'env', inspected: true, selectionReady: true });
    expect(receiptResult('remoteControl/pairing/start', { pairingId: 'pairing', environmentId: 'env', expiresAt: 123, pairingCode: 'private', manualPairingCode: 'private' })).toEqual({ pairingId: 'pairing', environmentId: 'env', expiresAt: 123 });
  });
  it('voice receipts retain session identity without SDP, transcript or native transport details', () => {
    const identity = { sessionHandle: 'voice', threadId: 'thread', state: 'active', nextSequence: 0, lastAcceptedSequence: -1 };
    expect(receiptResult('thread/realtime/start', { ...identity, sdp: 'private', params: { audio: 'private' } })).toEqual(identity);
    expect(receiptResult('thread/realtime/stop', { ...identity, state: 'closed', stopped: true, reason: 'private' })).toEqual({ ...identity, state: 'closed', stopped: true });
  });
  it('recovery receipts keep source and target identities while excluding backup contents', () => {
    const file = { path: 'restored', kind: 'file', revision: 'a'.repeat(64), bytes: 12, recoveryOperationId: 'new', restoredFromOperationId: 'old' };
    expect(receiptResult('workspace/recovery/restore', { ...file, text: 'private' })).toEqual(file);
    const directory = { path: 'folder', kind: 'directory', revision: 'a'.repeat(64), recoveryOperationId: 'new', restoredFromOperationId: 'old' };
    expect(receiptResult('workspace/recovery/restore', directory)).toEqual(directory);
    expect(receiptResult('workspace/recovery/discard', { recoveryOperationId: 'old', discarded: true, receiptRetained: true, path: 'private' })).toEqual({ recoveryOperationId: 'old', discarded: true, receiptRetained: true });
    for (const value of [{ ...file, revision: 'bad' }, { ...file, bytes: 524289 }, { ...file, kind: 'symlink' }]) expect(() => receiptResult('workspace/recovery/restore', value)).toThrow(expect.objectContaining({ delivery: 'unknown' }));
    expect(() => receiptResult('workspace/recovery/discard', { recoveryOperationId: 'old', discarded: true })).toThrow(expect.objectContaining({ delivery: 'unknown' }));
  });
  it('organizational receipts contain identities without associated payloads or private names', () => {
    expect(receiptResult('nativeProject/create', { project: { id: 'native', name: 'private', roots: [{ path: '/workspace' }], metadata: { secret: 'private' } } })).toEqual({ project: { id: 'native' } });
    expect(receiptResult('threadSection/create', { section: { id: 'section', name: 'private' } })).toEqual({ section: { id: 'section' } });
    expect(receiptResult('thread/attachment/add', { outcome: 'created', attachment: { id: 'a', attachmentType: 'link', identityKey: 'key', createdAt: 1, payload: { secret: 'private' } } })).toEqual({ outcome: 'created', attachment: { id: 'a', attachmentType: 'link', identityKey: 'key', createdAt: 1 } });
  });
  it('MCP receipts retain recovery identity and native errors without storing tool bodies', () => {
    expect(receiptResult('mcp/tool/call', { resultId: 'r', threadId: 't', server: 's', tool: 'echo', isError: true, content: [{ text: 'private' }] })).toEqual({ resultId: 'r', threadId: 't', server: 's', tool: 'echo', isError: true });
    expect(() => receiptResult('mcp/tool/call', { resultId: 'r', threadId: 't', server: 's', tool: 'echo' })).toThrow(expect.objectContaining({ delivery: 'unknown' }));
    expect(receiptResult('mcp/stream/start', { subscriptionId: 'sub', threadId: 't', server: 's', name: 'watch', arguments: { secret: 'no' } })).toEqual({ subscriptionId: 'sub', threadId: 't', server: 's', name: 'watch' });
    expect(receiptResult('thread/unsubscribe', { status: 'unsubscribed' })).toEqual({ status: 'unsubscribed' });
  });
  it('extension receipts retain readiness-relevant status and omit authentication links and configuration payloads', () => {
    expect(receiptResult('plugin/install', { pluginId: 'p', authPolicy: 'ON_INSTALL', appsNeedingAuth: [{ id: 'app', installUrl: 'https://example.test?token=secret', tools: ['private'] }] })).toEqual({ pluginId: 'p', authPolicy: 'ON_INSTALL', appsNeedingAuth: [{ id: 'app' }] });
    expect(receiptResult('settings/write', { status: 'okOverridden', version: 'v', filePath: '/native/config.toml', overriddenMetadata: { effectiveValue: 'secret' } })).toEqual({ status: 'okOverridden', version: 'v', filePath: '/native/config.toml' });
    expect(receiptResult('plugin/reconcile', { changedPlugins: [{ id: 'p', hasMcps: true, hasApps: false, hasHooks: false, hasSkills: true }], failedRemotePluginIds: ['bad'], failedMaterializationRemotePluginIds: ['bad'] })).toMatchObject({ failedRemotePluginIds: ['bad'], failedMaterializationRemotePluginIds: ['bad'] });
    expect(() => receiptResult('skills/config/write', {})).toThrow(expect.objectContaining({ delivery: 'unknown' }));
  });
  it('retains task workflow identities without queued text, goal objectives or review findings', () => {
    expect(receiptResult('thread/queue/add', { queuedSubmission: { id: 'q', clientUserMessageId: 'm', input: [{ text: 'private queued text' }] } })).toEqual({ queuedSubmission: { id: 'q', clientUserMessageId: 'm' } });
    expect(receiptResult('thread/goal/set', { goal: { threadId: 't', objective: 'private objective', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } })).toEqual({ goal: { threadId: 't', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
    expect(receiptResult('review/start', { reviewThreadId: 't', turn: { id: 'u', status: 'inProgress', items: [{ text: 'private finding' }] } })).toEqual({ reviewThreadId: 't', turn: { id: 'u', status: 'inProgress' } });
    expect(receiptResult('thread/fork', { thread: { id: 'fork', cwd: '/project', preview: 'private context' } })).toEqual({ thread: { id: 'fork', cwd: '/project' } });
  });
  it('does not turn unavailable settings targets or unread revisions into empty success', () => {
    expect(receiptResult('turn/settings/update', { status: 'targetUnavailable' })).toEqual({ status: 'targetUnavailable' });
    expect(() => receiptResult('turn/settings/update', { status: 'invented' })).toThrow(expect.objectContaining({ delivery: 'unknown' }));
    expect(receiptResult('thread/readState/update', { readState: { firstUnread: { type: 'turn', turnId: 'u' }, revision: 'r', unrelated: 'private' } })).toEqual({ readState: { firstUnread: { type: 'turn', turnId: 'u' }, revision: 'r' } });
  });
  it('stores stable first-send identity without native bodies, previews or instructions', () => {
    const output = receiptResult('conversation/start', {
      thread: { id: 't', cwd: '/work', createdAt: 1, preview: 'private prompt', name: 'private title', turns: [], instructions: 'private instructions' },
      turn: { id: 'u', status: 'inProgress', items: [{ text: 'private body' }] },
    });
    expect(output).toEqual({ thread: { id: 't', cwd: '/work', createdAt: 1 }, turn: { id: 'u', status: 'inProgress' } });
    expect(JSON.stringify(output)).not.toContain('private');
  });
  it('fails uncertain instead of acknowledging an unusable native turn response', () => {
    expect(() => receiptResult('turn/start', { turn: {} })).toThrow(expect.objectContaining({ delivery: 'unknown' }));
  });
  it('preserves valid long project paths and attachment MIME metadata', () => {
    const project = { id: 'p', name: 'project', path: '/workspace/' + 'a'.repeat(300) };
    expect(receiptResult('project/add', project)).toEqual(project);
    expect(receiptResult('attachment/upload', { attachmentId: 'a', mimeType: 'image/png', size: 1, path: '/private' })).toEqual({ attachmentId: 'a', mimeType: 'image/png', size: 1 });
  });
  it('does not persist new upstream fields in login or attachment results', () => {
    expect(receiptResult('account/login', { type: 'chatgptDeviceCode', loginId: 'login', userCode: 'short-code', verificationUrl: 'https://example.test/device', accessToken: 'never persist' })).toEqual({ type: 'chatgptDeviceCode', loginId: 'login' });
    expect(receiptResult('account/login/cancel', { status: 'notFound' })).toEqual({ status: 'notFound' });
    expect(() => receiptResult('account/login/cancel', {})).toThrow();
    expect(receiptResult('attachment/upload', { attachmentId: 'a', size: 1, content: 'private bytes' })).toEqual({ attachmentId: 'a', size: 1 });
  });
});
