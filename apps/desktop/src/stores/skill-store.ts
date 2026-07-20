import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  RuntimeKind,
  RuntimeSkill,
  SkillScope,
  SkillTarget,
} from "@/runtime/types";

export interface SkillStoreState {
  skills: RuntimeSkill[];
  loading: boolean;
  error: string | null;
  lastAutoImportCount: number;
  selectedTargets: SkillTarget[];
  setSelectedTargets: (targets: SkillTarget[]) => void;
  refresh: (projectPath?: string) => Promise<void>;
  importFolder: (
    sourcePath: string,
    targets: SkillTarget[],
    projectPath?: string,
  ) => Promise<void>;
  removeManaged: (entryId: string, confirmModified: boolean) => Promise<void>;
  autoImportProject: (projectPath: string) => Promise<number>;
}

const DEFAULT_TARGETS: SkillTarget[] = [{ runtime: "claude", scope: "user" }];

export function defaultSkillTargets(
  runtime: RuntimeKind = "claude",
  scope: SkillScope = "user",
): SkillTarget[] {
  return [{ runtime, scope }];
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,
  lastAutoImportCount: 0,
  selectedTargets: DEFAULT_TARGETS,

  setSelectedTargets: (targets) => {
    set({
      selectedTargets: targets.length > 0 ? targets : DEFAULT_TARGETS,
    });
  },

  refresh: async (projectPath) => {
    set({ loading: true, error: null });
    try {
      const skills = await invoke<RuntimeSkill[]>("skill_list", {
        projectPath: projectPath ?? null,
      });
      set({ skills, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  importFolder: async (sourcePath, targets, projectPath) => {
    set({ loading: true, error: null });
    try {
      await invoke<RuntimeSkill[]>("skill_import", {
        sourcePath,
        targets,
        projectPath: projectPath ?? null,
      });
      await get().refresh(projectPath);
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  removeManaged: async (entryId, confirmModified) => {
    set({ loading: true, error: null });
    try {
      await invoke("skill_delete_managed", { entryId, confirmModified });
      await get().refresh();
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  autoImportProject: async (projectPath) => {
    try {
      const imported = await invoke<RuntimeSkill[]>(
        "skill_auto_import_project",
        { projectPath },
      );
      set({ lastAutoImportCount: imported.length });
      if (imported.length > 0) {
        await get().refresh(projectPath);
      }
      return imported.length;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  },
}));
