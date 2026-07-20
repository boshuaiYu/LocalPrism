import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { defaultSkillTargets, useSkillStore } from "@/stores/skill-store";
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
    useSkillStore.setState({
      skills: [],
      loading: false,
      error: null,
      lastAutoImportCount: 0,
      selectedTargets: defaultSkillTargets(),
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
