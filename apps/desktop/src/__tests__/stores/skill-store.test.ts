import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { emitMockTauriEvent } from "@/__tests__/mocks/tauri";
import {
  defaultSkillTargets,
  resetDefaultSkillPacksForTests,
  resetScheduledSkillsRefreshForTests,
  useSkillStore,
} from "@/stores/skill-store";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import { useSkillCategoryStore } from "@/stores/skill-category-store";
import {
  ACADEMIC_RESEARCH_SKILLS_URL,
  NATURE_SKILLS_URL,
  SCIENTIFIC_AGENT_SKILLS_URL,
} from "@/lib/default-skill-packs";
import { PAPERSPINE_SKILLS_URL } from "@/lib/paperspine";
import type { RuntimeSkill, SkillTarget } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:writer",
    name: "Writer",
    description: "Writes prose",
    folder: "writer",
    sourcePath: "C:/skills/writer",
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude", "codex"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("skill-store", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetDefaultSkillPacksForTests();
    resetScheduledSkillsRefreshForTests();
    useSkillStore.setState({
      skills: [],
      loading: false,
      error: null,
      lastAutoImportCount: 0,
      installingPackId: null,
      selectedTargets: defaultSkillTargets(),
      listedProjectPath: null,
    });
    useSkillCategoryStore.getState().resetForTests();
    useAgentStore.setState({
      agents: [],
      loading: false,
      error: null,
    });
  });

  it("defaults import targets to Claude user scope", () => {
    expect(useSkillStore.getState().selectedTargets).toEqual([
      { runtime: "claude", scope: "user" },
    ]);
  });

  it("updates selected targets for Claude/Codex user/project", () => {
    const targets: SkillTarget[] = [
      { runtime: "claude", scope: "user" },
      { runtime: "codex", scope: "project" },
    ];
    useSkillStore.getState().setSelectedTargets(targets);
    expect(useSkillStore.getState().selectedTargets).toEqual(targets);

    useSkillStore.getState().setSelectedTargets([]);
    expect(useSkillStore.getState().selectedTargets).toEqual(
      defaultSkillTargets(),
    );
  });

  it("reloads the current project list when skills change", async () => {
    useSkillStore.setState({ listedProjectPath: "/paper" });
    invoke.mockResolvedValueOnce([
      skill({ folder: "new-skill", name: "New skill", category: "Editing" }),
    ]);

    emitMockTauriEvent("skills-changed", null);

    await vi.waitFor(() => {
      expect(
        useSkillStore.getState().skills.map((item) => item.folder),
      ).toEqual(["new-skill"]);
    });
    expect(invoke).toHaveBeenCalledWith("skill_list", {
      projectPath: "/paper",
    });
    expect(useSkillStore.getState().loading).toBe(false);
  });

  it("imports a folder to the selected targets then refreshes", async () => {
    const imported = [
      skill(),
      skill({
        id: "codex:user:writer",
        targets: [{ runtime: "codex", scope: "user" }],
      }),
    ];
    invoke.mockResolvedValueOnce(imported).mockResolvedValueOnce(imported);

    await useSkillStore.getState().importFolder(
      "C:/source/writer",
      [
        { runtime: "claude", scope: "user" },
        { runtime: "codex", scope: "user" },
      ],
      "/project",
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "skill_import", {
      sourcePath: "C:/source/writer",
      targets: [
        { runtime: "claude", scope: "user" },
        { runtime: "codex", scope: "user" },
      ],
      projectPath: "/project",
    });
    expect(useSkillStore.getState().skills).toEqual(imported);
  });

  it("assigns imported folders to the chosen user category", async () => {
    useSkillCategoryStore.getState().resetForTests();
    const imported = [skill({ folder: "writer" })];
    invoke.mockResolvedValueOnce(imported).mockResolvedValueOnce(imported);

    await useSkillStore
      .getState()
      .importFolder(
        "C:/source/writer",
        [{ runtime: "claude", scope: "user" }],
        "/project",
        "writing",
      );

    expect(useSkillCategoryStore.getState().assignments.writer).toBe("writing");
  });

  it("imports a public skill URL to the selected targets then refreshes", async () => {
    const imported = [skill()];
    invoke.mockResolvedValueOnce(imported).mockResolvedValueOnce(imported);

    await useSkillStore
      .getState()
      .importUrl(
        "https://github.com/acme/writer-skill",
        [{ runtime: "claude", scope: "user" }],
        "/project",
      );

    expect(invoke).toHaveBeenNthCalledWith(1, "skill_import_url", {
      sourceUrl: "https://github.com/acme/writer-skill",
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: "/project",
      skipExisting: false,
    });
    expect(useSkillStore.getState().skills).toEqual(imported);
  });

  it("requires a project path for project-scope import by forwarding it", async () => {
    invoke.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await useSkillStore
      .getState()
      .importFolder(
        "C:/source/writer",
        [{ runtime: "codex", scope: "project" }],
        "/paper",
      );
    expect(invoke).toHaveBeenCalledWith("skill_import", {
      sourcePath: "C:/source/writer",
      targets: [{ runtime: "codex", scope: "project" }],
      projectPath: "/paper",
    });
  });

  it("auto-imports untracked project skills and refreshes when any are found", async () => {
    const imported = [
      skill({
        id: "claude:project:local",
        folder: "local",
        targets: [{ runtime: "claude", scope: "project" }],
      }),
    ];
    invoke.mockResolvedValueOnce(imported).mockResolvedValueOnce(imported);

    const count = await useSkillStore.getState().autoImportProject("/paper");

    expect(count).toBe(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "skill_auto_import_project", {
      projectPath: "/paper",
    });
    expect(useSkillStore.getState().lastAutoImportCount).toBe(1);
    expect(useSkillStore.getState().skills).toEqual(imported);
  });

  it("installs PaperSpine together with the other default skill packs", async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === "skill_list") return [];
      if (command === "list_agents") return [];
      if (command === "skill_import_url") {
        const sourceUrl = (args as { sourceUrl?: string }).sourceUrl ?? "";
        if (sourceUrl === PAPERSPINE_SKILLS_URL) {
          return [
            skill({
              id: "claude:user:paper-spine",
              folder: "paper-spine",
              name: "PaperSpine",
            }),
          ];
        }
        if (sourceUrl === ACADEMIC_RESEARCH_SKILLS_URL) {
          return [skill({ folder: "deep-research", name: "Deep Research" })];
        }
        if (sourceUrl === NATURE_SKILLS_URL) {
          return [
            skill({ folder: "nature-polishing", name: "Nature polishing" }),
          ];
        }
        if (sourceUrl === SCIENTIFIC_AGENT_SKILLS_URL) {
          return [skill({ folder: "scanpy", name: "Scanpy" })];
        }
        return [];
      }
      return [];
    });

    const result = await useSkillStore.getState().ensurePaperSpineSkills();

    expect(result).toBe("imported");
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: PAPERSPINE_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: ACADEMIC_RESEARCH_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
  });

  it("still installs missing default packs when PaperSpine is already present", async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === "skill_list") {
        return [skill({ folder: "paper-spine", name: "PaperSpine" })];
      }
      if (command === "list_agents") return [];
      if (command === "slash_commands_list") {
        return [
          { name: "paperspine", full_command: "/paperspine", scope: "user" },
        ];
      }
      if (command === "skill_import_url") {
        const sourceUrl = (args as { sourceUrl?: string }).sourceUrl ?? "";
        if (sourceUrl === ACADEMIC_RESEARCH_SKILLS_URL) {
          return [skill({ folder: "deep-research" })];
        }
        if (sourceUrl === NATURE_SKILLS_URL) {
          return [skill({ folder: "nature-polishing" })];
        }
        if (sourceUrl === SCIENTIFIC_AGENT_SKILLS_URL) {
          return [skill({ folder: "scanpy" })];
        }
        return [];
      }
      return [];
    });

    const result = await useSkillStore.getState().ensurePaperSpineSkills();

    expect(result).toBe("already");
    expect(
      invoke.mock.calls.some(
        ([command, args]) =>
          command === "skill_import_url" &&
          (args as { sourceUrl?: string }).sourceUrl === PAPERSPINE_SKILLS_URL,
      ),
    ).toBe(false);
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: ACADEMIC_RESEARCH_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
  });

  it("auto-installs missing default skill packs to Claude user scope", async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === "skill_list") return [];
      if (command === "list_agents") return [];
      if (command === "skill_import_url") {
        const sourceUrl = (args as { sourceUrl?: string }).sourceUrl ?? "";
        if (sourceUrl === PAPERSPINE_SKILLS_URL) {
          return [skill({ folder: "paper-spine", name: "PaperSpine" })];
        }
        if (sourceUrl === ACADEMIC_RESEARCH_SKILLS_URL) {
          return [skill({ folder: "deep-research", name: "Deep Research" })];
        }
        if (sourceUrl === NATURE_SKILLS_URL) {
          return [
            skill({ folder: "nature-polishing", name: "Nature polishing" }),
          ];
        }
        if (sourceUrl === SCIENTIFIC_AGENT_SKILLS_URL) {
          return [skill({ folder: "scanpy", name: "Scanpy" })];
        }
        return [];
      }
      return [];
    });

    const results = await useSkillStore.getState().ensureDefaultSkillPacks();

    expect(results.map((item) => item.id)).toEqual([
      "paper-spine",
      "academic-research-skills",
      "nature-skills",
      "scientific-agent-skills",
      "paper-humanizer-skill",
    ]);
    expect(results.map((item) => item.status)).toEqual([
      "imported",
      "imported",
      "imported",
      "imported",
      "imported",
    ]);
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: ACADEMIC_RESEARCH_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: NATURE_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: SCIENTIFIC_AGENT_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
  });

  it("skips default packs that already have a marker skill", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "skill_list") {
        return [
          skill({ folder: "paper-spine" }),
          skill({ folder: "deep-research" }),
          skill({ folder: "nature-polishing" }),
          skill({ folder: "scanpy" }),
          skill({ folder: "paper-humanizer" }),
        ];
      }
      if (command === "list_agents") {
        return [
          {
            ...emptyAgentProfile("claude", "user"),
            id: "research_architect_agent",
            name: "Research Architect",
          },
        ];
      }
      if (command === "slash_commands_list") {
        return [
          { name: "paperspine", full_command: "/paperspine", scope: "user" },
          { name: "ars-plan", full_command: "/ars-plan", scope: "user" },
          {
            name: "ars-lit-review",
            full_command: "/ars-lit-review",
            scope: "user",
          },
        ];
      }
      return [];
    });

    const results = await useSkillStore.getState().ensureDefaultSkillPacks();

    expect(results.map((item) => item.status)).toEqual([
      "already",
      "already",
      "already",
      "already",
      "already",
    ]);
    expect(
      invoke.mock.calls.some(([command]) => command === "skill_import_url"),
    ).toBe(false);
  });

  it("reimports a pack when skills exist but official slash commands do not", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "skill_list") {
        return [
          skill({ folder: "paper-spine" }),
          skill({ folder: "deep-research" }),
          skill({ folder: "nature-polishing" }),
          skill({ folder: "scanpy" }),
          skill({ folder: "paper-humanizer" }),
        ];
      }
      if (command === "list_agents") return [];
      if (command === "slash_commands_list") {
        return [
          {
            name: "PaperSpine",
            full_command: "/paper-spine",
            scope: "skill",
          },
        ];
      }
      if (command === "skill_import_url") return [];
      return [];
    });

    const results = await useSkillStore.getState().ensureDefaultSkillPacks();

    expect(results.map((item) => item.status)).toEqual([
      "imported",
      "imported",
      "already",
      "already",
      "already",
    ]);
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: PAPERSPINE_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: ACADEMIC_RESEARCH_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: true,
    });
  });

  it("force-updates every default pack even when markers already exist", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "skill_list") {
        return [
          skill({ folder: "paper-spine" }),
          skill({ folder: "deep-research" }),
          skill({ folder: "nature-polishing" }),
          skill({ folder: "scanpy" }),
          skill({ folder: "paper-humanizer" }),
        ];
      }
      if (command === "list_agents") {
        return [
          {
            ...emptyAgentProfile("claude", "user"),
            id: "research_architect_agent",
            name: "Research Architect",
          },
        ];
      }
      if (command === "skill_import_url") return [];
      return [];
    });

    const results = await useSkillStore.getState().updateDefaultSkillPacks();

    expect(results.map((item) => item.status)).toEqual([
      "imported",
      "imported",
      "imported",
      "imported",
      "imported",
    ]);
    expect(
      invoke.mock.calls.filter(([command]) => command === "skill_import_url"),
    ).toHaveLength(5);
    expect(invoke).toHaveBeenCalledWith("skill_import_url", {
      sourceUrl: PAPERSPINE_SKILLS_URL,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
      skipExisting: false,
    });
  });

  it("does not let a startup install swallow a forced update", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const skipFlags: boolean[] = [];
    invoke.mockImplementation(async (command, args) => {
      if (command === "skill_list") return [];
      if (command === "list_agents") return [];
      if (command === "slash_commands_list") return [];
      if (command === "skill_import_url") {
        skipFlags.push(
          (args as { skipExisting?: boolean }).skipExisting === true,
        );
        if (skipFlags.length === 1) {
          await firstGate;
        }
        return [];
      }
      return [];
    });

    const startup = useSkillStore.getState().ensureDefaultSkillPacks();
    const update = useSkillStore.getState().updateDefaultSkillPacks();
    releaseFirst?.();
    await startup;
    const results = await update;

    expect(results.every((item) => item.status === "imported")).toBe(true);
    expect(skipFlags.some((skipExisting) => skipExisting === false)).toBe(true);
  });

  it("keeps unmanaged skills visible and only deletes managed ids", async () => {
    const unmanaged = skill({
      id: "claude:user:legacy",
      managed: false,
    });
    useSkillStore.setState({ skills: [unmanaged] });
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);

    await useSkillStore.getState().removeManaged("claude:user:writer", false);
    expect(invoke).toHaveBeenCalledWith("skill_delete_managed", {
      entryId: "claude:user:writer",
      confirmModified: false,
    });
  });
});
