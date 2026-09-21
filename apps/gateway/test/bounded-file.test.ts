import { afterEach, expect, it } from "vitest";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBoundedRegularTextFileSync } from "../src/bounded-file.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "gateway-bounded-file-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("reads only a singly-linked regular file within the explicit byte limit", () => {
  const root = fixture();
  const file = path.join(root, "metadata.json");
  writeFileSync(file, "fixture");
  expect(readBoundedRegularTextFileSync(file, 7)).toBe("fixture");
  expect(() => readBoundedRegularTextFileSync(file, 6)).toThrow(/bounded|limit/);
  const alias = path.join(root, "alias.json");
  linkSync(file, alias);
  expect(() => readBoundedRegularTextFileSync(file, 7)).toThrow(/singly-linked/);
});

it("rejects directories and leaf symlinks before reading them", (context) => {
  const root = fixture();
  const directory = path.join(root, "directory");
  mkdirSync(directory);
  expect(() => readBoundedRegularTextFileSync(directory, 1024)).toThrow(/regular file/);
  const target = path.join(root, "target.json");
  const linked = path.join(root, "linked.json");
  writeFileSync(target, "fixture");
  try { symlinkSync(target, linked, "file"); }
  catch (error: any) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { context.skip("file symlinks unavailable"); return; }
    throw error;
  }
  expect(() => readBoundedRegularTextFileSync(linked, 1024)).toThrow(/regular file/);
});

it("rejects malformed UTF-8 instead of silently changing durable identifiers", () => {
  const file = path.join(fixture(), "metadata.json");
  writeFileSync(file, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  expect(() => readBoundedRegularTextFileSync(file, 1024)).toThrow();
});
