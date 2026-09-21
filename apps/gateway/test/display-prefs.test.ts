import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DisplayPrefsStore } from "../src/display-prefs.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "display-prefs-review-"));
  homes.push(home);
  return { store: new DisplayPrefsStore(home), file: path.join(home, "webui-display.json") };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("does not load 100 percent as an enabled threshold when AutoCompaction treats it as disabled", () => {
  const { store, file } = fixture();
  writeFileSync(file, JSON.stringify({ reasoning: false, autoCompactThreshold: 1 }));
  expect(store.get()).toMatchObject({ reasoning: false, autoCompactThreshold: 0 });
});

it("uses the default only for a genuinely absent first-install file", () => {
  const { store } = fixture();
  expect(store.get().autoCompactThreshold).toBe(0.9);
});

it("fails closed for corrupt existing preferences and logs a bounded diagnostic", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const { store, file } = fixture();
  writeFileSync(file, "{not-json");
  expect(store.get().autoCompactThreshold).toBe(0);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("automatic compaction is disabled"));
});

it("ignores a 100 percent patch while preserving the existing threshold and unrelated preferences", () => {
  const { store, file } = fixture();
  store.set({ autoCompactThreshold: 0.85 });
  expect(store.set({ autoCompactThreshold: 1, commands: false })).toMatchObject({ commands: false, autoCompactThreshold: 0.85 });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ commands: false, autoCompactThreshold: 0.85 });
});

it("round-trips off and enabled fractions but ignores out-of-domain values", () => {
  const { store } = fixture();
  for (const threshold of [0, 0.5, 0.95, 0.999]) {
    expect(store.set({ autoCompactThreshold: threshold }).autoCompactThreshold).toBe(threshold);
    expect(store.get().autoCompactThreshold).toBe(threshold);
  }
  for (const threshold of [-1, 1.01, NaN, Infinity, "0.9", null]) {
    expect(store.set({ autoCompactThreshold: threshold }).autoCompactThreshold).toBe(0.999);
  }
});

it("serves the cached value on the notification path and updates it only after a successful save", () => {
  const { store, file } = fixture();
  writeFileSync(file, JSON.stringify({ autoCompactThreshold: 0.85 }));
  expect(store.get().autoCompactThreshold).toBe(0.85);
  writeFileSync(file, JSON.stringify({ autoCompactThreshold: 0.5 }));
  expect(store.get().autoCompactThreshold).toBe(0.85);

  rmSync(file);
  mkdirSync(file);
  expect(() => store.set({ autoCompactThreshold: 0.5 })).toThrow();
  expect(store.get().autoCompactThreshold).toBe(0.85);
});
