import type { CommandExecutionRequestApprovalParams } from "../../../protocol/v2/CommandExecutionRequestApprovalParams";
import type { NetworkApprovalProtocol } from "../../../protocol/v2/NetworkApprovalProtocol";

export const networkProtocols: NetworkApprovalProtocol[] = ["http", "https", "socks5Tcp", "socks5Udp"];

export function networkOnlyParams(command?: null, protocol: NetworkApprovalProtocol = "https"): CommandExecutionRequestApprovalParams {
  return {
    threadId: "T", turnId: "turn", itemId: "network", startedAtMs: 0, environmentId: null,
    ...(command === undefined ? {} : { command }),
    cwd: "/network-project", reason: "Fetch the requested resource",
    networkApprovalContext: { protocol, host: "api.example.test:8443" },
    proposedNetworkPolicyAmendments: [{ action: "allow", host: "api.example.test" }, { action: "deny", host: "blocked.example.test" }],
    proposedExecpolicyAmendment: ["curl", "--header", "X-Label: two words"],
  };
}

export const malformedNetworkApprovals: Array<[string, Record<string, unknown>]> = [
  ...[false, 0, [], {}, "", " ", "x".repeat(200_001)].map((command, index): [string, Record<string, unknown>] => [`invalid command ${index}`, { command }]),
  ...[undefined, null, false, [], {}, { protocol: "https" }, { host: "example.test" },
    { protocol: "futureProtocol", host: "example.test" }, { protocol: {}, host: "example.test" },
    { protocol: "https", host: {} }, { protocol: "https", host: "" }, { protocol: "https", host: " " },
    { protocol: "https", host: "x".repeat(2_049) }, { protocol: "https", host: "example.test", hiddenScope: "*" },
  ].map((networkApprovalContext, index): [string, Record<string, unknown>] => [`invalid network context ${index}`, { networkApprovalContext }]),
  ["invalid reason", { reason: {} }],
  ["oversized reason", { reason: "x".repeat(20_001) }],
  ["invalid cwd", { cwd: {} }],
  ["oversized cwd", { cwd: "x".repeat(4_097) }],
  ...[{}, [null], [{ action: "unknown", host: "example.test" }], [{ action: "allow", host: {} }],
    [{ action: "allow", host: " " }], [{ action: "allow", host: "x".repeat(2_049) }],
    [{ action: "allow", host: "example.test", hiddenScope: "*" }],
    Array.from({ length: 501 }, () => ({ action: "allow", host: "example.test" })),
  ].map((proposedNetworkPolicyAmendments, index): [string, Record<string, unknown>] => [`invalid network amendment ${index}`, { proposedNetworkPolicyAmendments }]),
  ...["not-an-array", [{}], ["x".repeat(4_097)], Array.from({ length: 501 }, () => "arg")]
    .map((proposedExecpolicyAmendment, index): [string, Record<string, unknown>] => [`invalid exec amendment ${index}`, { proposedExecpolicyAmendment }]),
];
