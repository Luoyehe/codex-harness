/** Handwritten adapters consume the pinned generated protocol through types.
 * No generated module is imported at runtime. Keep the wire transport generic;
 * requests made by gateway features are checked here against actual methods. */
import type { ClientRequest } from "../../../protocol/ClientRequest.js";
import type { ServerNotification } from "../../../protocol/ServerNotification.js";
import type { GetAccountResponse } from "../../../protocol/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../../../protocol/v2/LoginAccountResponse.js";
import type { ModelListResponse } from "../../../protocol/v2/ModelListResponse.js";
import type { ThreadListResponse } from "../../../protocol/v2/ThreadListResponse.js";
import type { ThreadStartResponse } from "../../../protocol/v2/ThreadStartResponse.js";
import type { ThreadResumeResponse } from "../../../protocol/v2/ThreadResumeResponse.js";
import type { ThreadReadResponse } from "../../../protocol/v2/ThreadReadResponse.js";
import type { TurnStartResponse } from "../../../protocol/v2/TurnStartResponse.js";
import type { CommandExecResponse } from "../../../protocol/v2/CommandExecResponse.js";
import type { FsReadDirectoryResponse } from "../../../protocol/v2/FsReadDirectoryResponse.js";
import type { ListMcpServerStatusResponse } from "../../../protocol/v2/ListMcpServerStatusResponse.js";

export type RequestMethod = ClientRequest["method"];
export type RequestParams<M extends RequestMethod> = Extract<ClientRequest, { method: M }>["params"];
interface Responses {
  "account/read": GetAccountResponse;
  "account/login/start": LoginAccountResponse;
  "model/list": ModelListResponse;
  "thread/list": ThreadListResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/read": ThreadReadResponse;
  "turn/start": TurnStartResponse;
  "command/exec": CommandExecResponse;
  "fs/readDirectory": FsReadDirectoryResponse;
  "mcpServerStatus/list": ListMcpServerStatusResponse;
}
export type ResponseFor<M extends RequestMethod> = M extends keyof Responses ? Responses[M] : unknown;

type ObservedMethod =
  | "turn/started" | "turn/completed" | "error" | "item/completed"
  | "thread/tokenUsage/updated" | "thread/compacted" | "thread/status/changed"
  | "thread/archived" | "thread/deleted" | "thread/closed" | "serverRequest/resolved";
export type ObservedNotification = Extract<ServerNotification, { method: ObservedMethod }>;
const OBSERVED = new Set<ObservedMethod>([
  "turn/started", "turn/completed", "error", "item/completed", "thread/tokenUsage/updated",
  "thread/compacted", "thread/status/changed", "thread/archived", "thread/deleted", "thread/closed",
  "serverRequest/resolved",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const activityId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
const validThreadStatus = (value: unknown): boolean => {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "active") {
    if (Object.keys(value).some((key) => key !== "type" && key !== "activeFlags")
        || !Array.isArray(value.activeFlags) || value.activeFlags.length > 2) return false;
    const flags = new Set<string>();
    for (const flag of value.activeFlags) {
      if (!["waitingOnApproval", "waitingOnUserInput"].includes(flag as string) || flags.has(flag as string)) return false;
      flags.add(flag as string);
    }
    return true;
  }
  return ["notLoaded", "idle", "systemError"].includes(value.type)
    && Object.keys(value).every((key) => key === "type");
};

/** Minimal shape checks at the untrusted JSON boundary. Beyond this function,
 * consumers use the generated discriminated union, never any-shaped params.
 * Unknown notifications are still forwarded to browsers but not interpreted. */
export function observedNotification(method: string, params: unknown): ObservedNotification | null {
  if (!OBSERVED.has(method as ObservedMethod) || !record(params) || !activityId(params.threadId)) return null;
  if ((method === "turn/started" || method === "turn/completed") && (!record(params.turn) || !activityId(params.turn.id))) return null;
  if (method === "error" && (!activityId(params.turnId) || typeof params.willRetry !== "boolean")) return null;
  if (method === "item/completed" && (!activityId(params.turnId) || !record(params.item)
      || typeof params.item.type !== "string" || params.item.type.length === 0 || params.item.type.length > 128)) return null;
  if (method === "thread/tokenUsage/updated" && !record(params.tokenUsage)) return null;
  if (method === "thread/status/changed" && !validThreadStatus(params.status)) return null;
  if (method === "serverRequest/resolved" && !(activityId(params.requestId)
      || typeof params.requestId === "number" && Number.isSafeInteger(params.requestId))) return null;
  return { method, params } as ObservedNotification;
}
