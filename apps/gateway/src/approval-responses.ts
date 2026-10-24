import type { CommandExecutionApprovalDecision } from "../../../protocol/v2/CommandExecutionApprovalDecision.js";
import type { FileChangeApprovalDecision } from "../../../protocol/v2/FileChangeApprovalDecision.js";
import type { FileSystemAccessMode } from "../../../protocol/v2/FileSystemAccessMode.js";
import type { NetworkPolicyRuleAction } from "../../../protocol/v2/NetworkPolicyRuleAction.js";
import type { PermissionGrantScope } from "../../../protocol/v2/PermissionGrantScope.js";

const DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const satisfies readonly (CommandExecutionApprovalDecision & FileChangeApprovalDecision)[];
const ACCESS = ["read", "write", "deny"] as const satisfies readonly FileSystemAccessMode[];
const ACTIONS = ["allow", "deny"] as const satisfies readonly NetworkPolicyRuleAction[];
const SCOPES = ["turn", "session"] as const satisfies readonly PermissionGrantScope[];

// Match the browser's bounded approval context and the WebSocket answer cap.
// These limits bound interpretation; they do not authorize a path or policy.
export const APPROVAL_RESPONSE_LIMITS = {
  bytes: 1024 * 1024,
  pathChars: 4096,
  hostChars: 2048,
  commandParts: 500,
  permissionEntries: 1000,
  globScanMaxDepth: 1024,
} as const;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.keys(value).every((key) => keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
const member = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
// JSON.parse permits lone UTF-16 surrogates; Rust String deserialization does
// not. In Unicode mode this range matches only unpaired surrogate code points.
const text = (value: unknown, max: number = APPROVAL_RESPONSE_LIMITS.pathChars) =>
  typeof value === "string" && value.length <= max && !/[\uD800-\uDFFF]/u.test(value);
function list(value: unknown, max: number, check: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value) || value.length > max) return false;
  // for..of observes holes as undefined, unlike every(), which could approve
  // a sparse array that becomes invalid null entries during serialization.
  for (const item of value) if (!check(item)) return false;
  return true;
}

function specialPath(value: unknown): boolean {
  if (!record(value, ["kind", "path", "subpath"])) return false;
  if (member(value.kind, ["root", "minimal", "tmpdir", "slash_tmp"])) return record(value, ["kind"]);
  // The pinned Rust deserializer also accepts its legacy spelling.
  if (value.kind === "project_roots" || value.kind === "current_working_directory") {
    return record(value, ["kind", "subpath"]) && (value.subpath == null || text(value.subpath));
  }
  return value.kind === "unknown" && text(value.path) && (value.subpath == null || text(value.subpath));
}

function permissionPath(value: unknown): boolean {
  if (!record(value, ["type", "path", "pattern", "value"])) return false;
  if (value.type === "path") return record(value, ["type", "path"]) && text(value.path);
  if (value.type === "glob_pattern") return record(value, ["type", "pattern"]) && text(value.pattern);
  return value.type === "special" && record(value, ["type", "value"]) && specialPath(value.value);
}

function permissions(value: unknown): boolean {
  if (!record(value, ["network", "fileSystem"])) return false;
  const network = value.network;
  if (network != null && (!record(network, ["enabled"]) || network.enabled != null && typeof network.enabled !== "boolean")) return false;
  const fs = value.fileSystem;
  if (fs == null) return true;
  if (!record(fs, ["read", "write", "entries", "globScanMaxDepth"])) return false;
  for (const roots of [fs.read, fs.write]) {
    if (roots != null && !list(roots, APPROVAL_RESPONSE_LIMITS.permissionEntries, (root) => text(root))) return false;
  }
  if (fs.globScanMaxDepth != null && (typeof fs.globScanMaxDepth !== "number"
      || !Number.isSafeInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 1
      || fs.globScanMaxDepth > APPROVAL_RESPONSE_LIMITS.globScanMaxDepth)) return false;
  return fs.entries == null || list(fs.entries, APPROVAL_RESPONSE_LIMITS.permissionEntries, (entry) =>
    record(entry, ["path", "access"]) && member(entry.access, ACCESS) && permissionPath(entry.path));
}

function commandDecision(value: unknown): boolean {
  if (member(value, DECISIONS)) return true;
  if (!record(value, ["acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment"]) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, "acceptWithExecpolicyAmendment")) {
    const amendment = value.acceptWithExecpolicyAmendment;
    return record(amendment, ["execpolicy_amendment"])
      && list(amendment.execpolicy_amendment, APPROVAL_RESPONSE_LIMITS.commandParts, (part) => text(part));
  }
  const amendment = value.applyNetworkPolicyAmendment;
  if (!record(amendment, ["network_policy_amendment"])) return false;
  const rule = amendment.network_policy_amendment;
  return record(rule, ["host", "action"]) && text(rule.host, APPROVAL_RESPONSE_LIMITS.hostChars) && member(rule.action, ACTIONS);
}

/** Check only the pinned response wire shape, before consuming a prompt.
 * Rust 0.164's permissions.rs uses Option for nullable/missing permission
 * fields and strictAutoReview, and #[serde(default)] for omitted scope. The
 * generated TS declarations do not express all of these deserialization cases.
 * Keep path strings verbatim: Codex interprets paths and intersects grants with
 * the requested permissions in the originating environment's policy context. */
export function validateApprovalResponse(method: string, payload: unknown): string | undefined {
  let valid: boolean;
  switch (method) {
    case "item/commandExecution/requestApproval":
      valid = record(payload, ["decision"]) && commandDecision(payload.decision);
      break;
    case "item/fileChange/requestApproval":
      valid = record(payload, ["decision"]) && member(payload.decision, DECISIONS);
      break;
    case "item/permissions/requestApproval":
      valid = record(payload, ["permissions", "scope", "strictAutoReview"]) && permissions(payload.permissions)
        && (payload.scope === undefined || member(payload.scope, SCOPES))
        && (payload.strictAutoReview == null || typeof payload.strictAutoReview === "boolean");
      break;
    default: return undefined;
  }
  if (!valid) return "审批回答结构无效或超过字段限制，请修正后重试";
  try {
    if (Buffer.byteLength(JSON.stringify(payload)) <= APPROVAL_RESPONSE_LIMITS.bytes) return undefined;
  } catch { /* no submitted values are included in diagnostics */ }
  return "审批回答超过大小限制，请修正后重试";
}
