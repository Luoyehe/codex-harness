import { runWorkspace, workspaceMutations, workspaceRequest, type WorkspaceRoot } from './workspace.js';
import { WorkspaceWitness } from './workspace-witness.js';
import { indexMutations } from './workspace-index.js';
import type { LaunchConfig } from './native-launch.js';
import { DeliveryError, jsonBytes, object, type CallContext, type JsonObject, type JsonValue } from './types.js';

interface WorkspaceHost {
  config: LaunchConfig & { workerHome: string; nativeHome?: string };
  cwd(value: JsonValue | undefined): string;
  admit(): void;
  configure(operation: (boundary: () => void) => Promise<JsonValue>, context: CallContext): Promise<JsonValue>;
  pending(change: 1 | -1): void;
  uncertain(): void;
}

/** Owns workspace dispatch, private acceptance proofs and their acknowledgement lifecycle. */
export class RuntimeWorkspace {
  private store: WorkspaceWitness | undefined;
  private tasks = new Set<Promise<JsonValue>>();
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
    if (method === 'workspace/witness/read') return this.witness().read(params);
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
      await Promise.allSettled([...this.tasks]);
      return this.host.configure(boundary => this.track(execute(boundary)), context);
    }
    this.host.admit();
    this.host.pending(1);
    try { return await this.track(execute(() => { this.host.admit(); context.beforeWrite!(); })); }
    finally { this.host.pending(-1); }
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
