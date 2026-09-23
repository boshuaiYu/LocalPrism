import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  BUILTIN_AGENT_PRESET_SEED_VERSION,
  builtinPresetContentUpdate,
  builtinPresetProfilesToSeed,
} from "@/lib/agent-presets";
import type { AgentProfile, RuntimeKind, SkillScope } from "@/runtime/types";
import { useSettingsStore } from "@/stores/settings-store";

export interface AgentStoreState {
  agents: AgentProfile[];
  loading: boolean;
  error: string | null;
  refresh: (runtime: RuntimeKind, projectPath?: string) => Promise<void>;
  save: (
    profile: AgentProfile,
    projectPath: string | undefined,
    overwrite: boolean,
  ) => Promise<AgentProfile>;
  remove: (profile: AgentProfile, projectPath?: string) => Promise<void>;
  getOne: (
    runtime: RuntimeKind,
    scope: SkillScope,
    agentId: string,
    projectPath?: string,
  ) => Promise<AgentProfile>;
  compatible: (runtime: RuntimeKind) => AgentProfile[];
  /**
   * Create missing built-in presets, and once per seed version refresh the
   * three builtins' name, description, instructions, and skillIds. Other
   * agents are left alone. Later deletions stay deleted.
   */
  ensureBuiltinPresets: () => Promise<void>;
}

let builtinPresetSeed: Promise<void> | null = null;

export function resetBuiltinPresetSeedForTests() {
  builtinPresetSeed = null;
}

function agentAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}

function whenSettingsHydrated(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

export function emptyAgentProfile(
  runtime: RuntimeKind,
  scope: SkillScope = "user",
): AgentProfile {
  return {
    id: "",
    runtime,
    scope,
    name: "",
    description: "",
    instructions: "",
    model: null,
    reasoningEffort: null,
    sandboxMode: null,
    permissionMode: null,
    tools: [],
    nicknameCandidates: [],
    skillIds: [],
    sourcePath: "",
    unknownFields: {},
  };
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,

  refresh: async (runtime, projectPath) => {
    set({ loading: true, error: null });
    try {
      const agents = await invoke<AgentProfile[]>("list_agents", {
        runtime,
        projectPath: projectPath ?? null,
      });
      set({ agents: agents ?? [], loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  save: async (profile, projectPath, overwrite) => {
    set({ loading: true, error: null });
    try {
      const saved = await invoke<AgentProfile>("save_agent", {
        profile,
        projectPath: projectPath ?? null,
        overwrite,
      });
      await get().refresh(profile.runtime, projectPath);
      return saved;
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  remove: async (profile, projectPath) => {
    set({ loading: true, error: null });
    try {
      await invoke("delete_agent", {
        runtime: profile.runtime,
        scope: profile.scope,
        agentId: profile.id,
        projectPath: projectPath ?? null,
      });
      await get().refresh(profile.runtime, projectPath);
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  getOne: async (runtime, scope, agentId, projectPath) => {
    return invoke<AgentProfile>("get_agent", {
      runtime,
      scope,
      agentId,
      projectPath: projectPath ?? null,
    });
  },

  compatible: (runtime) =>
    get().agents.filter((agent) => agent.runtime === runtime),

  ensureBuiltinPresets: () => {
    if (
      useSettingsStore.persist.hasHydrated() &&
      useSettingsStore.getState().builtinAgentPresetsSeedVersion >=
        BUILTIN_AGENT_PRESET_SEED_VERSION
    ) {
      return Promise.resolve();
    }
    if (builtinPresetSeed) return builtinPresetSeed;
    builtinPresetSeed = (async () => {
      await whenSettingsHydrated();
      if (
        useSettingsStore.getState().builtinAgentPresetsSeedVersion >=
        BUILTIN_AGENT_PRESET_SEED_VERSION
      ) {
        return;
      }
      const { useSkillStore } = await import("@/stores/skill-store");
      await useSkillStore.getState().refresh();
      await get().refresh("claude");
      const agents = get().agents;
      const skills = useSkillStore.getState().skills ?? [];
      const profiles = builtinPresetProfilesToSeed(agents, skills);
      const updates = agents.flatMap((agent) => {
        const next = builtinPresetContentUpdate(agent, skills);
        return next ? [next] : [];
      });
      let failed = false;
      for (const profile of profiles) {
        try {
          await get().save(profile, undefined, false);
        } catch (error) {
          if (!agentAlreadyExists(error)) {
            failed = true;
            continue;
          }
          set({ error: null, loading: false });
        }
      }
      for (const profile of updates) {
        try {
          await get().save(profile, undefined, true);
        } catch (error) {
          failed = true;
          set({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!failed) {
        useSettingsStore
          .getState()
          .setBuiltinAgentPresetsSeedVersion(BUILTIN_AGENT_PRESET_SEED_VERSION);
      }
    })().finally(() => {
      builtinPresetSeed = null;
    });
    return builtinPresetSeed;
  },
}));
