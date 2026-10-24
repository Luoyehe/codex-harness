import { describe, expect, it } from "vitest";
import { APPROVAL_RESPONSE_LIMITS as LIMITS, validateApprovalResponse } from "../src/approval-responses.js";
import type { CommandExecutionApprovalDecision } from "../../../protocol/v2/CommandExecutionApprovalDecision.js";
import type { PermissionsRequestApprovalResponse } from "../../../protocol/v2/PermissionsRequestApprovalResponse.js";

const command = "item/commandExecution/requestApproval";
const file = "item/fileChange/requestApproval";
const permission = "item/permissions/requestApproval";
const grant = (fileSystem: unknown) => ({ permissions: { fileSystem }, scope: "turn" });
const entry = (path: unknown, access: unknown = "read") => ({ path, access });
const special = (value: unknown) => ({ type: "special", value });
const exec = (value: unknown) => ({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: value } } });
const network = (value: unknown) => ({ decision: { applyNetworkPolicyAmendment: { network_policy_amendment: value } } });

describe("pinned approval response shapes", () => {
  it.each(["accept", "acceptForSession", "decline", "cancel"])("accepts %s for command and file approvals", (decision) => {
    expect(validateApprovalResponse(command, { decision })).toBeUndefined();
    expect(validateApprovalResponse(file, { decision })).toBeUndefined();
  });

  it("accepts both command amendment variants without rewriting their policy", () => {
    const decisions = [
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "", "--format=%s", "文件📁"] } },
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "*.example.test:443", action: "allow" } } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.test", action: "deny" } } },
    ] satisfies CommandExecutionApprovalDecision[];
    for (const decision of decisions) {
      const payload = { decision };
      const before = JSON.stringify(payload);
      expect(validateApprovalResponse(command, payload)).toBeUndefined();
      expect(JSON.stringify(payload)).toBe(before);
      expect(validateApprovalResponse(file, payload)).toBeTypeOf("string");
    }
  });

  it("accepts denial, every path variant and both permission scopes", () => {
    const fileSystem = {
      read: ["/workspace", "C:\\work", "file:///workspace"], write: [], globScanMaxDepth: 1,
      entries: [
        entry({ type: "path", path: "/workspace/file" }, "write"),
        entry({ type: "glob_pattern", pattern: "**/*.secret" }, "deny"),
        ...["root", "minimal", "tmpdir", "slash_tmp"].map(kind => entry(special({ kind }))),
        entry(special({ kind: "project_roots", subpath: "src" })),
        entry(special({ kind: "unknown", path: "future-location", subpath: null })),
      ],
    };
    const denial = { permissions: {}, scope: "turn" } satisfies PermissionsRequestApprovalResponse;
    expect(validateApprovalResponse(permission, denial)).toBeUndefined();
    for (const scope of ["turn", "session"]) {
      for (const strictAutoReview of [true, false]) {
        expect(validateApprovalResponse(permission, { permissions: { network: { enabled: true }, fileSystem }, scope, strictAutoReview })).toBeUndefined();
      }
    }
  });

  it("preserves Rust Option/default deserialization beyond the generated TS spelling", () => {
    for (const payload of [
      { permissions: {} }, // omitted scope defaults to turn
      { permissions: { network: null, fileSystem: null }, strictAutoReview: null },
      { permissions: { network: {}, fileSystem: {} } },
      { permissions: { network: { enabled: null }, fileSystem: { read: null, write: null, entries: null, globScanMaxDepth: null } } },
      grant({ entries: [entry(special({ kind: "project_roots" })), entry(special({ kind: "unknown", path: "legacy" }))] }),
      grant({ entries: [entry(special({ kind: "current_working_directory", subpath: null }))] }),
    ]) expect(validateApprovalResponse(permission, payload)).toBeUndefined();
  });

  it.each([command, file, permission])("rejects missing or non-object %s payloads", (method) => {
    for (const value of [undefined, null, {}, [], "accept", 1, true]) {
      expect(validateApprovalResponse(method, value), JSON.stringify(value)).toBeTypeOf("string");
    }
  });

  it("rejects unknown and malformed command/file decisions, including nested additions", () => {
    for (const payload of [
      { decision: null }, { decision: false }, { decision: "garbage" }, { decision: {} },
      { decision: "accept", extra: true }, { decision: ["accept"] },
      { decision: { acceptWithExecpolicyAmendment: null } },
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [], extra: true } } },
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] }, applyNetworkPolicyAmendment: {} } },
      exec(null), exec("git"), exec(["git", 1]), exec(new Array(1)), exec(["\uD800"]), exec(["\uDC00"]),
      network(null), network({ action: "allow" }), network({ host: "example", action: "accept" }),
      network({ host: ["example"], action: "allow" }), network({ host: "example", action: "deny", extra: true }),
    ]) {
      expect(validateApprovalResponse(command, payload), JSON.stringify(payload)).toBeTypeOf("string");
      expect(validateApprovalResponse(file, payload), JSON.stringify(payload)).toBeTypeOf("string");
    }
  });

  it("rejects malformed permission fields at every nested boundary", () => {
    for (const payload of [
      { permissions: null }, { permissions: [] }, { permissions: {}, scope: null },
      { permissions: {}, scope: "forever" }, { permissions: {}, strictAutoReview: "false" },
      { permissions: {}, extra: true }, { permissions: { extra: {} } },
      { permissions: { network: [] } }, { permissions: { network: { enabled: 1 } } },
      { permissions: { network: { enabled: true, hosts: [] } } },
      grant([]), grant({ read: "/root" }), grant({ write: [null] }), grant({ read: new Array(1) }), grant({ write: ["/bad\uD800"] }),
      grant({ entries: new Array(1) }), grant({ entries: {} }), grant({ arbitrary: true }),
      ...[0, -1, 1.5, NaN, Infinity, "2"].map(globScanMaxDepth => grant({ globScanMaxDepth })),
      grant({ entries: [null] }), grant({ entries: [entry({ type: "path", path: "/a" }, "execute")] }),
      grant({ entries: [{ ...entry({ type: "path", path: "/a" }), extra: true }] }),
      ...[
        { type: "future", path: "/a" }, { type: "path" }, { type: "path", path: ["/a"] },
        { type: "path", path: "/a", extra: true }, { type: "glob_pattern", pattern: 7 },
        special([]), special({ kind: "future" }), special({ kind: "root", subpath: "/a" }),
        special({ kind: "project_roots", subpath: [] }), special({ kind: "unknown", path: 4 }),
        special({ kind: "unknown", path: "/a", subpath: 4 }),
      ].map(path => grant({ entries: [entry(path)] })),
    ]) expect(validateApprovalResponse(permission, payload), JSON.stringify(payload)).toBeTypeOf("string");
  });

  it("bounds arrays, strings, scan depth and aggregate encoded bytes", () => {
    expect(validateApprovalResponse(command, exec(Array(LIMITS.commandParts).fill("x")))).toBeUndefined();
    expect(validateApprovalResponse(permission, grant({ read: Array(LIMITS.permissionEntries).fill("/a") }))).toBeUndefined();
    expect(validateApprovalResponse(permission, grant({ globScanMaxDepth: LIMITS.globScanMaxDepth }))).toBeUndefined();
    for (const [method, payload] of [
      [command, exec(Array(LIMITS.commandParts + 1).fill("x"))],
      [command, exec(["x".repeat(LIMITS.pathChars + 1)])],
      [command, network({ host: "x".repeat(LIMITS.hostChars + 1), action: "allow" })],
      [permission, grant({ read: Array(LIMITS.permissionEntries + 1).fill("/a") })],
      [permission, grant({ entries: Array(LIMITS.permissionEntries + 1).fill(entry({ type: "path", path: "/a" })) })],
      [permission, grant({ write: ["x".repeat(LIMITS.pathChars + 1)] })],
      [permission, grant({ entries: [entry(special({ kind: "unknown", path: "x".repeat(LIMITS.pathChars + 1) }))] })],
      [permission, grant({ globScanMaxDepth: LIMITS.globScanMaxDepth + 1 })],
      [command, exec(Array(100).fill("中".repeat(LIMITS.pathChars)))],
    ] as const) expect(validateApprovalResponse(method, payload)).toBeTypeOf("string");
  });

  it("does not evaluate getters or include submitted policy text in rejection diagnostics", () => {
    let read = false;
    const getter = { get decision() { read = true; return "accept"; } };
    expect(validateApprovalResponse(command, getter)).toBeTypeOf("string");
    expect(read).toBe(false);
    expect(validateApprovalResponse(command, { decision: "private-policy-value" })).not.toContain("private-policy-value");
  });
});
