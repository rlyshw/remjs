/**
 * Storage patch — intercepts localStorage and sessionStorage.
 */

import type { StorageOp } from "../ops.js";

export type Emit = (op: StorageOp) => void;

function patchStorage(
  storage: Storage,
  kind: "local" | "session",
  emit: Emit,
): () => void {
  const origGetItem = storage.getItem.bind(storage);
  const origSetItem = storage.setItem.bind(storage);
  const origRemoveItem = storage.removeItem.bind(storage);

  storage.getItem = function (key: string): string | null {
    const value = origGetItem(key);
    emit({ type: "storage", kind, action: "get", key, value });
    return value;
  };

  storage.setItem = function (key: string, value: string): void {
    origSetItem(key, value);
    emit({ type: "storage", kind, action: "set", key, value });
  };

  storage.removeItem = function (key: string): void {
    origRemoveItem(key);
    emit({ type: "storage", kind, action: "remove", key, value: null });
  };

  return function uninstall() {
    storage.getItem = origGetItem;
    storage.setItem = origSetItem;
    storage.removeItem = origRemoveItem;
  };
}

export function installStoragePatch(emit: Emit): () => void {
  const uninstallers: Array<() => void> = [];

  if (typeof globalThis.localStorage !== "undefined") {
    uninstallers.push(patchStorage(globalThis.localStorage, "local", emit));
  }
  if (typeof globalThis.sessionStorage !== "undefined") {
    uninstallers.push(patchStorage(globalThis.sessionStorage, "session", emit));
  }

  return function uninstall() {
    for (const fn of uninstallers) fn();
  };
}
