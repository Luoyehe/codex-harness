import { afterEach, expect, it, vi } from "vitest";
import {
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "../src/atomic-file.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const homes: string[] = [];
const fixture = () => {
  const home = mkdtempSync(path.join(tmpdir(), "atomic-file-audit-"));
  homes.push(home);
  const target = path.join(home, "operation.json");
  writeFileSync(target, '{"state":"unknown"}');
  return { home, target };
};

afterEach(() => {
  vi.clearAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("replaces an existing file with one same-directory rename after flushing the data", () => {
  const { home, target } = fixture();

  atomicWriteFileSync(target, '{"state":"accepted"}');

  expect(readFileSync(target, "utf8")).toBe('{"state":"accepted"}');
  expect(readdirSync(home)).toEqual(["operation.json"]);
  expect(renameSync).toHaveBeenCalledTimes(1);
  const [source, destination] = vi.mocked(renameSync).mock.calls[0];
  expect(path.dirname(String(source))).toBe(home);
  expect(String(source)).toMatch(/\.tmp$/);
  expect(destination).toBe(target);
  expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]);
});

it.each(["EPERM", "EACCES", "EEXIST"])(
  "preserves the authoritative record and cleans the temporary file when rename fails with %s",
  (code) => {
    const { home, target } = fixture();
    const failure = Object.assign(new Error("replacement refused"), { code });
    vi.mocked(renameSync).mockImplementationOnce(() => { throw failure; });

    expect(() => atomicWriteFileSync(target, '{"state":"accepted"}')).toThrow(failure);

    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renameSync).mock.calls[0][1]).toBe(target);
    expect(readFileSync(target, "utf8")).toBe('{"state":"unknown"}');
    expect(readdirSync(home)).toEqual(["operation.json"]);
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]);
  },
);
