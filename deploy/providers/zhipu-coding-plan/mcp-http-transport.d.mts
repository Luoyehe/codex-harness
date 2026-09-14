export class RemoteHttpError extends Error { status: number; constructor(status: number); }
export class ResponseTooLargeError extends Error {}
export function isSupportedProtocolVersion(version: unknown): boolean;
export function isResponseFor(message: any, id: string | number): boolean;
export function postMcp(endpoint: string | URL, body: unknown, options: {
  token: string;
  session: { id: string; version: string };
  onMessage(message: any): boolean | void | Promise<boolean | void>;
  maxResponseBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string>;
