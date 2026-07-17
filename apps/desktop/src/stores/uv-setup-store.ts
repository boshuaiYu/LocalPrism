import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@/lib/debug/logger";
import {
  ownsProjectFsState,
  type ProjectFsOwner,
  runProjectFsOperation,
} from "@/lib/project-fs-operations";
import { useDocumentStore } from "@/stores/document-store";

const log = createLogger("uv");

// ─── Types ───

interface UvStatus {
  installed: boolean;
  binary_path: string | null;
  version: string | null;
}

interface VenvInfo {
  venv_path: string;
  python_path: string;
  created: boolean;
}

type UvSetupStatus = "checking" | "not-installed" | "ready" | "error";

interface VenvSetupRequest extends ProjectFsOwner {
  requestId: number;
}

interface UvSetupState {
  status: UvSetupStatus;
  isInstalling: boolean;
  error: string | null;
  version: string | null;
  binaryPath: string | null;

  // venv state
  venvReady: boolean;
  venvPath: string | null;
  pythonPath: string | null;
  venvError: string | null;
  isSettingUpVenv: boolean;
  venvOwner: ProjectFsOwner | null;
  activeVenvRequestId: number | null;

  // Actions
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  beginVenvSetup: (owner: ProjectFsOwner) => VenvSetupRequest;
  setupVenv: (request: VenvSetupRequest | string) => Promise<void>;
  cancelVenvSetup: (request: VenvSetupRequest) => void;

  // Internal
  _finishInstall: (success: boolean) => void;
}

let nextStatusRequestId = 0;
let latestStatusRequestId = 0;
let nextVenvRequestId = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownsVenvRequest(
  state: Pick<UvSetupState, "activeVenvRequestId" | "venvOwner">,
  request: VenvSetupRequest,
): boolean {
  return (
    state.activeVenvRequestId === request.requestId &&
    state.venvOwner?.projectRoot === request.projectRoot &&
    state.venvOwner.projectGeneration === request.projectGeneration
  );
}

function ownsMountedProject(request: VenvSetupRequest): boolean {
  const document = useDocumentStore.getState();
  return !document.isProjectMutating && ownsProjectFsState(request, document);
}

// ─── Store ───

export const useUvSetupStore = create<UvSetupState>((set, get) => ({
  status: "checking",
  isInstalling: false,
  error: null,
  version: null,
  binaryPath: null,

  venvReady: false,
  venvPath: null,
  pythonPath: null,
  venvError: null,
  isSettingUpVenv: false,
  venvOwner: null,
  activeVenvRequestId: null,

  checkStatus: async () => {
    const requestId = ++nextStatusRequestId;
    latestStatusRequestId = requestId;
    set({ status: "checking", error: null });
    try {
      const result = await invoke<UvStatus>("check_uv_status");
      if (requestId !== latestStatusRequestId) return;

      if (!result.installed) {
        log.info("uv not installed");
        set({ status: "not-installed", version: null, binaryPath: null });
        return;
      }

      log.info(`uv ready: v${result.version}`);
      set({
        status: "ready",
        version: result.version,
        binaryPath: result.binary_path,
      });
    } catch (err: unknown) {
      if (requestId !== latestStatusRequestId) return;
      set({
        status: "error",
        error: errorMessage(err),
      });
    }
  },

  install: async () => {
    set({ isInstalling: true, error: null });
    try {
      await invoke("install_uv");
      // Completion is driven by the "uv-install-complete" event
    } catch (err: unknown) {
      set({
        isInstalling: false,
        status: "error",
        error: errorMessage(err),
      });
    }
  },

  beginVenvSetup: (owner) => {
    const request: VenvSetupRequest = {
      ...owner,
      requestId: ++nextVenvRequestId,
    };
    set({
      venvReady: false,
      venvPath: null,
      pythonPath: null,
      venvError: null,
      isSettingUpVenv: true,
      venvOwner: owner,
      activeVenvRequestId: request.requestId,
    });
    return request;
  },

  setupVenv: async (requestOrProjectPath) => {
    let request: VenvSetupRequest;
    if (typeof requestOrProjectPath === "string") {
      const document = useDocumentStore.getState();
      if (
        document.projectRoot !== requestOrProjectPath ||
        document.isProjectMutating
      ) {
        return;
      }
      request = get().beginVenvSetup({
        projectRoot: requestOrProjectPath,
        projectGeneration: document.projectGeneration,
      });
    } else {
      request = requestOrProjectPath;
    }

    if (!ownsVenvRequest(get(), request)) return;
    if (!ownsMountedProject(request)) {
      set((state) =>
        ownsVenvRequest(state, request)
          ? { isSettingUpVenv: false, activeVenvRequestId: null }
          : {},
      );
      return;
    }
    try {
      await runProjectFsOperation(request, async () => {
        const info = await invoke<VenvInfo>("setup_project_venv", {
          projectPath: request.projectRoot,
        });
        if (!ownsMountedProject(request)) return;
        set((state) =>
          ownsVenvRequest(state, request)
            ? {
                venvReady: true,
                venvPath: info.venv_path,
                pythonPath: info.python_path,
                venvError: null,
              }
            : {},
        );
        log.info(`Venv ready at ${info.venv_path}`);
      });
    } catch (err: unknown) {
      log.error("Failed to setup venv", { error: String(err) });
      // Don't set error status — uv itself is fine, just venv creation failed
      set((state) =>
        ownsVenvRequest(state, request) && ownsMountedProject(request)
          ? {
              venvReady: false,
              venvPath: null,
              pythonPath: null,
              venvError: errorMessage(err),
            }
          : {},
      );
    } finally {
      set((state) =>
        ownsVenvRequest(state, request)
          ? { isSettingUpVenv: false, activeVenvRequestId: null }
          : {},
      );
    }
  },

  cancelVenvSetup: (request) => {
    set((state) =>
      ownsVenvRequest(state, request)
        ? { isSettingUpVenv: false, activeVenvRequestId: null }
        : {},
    );
  },

  _finishInstall: (success: boolean) => {
    if (success) {
      set({ isInstalling: false });
      get().checkStatus();
    } else {
      set({
        isInstalling: false,
        status: "error",
        error:
          "uv installation failed. Check your internet connection and try again.",
      });
    }
  },
}));
