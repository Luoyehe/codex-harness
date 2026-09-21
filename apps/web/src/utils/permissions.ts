import type { RequestPermissionProfile } from "../../../../protocol/v2/RequestPermissionProfile";
import type { FileSystemPath } from "../../../../protocol/v2/FileSystemPath";
import { unreachable, type ApprovalRequest, type TimelineItem } from "../api/protocol";

const MAX_PERMISSION_PATH_LENGTH = 4_096;
const MAX_PERMISSION_ROWS = 1_000;
export const MAX_APPROVAL_FILE_CHANGES = 50;
const MAX_APPROVAL_DIFF_CHARS = 2 * 1024 * 1024;

export interface ApprovalFileChange {
  path: string;
  kind?: { type: "add" | "delete" | "update"; move_path?: string | null };
  diff?: string;
}

export interface FileChangeApprovalContext {
  changes: ApprovalFileChange[];
  total: number;
  present: boolean;
  valid: boolean;
}

/** A file-change approval is a write authorization, so the browser must be
 * able to inspect the complete matching change list. Oversized lists fail
 * closed instead of validating only the visible prefix. */
export function normalizeApprovalChanges(value: unknown): Omit<FileChangeApprovalContext, "present"> {
  if (!Array.isArray(value)) return { changes: [], total: 0, valid: false };
  const changes: ApprovalFileChange[] = [];
  let valid = value.length > 0 && value.length <= MAX_APPROVAL_FILE_CHANGES;
  let diffChars = 0;
  const inspected = Math.min(value.length, MAX_APPROVAL_FILE_CHANGES);
  for (let index = 0; index < inspected; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      valid = false;
      changes.push({ path: "（变更条目格式无效）" });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const path = validPathText(entry.path) ? entry.path : null;
    const rawKind = entry.kind;
    const kindRecord = rawKind && typeof rawKind === "object" && !Array.isArray(rawKind)
      ? rawKind as Record<string, unknown> : null;
    const kindType = kindRecord?.type;
    const normalizedKind = kindType === "add" || kindType === "delete" || kindType === "update" ? kindType : null;
    const movePath = normalizedKind === "update" ? kindRecord?.move_path : undefined;
    const movePathValid = normalizedKind !== "update" || !!kindRecord &&
      Object.prototype.hasOwnProperty.call(kindRecord, "move_path") && (movePath === null || validPathText(movePath));
    const diff = typeof entry.diff === "string" ? entry.diff : null;
    if (diff) diffChars += diff.length;
    if (!path || !normalizedKind || !movePathValid || diff === null || diffChars > MAX_APPROVAL_DIFF_CHARS) valid = false;
    changes.push({
      path: path ?? "（路径格式无效）",
      ...(normalizedKind ? { kind: { type: normalizedKind, ...(normalizedKind === "update" && movePath != null ? { move_path: movePath as string } : {}) } } : {}),
      ...(diff !== null ? { diff } : {}),
    });
  }
  return { changes, total: value.length, valid };
}

/** Resolve a file-change approval only against the exact thread/item pair.
 * The record key is the authoritative thread owner; an optional stamped owner
 * or turn must agree as an additional defence against malformed runtime data. */
export function fileChangeApprovalContext(
  approval: ApprovalRequest,
  items: Record<string, TimelineItem[] | undefined> | undefined,
): FileChangeApprovalContext {
  if (approval.method !== "item/fileChange/requestApproval") {
    return { changes: [], total: 0, present: false, valid: false };
  }
  const raw = approval.params as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { changes: [], total: 0, present: false, valid: false };
  }
  const params = raw as Record<string, unknown>;
  const threadId = typeof params.threadId === "string" && params.threadId.length > 0 && params.threadId.length <= 256
    ? params.threadId : null;
  const itemId = typeof params.itemId === "string" && params.itemId.length > 0 && params.itemId.length <= 512
    ? params.itemId : null;
  const turnId = typeof params.turnId === "string" && params.turnId.length > 0 && params.turnId.length <= 512
    ? params.turnId : null;
  if (!threadId || !turnId || !itemId) return { changes: [], total: 0, present: false, valid: false };
  const item = items?.[threadId]?.find((candidate) => candidate?.id === itemId && candidate.type === "fileChange");
  if (!item || item.type !== "fileChange") return { changes: [], total: 0, present: false, valid: false };
  const ownerValid = item.threadId == null || item.threadId === threadId;
  const turnValid = item.turnId === turnId;
  const statusValid = item.status === "inProgress";
  const normalized = normalizeApprovalChanges(item.changes);
  return { ...normalized, present: true, valid: ownerValid && turnValid && statusValid && normalized.valid };
}

function validPathText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PERMISSION_PATH_LENGTH;
}

function hasOnlyDataKeys(value: object, allowed: readonly string[]): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || !allowed.includes(key) || ++count > allowed.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function pathLabel(path: FileSystemPath): string {
  if (!path || typeof path !== "object") throw new Error();
  switch (path.type) {
    case "path":
      if (!validPathText(path.path) || !hasOnlyDataKeys(path, ["type", "path"])) throw new Error();
      return path.path;
    case "glob_pattern":
      if (!validPathText(path.pattern) || !hasOnlyDataKeys(path, ["type", "pattern"])) throw new Error();
      return `匹配 ${path.pattern}`;
    case "special": {
      if (!hasOnlyDataKeys(path, ["type", "value"])) throw new Error();
      const value = path.value;
      if (!value || typeof value !== "object") throw new Error();
      const allowed = value.kind === "project_roots" ? ["kind", "subpath"] : value.kind === "unknown" ? ["kind", "path", "subpath"] : ["kind"];
      if (!hasOnlyDataKeys(value, allowed)) throw new Error();
      switch (value.kind) {
        case "root": return "整个文件系统";
        case "minimal": return "最小系统路径集";
        case "project_roots":
          if (value.subpath !== null && !validPathText(value.subpath)) throw new Error();
          return `全部项目根目录${value.subpath ? ` / ${value.subpath}` : ""}`;
        case "tmpdir": return "系统临时目录";
        case "slash_tmp": return "/tmp";
        case "unknown": return `无法识别的特殊路径: ${value.path}`;
        default: return unreachable(value);
      }
    }
    default: return unreachable(path);
  }
}

/** Fail closed for unknown runtime structures: typed contracts also need an
 * explicit UI fallback if a newer server sends an unfamiliar permission. */
export function describePermissions(profile: RequestPermissionProfile): { rows: string[]; valid: boolean } {
  const rows: string[] = [];
  const add = (row: string) => {
    if (rows.length >= MAX_PERMISSION_ROWS) throw new Error();
    rows.push(row);
  };
  try {
    if (!profile || typeof profile !== "object" || Array.isArray(profile) || !hasOnlyDataKeys(profile, ["network", "fileSystem"])) throw new Error();
    if (profile.network != null) {
      if (typeof profile.network !== "object" || Array.isArray(profile.network)) throw new Error();
      if (!hasOnlyDataKeys(profile.network, ["enabled"]) || (profile.network.enabled !== null && typeof profile.network.enabled !== "boolean")) throw new Error();
      if (profile.network.enabled !== null) add(profile.network.enabled ? "网络访问：开启" : "网络访问：关闭");
    }
    const fs = profile.fileSystem;
    if (fs != null) {
      if (typeof fs !== "object" || Array.isArray(fs)) throw new Error();
      if (!hasOnlyDataKeys(fs, ["read", "write", "entries", "globScanMaxDepth"])) throw new Error();
      for (const [paths, label] of [[fs.read, "额外读取"], [fs.write, "额外写入"]] as const) {
        if (paths != null && !Array.isArray(paths)) throw new Error();
        if ((paths?.length ?? 0) > MAX_PERMISSION_ROWS) throw new Error();
        for (const path of paths ?? []) {
          if (!validPathText(path)) throw new Error();
          add(`${label}: ${path}`);
        }
      }
      if (fs.entries != null && !Array.isArray(fs.entries)) throw new Error();
      if ((fs.entries?.length ?? 0) > MAX_PERMISSION_ROWS) throw new Error();
      for (const entry of fs.entries ?? []) {
        if (!entry || !["read", "write", "deny"].includes(entry.access) || !hasOnlyDataKeys(entry, ["path", "access"])) throw new Error();
        const label = pathLabel(entry.path);
        if (!label || (entry.path.type === "special" && entry.path.value.kind === "unknown")) throw new Error();
        add(`${entry.access === "read" ? "读取" : entry.access === "write" ? "写入" : "禁止访问"}: ${label}`);
      }
      if (fs.globScanMaxDepth !== undefined) {
        if (!Number.isInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 0 || fs.globScanMaxDepth > 1_024) throw new Error();
        add(`路径匹配最大扫描深度: ${fs.globScanMaxDepth}`);
      }
    }
    if (!rows.length) add("未请求额外文件系统/网络权限");
    return { rows, valid: true };
  } catch {
    return { rows: ["无法完整解释请求的权限，已禁用批准。请查看原始权限详情。"], valid: false };
  }
}

function optionalApprovalText(params: Record<string, unknown>, key: string, max: number): boolean {
  const value = params[key];
  return value == null || typeof value === "string" && value.length <= max;
}

/** Approval responses are writes. Enforce the same runtime contract in the
 * store as in the UI so a stale callback or direct caller cannot bypass a
 * disabled button and approve context the browser could not show faithfully. */
export function approvalCanAccept(
  approval: ApprovalRequest,
  items?: Record<string, TimelineItem[] | undefined>,
): boolean {
  const raw: unknown = approval?.params;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const params = raw as Record<string, unknown>;
  if (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 256) return false;
  if (!optionalApprovalText(params, "reason", 20_000) || !optionalApprovalText(params, "cwd", 4_096)) return false;
  if (approval.method === "item/permissions/requestApproval") {
    return describePermissions(params.permissions as RequestPermissionProfile).valid;
  }
  if (approval.method === "item/fileChange/requestApproval") {
    return optionalApprovalText(params, "grantRoot", 4_096) && fileChangeApprovalContext(approval, items).valid;
  }
  if (typeof params.command !== "string" || params.command.length > 200_000) return false;
  const network = params.networkApprovalContext;
  if (network != null) {
    if (!network || typeof network !== "object" || Array.isArray(network)) return false;
    const context = network as Record<string, unknown>;
    if (typeof context.protocol !== "string" || !new Set(["http", "https", "socks5Tcp", "socks5Udp"]).has(context.protocol) ||
        !validPathText(context.host) || (context.host as string).length > 2_048) return false;
  }
  const networkRules = params.proposedNetworkPolicyAmendments;
  if (networkRules != null && (!Array.isArray(networkRules) || networkRules.length > 500 || networkRules.some((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return true;
    const record = rule as Record<string, unknown>;
    return (record.action !== "allow" && record.action !== "deny") ||
      typeof record.host !== "string" || !record.host || record.host.length > 2_048;
  }))) return false;
  const execRule = params.proposedExecpolicyAmendment;
  return execRule == null || Array.isArray(execRule) && execRule.length <= 500 &&
    execRule.every((part) => typeof part === "string" && part.length <= 4_096);
}
