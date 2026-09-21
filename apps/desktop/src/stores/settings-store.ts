import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  type PermissionMode,
} from "@/lib/permission-mode";

type CompilerBackend = "tectonic" | "texlive";

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
  autoCompile: boolean;
  setAutoCompile: (enabled: boolean) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
      autoCompile: true,
      setAutoCompile: (enabled) => set({ autoCompile: enabled }),
      permissionMode: DEFAULT_PERMISSION_MODE,
      setPermissionMode: (mode) =>
        set({ permissionMode: normalizePermissionMode(mode) }),
    }),
    {
      name: "claude-prism-settings",
      version: 3,
      migrate: (persisted) => {
        const state = persisted as Partial<SettingsState>;
        return {
          ...state,
          autoCompile: state.autoCompile ?? true,
          permissionMode: normalizePermissionMode(state.permissionMode),
        };
      },
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...state,
          permissionMode: normalizePermissionMode(
            state.permissionMode ?? current.permissionMode,
          ),
        };
      },
    },
  ),
);
