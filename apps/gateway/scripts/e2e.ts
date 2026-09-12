// Compatibility entry point: one isolated no-inference implementation.
// Paid end-to-end verification is deploy/verify-full.mjs and requires opt-in.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../../../scripts/gateway-smoke.mjs", import.meta.url));
const result = spawnSync(process.execPath, [script], { stdio: "inherit", windowsHide: true });
process.exitCode = result.status ?? 1;
