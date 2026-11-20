/** Per-call transport envelopes. Only the worker reads effective tool configuration. */
export const MANUAL_MCP_DEFAULT_SECONDS = 300;
export const MANUAL_MCP_MAX_SECONDS = 30 * 60;
export const MANUAL_MCP_REPLY_GRACE_MS = 20_000;
export const MANUAL_MCP_WORKER_WAIT_MS = MANUAL_MCP_MAX_SECONDS * 1000 + MANUAL_MCP_REPLY_GRACE_MS + 120_000;
export const MANUAL_MCP_BROWSER_WAIT_MS = MANUAL_MCP_WORKER_WAIT_MS + 10_000;
