import { readFileSync } from "node:fs";

// src/ and dist/ are siblings of the package manifest. Keep the handshake and
// status response tied to the installed package, including future releases.
const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!manifest || typeof manifest !== "object" || !("version" in manifest)
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error("gateway package version is invalid");
}
export const GATEWAY_VERSION = manifest.version;
