import { describe, it, expect, beforeEach } from "vitest";
import { installStoragePatch } from "../../src/patches/storage.js";
import type { StorageOp } from "../../src/ops.js";

// Node doesn't have localStorage/sessionStorage by default.
// Create a minimal mock for testing.
function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem(key: string) { return store.get(key) ?? null; },
    setItem(key: string, value: string) { store.set(key, value); },
    removeItem(key: string) { store.delete(key); },
    clear() { store.clear(); },
    key(index: number) { return [...store.keys()][index] ?? null; },
    get length() { return store.size; },
  } as Storage;
}

describe("storage patch", () => {
  let mockLocal: Storage;

  beforeEach(() => {
    mockLocal = createMockStorage();
    (globalThis as any).localStorage = mockLocal;
  });

  it("records setItem", () => {
    const ops: StorageOp[] = [];
    const uninstall = installStoragePatch((op) => ops.push(op));

    localStorage.setItem("key1", "value1");

    uninstall();

    expect(ops).toHaveLength(1);
    expect(ops[0]!).toEqual({
      type: "storage",
      kind: "local",
      action: "set",
      key: "key1",
      value: "value1",
    });
  });

  it("records getItem", () => {
    localStorage.setItem("existing", "hello");

    const ops: StorageOp[] = [];
    const uninstall = installStoragePatch((op) => ops.push(op));

    const val = localStorage.getItem("existing");

    uninstall();

    expect(val).toBe("hello");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.action).toBe("get");
    expect(ops[0]!.key).toBe("existing");
    expect(ops[0]!.value).toBe("hello");
  });

  it("records removeItem", () => {
    localStorage.setItem("toRemove", "val");

    const ops: StorageOp[] = [];
    const uninstall = installStoragePatch((op) => ops.push(op));

    localStorage.removeItem("toRemove");

    uninstall();

    expect(ops).toHaveLength(1);
    expect(ops[0]!.action).toBe("remove");
    expect(ops[0]!.value).toBeNull();
  });

  it("records getItem returning null for missing key", () => {
    const ops: StorageOp[] = [];
    const uninstall = installStoragePatch((op) => ops.push(op));

    const val = localStorage.getItem("nonexistent");

    uninstall();

    expect(val).toBeNull();
    expect(ops[0]!.value).toBeNull();
  });
});
