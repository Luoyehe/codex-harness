import type { ServerNotification } from "../../../../protocol/ServerNotification";
import type { ServerRequest } from "../../../../protocol/ServerRequest";
import type { ThreadItem } from "../../../../protocol/v2/ThreadItem";
import type { ThreadReadResponse } from "../../../../protocol/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "../../../../protocol/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "../../../../protocol/v2/ThreadStartResponse";
import type { ThreadStartParams } from "../../../../protocol/v2/ThreadStartParams";
import type { ThreadListParams } from "../../../../protocol/v2/ThreadListParams";
import type { ThreadListResponse } from "../../../../protocol/v2/ThreadListResponse";
import type { TurnStartParams } from "../../../../protocol/v2/TurnStartParams";
import type { TurnStartResponse } from "../../../../protocol/v2/TurnStartResponse";
import type { GetAccountResponse } from "../../../../protocol/v2/GetAccountResponse";
import type { ModelListResponse } from "../../../../protocol/v2/ModelListResponse";
import type { ListMcpServerStatusResponse } from "../../../../protocol/v2/ListMcpServerStatusResponse";
import type { LoginAccountResponse } from "../../../../protocol/v2/LoginAccountResponse";

/** The gateway passes upstream notifications through, except approval IDs, and
 * adds these lifecycle events. Keep this boundary separate from UI state. */
export type GatewayNotification = Exclude<ServerNotification, { method: "serverRequest/resolved" }> |
  { method: "serverRequest/resolved"; params: { requestId?: string | number; serverRequestId?: string | number } } |
  { method: "appServer/stateChanged"; params: { state: string } } |
  { method: "thread/autoCompacting"; params: { threadId: string; usedTokens: number; windowTokens: number } } |
  { method: "thread/autoCompactFailed"; params: { threadId: string; error: string } } |
  { method: "displayPrefs/updated"; params: unknown } |
  { method: "terminal/allExited"; params: { reason?: string } } |
  { method: "terminal/exited"; params: { processId: string; exitCode: number | null; error?: string } };

type BrowserRequest<T> = T extends ServerRequest ? Omit<T, "id"> & { requestId: string | number } : never;
export type GatewayServerRequest = BrowserRequest<ServerRequest>;
export type ApprovalRequest = Extract<GatewayServerRequest, { method:
  "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval"
}>;

export interface Attachment {
  kind: "image" | "file";
  name: string;
  path: string;
  previewUrl?: string;
}

export type TimelineItem = (ThreadItem |
  { type: "localUserMessage"; id: string; text: string; attachments: Attachment[] } |
  { type: "errorItem"; id: string; message: string; willRetry: boolean; historyLoadError?: boolean } |
  { type: "compactionProgress"; id: string; message: string; status: "inProgress" | "completed" | "failed" }
) & { threadId?: string; streaming?: boolean; completed?: boolean };

/** Gateway-owned request shapes intentionally differ from raw app-server input. */
export interface ProtocolRpc {
  "thread/read": { params: { threadId: string; includeTurns?: boolean }; result: ThreadReadResponse };
  "thread/resume": { params: { threadId: string }; result: ThreadResumeResponse };
  "thread/start": { params: Pick<ThreadStartParams, "cwd" | "model" | "approvalPolicy">; result: ThreadStartResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "turn/start": { params: Pick<TurnStartParams, "threadId" | "model" | "approvalPolicy" | "effort"> & {
    text: string; attachments?: Attachment[]; sandbox?: "network" | "full" | null;
  }; result: TurnStartResponse };
  "account/read": { params: undefined; result: GetAccountResponse };
  "account/login/start": { params: { type: "chatgptDeviceCode" }; result: LoginAccountResponse };
  "model/list": { params: { limit?: number; cursor?: string }; result: ModelListResponse };
  "mcpServerStatus/list": { params: undefined; result: ListMcpServerStatusResponse };
}

export function unreachable(value: never): never {
  throw new Error(`Unhandled protocol variant: ${JSON.stringify(value)}`);
}
