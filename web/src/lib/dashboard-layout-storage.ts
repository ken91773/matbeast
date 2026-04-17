import type { LayoutStorage } from "react-resizable-panels";

function memoryStorage(): LayoutStorage {
  const m = new Map<string, string>();
  return {
    getItem: (key) => m.get(key) ?? null,
    setItem: (key, value) => {
      m.set(key, value);
    },
  };
}

/**
 * Persists react-resizable-panels layout under the saved event file name
 * (`normalizeEventFileKey`), not the DB tournament cuid.
 * UNTITLED / unsaved → in-memory only → default panel sizes each new event.
 */
export function createEventFileLayoutStorage(
  eventFileKey: string | null,
): LayoutStorage {
  if (typeof window === "undefined") {
    return memoryStorage();
  }
  if (!eventFileKey) {
    return memoryStorage();
  }
  const prefix = `matbeast-dash-layout:${eventFileKey}:`;
  return {
    getItem: (key) => window.localStorage.getItem(prefix + key),
    setItem: (key, value) => {
      try {
        window.localStorage.setItem(prefix + key, value);
      } catch {
        /* quota / private mode */
      }
    },
  };
}
