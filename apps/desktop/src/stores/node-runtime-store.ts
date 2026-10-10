import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export const NODE_RUNTIME_DECLINED_KEY = "localprism-node-runtime-declined";

export type NodeRuntimeSource = "managed" | "system";
export type NodeRuntimeSetupStatus = "checking" | "missing" | "ready" | "error";

interface NodeRuntimeResponse {
  available: boolean;
  source: NodeRuntimeSource | null;
  version: string | null;
  node_path: string | null;
  npx_path: string | null;
  managed_dir: string | null;
}

interface NodeRuntimeState {
  status: NodeRuntimeSetupStatus;
  source: NodeRuntimeSource | null;
  version: string | null;
  nodePath: string | null;
  npxPath: string | null;
  managedDir: string | null;
  isInstalling: boolean;
  isRemoving: boolean;
  progress: string | null;
  error: string | null;
  promptDeclined: boolean;
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  remove: () => Promise<void>;
  declinePrompt: () => void;
  _setProgress: (line: string) => void;
  _finishInstall: (success: boolean) => void;
}

let nextStatusRequestId = 0;
let latestStatusRequestId = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDeclined(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(NODE_RUNTIME_DECLINED_KEY) === "true";
}

export const useNodeRuntimeStore = create<NodeRuntimeState>((set, get) => ({
  status: "checking",
  source: null,
  version: null,
  nodePath: null,
  npxPath: null,
  managedDir: null,
  isInstalling: false,
  isRemoving: false,
  progress: null,
  error: null,
  promptDeclined: readDeclined(),

  checkStatus: async () => {
    const requestId = ++nextStatusRequestId;
    latestStatusRequestId = requestId;
    set({ status: "checking", error: null });
    try {
      const result = await invoke<NodeRuntimeResponse>("check_node_runtime");
      if (requestId !== latestStatusRequestId) return;
      if (!result?.available) {
        set({
          status: "missing",
          source: null,
          version: null,
          nodePath: null,
          npxPath: null,
          managedDir: result?.managed_dir ?? null,
        });
        return;
      }
      set({
        status: "ready",
        source: result.source,
        version: result.version,
        nodePath: result.node_path,
        npxPath: result.npx_path,
        managedDir: result.managed_dir,
        error: null,
      });
    } catch (error: unknown) {
      if (requestId !== latestStatusRequestId) return;
      set({
        status: "error",
        error: errorMessage(error),
      });
    }
  },

  install: async () => {
    if (get().isInstalling) return;
    set({ isInstalling: true, error: null, progress: null });
    try {
      await invoke("install_node_runtime");
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("already running")) return;
      set({
        isInstalling: false,
        status: "error",
        error: message,
      });
    }
  },

  remove: async () => {
    if (get().isRemoving || get().isInstalling) return;
    set({ isRemoving: true, error: null });
    try {
      await invoke("remove_node_runtime");
      set({ isRemoving: false });
      await get().checkStatus();
    } catch (error: unknown) {
      set({
        isRemoving: false,
        status: "error",
        error: errorMessage(error),
      });
    }
  },

  declinePrompt: () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(NODE_RUNTIME_DECLINED_KEY, "true");
    }
    set({ promptDeclined: true });
  },

  _setProgress: (line) => {
    set({ progress: line });
  },

  _finishInstall: (success) => {
    if (success) {
      set({ isInstalling: false, progress: null, error: null });
      void get().checkStatus();
      return;
    }
    set((state) => ({
      isInstalling: false,
      status: "error",
      error: state.progress ?? "Node.js installation failed.",
    }));
  },
}));
