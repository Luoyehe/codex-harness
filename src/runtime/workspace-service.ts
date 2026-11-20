import { runWorkspace, workspaceMutations, workspaceRequest, type WorkspaceRoot } from './workspace.js';
import { WorkspaceWitness } from './workspace-witness.js';
import { indexMutations } from './workspace-index.js';
import type { LaunchConfig } from './native-launch.js';
import { DeliveryError, jsonBytes, object, type CallContext, type JsonObject, type JsonValue } from './types.js';

interface WorkspaceHost {
  config: LaunchConfig & { workerHome: string; nativeHome?: string };
  cwd(value: JsonValue | undefined): string;
  admit(): void;
  repository(cwd: string, work: (check: () => void, identity?: string) => Promise<JsonValue>): Promise<JsonValue>;
  pending(change: 1 | -1): void;
  uncertain(): void;
}

/** Owns workspace dispatch, private acceptance proofs and their acknowledgement lifecycle. */
export class RuntimeWorkspace {
  private store: WorkspaceWitness | undefined;
  private tasks = new Set<Promise<JsonValue>>();
  private ordinaryWrites = new Map<Promise<JsonValue>, string>();
  get pendingWrites(): number { return this.ordinaryWrites.size; }
  constructor(private readonly host: WorkspaceHost) {}

  get pending(): number { return this.tasks.size; }
  private witness(): WorkspaceWitness {
    return this.store ??= new WorkspaceWitness(this.host.config.workerHome, this.host.config.nativeHome);
  }
  usage(): JsonObject { return this.witness().usage(); }
  private async track(task: Promise<JsonValue>): Promise<JsonValue> {
    this.tasks.add(task);
    try { return await task; } finally { this.tasks.delete(task); }
  }

  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'workspace/witness/read') {
      const store = this.witness(), current = object(store.read(params)), guard = { ...context, beforeWrite: () => {} };
      if (current.state === 'unknown' && current.method === 'workspace/worktree/retire') {
        return this.track(store.reconcileRetire(params,
          (root, operation) => runWorkspace(this.host.config, { path: root }, 'worktree/reconcile-retire-info', operation, guard, true),
          (body, operation) => runWorkspace(this.host.config, { path: String(body.root), worktreeBinding: object(body.binding), ...(typeof body.repositoryIdentity === 'string' ? { repositoryIdentity: body.repositoryIdentity } : {}) },
            'worktree/reconcile-retire', { ...object(body.params), ...operation }, guard, true)));
      }
      return this.track(store.reconcileCreate(params, (root, operationId, requestDigest) =>
        runWorkspace(this.host.config, { path: root }, 'worktree/reconcile-create', { operationId, requestDigest }, guard, true)));
    }
    if (method === 'workspace/witness/pending') return this.witness().pending(params);
    if (method === 'workspace/witness/ack') {
      return this.track(this.witness().acknowledge(params, async (root, operationId, requestDigest) => {
        const result = object(await runWorkspace(this.host.config, { path: root }, 'operation/ack', { operationId, requestDigest }, context, true));
        if (result.acknowledged !== true || result.operationId !== operationId) {
          throw new DeliveryError('invalid_native_response', 'Native receipt cleanup was not confirmed');
        }
      }));
    }
    if (!this.host.config.launcher) throw new DeliveryError('workspace_unsupported', 'Workspace tools require the native identity launcher');
    const { cwd, ...request } = params;
    const action = method.slice('workspace/'.length);
    const root: WorkspaceRoot = { path: this.host.cwd(cwd) };
    const worktree = action.startsWith('worktree/');
    if (worktree && !this.host.config.nativeHome) throw new DeliveryError('worktree_unavailable', 'Native home is required for managed worktrees');
    if (worktree && action !== 'worktree/create') root.worktreeBinding = this.witness().worktreeBinding(request.worktreeId, root.path);
    if (!workspaceMutations.has(action)) {
      const result = await runWorkspace(this.host.config, root, action, request, context);
      jsonBytes(result);
      return publicWorkspaceValue(result);
    }
    if (!context.beforeWrite) throw new DeliveryError('operation_required', 'Workspace mutations require the durable operation boundary');
    const execute = async (boundary: () => void): Promise<JsonValue> => {
      let sent = false;
      let acknowledged = false;
      const body = workspaceRequest(root, action, request, context);
      const witness = this.witness();
      try {
        const result = await runWorkspace(this.host.config, root, action, request, {
          ...context,
          beforeWrite: () => { boundary(); witness.reserve(method, body, context); sent = true; },
        });
        acknowledged = true;
        return witness.complete(method, body, result, context);
      } catch (error) {
        // A positive helper reply means the mutation may already exist. Local
        // result validation or proof storage cannot downgrade it to not_sent.
        const failure = acknowledged && (!(error instanceof DeliveryError) || error.delivery === 'not_sent')
          ? new DeliveryError('workspace_witness', 'Workspace acknowledgement could not be confirmed', 'unknown')
          : error instanceof DeliveryError ? error : new DeliveryError('workspace_witness', 'Workspace acknowledgement could not be confirmed', sent ? 'unknown' : 'not_sent');
        if (sent && failure.delivery === 'not_sent') witness.discardNotSent(method, body, context);
        if (failure.delivery === 'unknown') this.host.uncertain();
        throw failure;
      }
    };
    if (worktree || action === 'git/commit' || indexMutations.includes(action)) {
      const sameRoot = [...this.ordinaryWrites].filter(([, path]) => path === root.path);
      if (sameRoot.length) await Promise.allSettled(sameRoot.map(([task]) => task));
      this.host.admit();
      return this.host.repository(root.path, (check, identity) => {
        if (!identity) throw new DeliveryError('activity_unknown', '仓库身份尚未确认。');
        root.repositoryIdentity = identity;
        return this.track(execute(() => { this.host.admit(); check(); context.beforeWrite!(); }));
      });
    }
    this.host.admit();
    this.host.pending(1);
    const task = this.track(execute(() => { this.host.admit(); context.beforeWrite!(); }));
    this.ordinaryWrites.set(task, root.path);
    try { return await task; }
    finally { this.ordinaryWrites.delete(task); this.host.pending(-1); }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
    this.store?.close();
  }
}

// Native recovery records can nest worktree results. Private inode bindings must
// never leave the supervisor, including through workspace/operation/read.
function publicWorkspaceValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(publicWorkspaceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'binding').map(([key, item]) => [key, publicWorkspaceValue(item)]));
  }
  return value;
}
