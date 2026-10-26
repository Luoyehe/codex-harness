export type JsonObject = Record<string, unknown>;
export type Project = { id: string; name: string; cwd: string };
export type Thread = {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
  status?: unknown;
  archived?: boolean;
  turns?: Turn[];
  parentThreadId?: string | null;
  canAcceptDirectInput?: boolean | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  projectId?: string | null;
  section?: {
    id: string;
    name: string;
    appearance?: { icon: string | null; color: string | null } | null;
  } | null;
};
export type Item = {
  id: string;
  type: string;
  streamComplete?: boolean;
  historySync?: {
    field: 'text' | 'aggregatedOutput' | 'reasoning';
    snapshot?: string;
    deltas: string;
  };
  [key: string]: unknown;
};
export type Turn = { id: string; status: string; items: Item[]; error?: unknown };
export type Model = {
  id: string;
  model?: string;
  displayName?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  inputModalities?: string[];
};
export type Options = {
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  sandbox?: string;
  personality?: string;
  mode?: 'plan' | 'default';
  environments?: string[];
};
export type HarnessEvent = { type: string; data: JsonObject };
export type PromptRecord = {
  promptId: string;
  method: string;
  params: JsonObject;
  epoch?: string;
  threadId?: string;
};
export const object = (v: unknown): JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
export const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const message = (e: unknown): string =>
  e instanceof Error ? e.message : '请求未完成，请重试读取状态。';
export const composing = (e: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
  keyCode?: number;
}) =>
  Boolean(
    e.isComposing ||
      e.keyCode === 229 ||
      e.nativeEvent?.isComposing ||
      e.nativeEvent?.keyCode === 229,
  );
export const safeUrl = (s: unknown): string | undefined => {
  try {
    const u = new URL(String(s));
    return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
};
