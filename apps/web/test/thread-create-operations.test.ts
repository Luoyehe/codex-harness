import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finishThreadCreateOperation, readThreadCreateOperations, saveThreadCreateOperation,
  LEGACY_THREAD_CREATE_KEY as legacyKey, THREAD_CREATE_PREFIX as prefix,
  THREAD_CREATE_LEGACY_PREFIX as migratedPrefix, THREAD_CREATE_RESOLVED_PREFIX as resolvedPrefix,
  type ThreadCreateOperation } from "../src/utils/thread-create-operations";

const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
const operation = (index = 1): ThreadCreateOperation => ({ clientOperationId: id(index), cwd: "P", state: "unknown" });
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { get length() { return storage.size; }, key: vi.fn((index: number) => [...storage.keys()][index] ?? null),
    getItem: vi.fn((key: string) => storage.get(key) ?? null), setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: vi.fn((key: string) => storage.delete(key)) });
});
afterEach(() => vi.unstubAllGlobals());

describe("independent creation receipts", () => {
  it("keeps unrelated IDs and leaves no tombstones for ordinary completions", () => {
    saveThreadCreateOperation(operation(1));
    for (let index = 2; index < 200; index++) {
      saveThreadCreateOperation(operation(index)); finishThreadCreateOperation(operation(index));
    }
    expect([...storage.keys()]).toEqual([prefix + id(1)]);
    expect(readThreadCreateOperations().records).toEqual({ [id(1)]: operation(1) });
  });

  it("does not overwrite a newer legacy slot while capturing and finishing its predecessor", () => {
    storage.set(legacyKey, JSON.stringify(operation(1)));
    const write = vi.mocked(localStorage.setItem).getMockImplementation()!;
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      if (key === migratedPrefix + id(1)) storage.set(legacyKey, JSON.stringify(operation(2)));
      write(key, value);
    });
    const snapshot = readThreadCreateOperations();
    finishThreadCreateOperation(snapshot.records[id(1)]);
    expect(JSON.parse(storage.get(legacyKey)!)).toEqual(operation(2));
    expect(storage.has(resolvedPrefix + id(1))).toBe(true);
    expect(readThreadCreateOperations().records).toEqual({ [id(2)]: { ...operation(2), legacy: true } });
  });

  it("keeps completion authoritative over a migration or accepted receipt arriving late", () => {
    storage.set(legacyKey, JSON.stringify(operation()));
    const write = vi.mocked(localStorage.setItem).getMockImplementation()!;
    let interleave = true;
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      if (key === migratedPrefix + id(1) && interleave) {
        interleave = false;
        finishThreadCreateOperation({ ...operation(), legacy: true });
      }
      write(key, value);
    });
    expect(readThreadCreateOperations().records).toEqual({});
    saveThreadCreateOperation({ ...operation(), state: "accepted", threadId: "late" });
    expect(readThreadCreateOperations().records).toEqual({});
    expect(storage.has(legacyKey)).toBe(true);
  });

  it("honors completion beyond the enumeration budget and retains all excess source data", () => {
    storage.set(legacyKey, JSON.stringify(operation()));
    for (let index = 0; index < 4_100; index++) storage.set("unrelated-" + index, "x");
    finishThreadCreateOperation({ ...operation(), legacy: true });
    const before = storage.size;
    expect(readThreadCreateOperations()).toMatchObject({ records: {}, overflow: true });
    expect(storage.size).toBe(before);
    expect(localStorage.key).toHaveBeenCalledTimes(4_096);
  });

  it("limits displayed records and reveals the next record after exact-ID completion", () => {
    for (let index = 1; index <= 101; index++) saveThreadCreateOperation(operation(index));
    expect(Object.keys(readThreadCreateOperations().records)).toHaveLength(100);
    expect(readThreadCreateOperations().overflow).toBe(true);
    finishThreadCreateOperation(operation(1));
    expect(readThreadCreateOperations()).toMatchObject({ overflow: false, records: { [id(101)]: operation(101) } });
    expect(storage.size).toBe(100);
  });

  it("keeps legacy and canonical not_received snapshots unknown", () => {
    storage.set(legacyKey, JSON.stringify({ ...operation(1), state: "not_received" }));
    storage.set(prefix + id(2), JSON.stringify({ ...operation(2), state: "not_received" }));
    expect(Object.values(readThreadCreateOperations().records).map((entry) => entry.state)).toEqual(["unknown", "unknown"]);
  });

  it("preserves original records and reports failed migration, malformed input, and cleanup failures", () => {
    storage.set(legacyKey, JSON.stringify(operation()));
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error("quota"); });
    expect(readThreadCreateOperations()).toMatchObject({ error: expect.any(String), records: { [id(1)]: { ...operation(), legacy: true } } });
    expect(() => finishThreadCreateOperation({ ...operation(), legacy: true })).toThrow("quota");
    expect(storage.get(legacyKey)).toBe(JSON.stringify(operation()));
    storage.set(prefix + id(2), "x".repeat(8_193));
    expect(readThreadCreateOperations().error).not.toBeNull();
    expect(storage.size).toBe(2);
  });
});
