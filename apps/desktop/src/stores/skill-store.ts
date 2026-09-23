import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type {
  RuntimeKind,
  RuntimeSkill,
  SkillScope,
  SkillTarget,
} from "@/runtime/types";
import {
  DEFAULT_SKILL_PACKS,
  shouldInstallDefaultPack,
  type DefaultSkillPackId,
} from "@/lib/default-skill-packs";
import { isPaperSpineSkill } from "@/lib/paperspine";
import {
  notifySkillsListUpdated,
  SKILLS_CHANGED_EVENT,
} from "@/lib/skills-refresh";
import { useAgentStore } from "@/stores/agent-store";
import { useSkillCategoryStore } from "@/stores/skill-category-store";

function invokeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "Skill import failed";
}

export type DefaultSkillPackResult = {
  id: string;
  status: "already" | "imported" | "error";
  error?: string;
};

export interface SkillStoreState {
  skills: RuntimeSkill[];
  loading: boolean;
  error: string | null;
  lastAutoImportCount: number;
  installingPackId: DefaultSkillPackId | null;
  selectedTargets: SkillTarget[];
  /** Project path used by the last skills list, so external installs reload the same scope. */
  listedProjectPath: string | null;
  setSelectedTargets: (targets: SkillTarget[]) => void;
  refresh: (
    projectPath?: string | null,
    options?: { silent?: boolean },
  ) => Promise<void>;
  refreshListed: () => Promise<void>;
  importFolder: (
    sourcePath: string,
    targets: SkillTarget[],
    projectPath?: string,
    categoryId?: string,
  ) => Promise<void>;
  importUrl: (
    sourceUrl: string,
    targets: SkillTarget[],
    projectPath?: string,
    categoryId?: string,
    skipExisting?: boolean,
  ) => Promise<void>;
  removeManaged: (entryId: string, confirmModified: boolean) => Promise<void>;
  autoImportProject: (projectPath: string) => Promise<number>;
  ensurePaperSpineSkills: () => Promise<"already" | "imported">;
  ensureDefaultSkillPacks: (options?: {
    force?: boolean;
  }) => Promise<DefaultSkillPackResult[]>;
  updateDefaultSkillPacks: () => Promise<DefaultSkillPackResult[]>;
}

const DEFAULT_TARGETS: SkillTarget[] = [{ runtime: "claude", scope: "user" }];

let defaultPacksInFlight: Promise<DefaultSkillPackResult[]> | null = null;
let skillListEpoch = 0;

export function resetDefaultSkillPacksForTests() {
  defaultPacksInFlight = null;
}

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
  installingPackId: null,
  selectedTargets: DEFAULT_TARGETS,
  listedProjectPath: null,

  setSelectedTargets: (targets) => {
    set({
      selectedTargets: targets.length > 0 ? targets : DEFAULT_TARGETS,
    });
  },

  refresh: async (projectPath, options) => {
    const path =
      projectPath === undefined ? get().listedProjectPath : projectPath;
    const silent = options?.silent === true;
    const epoch = ++skillListEpoch;
    set({
      listedProjectPath: path ?? null,
      error: null,
      ...(silent ? {} : { loading: true }),
    });
    try {
      const skills = await invoke<RuntimeSkill[]>("skill_list", {
        projectPath: path ?? null,
      });
      if (epoch !== skillListEpoch) return;
      set({ skills: skills ?? [], loading: false });
      notifySkillsListUpdated();
    } catch (error) {
      if (epoch !== skillListEpoch) return;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  refreshListed: async () => {
    await get().refresh(undefined, { silent: true });
  },

  importFolder: async (sourcePath, targets, projectPath, categoryId) => {
    set({ loading: true, error: null });
    try {
      const imported = await invoke<RuntimeSkill[]>("skill_import", {
        sourcePath,
        targets,
        projectPath: projectPath ?? null,
      });
      if (categoryId) {
        useSkillCategoryStore.getState().assignFolders(
          imported.map((skill) => skill.folder),
          categoryId,
        );
      }
      await get().refresh(projectPath);
    } catch (error) {
      set({
        loading: false,
        error: invokeErrorMessage(error),
      });
      throw error;
    }
  },

  importUrl: async (
    sourceUrl,
    targets,
    projectPath,
    categoryId,
    skipExisting,
  ) => {
    set({ loading: true, error: null });
    try {
      const imported = await invoke<RuntimeSkill[]>("skill_import_url", {
        sourceUrl,
        targets,
        projectPath: projectPath ?? null,
        skipExisting: skipExisting === true,
      });
      if (categoryId) {
        useSkillCategoryStore.getState().assignFolders(
          imported.map((skill) => skill.folder),
          categoryId,
        );
      }
      await get().refresh(projectPath);
    } catch (error) {
      set({
        loading: false,
        error: invokeErrorMessage(error),
      });
      throw error;
    }
  },

  removeManaged: async (entryId, confirmModified) => {
    set({ loading: true, error: null });
    try {
      await invoke("skill_delete_managed", { entryId, confirmModified });
      await get().refresh(get().listedProjectPath);
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

  ensurePaperSpineSkills: async () => {
    const results = await get().ensureDefaultSkillPacks();
    const paper = results.find((item) => item.id === "paper-spine");
    if (paper?.status === "error") {
      throw new Error(paper.error ?? "PaperSpine install failed");
    }
    if (paper?.status === "imported") {
      return "imported";
    }
    return get().skills.some(isPaperSpineSkill) ? "already" : "imported";
  },

  ensureDefaultSkillPacks: async (options) => {
    const force = options?.force === true;
    if (defaultPacksInFlight) {
      if (!force) {
        return defaultPacksInFlight;
      }
      await defaultPacksInFlight.catch(() => undefined);
    }
    const operation = (async () => {
      await get().refresh();
      await useAgentStore.getState().refresh("claude");
      const results: DefaultSkillPackResult[] = [];
      const listOfficialSlash = async () => {
        try {
          return {
            ok: true as const,
            commands: await invoke<
              Array<{ name?: string; full_command?: string; scope?: string }>
            >("slash_commands_list", { projectPath: null }),
          };
        } catch {
          return { ok: false as const, commands: [] };
        }
      };
      let slash = await listOfficialSlash();

      for (const pack of DEFAULT_SKILL_PACKS) {
        const skills = get().skills ?? [];
        const agents = useAgentStore.getState().agents ?? [];
        if (
          !force &&
          !shouldInstallDefaultPack(
            skills,
            agents,
            pack,
            slash.commands,
            slash.ok,
          )
        ) {
          results.push({ id: pack.id, status: "already" });
          continue;
        }
        set({
          loading: true,
          error: null,
          installingPackId: pack.id,
        });
        try {
          await get().importUrl(
            pack.sourceUrl,
            defaultSkillTargets(),
            undefined,
            undefined,
            !force,
          );
          await useAgentStore.getState().refresh("claude");
          slash = await listOfficialSlash();
          results.push({ id: pack.id, status: "imported" });
        } catch (error) {
          const message = invokeErrorMessage(error);
          set({ loading: false, error: message, installingPackId: null });
          results.push({
            id: pack.id,
            status: "error",
            error: message,
          });
        }
      }

      set({ loading: false, installingPackId: null });
      return results;
    })().finally(() => {
      if (defaultPacksInFlight === operation) {
        defaultPacksInFlight = null;
      }
      useSkillStore.setState({ installingPackId: null });
    });
    defaultPacksInFlight = operation;
    return operation;
  },

  updateDefaultSkillPacks: async () =>
    get().ensureDefaultSkillPacks({ force: true }),
}));

let scheduledSkillsRefresh: ReturnType<typeof setTimeout> | null = null;

/** Reload the skills list after a chat install or a backend skills-changed event. */
export function scheduleSkillsRefresh() {
  if (scheduledSkillsRefresh) clearTimeout(scheduledSkillsRefresh);
  scheduledSkillsRefresh = setTimeout(() => {
    scheduledSkillsRefresh = null;
    void useSkillStore.getState().refreshListed();
  }, 200);
}

export function resetScheduledSkillsRefreshForTests() {
  if (scheduledSkillsRefresh) clearTimeout(scheduledSkillsRefresh);
  scheduledSkillsRefresh = null;
}

if (typeof window !== "undefined") {
  void listen(SKILLS_CHANGED_EVENT, () => {
    scheduleSkillsRefresh();
  });
}
