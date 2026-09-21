import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthToken } from "../src/auth-token.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

const homes: string[] = [];
function fixture(): string {
  const home = fs.mkdtempSync(join(tmpdir(), "auth-token-concurrency-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32").each([0o640, 0o2600])("only tightens token permissions when needed (mode %i)", (looseMode) => {
  vi.stubEnv("GATEWAY_TOKEN", "");
  vi.stubEnv("GATEWAY_BOOTSTRAP_AUTH", "required");
  const home = fixture();
  const file = join(home, "gateway-token");
  const persisted = "b".repeat(64);
  fs.writeFileSync(file, persisted + "\n", { mode: 0o600 });
  const chmod = vi.spyOn(fs, "fchmodSync");

  expect(new AuthToken(home, 8410).token).toBe(persisted);
  expect(chmod).not.toHaveBeenCalled();

  fs.chmodSync(file, looseMode);
  expect(new AuthToken(home, 8410).token).toBe(persisted);
  expect(chmod).toHaveBeenCalledTimes(1);
  expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
  expect(new AuthToken(home, 8410).token).toBe(persisted);
  expect(chmod).toHaveBeenCalledTimes(1);
});

it("allows another constructor to read between the publisher's read and snapshot check", () => {
  vi.stubEnv("GATEWAY_TOKEN", "");
  vi.stubEnv("GATEWAY_BOOTSTRAP_AUTH", "required");
  const home = fixture();
  const read = fs.readSync;
  const chmod = vi.spyOn(fs, "fchmodSync");
  let concurrent: AuthToken | undefined;
  // Pause the publisher after reading its now-single-link token. The nested
  // constructor completes before the publisher checks that inode's ctime.
  vi.spyOn(fs, "readSync").mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    concurrent = new AuthToken(home, 8410);
    return count;
  });

  const publisher = new AuthToken(home, 8410);
  expect(concurrent?.token).toBe(publisher.token);
  expect(fs.readdirSync(home)).toEqual(["gateway-token"]);
  expect(fs.statSync(join(home, "gateway-token")).nlink).toBe(1);
  // Only the unpublished temporary inode needs a chmod; readers are inert.
  expect(chmod).toHaveBeenCalledTimes(process.platform === "win32" ? 0 : 1);
});
