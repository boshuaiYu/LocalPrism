import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isUiLanguage, type UiLanguage } from "@/lib/i18n";
import {
  normalizeProductTourStatus,
  type ProductTourStatus,
} from "@/lib/product-tour";
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
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  /** True after a built-in agent preset install has finished at least once. */
  builtinAgentPresetsSeeded: boolean;
  setBuiltinAgentPresetsSeeded: (seeded: boolean) => void;
  /**
   * Last applied builtin preset copy. 0 = never seeded, 1 = first install,
   * 2 = playful names and stronger prompts,
   * 3 = richer instructions and refreshed skill attachments.
   */
  builtinAgentPresetsSeedVersion: number;
  setBuiltinAgentPresetsSeedVersion: (version: number) => void;
  /** First-run product tour. Skip and finish both stick. */
  productTour: ProductTourStatus;
  setProductTour: (status: ProductTourStatus) => void;
}

function normalizeSeedVersion(state: Partial<SettingsState>): number {
  if (
    typeof state.builtinAgentPresetsSeedVersion === "number" &&
    Number.isFinite(state.builtinAgentPresetsSeedVersion)
  ) {
    return state.builtinAgentPresetsSeedVersion;
  }
  return state.builtinAgentPresetsSeeded === true ? 1 : 0;
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
      uiLanguage: "en",
      setUiLanguage: (language) =>
        set({ uiLanguage: isUiLanguage(language) ? language : "en" }),
      builtinAgentPresetsSeeded: false,
      setBuiltinAgentPresetsSeeded: (seeded) =>
        set({ builtinAgentPresetsSeeded: seeded }),
      builtinAgentPresetsSeedVersion: 0,
      setBuiltinAgentPresetsSeedVersion: (version) =>
        set({
          builtinAgentPresetsSeedVersion: version,
          builtinAgentPresetsSeeded: version > 0,
        }),
      productTour: "pending",
      setProductTour: (status) =>
        set({ productTour: normalizeProductTourStatus(status) }),
    }),
    {
      name: "claude-prism-settings",
      version: 4,
      migrate: (persisted) => {
        const state = persisted as Partial<SettingsState>;
        return {
          ...state,
          autoCompile: state.autoCompile ?? true,
          permissionMode: normalizePermissionMode(state.permissionMode),
          uiLanguage: isUiLanguage(state.uiLanguage) ? state.uiLanguage : "en",
          builtinAgentPresetsSeeded: state.builtinAgentPresetsSeeded === true,
          builtinAgentPresetsSeedVersion: normalizeSeedVersion(state),
          productTour: normalizeProductTourStatus(state.productTour),
        };
      },
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as Partial<SettingsState>;
        const seedVersion = normalizeSeedVersion(state);
        return {
          ...current,
          ...state,
          permissionMode: normalizePermissionMode(
            state.permissionMode ?? current.permissionMode,
          ),
          uiLanguage: isUiLanguage(state.uiLanguage)
            ? state.uiLanguage
            : current.uiLanguage,
          builtinAgentPresetsSeeded:
            seedVersion > 0 || state.builtinAgentPresetsSeeded === true,
          builtinAgentPresetsSeedVersion: seedVersion,
          productTour: normalizeProductTourStatus(state.productTour),
        };
      },
    },
  ),
);
