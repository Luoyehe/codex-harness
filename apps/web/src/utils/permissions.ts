import type { RequestPermissionProfile } from "../../../../protocol/v2/RequestPermissionProfile";
import type { FileSystemPath } from "../../../../protocol/v2/FileSystemPath";
import { unreachable } from "../api/protocol";

function pathLabel(path: FileSystemPath): string {
  if (!path || typeof path !== "object") throw new Error();
  switch (path.type) {
    case "path":
      if (typeof path.path !== "string" || !path.path || Object.keys(path).some((key) => !["type", "path"].includes(key))) throw new Error();
      return path.path;
    case "glob_pattern":
      if (typeof path.pattern !== "string" || !path.pattern || Object.keys(path).some((key) => !["type", "pattern"].includes(key))) throw new Error();
      return `匹配 ${path.pattern}`;
    case "special": {
      if (Object.keys(path).some((key) => !["type", "value"].includes(key))) throw new Error();
      const value = path.value;
      if (!value || typeof value !== "object") throw new Error();
      const allowed = value.kind === "project_roots" ? ["kind", "subpath"] : value.kind === "unknown" ? ["kind", "path", "subpath"] : ["kind"];
      if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
      switch (value.kind) {
        case "root": return "整个文件系统";
        case "minimal": return "最小系统路径集";
        case "project_roots":
          if (value.subpath !== null && typeof value.subpath !== "string") throw new Error();
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
  try {
    if (!profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).some((key) => !["network", "fileSystem"].includes(key))) throw new Error();
    if (profile.network != null) {
      if (typeof profile.network !== "object" || Array.isArray(profile.network)) throw new Error();
      if (Object.keys(profile.network).some((key) => key !== "enabled") || (profile.network.enabled !== null && typeof profile.network.enabled !== "boolean")) throw new Error();
      if (profile.network.enabled !== null) rows.push(profile.network.enabled ? "网络访问：开启" : "网络访问：关闭");
    }
    const fs = profile.fileSystem;
    if (fs != null) {
      if (typeof fs !== "object" || Array.isArray(fs)) throw new Error();
      if (Object.keys(fs).some((key) => !["read", "write", "entries", "globScanMaxDepth"].includes(key))) throw new Error();
      for (const [paths, label] of [[fs.read, "额外读取"], [fs.write, "额外写入"]] as const) {
        if (paths != null && (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))) throw new Error();
        for (const path of paths ?? []) rows.push(`${label}: ${path}`);
      }
      if (fs.entries != null && !Array.isArray(fs.entries)) throw new Error();
      for (const entry of fs.entries ?? []) {
        if (!entry || !["read", "write", "deny"].includes(entry.access) || Object.keys(entry).some((key) => !["path", "access"].includes(key))) throw new Error();
        const label = pathLabel(entry.path);
        if (!label || (entry.path.type === "special" && entry.path.value.kind === "unknown")) throw new Error();
        rows.push(`${entry.access === "read" ? "读取" : entry.access === "write" ? "写入" : "禁止访问"}: ${label}`);
      }
      if (fs.globScanMaxDepth !== undefined) {
        if (!Number.isInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 0) throw new Error();
        rows.push(`路径匹配最大扫描深度: ${fs.globScanMaxDepth}`);
      }
    }
    if (!rows.length) rows.push("未请求额外文件系统/网络权限");
    return { rows, valid: true };
  } catch {
    return { rows: ["无法完整解释请求的权限，已禁用批准。请查看原始权限详情。"], valid: false };
  }
}
