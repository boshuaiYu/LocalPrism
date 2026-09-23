import { vi } from "vitest";

const storageData = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storageData.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storageData.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storageData.delete(key);
  }),
  clear: vi.fn(() => {
    storageData.clear();
  }),
  key: vi.fn((index: number) => Array.from(storageData.keys())[index] ?? null),
  get length() {
    return storageData.size;
  },
};

const mockWebview = {
  setZoom: vi.fn(() => Promise.resolve()),
  onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
};

Object.defineProperty(window, "localStorage", {
  value: mockStorage,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: mockStorage,
  configurable: true,
});

const tauriEventHelpers = vi.hoisted(() => {
  type Listener = (event: {
    event: string;
    id: number;
    payload: unknown;
  }) => void;
  const listeners = new Map<string, Set<Listener>>();
  return {
    listen: vi.fn(async (name: string, callback: Listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(callback);
      listeners.set(name, set);
      return () => {
        set.delete(callback);
      };
    }),
    emitMockTauriEvent(name: string, payload: unknown) {
      const set = listeners.get(name);
      if (!set) return;
      for (const listener of set) {
        listener({ event: name, id: 1, payload });
      }
    },
    resetMockTauriEvents() {
      listeners.clear();
    },
  };
});

export const emitMockTauriEvent = tauriEventHelpers.emitMockTauriEvent;
export const resetMockTauriEvents = tauriEventHelpers.resetMockTauriEvents;

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: tauriEventHelpers.listen,
}));

// Mock @tauri-apps/api/webview
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => mockWebview),
}));

// Mock @tauri-apps/api/path
vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn((...args: string[]) => Promise.resolve(args.join("/"))),
}));

// Mock @tauri-apps/plugin-fs
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  stat: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  copyFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
}));

// Mock @tauri-apps/plugin-shell
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(() => Promise.resolve()),
  Command: {
    create: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(async () => undefined),
}));

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
