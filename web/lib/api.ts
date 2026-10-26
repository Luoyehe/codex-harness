import { uuid } from './ids';
import {
  acknowledgeOperation,
  checkedTerminalResult,
  createOperation,
  isArchivedReceipt,
  reconcileOperation,
  updateOperation,
  type TerminalOwner,
  type TerminalResult,
} from './operations';
import { message, object } from './types';
import { readDraft } from './drafts';
import { INPUT_METHODS } from './workflows';
import { parseOutputSchema, referenceInput } from './input-context';

export class RpcError extends Error {
  constructor(
    message: string,
    public code: string,
    public delivery?: string,
    public operationId?: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export type Session = {
  authenticated: boolean;
  authenticationMode?: 'account';
  initialized?: boolean;
  setupRequired?: boolean;
  username?: string;
  csrf?: string;
  clientId?: string;
  operationGeneration?: number;
};
export type LoginCredentials = {
  username: string;
  password: string;
  otp?: string;
  remember?: boolean;
};
export type AccountSecurity = {
  revision: string;
  username: string;
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
  sessions: {
    id: string;
    label: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    current: boolean;
  }[];
};
export type AccountAction =
  | 'password'
  | 'sessions/revoke'
  | 'totp/start'
  | 'totp/confirm'
  | 'totp/disable'
  | 'totp/recovery';
export type TerminalOperation = TerminalOwner & {
  operationId: string;
  projectId: string;
  program?: 'shell' | 'codex' | 'codex-cloud';
};
export type TerminalRecovery =
  | { state: 'accepted'; result: TerminalResult }
  | { state: 'not_sent' }
  | { state: 'unresolved' };
export class Api {
  csrf = '';
  operationGeneration = 0;
  observeOperationGeneration(value: unknown) {
    if (
      Number.isSafeInteger(value) &&
      Number(value) >= this.operationGeneration &&
      Number(value) <= 0xffffffffffff
    )
      this.operationGeneration = Number(value);
  }
  externalAuthenticationRequired = false;
  private sessionGeneration = 0;
  private authenticationLost = new Set<(external: boolean) => void>();
  clientId: string;
  constructor() {
    // A document gets its own identity, including a tab duplicated by the browser.
    this.clientId = uuid();
  }
  onAuthenticationLost(listener: (external: boolean) => void) {
    this.authenticationLost.add(listener);
    return () => {
      this.authenticationLost.delete(listener);
    };
  }
  private loseAuthentication(expectedCsrf: string, external = false) {
    if (
      this.csrf !== expectedCsrf ||
      (!expectedCsrf && this.externalAuthenticationRequired === external)
    )
      return;
    this.csrf = '';
    this.externalAuthenticationRequired = external;
    this.sessionGeneration++;
    this.authenticationLost.forEach((listener) => listener(external));
  }
  private async authenticationError(
    response: Response,
    csrf: string,
    generation: number,
    operationId?: string,
  ): Promise<RpcError> {
    let body: Record<string, unknown> = {};
    try {
      body = object(await response.json());
    } catch {
      /* A proxy can return an empty/non-JSON 401. */
    }
    const external = object(body.error).code !== 'unauthorized';
    if (generation === this.sessionGeneration) this.loseAuthentication(csrf, external);
    return new RpcError(
      external
        ? '站点访问认证已失效。请完成访问认证后重新检查登录，草稿和操作记录仍保留。'
        : '登录已失效，请重新登录。草稿和操作恢复记录仍保留。',
      external ? 'access_authentication_required' : 'unauthorized',
      object(body.error).delivery === 'unknown' ? 'unknown' : 'not_sent',
      operationId,
    );
  }
  async session(credentials?: LoginCredentials): Promise<Session> {
    return this.readSession('/api/session', credentials);
  }
  async setupAccount(credentials: { token: string; username: string; password: string }): Promise<Session> {
    return this.readSession('/api/account/setup', credentials);
  }
  private async readSession(
    endpoint: string,
    credentials?: LoginCredentials | { token: string; username: string; password: string },
  ): Promise<Session> {
    const generation = credentials === undefined ? this.sessionGeneration : ++this.sessionGeneration,
      previousCsrf = this.csrf;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: credentials === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: this.headers(),
        ...(credentials === undefined ? {} : { body: JSON.stringify(credentials) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new RpcError('暂时无法确认登录状态，请重新检查账号状态。', 'transport_error', credentials ? 'unknown' : undefined);
    }
    if (!response.ok) {
      let error: Record<string, unknown> = {};
      try { error = object(object(await response.json()).error); } catch { /* Proxy response. */ }
      if (error.delivery === 'unknown')
        throw new RpcError(
          '登录操作结果尚未确认，请先重新检查账号状态。',
          String(error.code ?? response.status), 'unknown',
        );
      if (credentials !== undefined && ['unauthorized', 'mfa_required'].includes(String(error.code)))
        throw new RpcError(
          error.code === 'mfa_required' ? '请输入验证器验证码或恢复码。' : '登录信息不正确，请核对后重试。',
          String(error.code), 'not_sent',
        );
      if (response.status === 401) {
        const external = error.code !== 'unauthorized';
        if (generation === this.sessionGeneration) this.loseAuthentication(previousCsrf, external);
        throw new RpcError(
          external ? '站点访问认证已失效。请完成访问认证后重新检查登录。' : '登录已失效，请重新登录。',
          external ? 'access_authentication_required' : 'unauthorized', 'not_sent',
        );
      }
      throw new RpcError(
        typeof error.message === 'string' ? error.message : `登录服务暂不可用（${response.status}）。`,
        String(error.code ?? response.status), response.status >= 500 ? 'unknown' : 'not_sent',
      );
    }
    let session: Session;
    try {
      session = (await response.json()) as Session;
      if (typeof session?.authenticated !== 'boolean' || (session.authenticated && !session.csrf)) throw new Error();
    } catch { throw new RpcError('登录状态无法确认，请重新检查账号状态。', 'invalid_response', credentials ? 'unknown' : undefined); }
    if (credentials && generation !== this.sessionGeneration)
      throw new RpcError('登录请求已过期，请重新检查账号状态。', 'stale_session', 'unknown');
    if (generation === this.sessionGeneration) {
      if (session.authenticated) {
        this.csrf = session.csrf ?? '';
        this.observeOperationGeneration(session.operationGeneration);
        this.externalAuthenticationRequired = false;
      } else this.loseAuthentication(previousCsrf);
    }
    return session;
  }
  /** Account secrets never enter the durable business-operation journal or browser storage. */
  async account<T = AccountSecurity>(action?: AccountAction, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const csrf = this.csrf, generation = this.sessionGeneration;
    let response: Response;
    try {
      response = await fetch(action ? `/api/account/${action}` : '/api/account', {
        method: action ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: this.headers(),
        ...(action ? { body: JSON.stringify(params ?? {}) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
    } catch {
      throw new RpcError(action ? '未收到安全设置操作结果。请先重新读取状态，不要直接重复操作。' : '暂时无法读取账号安全状态。', 'transport_error', action ? 'unknown' : undefined);
    }
    if (response.status === 401) throw await this.authenticationError(response, csrf, generation);
    let body: Record<string, unknown>;
    try { body = object(await response.json()); }
    catch { throw new RpcError('账号服务返回了无法确认的结果，请重新读取状态。', 'invalid_response', action ? 'unknown' : undefined); }
    if (!response.ok) {
      const error = object(body.error);
      throw new RpcError(String(error.message ?? '账号安全操作失败。'), String(error.code ?? response.status), error.delivery === 'unknown' || response.status >= 500 ? 'unknown' : 'not_sent');
    }
    if (generation !== this.sessionGeneration || csrf !== this.csrf)
      throw new RpcError('登录身份已变化，请重新读取账号状态。', 'stale_session', action ? 'unknown' : undefined);
    if (body.authenticated === false) this.loseAuthentication(csrf);
    return body as T;
  }
  async logout() {
    const csrf = this.csrf,
      generation = this.sessionGeneration;
    const r = await fetch('/api/session', {
      method: 'DELETE',
      headers: this.headers(),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) {
      const error = await this.authenticationError(r, csrf, generation);
      if (error.code === 'access_authentication_required') throw error;
      return;
    }
    if (!r.ok) throw new Error('退出失败，请重试。');
    this.loseAuthentication(csrf);
  }
  headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Harness-CSRF': this.csrf,
      'X-Harness-Client': this.clientId,
    };
  }
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<T> {
    const csrf = this.csrf,
      generation = this.sessionGeneration;
    const timeout = [
      'import/apply',
      'workspace/worktree/create',
      'workspace/worktree/attach',
      'workspace/worktree/archive',
      'workspace/worktree/restore',
      'workspace/git/commit',
    ].includes(method)
      ? 110_000
      : 30_000;
    const r = await fetch('/api/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.headers(),
      body: JSON.stringify({ method, params, ...(operationId ? { operationId } : {}) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
    if (r.status === 401) throw await this.authenticationError(r, csrf, generation, operationId);
    const body = object(await r.json());
    if (body.ok !== true) {
      const error = object(body.error);
      throw new RpcError(
        String(error.message ?? `请求失败（${r.status}）`),
        String(error.code ?? r.status),
        typeof error.delivery === 'string' ? error.delivery : undefined,
        operationId,
        object(error.data),
      );
    }
    if (
      generation === this.sessionGeneration &&
      ['system/status', 'operation/maintenance/rotate'].includes(method)
    )
      this.observeOperationGeneration(
        object(body.result)[method === 'system/status' ? 'operationGeneration' : 'generation'],
      );
    return body.result as T;
  }
  /** Keep creation identity before dispatch; recovery reads that identity and never repeats open. */
  openTerminal(
    params: {
      projectId: string;
      rows: number;
      cols: number;
      program?: 'shell' | 'codex' | 'codex-cloud';
    },
    connectionId: string,
  ): { operation: TerminalOperation; result: Promise<TerminalResult> } {
    const owner = { clientId: this.clientId, connectionId };
    const saved = createOperation(
      'terminal/open',
      {
        projectId: params.projectId,
        terminalOwner: owner,
      },
      localStorage,
      this.operationGeneration,
    );
    const operation = {
      ...owner,
      projectId: params.projectId,
      operationId: saved.id,
      ...(params.program ? { program: params.program } : {}),
    };
    const result = this.call('terminal/open', params, undefined, saved.id)
      .then((value) => {
        const terminal = checkedTerminalResult(value);
        updateOperation(saved.id, 'accepted', undefined, localStorage, terminal);
        return terminal;
      })
      .catch((error) => {
        try {
          updateOperation(
            saved.id,
            error instanceof RpcError && error.delivery === 'not_sent' ? 'not_sent' : 'unknown',
          );
        } catch {
          /* The pre-dispatch identity still permits read-only recovery. */
        }
        throw error;
      });
    return { operation, result };
  }
  async recoverTerminal(
    operation: TerminalOperation,
    connectionId: string,
  ): Promise<TerminalRecovery> {
    if (operation.clientId !== this.clientId || operation.connectionId !== connectionId)
      throw new Error('终端属于已结束的连接，不能在当前连接恢复。');
    const receipt = await this.call('operation/read', { operationId: operation.operationId });
    if (
      receipt.operationId !== operation.operationId ||
      (receipt.state !== 'not_received' &&
        receipt.method !== 'terminal/open' &&
        !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
        !isArchivedReceipt(receipt))
    )
      throw new Error('终端回执身份不匹配。');
    if (receipt.state === 'accepted') {
      const result = checkedTerminalResult(receipt.result);
      reconcileOperation(operation.operationId, receipt);
      return { state: 'accepted', result };
    }
    reconcileOperation(operation.operationId, receipt);
    return receipt.state === 'not_sent' ? { state: 'not_sent' } : { state: 'unresolved' };
  }
  async mutate<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.beginMutation<T>(method, params).result;
  }
  /** Expose the already persisted identity to editors that retain their write intent. */
  beginMutation<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    prepare?: (operationId: string) => void,
  ): { operationId: string; result: Promise<T> } {
    const resourceId =
      params.promptId ??
      params.terminalId ??
      params.attachmentId ??
      params.queuedSubmissionId ??
      params.subscriptionId ??
      params.resultId ??
      (method.startsWith('workspace/') ? params.path : undefined);
    if (
      ['turn/steer', 'thread/queue/add'].includes(method) &&
      params.clientUserMessageId === undefined
    )
      params = { ...params, clientUserMessageId: uuid() };
    let draftScope = {};
    if (INPUT_METHODS.includes(method)) {
      const key =
          method === 'conversation/start'
            ? `new:${String(params.projectId)}`
            : String(params.threadId),
        draft = readDraft(key);
      let schemaMatches = false;
      try {
        schemaMatches =
          JSON.stringify(parseOutputSchema(draft.outputSchema)) ===
          JSON.stringify(object(params.options).outputSchema);
      } catch {
        /* An invalid unsent schema must never be cleared by an unrelated write. */
      }
      if (
        draft.text === params.text &&
        JSON.stringify(draft.references.map(referenceInput)) ===
          JSON.stringify(params.references ?? []) &&
        JSON.stringify(draft.extraContext) === JSON.stringify(params.extraContext ?? []) &&
        JSON.stringify(draft.attachments.map((attachment) => attachment.attachmentId)) ===
          JSON.stringify(params.attachmentIds ?? []) &&
        schemaMatches
      )
        draftScope = { draftKey: key, draftRevision: draft.revision };
    }
    const op = createOperation(
      method,
      {
        ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
        ...(typeof params.projectId === 'string' ? { projectId: params.projectId } : {}),
        ...(typeof resourceId === 'string' ? { resourceId } : {}),
        ...draftScope,
      },
      localStorage,
      this.operationGeneration,
    );
    try {
      prepare?.(op.id);
    } catch (e) {
      updateOperation(op.id, 'not_sent');
      throw new RpcError(message(e), 'local_intent_failed', 'not_sent', op.id);
    }
    const dispatch = async () => {
      let result: T;
      try {
        result = await this.call<T>(method, params, undefined, op.id);
      } catch (e) {
        try {
          updateOperation(
            op.id,
            e instanceof RpcError && e.delivery === 'not_sent' ? 'not_sent' : 'unknown',
            e instanceof RpcError && typeof e.data?.threadId === 'string'
              ? e.data.threadId
              : undefined,
          );
        } catch {
          /* The pre-dispatch record remains recoverable. */
        }
        throw e instanceof RpcError
          ? e
          : new RpcError(message(e), 'transport_error', 'unknown', op.id);
      }
      const thread = object(object(result).thread);
      updateOperation(op.id, 'accepted', typeof thread.id === 'string' ? thread.id : undefined);
      if (![...INPUT_METHODS, 'thread/fork', 'review/startNew'].includes(method))
        acknowledgeOperation(op.id);
      return result;
    };
    return { operationId: op.id, result: dispatch() };
  }
}
