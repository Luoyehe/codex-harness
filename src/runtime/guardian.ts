import { EpochIdentities } from './epoch-identities.js';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonical, DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { WorkflowMutation } from './workflows.js';
interface Host { mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue> }
interface Denial { approvalId: string; threadId: string; reviewId: string; event: JsonObject; notification: JsonObject; createdAt: number; expiresAt: number; state: 'available' | 'pending' | 'registered' | 'unknown' }
export const guardianMethods = new Set(['thread/guardian/list', 'thread/approveGuardianDeniedAction']);
// Internal GuardianAssessmentEvent is not the public camelCase notification. Keep
// this deliberately enumerated adapter tied to the pinned CLI, never case-rewrite
// arbitrary JSON or accept a browser-supplied serialized assessment.
function uri(value: JsonValue): string { const path = string(value, 'native action path'); return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') ? pathToFileURL(path, { windows: true }).href : path; }
function fileSystem(value: JsonValue): JsonObject {
  const f = object(value); onlyKeys(f, ['read', 'write', 'globScanMaxDepth', 'entries']);
  // The public notification includes legacy path projections alongside entries.
  // The internal serde union accepts either legacy lists OR entries, never both.
  const entries = f.entries == null ? undefined : f.entries as JsonObject[];
  for (const entry of entries ?? []) {
    onlyKeys(entry, ['path', 'access']); const path = object(entry.path);
    if (path.type === 'path') onlyKeys(path, ['type', 'path']);
    else if (path.type === 'glob_pattern') onlyKeys(path, ['type', 'pattern']);
    else { onlyKeys(path, ['type', 'value']); const special = object(path.value); onlyKeys(special, special.kind === 'unknown' ? ['kind', 'path', 'subpath'] : special.kind === 'project_roots' ? ['kind', 'subpath'] : ['kind']); }
  }
  if (entries !== undefined) for (const access of ['read', 'write']) {
    const legacy = f[access]; if (legacy == null) continue;
    const projected = entries.filter(entry => entry.access === access && object(entry.path).type === 'path').map(entry => object(entry.path).path!);
    if (canonical([...(legacy as JsonValue[])].sort()) !== canonical(projected.sort())) throw new DeliveryError('guardian_action_unsupported', 'Native filesystem permission projections disagree');
  }
  return { entries: entries ?? ['read', 'write'].flatMap(access => (f[access] == null ? [] : f[access] as JsonValue[]).map(path => ({ path: { type: 'path', path }, access }))), ...(f.globScanMaxDepth != null ? { glob_scan_max_depth: f.globScanMaxDepth } : {}) };
}
function action(value: JsonValue): JsonObject {
  const a = object(value), source = a.source === 'unifiedExec' ? 'unified_exec' : a.source;
  switch (a.type) {
    case 'command': onlyKeys(a, ['type', 'source', 'command', 'cwd']); return { type: 'command', source: source!, command: a.command!, cwd: a.cwd! };
    case 'execve': onlyKeys(a, ['type', 'source', 'program', 'argv', 'cwd']); return { type: 'execve', source: source!, program: a.program!, argv: a.argv!, cwd: a.cwd! };
    case 'writeStdin': onlyKeys(a, ['type', 'approvalId', 'processId', 'stdin', 'cwd']); return { type: 'write_stdin', approval_id: a.approvalId!, process_id: a.processId!, stdin: a.stdin!, cwd: uri(a.cwd!) };
    case 'applyPatch': onlyKeys(a, ['type', 'cwd', 'files']); return { type: 'apply_patch', cwd: a.cwd!, files: a.files! };
    case 'networkAccess': onlyKeys(a, ['type', 'target', 'host', 'protocol', 'port']); return { type: 'network_access', target: a.target!, host: a.host!, protocol: a.protocol === 'socks5Tcp' ? 'socks5_tcp' : a.protocol === 'socks5Udp' ? 'socks5_udp' : a.protocol!, port: a.port! };
    case 'mcpToolCall': onlyKeys(a, ['type', 'server', 'toolName', 'connectorId', 'connectorName', 'toolTitle']); return { type: 'mcp_tool_call', server: a.server!, tool_name: a.toolName!, connector_id: a.connectorId!, connector_name: a.connectorName!, tool_title: a.toolTitle! };
    case 'requestPermissions': {
      onlyKeys(a, ['type', 'reason', 'permissions']); const p = object(a.permissions); onlyKeys(p, ['network', 'fileSystem']); let fs: JsonValue = null;
      if (p.network != null) onlyKeys(object(p.network), ['enabled']);
      if (p.fileSystem != null) fs = fileSystem(p.fileSystem);
      return { type: 'request_permissions', reason: a.reason ?? null, permissions: { network: p.network ?? null, file_system: fs } };
    }
    default: throw new DeliveryError('guardian_action_unsupported', 'This native guardian action has no verified retry adapter');
  }
}
export function guardianEvent(notification: JsonObject): JsonObject {
  jsonBytes(notification, 65536); validateOfficial('ItemGuardianApprovalReviewCompletedNotification', notification);
  onlyKeys(notification, ['threadId', 'turnId', 'startedAtMs', 'completedAtMs', 'reviewId', 'targetItemId', 'decisionSource', 'review', 'action']);
  const review = object(notification.review); onlyKeys(review, ['status', 'riskLevel', 'userAuthorization', 'rationale']);
  if (review.status !== 'denied') throw new DeliveryError('guardian_not_denied', 'Only explicit captured denials may be retried');
  return { id: notification.reviewId!, status: 'denied', action: action(notification.action!), target_item_id: notification.targetItemId!, turn_id: notification.turnId!, started_at_ms: notification.startedAtMs!, completed_at_ms: notification.completedAtMs!, risk_level: review.riskLevel!, user_authorization: review.userAuthorization!, rationale: review.rationale! };
}
/** Captured native denials are epoch-local capabilities, not editable assessments. */
export class Guardian {
  private entries = new Map<string, Denial>(); private identities = new EpochIdentities();
  private issues = new Map<string, { reviewId: string; reason: string }>();
  constructor(private host: Host) {}
  notification(method: string, params: JsonObject) {
    if (method === 'thread/deleted' && typeof params.threadId === 'string') { this.identities.forgetThread(params.threadId); this.issues.delete(params.threadId); }
    if (method === 'turn/started') { const turnId = object(params.turn).id; for (const [id, entry] of this.entries) if (entry.threadId === params.threadId && entry.notification.turnId !== turnId) this.entries.delete(id); return; }
    if (['thread/reverted', 'thread/closed', 'thread/deleted', 'thread/archived', 'thread/settings/updated'].includes(method) && typeof params.threadId === 'string') { this.invalidate(params.threadId); return; }
    if (method !== 'item/autoApprovalReview/completed' || object(params.review).status !== 'denied') return;
    // Invalid native lifecycle data still fails closed. Only the local retry
    // adapter's bounded representation may be omitted without killing the epoch.
    validateOfficial('ItemGuardianApprovalReviewCompletedNotification', params);
    const threadId = string(params.threadId, 'threadId', 256), reviewId = string(params.reviewId, 'reviewId', 256);
    let event: JsonObject;
    try { event = guardianEvent(params); }
    catch (error) {
      if (!(error instanceof DeliveryError) || !['capacity', 'guardian_action_unsupported'].includes(error.code)) throw error;
      for (const [id, row] of this.entries) if (row.threadId === threadId && row.reviewId === reviewId) this.entries.delete(id);
      if (this.issues.size >= 64 && !this.issues.has(threadId)) this.issues.delete(this.issues.keys().next().value!);
      this.issues.set(threadId, { reviewId, reason: error.code }); return;
    }
    const fingerprint = createHash('sha256').update(canonical(event)).digest('hex');
    const prior = this.identities.read(threadId, reviewId);
    if (prior !== undefined) {
      if (prior !== fingerprint) {
        for (const [id, row] of this.entries) if (row.threadId === threadId && row.reviewId === reviewId) this.entries.delete(id);
        if (this.issues.size >= 64 && !this.issues.has(threadId)) this.issues.delete(this.issues.keys().next().value!);
        this.issues.set(threadId, { reviewId, reason: 'guardian_identity_conflict' });
      }
      return;
    }
    this.identities.add(threadId, reviewId, fingerprint); this.prune();
    const thread = [...this.entries.values()].filter(entry => entry.threadId === threadId); if (thread.length >= 10) this.entries.delete(thread[0]!.approvalId);
    if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
    const now = Date.now(), approvalId = randomUUID(); this.entries.set(approvalId, { approvalId, threadId, reviewId, event, notification: structuredClone(params), createdAt: now, expiresAt: now + 600000, state: 'available' });
  }
  invalidate(threadId: string) { for (const [id, entry] of this.entries) if (entry.threadId === threadId) this.entries.delete(id); }
  invalidateAll() { this.entries.clear(); }
  private prune() { const now = Date.now(); for (const [id, entry] of this.entries) if (entry.expiresAt <= now && entry.state !== 'pending') this.entries.delete(id); }
  reset() { this.entries.clear(); this.identities.clear(); this.issues.clear(); }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    this.prune(); const threadId = string(params.threadId, 'threadId');
    if (method === 'thread/guardian/list') { onlyKeys(params, ['threadId']); return { data: [...this.entries.values()].filter(entry => entry.threadId === threadId).map(entry => ({ ...entry.notification, approvalId: entry.approvalId, createdAt: entry.createdAt, expiresAt: entry.expiresAt, state: entry.state })), captureExhausted: false, captureIssues: this.issues.has(threadId) ? [this.issues.get(threadId)!] : [] }; }
    onlyKeys(params, ['threadId', 'approvalId', 'confirm']); if (params.confirm !== true) throw new DeliveryError('confirmation_required', 'Explicitly approve one retry of this exact denied action');
    const entry = this.entries.get(string(params.approvalId, 'approvalId', 36)); if (!entry || entry.threadId !== threadId) throw new DeliveryError('not_found', 'This denial expired, changed context, or belongs to another runtime epoch');
    if (entry.state !== 'available') throw new DeliveryError('guardian_already_used', 'This retry authorization was already dispatched; read its original receipt');
    entry.state = 'pending';
    try {
      const result = await this.host.mutate({ method, params: { threadId, event: entry.event }, schema: 'ThreadApproveGuardianDeniedActionParams', responseSchema: 'ThreadApproveGuardianDeniedActionResponse', threadId, mode: 'idle', history: true, directInput: true, invalidateHistory: true,
        beforeWrite: () => { if (this.entries.get(entry.approvalId) !== entry || entry.expiresAt <= Date.now()) throw new DeliveryError('guardian_context_changed', 'The captured denial is no longer current'); }, project: () => ({ threadId, approvalId: entry.approvalId, registered: true }) }, context);
      entry.state = 'registered'; return result;
    } catch (error) { entry.state = error instanceof DeliveryError && error.delivery === 'not_sent' ? 'available' : 'unknown'; throw error; }
  }
}
